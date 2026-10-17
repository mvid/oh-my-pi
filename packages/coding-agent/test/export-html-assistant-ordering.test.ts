import { afterEach, describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { supersededAnswerEntryIds, type TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { type Document, Element, parseHTML } from "@oh-my-pi/pi-utils/dom";
import { Marked } from "@oh-my-pi/pi-utils/marked";

const [templateHtml, templateJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
]);
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

afterEach(() => {
	if (originalScrollIntoView) {
		Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
	} else {
		Reflect.deleteProperty(Element.prototype, "scrollIntoView");
	}
});

interface AssistantBlock {
	type: "text" | "thinking" | "image" | "toolCall";
	text?: string;
	thinking?: string;
	mimeType?: string;
	data?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface RenderedSession {
	assistant: Element;
	document: Document;
	context: vm.Context;
	lastScrolledId: () => string | null;
}

function renderSession(
	entries: unknown[],
	leafId: string,
	options: { search?: string; subSessions?: Record<string, { entries: unknown[]; leafId: string }> } = {},
): RenderedSession {
	const { document, window } = parseHTML(templateHtml);
	let lastScrolledId: string | null = null;
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		value(this: Element) {
			lastScrolledId = this.id || null;
		},
		configurable: true,
	});
	const sessionData = document.getElementById("session-data");
	if (!sessionData) throw new Error("Export template is missing session data");
	sessionData.textContent = Buffer.from(
		JSON.stringify({
			header: {
				type: "session",
				version: 3,
				id: "assistant-ordering-test",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: "/tmp",
			},
			entries,
			leafId,
			subSessions: options.subSessions,
		}),
	).toBase64();
	Object.defineProperty(window, "location", {
		value: new URL(`https://example.test/export.html${options.search ?? ""}`),
		configurable: true,
	});
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});
	const themeSelect = document.getElementById("theme-select");
	if (themeSelect) {
		let themeValue = "auto";
		Object.defineProperty(themeSelect, "value", {
			get: () => themeValue,
			set: next => {
				themeValue = String(next);
			},
			configurable: true,
		});
	}

	const context = vm.createContext({
		window,
		document,
		marked: new Marked(),
		hljs: {
			getLanguage: () => false,
			highlight: () => ({ value: "" }),
			highlightAuto: () => ({ value: "" }),
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		navigator: { clipboard: null },
		localStorage: { getItem: () => null, setItem() {} },
		setTimeout: (callback: () => void, delay = 0) => {
			if (delay === 0) callback();
			return 0;
		},
		clearTimeout() {},
	});
	vm.runInContext(templateJs, context);

	const assistant = document.querySelector(".assistant-message");
	if (!assistant) throw new Error("Export viewer did not render the assistant message");
	return { assistant, document, context, lastScrolledId: () => lastScrolledId };
}

function renderAssistant(
	content: AssistantBlock[],
	stopReason: "stop" | "aborted" | "error" = "stop",
	withToolResults = false,
	reverseToolResultChain = false,
): RenderedSession {
	const toolCalls = content.filter(
		(block): block is AssistantBlock & { id: string; name: string } => block.type === "toolCall",
	);
	const entries = [
		{
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				role: "assistant",
				content,
				stopReason,
				errorMessage: stopReason === "error" ? "provider failed" : undefined,
				timestamp: 1,
			},
		},
		...(withToolResults
			? toolCalls.map((block, index) => ({
					type: "message",
					id: `result-${block.id}`,
					parentId: reverseToolResultChain
						? index === toolCalls.length - 1
							? "assistant-1"
							: `result-${toolCalls[index + 1]!.id}`
						: index === 0
							? "assistant-1"
							: `result-${toolCalls[index - 1]!.id}`,
					timestamp: `2026-01-01T00:00:0${index + 2}.000Z`,
					message: {
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: [{ type: "text", text: `${block.name} result` }],
						isError: false,
						timestamp: index + 2,
					},
				}))
			: []),
	];
	const leafId = withToolResults ? `result-${toolCalls.at(reverseToolResultChain ? 0 : -1)?.id}` : "assistant-1";
	return renderSession(entries, leafId);
}

