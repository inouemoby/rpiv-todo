import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTodo from "./index.js";
import { __resetState } from "./todo.js";

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const handler = captured.events.get("agent_before_settle")?.[0];
	const tool = captured.tools.get("todo");
	if (!handler) throw new Error("agent_before_settle handler not registered");
	if (!tool) throw new Error("todo tool not registered");
	return { pi, handler, tool };
}

function makeCtx(pendingMessages = false) {
	const ctx = createMockCtx({ sessionId: "retry-session" });
	Object.assign(ctx, { hasPendingMessages: vi.fn(() => pendingMessages) });
	return ctx;
}

async function callTodo(tool: ReturnType<typeof setup>["tool"], ctx: ReturnType<typeof makeCtx>, params: object) {
	await tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
}

async function createTask(tool: ReturnType<typeof setup>["tool"], ctx: ReturnType<typeof makeCtx>, subject: string) {
	await callTodo(tool, ctx, { action: "create", subject });
}

async function runBeforeSettle(
	handler: ReturnType<typeof setup>["handler"],
	ctx: ReturnType<typeof makeCtx>,
	options: {
		outcome?: "completed" | "aborted" | "error";
		continue?: boolean;
		pendingMessages?: unknown[];
		entries?: unknown[];
	} = {},
) {
	return handler(
		{
			type: "agent_before_settle",
			outcome: options.outcome ?? "completed",
			continue: options.continue ?? false,
			entries: options.entries ?? [],
			context: {
				contextEntries: [],
				contextMessages: [],
				llmMessages: [],
				pendingMessages: options.pendingMessages ?? [],
				canContinue: false,
			},
		} as never,
		ctx as never,
	);
}

beforeEach(() => __resetState());
afterEach(() => {
	__resetState();
	vi.restoreAllMocks();
});

describe("in-progress todo low-priority continuation", () => {
	it("commits one reminder at the boundary when an in-progress task remains", async () => {
		const { pi, handler, tool } = setup();
		const ctx = makeCtx();
		await createTask(tool, ctx, "pending task");
		await callTodo(tool, ctx, {
			action: "create",
			subject: "active task",
			description: "resume the parser",
			activeForm: "writing parser tests",
		});
		await callTodo(tool, ctx, { action: "update", id: 2, status: "in_progress" });
		await createTask(tool, ctx, "completed task");
		await callTodo(tool, ctx, { action: "update", id: 3, status: "completed" });
		await createTask(tool, ctx, "deleted task");
		await callTodo(tool, ctx, { action: "update", id: 4, status: "deleted" });
		await createTask(tool, ctx, "failed task");
		await callTodo(tool, ctx, { action: "update", id: 5, status: "failed" });

		const result = await runBeforeSettle(handler, ctx) as
			| { entries: unknown[]; continue: true }
			| undefined;

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(result?.continue).toBe(true);
		const reminder = result?.entries.at(-1) as { type: string; customType: string; content: string; display: boolean };
		expect(reminder.type).toBe("custom_message");
		expect(reminder.customType).toBe("rpiv-todo:in-progress-reminder");
		expect(reminder.display).toBe(false);
		expect(reminder.content).toContain('"subject":"active task"');
		expect(reminder.content).toContain('"description":"resume the parser"');
		expect(reminder.content).toContain('"activeForm":"writing parser tests"');
		expect(reminder.content).not.toContain("pending task");
		expect(reminder.content).not.toContain("completed task");
		expect(reminder.content).not.toContain("deleted task");
		expect(reminder.content).not.toContain("failed task");
	});

	it("does not retry for pending, completed, deleted, or failed tasks alone", async () => {
		const { pi, handler, tool } = setup();
		const ctx = makeCtx();
		await createTask(tool, ctx, "pending task");
		await createTask(tool, ctx, "completed task");
		await callTodo(tool, ctx, { action: "update", id: 2, status: "completed" });
		await createTask(tool, ctx, "deleted task");
		await callTodo(tool, ctx, { action: "update", id: 3, status: "deleted" });
		await createTask(tool, ctx, "failed task");
		await callTodo(tool, ctx, { action: "update", id: 4, status: "failed" });

		expect(await runBeforeSettle(handler, ctx)).toBeUndefined();

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("yields when another plugin or the user already has a message queued", async () => {
		const { pi, handler, tool } = setup();
		const ctx = makeCtx(true);
		await createTask(tool, ctx, "active task");
		await callTodo(tool, ctx, { action: "update", id: 1, status: "in_progress" });

		expect(await runBeforeSettle(handler, ctx)).toBeUndefined();
		expect(await runBeforeSettle(handler, makeCtx(false), {
			pendingMessages: [{ role: "user", content: "another plugin's follow-up" }],
		})).toBeUndefined();

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not add a stale reminder after another queued follow-up completes the task", async () => {
		const { pi, handler, tool } = setup();
		const pendingCtx = makeCtx(true);
		await createTask(tool, pendingCtx, "active task");
		await callTodo(tool, pendingCtx, { action: "update", id: 1, status: "in_progress" });

		expect(await runBeforeSettle(handler, pendingCtx)).toBeUndefined();
		await callTodo(tool, pendingCtx, { action: "update", id: 1, status: "completed" });
		expect(await runBeforeSettle(handler, makeCtx(false))).toBeUndefined();

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("yields to another boundary continuation and does not override aborts or errors", async () => {
		const { pi, handler, tool } = setup();
		const ctx = makeCtx();
		await createTask(tool, ctx, "active task");
		await callTodo(tool, ctx, { action: "update", id: 1, status: "in_progress" });

		expect(await runBeforeSettle(handler, ctx, { continue: true })).toBeUndefined();
		expect(await runBeforeSettle(handler, ctx, { outcome: "aborted" })).toBeUndefined();
		expect(await runBeforeSettle(handler, ctx, { outcome: "error" })).toBeUndefined();

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});
