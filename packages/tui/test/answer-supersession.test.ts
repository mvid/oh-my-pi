import { beforeAll, describe, expect, it, vi } from "bun:test";
import { createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { createSupersededAnswerDisclosure } from "@oh-my-pi/pi-tui/chat/superseded-answer";
import { supersededAnswerEntryIds, type TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { appendOutlineEntries } from "@oh-my-pi/pi-tui/chat/transcript-outline";
import { Disclosure } from "@oh-my-pi/pi-tui/components/disclosure";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

beforeAll(() => initTheme());

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function answer(id: string, overrides: Partial<AssistantMessage> = {}): TranscriptEntryLike {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `${id} answer` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage,
			stopReason: "stop",
			timestamp: 1,
			...overrides,
		},
	};
}

function user(): TranscriptEntryLike {
	return {
		type: "message",
		id: "user",
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content: "question", timestamp: 1 },
	};
}

function path(): TranscriptEntryLike[] {
	return [user(), answer("draft"), answer("replacement", { supersedesEntryId: "draft" })];
}

function builder(): ChatTranscriptBuilder {
	return new ChatTranscriptBuilder({
		ui: { requestRender() {}, requestComponentRender() {} } as unknown as TUI,
		cwd: "/tmp",
		requestRender() {},
	});
}

describe("supersededAnswerEntryIds", () => {
	it("resolves entry IDs despite identical timestamps", () => {
		expect([...supersededAnswerEntryIds(path())]).toEqual(["draft"]);
	});

	it("keeps chains of valid replacements in the same run", () => {
		expect([...supersededAnswerEntryIds([...path(), answer("third", { supersedesEntryId: "replacement" })])]).toEqual(
			["draft", "replacement"],
		);
	});

	it.each([
		["unknown", "missing"],
		["self", "replacement"],
		["malformed", 42 as unknown as string],
	])("ignores %s references", (_name, target) => {
		expect(
			supersededAnswerEntryIds([answer("draft"), answer("replacement", { supersedesEntryId: target })]).size,
		).toBe(0);
	});

	it("ignores forward references", () => {
		expect(
			supersededAnswerEntryIds([answer("draft", { supersedesEntryId: "replacement" }), answer("replacement")]).size,
		).toBe(0);
	});

	it("ignores a pruned target instead of looking elsewhere", () => {
		expect(supersededAnswerEntryIds([user(), path()[2]!]).size).toBe(0);
	});

	it("does not resolve targets on another branch", () => {
		const sibling = [user(), answer("sibling", { supersedesEntryId: "draft" })];
		expect(supersededAnswerEntryIds(sibling).size).toBe(0);
	});

	it.each(["error", "aborted", "length", "toolUse"] as const)("rejects a %s replacement", stopReason => {
		expect(
			supersededAnswerEntryIds([answer("draft"), answer("replacement", { stopReason, supersedesEntryId: "draft" })])
				.size,
		).toBe(0);
	});

	it.each(["error", "aborted", "length", "toolUse"] as const)("rejects a %s target", stopReason => {
		expect(
			supersededAnswerEntryIds([
				answer("draft", { stopReason }),
				answer("replacement", { supersedesEntryId: "draft" }),
			]).size,
		).toBe(0);
	});

	const invalidContents: Array<[string, AssistantMessage["content"]]> = [
		["empty", []],
		["blank", [{ type: "text", text: " \n\t " }]],
		["thinking-only", [{ type: "thinking", thinking: "considering" }]],
		["image-only", [{ type: "image", data: "AA==", mimeType: "image/png" }]],
		[
			"tool call",
			[
				{ type: "text", text: "draft" },
				{ type: "toolCall", id: "call", name: "read", arguments: {} },
			],
		],
	];
	it.each(invalidContents)("rejects %s replacements", (_name, content) => {
		expect(
			supersededAnswerEntryIds([answer("draft"), answer("replacement", { content, supersedesEntryId: "draft" })])
				.size,
		).toBe(0);
	});
	it.each(invalidContents)("rejects %s targets", (_name, content) => {
		expect(
			supersededAnswerEntryIds([answer("draft", { content }), answer("replacement", { supersedesEntryId: "draft" })])
				.size,
		).toBe(0);
	});

	it("accepts text accompanied by thinking, redacted thinking and images", () => {
		const content: AssistantMessage["content"] = [
			{ type: "thinking", thinking: "considering" },
			{ type: "redactedThinking", data: "opaque" },
			{ type: "image", data: "AA==", mimeType: "image/png" },
			{ type: "text", text: "answer" },
		];
		expect([
			...supersededAnswerEntryIds([
				answer("draft", { content }),
				answer("replacement", { content, supersedesEntryId: "draft" }),
			]),
		]).toEqual(["draft"]);
	});

	it.each([
		["user", user()],
		[
			"custom message",
			{
				type: "message",
				id: "skill",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				message: createCustomMessage(
					"skill-prompt",
					"new question",
					true,
					undefined,
					"2026-01-01T00:00:00Z",
					"user",
				),
			},
		],
		[
			"persisted custom message",
			{
				type: "custom_message",
				id: "collab",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				customType: "collab-prompt",
				content: "new question",
				display: true,
				attribution: "user",
			},
		],
	] satisfies Array<[string, TranscriptEntryLike]>)("resets the run on %s requests", (_name, request) => {
		expect(
			supersededAnswerEntryIds([answer("draft"), request, answer("replacement", { supersedesEntryId: "draft" })])
				.size,
		).toBe(0);
	});

	it("does not treat advisor messages as new user requests", () => {
		const note: TranscriptEntryLike = {
			type: "custom_message",
			id: "advisor",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			customType: "advisor",
			content: "review",
			display: true,
			attribution: "agent",
		};
		expect([
			...supersededAnswerEntryIds([answer("draft"), note, answer("replacement", { supersedesEntryId: "draft" })]),
		]).toEqual(["draft"]);
	});
});

