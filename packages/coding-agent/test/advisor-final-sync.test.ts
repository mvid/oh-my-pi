import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { TempDir } from "@oh-my-pi/pi-utils";

const stepSchema = type({});

function text(value: string): MockResponse {
	return { content: [value], stopReason: "stop" };
}

function step(id: string): MockResponse {
	return { content: [{ type: "toolCall", id, name: "step", arguments: {} }], stopReason: "toolUse" };
}

function advise(id: string, note: string, severity: "nit" | "concern" | "blocker"): MockResponse {
	return { content: [{ type: "toolCall", id, name: "advise", arguments: { note, severity } }], stopReason: "toolUse" };
}

function messageText(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map(part => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
}

function lastMessageIsToolResult(context: Context): boolean {
	return context.messages.at(-1)?.role === "toolResult";
}

interface HarnessOptions {
	primary: (call: number, context: Context) => MockResponse | Promise<MockResponse>;
	advisor: (call: number, context: Context, advisor: string) => MockResponse | Promise<MockResponse>;
	settings?: Record<string, unknown>;
	advisorConfigs?: AdvisorConfig[];
	sessionManager?: SessionManager;
	agentKind?: "main" | "sub";
}

let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const run of cleanup.reverse()) await run().catch(() => {});
	cleanup = [];
});

async function createHarness(options: HarnessOptions) {
	const temp = TempDir.createSync("@pi-advisor-final-sync-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	let primaryCalls = 0;
	let advisorCalls = 0;
	const primaryContexts: string[] = [];
	const advisorContexts: { advisor: string; text: string }[] = [];
	const primaryMock = createMockModel({
		id: "final-sync-primary",
		provider: "anthropic",
		handler: context => options.primary(primaryCalls, context),
	});
	const advisorMock = createMockModel({
		id: "final-sync-advisor",
		provider: "anthropic",
		handler: context => {
			const prompt = JSON.stringify(context.systemPrompt ?? "");
			const name = /ADVISOR_NAME=(\w+)/.exec(prompt)?.[1] ?? "default";
			advisorContexts.push({ advisor: name, text: JSON.stringify(context.messages) });
			return options.advisor(++advisorCalls, context, name);
		},
	});
	const stepTool: AgentTool<typeof stepSchema, undefined> = {
		name: "step",
		label: "Step",
		description: "Run one step",
		parameters: stepSchema,
		execute: async () => ({ content: [{ type: "text", text: "step complete" }] }),
	};
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["advisor final sync"], tools: [stepTool] },
		convertToLlm,
		streamFn: (streamModel, context, streamOptions) => {
			primaryCalls++;
			primaryContexts.push(JSON.stringify(context.messages));
			return primaryMock.stream(streamModel, context, streamOptions);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.syncBacklog": "off",
		"advisor.finalSync": true,
		...options.settings,
	});
	settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		advisorTools: [],
		advisorStreamFn: advisorMock.stream,
		advisorConfigs: options.advisorConfigs,
		agentKind: options.agentKind,
	});
	cleanup.push(async () => {
		await session.dispose();
		auth.close();
		await temp.remove();
	});
	if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
	const events: AgentSessionEvent[] = [];
	const order: string[] = [];
	const agentEnd = Promise.withResolvers<void>();
	session.subscribe(event => {
		events.push(event);
		if (event.type === "agent_end") {
			order.push("agent_end");
			agentEnd.resolve();
		}
	});
	return {
		session,
		agent,
		sessionManager,
		temp,
		events,
		order,
		agentEnd: agentEnd.promise,
		primaryContexts,
		advisorContexts,
		get primaryCalls() {
			return primaryCalls;
		},
		get advisorCalls() {
			return advisorCalls;
		},
		assistantEntries(): (SessionMessageEntry & { message: AssistantMessage })[] {
			return sessionManager
				.getEntries()
				.filter(
					(entry): entry is SessionMessageEntry & { message: AssistantMessage } =>
						entry.type === "message" && entry.message.role === "assistant",
				);
		},
		cards(): string[] {
			return session.agent.state.messages
				.filter(message => message.role === "custom" && message.customType === "advisor")
				.map(messageText);
		},
		supersedingEvents(): AssistantMessage[] {
			return events.flatMap(event =>
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.supersedesEntryId !== undefined
					? [event.message]
					: [],
			);
		},
	};
}