function toolName(element: Element, context: vm.Context): string {
	const key = element.getAttribute("data-key");
	if (!key) throw new Error("Rendered tool call is missing its data key");
	const payload = vm.runInContext(`globalThis.__OMP_TOOL_VIEW_DATA.get(${JSON.stringify(key)})`, context) as unknown;
	if (!payload || typeof payload !== "object" || !("name" in payload) || typeof payload.name !== "string") {
		throw new Error(`Rendered tool call ${key} is missing its name`);
	}
	return payload.name;
}

function renderedBlockOrder({ assistant, context }: RenderedSession): string[] {
	const order: string[] = [];
	for (const child of Array.from(assistant.children)) {
		if (child.classList.contains("assistant-text")) {
			order.push(child.textContent?.trim() ?? "");
		} else if (child.classList.contains("thinking-block")) {
			order.push(child.querySelector(".thinking-text")?.textContent?.trim() ?? "");
		} else if (child.classList.contains("message-images")) {
			order.push("image");
		} else if (child.tagName.toLowerCase() === "omp-tool-view") {
			order.push(toolName(child, context));
		} else if (child.classList.contains("error-text")) {
			order.push(child.textContent?.trim() ?? "");
		}
	}
	return order;
}

function renderedSidebarOrder({ document }: RenderedSession): string[] {
	return Array.from(document.querySelectorAll("#tree-container .tree-content")).map(
		node => node.textContent?.trim() ?? "",
	);
}