describe("superseded answer disclosure", () => {
	it("constructs its body lazily, supports native toggles and disposes it once", () => {
		const dispose = vi.fn();
		const body = vi.fn(() => Object.assign(new Text("original answer"), { dispose }));
		const disclosure = createSupersededAnswerDisclosure(body);
		expect(disclosure).toBeInstanceOf(Disclosure);
		expect(Bun.stripANSI(disclosure.render(120).join("\n"))).toContain(
			"Earlier answer superseded after advisor review",
		);
		expect(body).not.toHaveBeenCalled();
		const described = disclosure.describe({
			cols: 120,
			reduceMotion: true,
			dark: true,
			supports: () => true,
			feature: () => false,
		});
		expect(described.k).toBe("section");
		expect(described.p).toMatchObject({ collapsible: true, collapsed: true });
		disclosure.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect(disclosure.render(120).join("\n")).toContain("original answer");
		disclosure.setExpanded(false);
		expect(disclosure.render(120).join("\n")).not.toContain("original answer");
		disclosure.setExpanded(true);
		disclosure.render(120);
		expect(body).toHaveBeenCalledTimes(1);
		disclosure.dispose();
		disclosure.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("projects the current branch outline through the shared disclosure", () => {
		const transcript = builder();
		try {
			transcript.reset();
			const targets = appendOutlineEntries(transcript, path());
			expect(targets.map(target => target.entryId)).toEqual(["user", "draft", "replacement"]);
			const disclosure = transcript.container.children.find(child => child instanceof Disclosure);
			expect(disclosure).toBeInstanceOf(Disclosure);
			expect(transcript.container.render(120).join("\n")).not.toContain("draft answer");
			expect(transcript.container.render(120).join("\n")).toContain("replacement answer");
			transcript.setExpanded(true);
			expect(transcript.container.render(120).join("\n")).toContain("draft answer");
			transcript.setExpanded(false);
			expect(transcript.container.render(120).join("\n")).not.toContain("draft answer");
		} finally {
			transcript.dispose();
		}
	});

	it("leaves default append and rebuild raw for audit viewers", () => {
		const transcript = builder();
		try {
			transcript.append(path());
			expect(transcript.container.children.filter(child => child instanceof AssistantMessageComponent)).toHaveLength(
				2,
			);
			transcript.reset();
			transcript.setSuperseded(supersededAnswerEntryIds(path()));
			transcript.append(path());
			expect(transcript.container.children.some(child => child instanceof Disclosure)).toBe(true);
			transcript.rebuild(path());
			expect(transcript.container.children.some(child => child instanceof Disclosure)).toBe(false);
			expect(transcript.container.render(120).join("\n")).toContain("draft answer");
		} finally {
			transcript.dispose();
		}
	});
});