/** Draft on first call after `tools` step rounds; the advisor flags the draft once with `severity`. */
function draftThenReplacement(options: {
	tools?: number;
	severity?: "nit" | "concern" | "blocker";
	replacement?: MockResponse | ((context: Context) => MockResponse | Promise<MockResponse>);
}) {
	const tools = options.tools ?? 0;
	let advised = false;
	return {
		primary: (call: number, context: Context): MockResponse | Promise<MockResponse> => {
			if (call <= tools) return step(`step-${call}`);
			if (call === tools + 1) return text("draft: the answer is 41");
			const replacement = options.replacement ?? text("final: the answer is 42");
			return typeof replacement === "function" ? replacement(context) : replacement;
		},
		advisor: (_call: number, context: Context): MockResponse => {
			if (lastMessageIsToolResult(context)) return text("advisor done");
			if (!advised && JSON.stringify(context.messages).includes("the answer is 41")) {
				advised = true;
				return advise("advice-draft", "41 is wrong; recompute", options.severity ?? "concern");
			}
			return text("advisor quiet");
		},
	};
}

describe("advisor final sync", () => {
	it.each([
		{ label: "setting off", settings: { "advisor.finalSync": false }, agentKind: undefined },
		{ label: "subagent", settings: {}, agentKind: "sub" as const },
	])("keeps asynchronous final delivery when final sync does not apply ($label)", async ({ settings, agentKind }) => {
		const runSettled = Promise.withResolvers<void>();
		const script = draftThenReplacement({ tools: 1 });
		const harness = await createHarness({
			...script,
			settings,
			agentKind,
			advisor: async (call, context) => {
				// Reviews stay parked until the run settles: a final-sync wait would deadlock here.
				await runSettled.promise;
				return script.advisor(call, context);
			},
		});
		void harness.agentEnd.then(runSettled.resolve);
		await harness.session.prompt("question");
		await harness.session.waitForIdle();
		expect(harness.primaryCalls).toBe(2);
		expect(harness.supersedingEvents()).toHaveLength(0);
		expect(harness.assistantEntries().some(entry => entry.message.supersedesEntryId !== undefined)).toBe(false);
	});

	it("reviews held cadence updates once at the final answer", async () => {
		const harness = await createHarness({
			...draftThenReplacement({ tools: 1 }),
			settings: { "advisor.reviewInterval": 3 },
			advisor: (_call, context) => (lastMessageIsToolResult(context) ? text("done") : text("advisor quiet")),
		});
		await harness.session.prompt("question");
		await harness.session.waitForIdle();
		expect(harness.advisorCalls).toBe(1);
		expect(harness.advisorContexts[0]?.text).toContain("step complete");
		expect(harness.advisorContexts[0]?.text).toContain("the answer is 41");
		expect(harness.primaryCalls).toBe(2);
	});

	it("waits only at the final answer, then supersedes the draft with one standalone replacement", async () => {
		const draftTurnEnd = Promise.withResolvers<void>();
		let gateHeldAtDraft = false;
		let gateReleased = false;
		const script = draftThenReplacement({ tools: 2 });
		const harness = await createHarness({
			primary: (call, context) => {
				if (call === 3) gateHeldAtDraft = !gateReleased;
				if (call === 5) return text("follow-up answer");
				return script.primary(call, context);
			},
			advisor: async (call, context) => {
				if (call === 1) {
					await draftTurnEnd.promise;
					gateReleased = true;
				}
				const response = script.advisor(call, context);
				if (response.content?.some(part => typeof part !== "string" && part.type === "toolCall")) {
					harness.order.push("advice");
				}
				return response;
			},
		});
		harness.session.subscribe(event => {
			if (event.type === "turn_end" && messageText(event.message).includes("the answer is 41"))
				draftTurnEnd.resolve();
		});
		await harness.session.prompt("question");
		await harness.session.waitForIdle();

		expect(gateHeldAtDraft).toBe(true);
		expect(harness.order.indexOf("advice")).toBeLessThan(harness.order.indexOf("agent_end"));
		expect(harness.primaryCalls).toBe(4);
		expect(harness.events.filter(event => event.type === "agent_start")).toHaveLength(1);
		expect(harness.primaryContexts[3]).toContain("41 is wrong; recompute");
		const [draft, replacement] = harness.assistantEntries().slice(-2);
		expect(messageText(draft?.message)).toContain("the answer is 41");
		expect(draft?.message.supersedesEntryId).toBeUndefined();
		expect(messageText(replacement?.message)).toContain("the answer is 42");
		expect(replacement?.message.supersedesEntryId).toBe(draft!.id);
		expect(harness.supersedingEvents().map(message => message.supersedesEntryId)).toEqual([draft!.id]);
		expect(harness.session.getAdvisorFinalSyncFallbackAnswer()).toBeUndefined();

		// Both answers stay in model context and replay; the relation never reaches the provider.
		const context = harness.sessionManager.buildSessionContext();
		const answers = context.messages.filter(message => message.role === "assistant").map(messageText);
		expect(answers.filter(answer => answer.includes("the answer is 4"))).toHaveLength(2);
		await harness.session.prompt("follow up");
		await harness.session.waitForIdle();
		expect(harness.primaryContexts[4]).toContain("the answer is 41");
		expect(harness.primaryContexts[4]).toContain("the answer is 42");
		expect(harness.primaryContexts[4]).not.toContain("supersedesEntryId");
	});

	it("replacement tool steps never carry the relation; only its successful final does", async () => {
		const harness = await createHarness(
			draftThenReplacement({
				replacement: context => (lastMessageIsToolResult(context) ? text("final: 42") : step("fix-1")),
			}),
		);
		await harness.session.prompt("question");
		await harness.session.waitForIdle();
		const entries = harness.assistantEntries();
		expect(entries.map(entry => entry.message.stopReason)).toEqual(["stop", "toolUse", "stop"]);
		expect(entries.map(entry => entry.message.supersedesEntryId)).toEqual([undefined, undefined, entries[0]!.id]);
	});

	it.each([
		{ label: "nit", severity: "nit" as const, setup: () => {} },
		{
			label: "plan mode",
			severity: "blocker" as const,
			setup: (session: AgentSession) => session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" }),
		},
		{
			label: "preserve-only host",
			severity: "blocker" as const,
			setup: (session: AgentSession) => session.prepareForHeadlessAdvisorDrain(),
		},
	])("keeps advice as a card without a replacement ($label)", async ({ severity, setup }) => {
		const harness = await createHarness(draftThenReplacement({ severity }));
		setup(harness.session);
		await harness.session.prompt("question");
		await harness.session.waitForIdle();
		expect(harness.supersedingEvents()).toHaveLength(0);
		expect(harness.cards().some(card => card.includes("41 is wrong; recompute"))).toBe(true);
		expect(harness.primaryContexts.some(context => context.includes("41 is wrong; recompute"))).toBe(false);
	});

	it("keeps a cooldown-suppressed concern as a card while a blocker still replaces", async () => {
		const run = async (finalSeverity: "concern" | "blocker") => {
			let finalAdvised = false;
			const harness = await createHarness({
				settings: { "advisor.syncBacklog": "1" },
				primary: call =>
					call === 1 ? step("step-1") : call === 2 ? text("draft: the answer is 41") : text("final: 42"),
				advisor: (_call, context) => {
					if (lastMessageIsToolResult(context)) return text("done");
					const transcript = JSON.stringify(context.messages);
					if (transcript.includes("the answer is 41")) {
						if (finalAdvised) return text("quiet");
						finalAdvised = true;
						return advise("advice-final", "41 is wrong; recompute", finalSeverity);
					}
					// A live mid-run blocker arms the post-interrupt cooldown.
					return advise("advice-mid", "check the step output", "blocker");
				},
			});
			await harness.session.prompt("question");
			await harness.session.waitForIdle();
			return harness;
		};
		const concern = await run("concern");
		expect(concern.supersedingEvents()).toHaveLength(0);
		expect(concern.cards().some(card => card.includes("41 is wrong; recompute"))).toBe(true);
		const blocker = await run("blocker");
		expect(blocker.supersedingEvents()).toHaveLength(1);
	});

	it.each([
		{
			label: "error",
			replacement: { content: [], stopReason: "error", errorMessage: "provider failed" } as MockResponse,
		},
		{ label: "empty", replacement: text("") },
		{ label: "truncated", replacement: { content: ["final: the answer"], stopReason: "length" } as MockResponse },
	])("an unsuccessful replacement never hides the draft ($label)", async ({ replacement }) => {
		const harness = await createHarness(draftThenReplacement({ replacement }));
		await harness.session.prompt("question");
		await harness.session.waitForIdle();
		// An empty stop may be re-prompted by existing recovery; none of the attempts may supersede.
		expect(harness.primaryCalls).toBeGreaterThan(1);
		expect(harness.supersedingEvents()).toHaveLength(0);
		const draft = harness.session.getAdvisorFinalSyncFallbackAnswer();
		expect(messageText(draft)).toContain("the answer is 41");

		// A fresh request owns the next answer; the old draft is never substituted for it.
		await harness.session.prompt("next question");
		await harness.session.waitForIdle();
		expect(harness.session.getAdvisorFinalSyncFallbackAnswer()).toBeUndefined();
	});

	it("an interrupted replacement keeps the draft as the run's fallback", async () => {
		const replacementStarted = Promise.withResolvers<void>();
		const harness = await createHarness(
			draftThenReplacement({
				replacement: async () => {
					replacementStarted.resolve();
					return { content: ["final: the answer"], delayMs: 60_000 };
				},
			}),
		);
		const run = harness.session.prompt("question");
		await replacementStarted.promise;
		await harness.session.abort({ reason: USER_INTERRUPT_LABEL });
		await run;
		await harness.session.waitForIdle();
		expect(harness.supersedingEvents()).toHaveLength(0);
		expect(messageText(harness.session.getAdvisorFinalSyncFallbackAnswer())).toContain("the answer is 41");
	});

	it("new user input during the final wait cancels consolidation and runs first", async () => {
		const draftTurnEnd = Promise.withResolvers<void>();
		const releaseAdvisor = Promise.withResolvers<void>();
		const harness = await createHarness({
			primary: (call, context) => {
				if (call === 1) return text("draft: the answer is 41");
				// The queued input runs while the old review is still parked: the wait was cancelled.
				releaseAdvisor.resolve();
				return text(JSON.stringify(context.messages).includes("new question") ? "new answer" : "unexpected");
			},
			advisor: async (_call, context) => {
				await releaseAdvisor.promise;
				return lastMessageIsToolResult(context) ? text("done") : text("advisor quiet");
			},
		});
		harness.session.subscribe(event => {
			if (event.type === "turn_end" && messageText(event.message).includes("the answer is 41"))
				draftTurnEnd.resolve();
		});
		const run = harness.session.prompt("question");
		await draftTurnEnd.promise;
		await harness.session.prompt("new question", { streamingBehavior: "steer" });
		await run;
		await harness.session.waitForIdle();
		expect(harness.primaryCalls).toBe(2);
		expect(messageText(harness.assistantEntries().at(-1)?.message)).toBe("new answer");
		expect(harness.supersedingEvents()).toHaveLength(0);
	});

	it("bounds the final wait with one 30-second deadline per advisor; a late blocker stays a card", async () => {
		const fastAdvised = Promise.withResolvers<void>();
		const releaseSlow = Promise.withResolvers<void>();
		const replacementStarted = Promise.withResolvers<void>();
		let slowAdvised = false;
		let capture = false;
		const deadlines: (() => void)[] = [];
		const realSetTimeout = globalThis.setTimeout;
		// Capture the final-gate deadline timers so the test fires them instead of waiting 30s.
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number) => {
			if (capture && delay === 30_000) {
				deadlines.push(handler);
				return realSetTimeout(() => {}, 0);
			}
			return realSetTimeout(handler, delay);
		}) as unknown as typeof setTimeout);
		const harness = await createHarness({
			advisorConfigs: [
				{ name: "fast", instructions: "ADVISOR_NAME=fast", syncBacklog: "off" },
				{ name: "slow", instructions: "ADVISOR_NAME=slow", syncBacklog: "strict" },
			],
			primary: call => {
				if (call === 1) {
					capture = true;
					return text("draft: the answer is 41");
				}
				capture = false;
				replacementStarted.resolve();
				return text("final: the answer is 42");
			},
			advisor: async (_call, context, name) => {
				if (lastMessageIsToolResult(context)) return text("done");
				if (name === "fast") return advise("advice-fast", "41 is wrong; recompute", "concern");
				await releaseSlow.promise;
				if (slowAdvised) return text("quiet");
				slowAdvised = true;
				return advise("advice-slow", "late blocker finding", "blocker");
			},
		});
		const fastAdvise = harness.session.getAdvisorAgent()?.state.tools.find(tool => tool.name === "advise");
		if (!fastAdvise) throw new Error("Expected the fast advisor's advise tool");
		const execute = fastAdvise.execute.bind(fastAdvise);
		fastAdvise.execute = async (...args) => {
			const result = await execute(...args);
			fastAdvised.resolve();
			return result;
		};
		const run = harness.session.prompt("question");
		await fastAdvised.promise;
		for (let i = 0; i < 50; i++) await Promise.resolve();
		// The strict reviewer is still running; only the deadline can release the gate.
		expect(harness.primaryCalls).toBe(1);
		expect(deadlines).toHaveLength(2);
		for (const fire of deadlines) fire();
		await replacementStarted.promise;
		await run;
		await harness.session.waitForIdle();
		expect(harness.primaryContexts[1]).toContain("41 is wrong; recompute");
		expect(harness.supersedingEvents()).toHaveLength(1);

		const lateCard = Promise.withResolvers<void>();
		harness.session.subscribe(event => {
			if (event.type === "message_end" && messageText(event.message).includes("late blocker finding")) {
				lateCard.resolve();
			}
		});
		releaseSlow.resolve();
		await lateCard.promise;
		await harness.session.waitForIdle();
		expect(harness.cards().some(card => card.includes("late blocker finding"))).toBe(true);
		expect(harness.primaryCalls).toBe(2);
	});

	it("a failed advisor releases only itself; the healthy reviewer still gates the answer", async () => {
		const brokenFailed = Promise.withResolvers<void>();
		const harness = await createHarness({
			advisorConfigs: [
				{ name: "broken", instructions: "ADVISOR_NAME=broken" },
				{ name: "healthy", instructions: "ADVISOR_NAME=healthy" },
			],
			primary: call => (call === 1 ? text("draft: the answer is 41") : text("final: the answer is 42")),
			advisor: async (_call, context, name) => {
				if (name === "broken") {
					brokenFailed.resolve();
					return { throw: "advisor provider down" };
				}
				if (lastMessageIsToolResult(context)) return text("done");
				await brokenFailed.promise;
				return advise("advice-healthy", "41 is wrong; recompute", "concern");
			},
		});
		await harness.session.prompt("question");
		await harness.session.waitForIdle();
		expect(harness.primaryCalls).toBe(2);
		expect(harness.primaryContexts[1]).toContain("41 is wrong; recompute");
		expect(harness.supersedingEvents()).toHaveLength(1);
	});
});