describe("HTML export assistant content ordering", () => {
	test("preserves interleaved text, tool calls, thinking, images, and the terminal stop reason", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-read" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
				{ type: "text", text: "between-tools" },
				{
					type: "toolCall",
					id: "tool-2",
					name: "task",
					arguments: { agent: "ExploreCompletion", prompt: "Inspect completion handling" },
				},
				{ type: "thinking", thinking: "thinking-after-task" },
				{ type: "image", mimeType: "image/png", data: "aa" },
				{ type: "text", text: "final-answer" },
			],
			"aborted",
		);

		expect(renderedBlockOrder(rendered)).toEqual([
			"before-read",
			"read",
			"between-tools",
			"task",
			"thinking-after-task",
			"image",
			"final-answer",
			"Aborted",
		]);
	});

	test("projects interleaved assistant blocks into pi-style sidebar timeline rows", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-read" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
				{ type: "text", text: "between-tools" },
				{
					type: "toolCall",
					id: "tool-2",
					name: "task",
					arguments: { agent: "ExploreCompletion", prompt: "Inspect completion handling" },
				},
				{ type: "thinking", thinking: "thinking-after-task" },
				{ type: "image", mimeType: "image/png", data: "aa" },
				{ type: "text", text: "final-answer" },
			],
			"stop",
			true,
		);

		expect(renderedSidebarOrder(rendered)).toEqual([
			"assistant: before-read",
			"[read: README.md]",
			"assistant: between-tools",
			'[task: {"agent":"ExploreCompletion","prompt":"I...]',
			"assistant: final-answer",
		]);
		expect(rendered.document.getElementById("tree-status")?.textContent).toBe("5 / 5 rows");

		const rows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		const expectedTargets = [
			"entry-assistant-1-block-0",
			"entry-assistant-1-block-1",
			"entry-assistant-1-block-2",
			"entry-assistant-1-block-3",
			"entry-assistant-1-block-6",
		];
		rows[2]!.click();
		expect(
			Array.from(rendered.document.querySelectorAll("#tree-container .tree-node")).map(row =>
				row.classList.contains("in-path"),
			),
		).toEqual([true, true, true, false, false]);
		for (let i = 0; i < rows.length; i++) {
			const currentRows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
			currentRows[i]!.click();
			expect(rendered.lastScrolledId()).toBe(expectedTargets[i]);
		}
	});

	test("collapses projected sidebar assistant text the same way as other tree rows", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "first\nline" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "one.ts" } },
				{ type: "text", text: "after" },
			],
			"stop",
			true,
		);

		expect(renderedSidebarOrder(rendered)[0]).toBe("assistant: first line");
	});

	test("clicking a pi-style tool result row locates its assistant tool card", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "one.ts" } },
			],
			"stop",
			true,
		);

		const rows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		expect(rows).toHaveLength(2);
		rows[1]!.click();
		expect(rendered.lastScrolledId()).toBe("entry-assistant-1-block-1");
		expect(
			rendered.document.getElementById("entry-assistant-1-block-1")?.classList.contains("highlight"),
		).toBeFalse();
	});

	test("keeps a pending tool call in the projected sidebar without a tool result", () => {
		const rendered = renderAssistant([
			{ type: "text", text: "before-tool" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "pending.ts" } },
			{ type: "text", text: "after-tool" },
		]);

		expect(renderedSidebarOrder(rendered)).toEqual([
			"assistant: before-tool",
			"[read: pending.ts]",
			"assistant: after-tool",
		]);
		expect(rendered.document.getElementById("tree-status")?.textContent).toBe("3 / 3 rows");

		const rows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		rows[1]!.click();
		expect(rendered.lastScrolledId()).toBe("entry-assistant-1-block-1");
	});

	test("hides projected tool calls when the No-tools filter is active", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "hidden.ts" } },
				{ type: "text", text: "after-tool" },
			],
			"stop",
			true,
		);

		const noToolsButton = rendered.document.querySelector('.filter-btn[data-filter="no-tools"]');
		if (!noToolsButton) throw new Error("Export template is missing the No-tools filter");
		noToolsButton.click();

		expect(renderedSidebarOrder(rendered)).toEqual(["assistant: before-tool", "assistant: after-tool"]);
		expect(rendered.document.getElementById("tree-status")?.textContent).toBe("2 / 3 rows");
	});

	test("uses projected timeline order when tool result ancestry is reversed", () => {
		const rendered = renderAssistant(
			[
				{ type: "text", text: "before-read" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "one.ts" } },
				{ type: "text", text: "after-read" },
				{ type: "toolCall", id: "tool-2", name: "custom_tool", arguments: { op: "jobs" } },
				{ type: "text", text: "after-custom" },
			],
			"stop",
			true,
			true,
		);

		const rows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		rows[1]!.click();
		expect(renderedSidebarOrder(rendered)).toEqual([
			"assistant: before-read",
			"[read: one.ts]",
			"assistant: after-read",
			'[custom_tool: {"op":"jobs"}]',
			"assistant: after-custom",
		]);
		expect(
			Array.from(rendered.document.querySelectorAll("#tree-container .tree-node")).map(row =>
				row.classList.contains("in-path"),
			),
		).toEqual([true, true, false, false, false]);
	});

	test("rebuilds cached sidebar rows when navigation reprioritizes a sibling branch", () => {
		const rendered = renderSession(
			[
				{
					type: "message",
					id: "root",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "root" }],
						stopReason: "stop",
						timestamp: 1,
					},
				},
				{
					type: "message",
					id: "branch-a",
					parentId: "root",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: { role: "user", content: "branch-a", timestamp: 2 },
				},
				{
					type: "message",
					id: "branch-b",
					parentId: "root",
					timestamp: "2026-01-01T00:00:03.000Z",
					message: { role: "user", content: "branch-b", timestamp: 3 },
				},
			],
			"branch-a",
		);

		expect(renderedSidebarOrder(rendered)).toEqual(["assistant: root", "user: branch-a", "user: branch-b"]);
		const initialRows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		initialRows[2]!.click();

		expect(renderedSidebarOrder(rendered)).toEqual(["assistant: root", "user: branch-b", "user: branch-a"]);
		const updatedRows = Array.from(rendered.document.querySelectorAll("#tree-container .tree-node"));
		expect(updatedRows.map(row => row.classList.contains("in-path"))).toEqual([true, true, false]);
	});
});

function answerEntry(
	id: string,
	parentId: string | null,
	supersedesEntryId?: unknown,
	message: Record<string, unknown> = {},
) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: id }],
			stopReason: "stop",
			timestamp: 1,
			supersedesEntryId,
			...message,
		},
	};
}

function collapsedAnswerIds(document: Document): string[] {
	return Array.from(document.querySelectorAll("details.superseded-answer > .assistant-message")).map(node =>
		node.id.replace(/^entry-/, ""),
	);
}

describe("HTML export answer supersession", () => {
	const draft = answerEntry("draft", null);
	const replacement = answerEntry("replacement", "draft", "draft");
	const fixtures: { name: string; entries: unknown[]; expected: string[] }[] = [
		{ name: "same-run answers with duplicate timestamps", entries: [draft, replacement], expected: ["draft"] },
		{
			name: "thinking, redacted thinking and images accompany terminal text",
			entries: [
				answerEntry("draft", null, undefined, {
					content: [
						{ type: "text", text: "draft" },
						{ type: "thinking", thinking: "reasoning" },
						{ type: "redactedThinking", data: "opaque" },
						{ type: "image", mimeType: "image/png", data: "aa" },
					],
				}),
				answerEntry("replacement", "draft", "draft", {
					content: [
						{ type: "thinking", thinking: "review" },
						{ type: "text", text: "replacement" },
					],
				}),
			],
			expected: ["draft"],
		},
		{ name: "unknown target", entries: [draft, answerEntry("replacement", "draft", "missing")], expected: [] },
		{ name: "non-string target", entries: [draft, answerEntry("replacement", "draft", 1)], expected: [] },
		{ name: "self reference", entries: [draft, answerEntry("replacement", "draft", "replacement")], expected: [] },
		{
			name: "forward reference",
			entries: [answerEntry("replacement", null, "draft"), answerEntry("draft", "replacement")],
			expected: [],
		},
		{
			name: "pruned target",
			entries: [answerEntry("replacement", "pruned-draft", "pruned-draft")],
			expected: [],
		},
		{
			name: "replacement chains retain both superseded targets",
			entries: [draft, replacement, answerEntry("last", "replacement", "replacement")],
			expected: ["draft", "replacement"],
		},
		{
			name: "real user input starts another run",
			entries: [
				draft,
				{
					type: "message",
					id: "request",
					parentId: "draft",
					timestamp: draft.timestamp,
					message: { role: "user", content: "new request", timestamp: 1 },
				},
				answerEntry("replacement", "request", "draft"),
			],
			expected: [],
		},
	];
	for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
		fixtures.push(
			{
				name: `${stopReason} replacement`,
				entries: [draft, answerEntry("replacement", "draft", "draft", { stopReason })],
				expected: [],
			},
			{
				name: `${stopReason} target`,
				entries: [answerEntry("draft", null, undefined, { stopReason }), replacement],
				expected: [],
			},
		);
	}
	for (const [name, content] of [
		["empty", []],
		["whitespace", [{ type: "text", text: " \n\t " }]],
		["reasoning-only", [{ type: "thinking", thinking: "reasoning" }]],
		["image-only", [{ type: "image", mimeType: "image/png", data: "aa" }]],
		[
			"tool-calling",
			[
				{ type: "text", text: "text" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.ts" } },
			],
		],
	] as const) {
		fixtures.push(
			{
				name: `${name} replacement`,
				entries: [draft, answerEntry("replacement", "draft", "draft", { content })],
				expected: [],
			},
			{
				name: `${name} target`,
				entries: [answerEntry("draft", null, undefined, { content }), replacement],
				expected: [],
			},
		);
	}
	for (const customType of ["skill-prompt", "collab-prompt", "advisor"]) {
		for (const attribution of ["user", "agent"]) {
			for (const type of ["message", "custom_message"]) {
				fixtures.push({
					name: `${type} ${attribution} ${customType} request boundary`,
					entries: [
						draft,
						{
							type,
							id: "request",
							parentId: "draft",
							timestamp: draft.timestamp,
							...(type === "message"
								? { message: { role: "custom", customType, attribution, content: "request" } }
								: { customType, attribution, content: "request", display: false }),
						},
						answerEntry("replacement", "request", "draft"),
					],
					expected: attribution === "user" && customType !== "advisor" ? [] : ["draft"],
				});
			}
		}
	}
	fixtures.push({
		name: "malformed custom-message content is not a request boundary",
		entries: [
			draft,
			{
				type: "custom_message",
				id: "request",
				parentId: "draft",
				timestamp: draft.timestamp,
				customType: "skill-prompt",
				attribution: "user",
				content: null,
				display: false,
			},
			answerEntry("replacement", "request", "draft"),
		],
		expected: ["draft"],
	});

	test.each(fixtures)("$name matches the shared transcript resolver", ({ entries, expected }) => {
		const leaf = entries.at(-1) as { id: string };
		const rendered = renderSession(entries, leaf.id);
		expect([...supersededAnswerEntryIds(entries as TranscriptEntryLike[])]).toEqual(expected);
		expect(collapsedAnswerIds(rendered.document)).toEqual(expected);
		for (const disclosure of Array.from(rendered.document.querySelectorAll("details.superseded-answer"))) {
			expect(disclosure.hasAttribute("open")).toBeFalse();
			expect(disclosure.querySelector("summary")?.textContent).toBe(
				"Earlier answer superseded after advisor review",
			);
		}
	});

	test("recomputes each branch without leaking cached disclosures or finding sibling targets", () => {
		const rendered = renderSession(
			[draft, replacement, answerEntry("sibling", "draft"), answerEntry("other-root", null, "draft")],
			"replacement",
		);
		const select = (id: string) => {
			const row = rendered.document.querySelector(`#tree-container .tree-node[data-id="${id}"]`);
			if (!row) throw new Error(`Missing tree entry ${id}`);
			row.click();
		};
		expect(collapsedAnswerIds(rendered.document)).toEqual(["draft"]);
		for (const id of ["sibling", "draft", "other-root", "replacement", "sibling", "replacement"]) {
			select(id);
			expect(collapsedAnswerIds(rendered.document)).toEqual(id === "replacement" ? ["draft"] : []);
			expect(rendered.document.querySelector("details details")).toBeNull();
		}
	});

	test("deep links open the original before scrolling without losing its blocks or copy link", () => {
		const rendered = renderSession(
			[
				answerEntry("draft", null, undefined, {
					content: [
						{ type: "text", text: "`<unsafe>` draft" },
						{ type: "thinking", thinking: "original reasoning" },
						{ type: "image", mimeType: "image/png", data: "aa" },
					],
				}),
				replacement,
			],
			"replacement",
			{ search: "?leafId=replacement&targetId=draft" },
		);
		const original = rendered.document.getElementById("entry-draft");
		expect(original?.closest("details")?.hasAttribute("open")).toBeTrue();
		expect(rendered.lastScrolledId()).toBe("entry-draft");
		expect(original?.classList.contains("highlight")).toBeTrue();
		expect(original?.querySelector(".assistant-text")?.textContent).toContain("<unsafe> draft");
		expect(original?.querySelector("unsafe")).toBeNull();
		expect(original?.querySelector(".thinking-text")?.textContent).toBe("original reasoning");
		expect(original?.querySelector(".message-image")?.getAttribute("src")).toBe("data:image/png;base64,aa");
		expect(original?.querySelector(".copy-link-btn")?.getAttribute("data-entry-id")).toBe("draft");
	});

	test("includes every billed answer in the header totals", () => {
		const rendered = renderSession(
			[
				answerEntry("draft", null, undefined, {
					usage: { input: 10, output: 20, cost: { input: 0.1, output: 0.2 } },
				}),
				answerEntry("replacement", "draft", "draft", {
					usage: { input: 30, output: 40, cost: { input: 0.3, output: 0.4 } },
				}),
			],
			"replacement",
		);
		const header = rendered.document.getElementById("header-container")?.textContent;
		expect(header).toContain("2 assistant");
		expect(header).toContain("↑40 ↓60");
		expect(header).toContain("$1.000");
		expect(rendered.document.querySelectorAll(".assistant-message")).toHaveLength(2);
	});

	test("resolves each embedded sub-session path without borrowing main or sibling targets", () => {
		const rendered = renderSession(
			[
				answerEntry("task", null, undefined, {
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "task-call", name: "task", arguments: {} }],
				}),
			],
			"task",
			{
				subSessions: {
					Reviewed: {
						entries: [draft, replacement, answerEntry("sibling", "draft", "replacement")],
						leafId: "replacement",
					},
					Sibling: { entries: [draft, replacement, answerEntry("sibling", "draft")], leafId: "sibling" },
					Unrelated: { entries: [answerEntry("replacement", null, "draft")], leafId: "replacement" },
				},
			},
		);
		const tool = rendered.document.querySelector("omp-tool-view");
		const key = tool?.getAttribute("data-key");
		if (!key) throw new Error("Missing task tool payload");
		for (const agent of ["Reviewed", "Sibling", "Unrelated", "Reviewed"]) {
			vm.runInContext(
				`globalThis.__OMP_TOOL_VIEW_DATA.get(${JSON.stringify(key)}).host.openAgent(${JSON.stringify(agent)})`,
				rendered.context,
			);
			const overlay = rendered.document.querySelector(".subsession-body");
			expect(overlay?.querySelectorAll("details.superseded-answer")).toHaveLength(agent === "Reviewed" ? 1 : 0);
			if (agent === "Reviewed") {
				expect(overlay?.querySelector("details > .assistant-message")?.id).toBe("sub-Reviewed-entry-draft");
				expect(overlay?.querySelector("details")?.hasAttribute("open")).toBeFalse();
			}
		}
	});
});