describe("advisor final sync persistence", () => {
	async function persistedHarness(flush?: (original: () => Promise<void>) => Promise<void>) {
		const temp = TempDir.createSync("@pi-advisor-final-sync-store-");
		cleanup.push(() => temp.remove());
		const sessionManager = SessionManager.create(temp.path(), temp.join("sessions"));
		let armed = false;
		if (flush) {
			const original = sessionManager.flush.bind(sessionManager);
			vi.spyOn(sessionManager, "flush").mockImplementation(() => (armed ? flush(original) : original()));
		}
		const script = draftThenReplacement({});
		const harness = await createHarness({
			...script,
			sessionManager,
			primary: (call, context) => {
				if (call === 2) armed = true;
				return script.primary(call, context);
			},
		});
		return harness;
	}

	it("publishes the marked replacement only after its append is flushed, and resumes with the relation", async () => {
		const flushStarted = Promise.withResolvers<void>();
		const releaseFlush = Promise.withResolvers<void>();
		let markedBeforeFlush = -1;
		const harness = await persistedHarness(async original => {
			markedBeforeFlush = harness.supersedingEvents().length;
			flushStarted.resolve();
			await releaseFlush.promise;
			await original();
		});
		const run = harness.session.prompt("question");
		await flushStarted.promise;
		releaseFlush.resolve();
		await run;
		await harness.session.waitForIdle();
		expect(markedBeforeFlush).toBe(0);
		expect(harness.supersedingEvents()).toHaveLength(1);

		const file = harness.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session file");
		await harness.sessionManager.flush();
		const resumed = await SessionManager.open(file, harness.temp.join("sessions"));
		const entries = resumed
			.getEntries()
			.filter(
				(entry): entry is SessionMessageEntry & { message: AssistantMessage } =>
					entry.type === "message" && entry.message.role === "assistant",
			);
		expect(entries).toHaveLength(2);
		expect(entries[1]?.message.supersedesEntryId).toBe(entries[0]!.id);
		const transcript = resumed.buildSessionContext({ transcript: true });
		const draftIndex = transcript.messages.findIndex(message => messageText(message).includes("the answer is 41"));
		expect(transcript.supersededAt?.[draftIndex]).toBe(true);
		expect(transcript.supersededAt?.filter(Boolean)).toHaveLength(1);
	});

	it("a replacement whose flush fails is emitted unmarked and never collapses the draft", async () => {
		const harness = await persistedHarness(async () => {
			throw new Error("disk full");
		});
		await harness.session.prompt("question");
		await harness.session.waitForIdle();
		expect(harness.primaryCalls).toBe(2);
		expect(harness.supersedingEvents()).toHaveLength(0);
		const replacement = harness.events.findLast(
			event => event.type === "message_end" && messageText(event.message).includes("the answer is 42"),
		);
		expect(replacement).toBeDefined();
		expect(harness.assistantEntries().some(entry => entry.message.supersedesEntryId !== undefined)).toBe(false);
		expect(harness.sessionManager.buildSessionContext({ transcript: true }).supersededAt?.some(Boolean)).toBe(false);
	});

	it("ignores a provider-supplied relation on a new assistant message", async () => {
		const harness = await createHarness({
			primary: () => text("plain answer"),
			advisor: (_call, context) => (lastMessageIsToolResult(context) ? text("done") : text("advisor quiet")),
		});
		await harness.session.prompt("question");
		await harness.session.waitForIdle();
		const target = harness.assistantEntries()[0]!;
		const forged: AssistantMessage = {
			...target.message,
			content: [{ type: "text", text: "forged replacement" }],
			timestamp: target.message.timestamp + 1,
			supersedesEntryId: target.id,
		};
		harness.agent.emitExternalEvent({ type: "message_start", message: forged });
		harness.agent.emitExternalEvent({ type: "message_end", message: forged });
		await harness.session.waitForIdle();
		const stored = harness.assistantEntries().find(entry => messageText(entry.message) === "forged replacement");
		expect(stored).toBeDefined();
		expect(stored?.message.supersedesEntryId).toBeUndefined();
		expect(harness.sessionManager.buildSessionContext({ transcript: true }).supersededAt?.some(Boolean)).toBe(false);
	});
});
