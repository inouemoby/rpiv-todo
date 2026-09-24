import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { applyTaskMutation } from "./state-reducer.js";

const emptyState = (): TaskState => ({ tasks: [], nextId: 1 });

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks: [...tasks],
	nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
});

const task = (overrides: Partial<Task> & { id: number; subject: string }): Task => ({
	status: "pending",
	...overrides,
});

describe("applyTaskMutation — create", () => {
	it("rejects empty subject", () => {
		const result = applyTaskMutation(emptyState(), "create", { subject: "" });
		expect(result.op).toEqual({ kind: "error", message: "subject required for create" });
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("rejects dangling blockedBy", () => {
		const result = applyTaskMutation(emptyState(), "create", { subject: "x", blockedBy: [99] });
		expect(result.op).toEqual({ kind: "error", message: "blockedBy: #99 not found" });
		expect(result.state.nextId).toBe(1);
	});

	it("rejects deleted blockedBy", () => {
		const state = stateWith(task({ id: 1, subject: "done", status: "deleted" }));
		const result = applyTaskMutation(state, "create", { subject: "new", blockedBy: [1] });
		expect(result.op).toEqual({ kind: "error", message: "blockedBy: #1 is deleted" });
	});

	it("rejects failed blockedBy", () => {
		const state = stateWith(task({ id: 1, subject: "broken", status: "failed" }));
		const result = applyTaskMutation(state, "create", { subject: "new", blockedBy: [1] });
		expect(result.op).toEqual({ kind: "error", message: "blockedBy: #1 is failed" });
	});

	it("creates with next id and preserves immutability", () => {
		const state = emptyState();
		const result = applyTaskMutation(state, "create", { subject: "write tests" });
		expect(result.state.tasks).toHaveLength(1);
		expect(result.state.tasks[0]).toMatchObject({ id: 1, subject: "write tests", status: "pending" });
		expect(result.state.nextId).toBe(2);
		expect(result.state.tasks).not.toBe(state.tasks);
		expect(result.op).toEqual({ kind: "create", taskId: 1 });
	});
});

describe("applyTaskMutation — update", () => {
	it("rejects id-only update", () => {
		const state = stateWith(task({ id: 1, subject: "x" }));
		const result = applyTaskMutation(state, "update", { id: 1 });
		expect(result.op).toEqual({
			kind: "error",
			message:
				"update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
		});
	});

	it("rejects illegal transition completed → in_progress", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "in_progress" });
		expect(result.op).toEqual({
			kind: "error",
			message: "illegal transition completed → in_progress",
		});
	});

	it("allows completed → deleted transition", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "deleted" });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "completed", toStatus: "deleted", changed: true });
		expect(result.state.tasks[0].status).toBe("deleted");
	});

	it("fails a task and all transitive dependents, but not independent or deleted tasks", () => {
		const state = stateWith(
			task({ id: 1, subject: "root", status: "in_progress" }),
			task({ id: 2, subject: "child", blockedBy: [1] }),
			task({ id: 3, subject: "grandchild", blockedBy: [2] }),
			task({ id: 4, subject: "shared descendant", blockedBy: [1, 2] }),
			task({ id: 5, subject: "independent" }),
			task({ id: 6, subject: "deleted intermediary", status: "deleted", blockedBy: [1] }),
			task({ id: 7, subject: "dependent of deleted intermediary", blockedBy: [6] }),
		);
		const result = applyTaskMutation(state, "update", { id: 1, status: "failed" });

		expect(result.state.tasks.map((t) => t.status)).toEqual([
			"failed",
			"failed",
			"failed",
			"failed",
			"pending",
			"deleted",
			"failed",
		]);
		expect(result.op).toMatchObject({
			kind: "update",
			id: 1,
			fromStatus: "in_progress",
			toStatus: "failed",
			changed: true,
			failedDependentIds: [2, 4, 3, 7],
		});
		expect(state.tasks[0]?.status).toBe("in_progress");
	});

	it("fails only the dependent chain and leaves unrelated tasks unchanged", () => {
		const state = stateWith(
			task({ id: 1, subject: "root", status: "in_progress" }),
			task({ id: 2, subject: "unrelated" }),
			task({ id: 3, subject: "downstream", blockedBy: [1] }),
			task({ id: 4, subject: "transitive downstream", blockedBy: [3] }),
		);
		const result = applyTaskMutation(state, "update", { id: 1, status: "failed" });
		expect(result.state.tasks.map((task) => task.status)).toEqual(["failed", "pending", "failed", "failed"]);
	});

	it("does not allow a failed task to recover", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "failed" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "pending" });
		expect(result.op).toEqual({ kind: "error", message: "illegal transition failed → pending" });
	});

	it("rejects starting or completing a task before its prerequisites", () => {
		const state = stateWith(
			task({ id: 1, subject: "prerequisite" }),
			task({ id: 2, subject: "dependent", blockedBy: [1] }),
		);
		for (const status of ["in_progress", "completed"] as const) {
			const result = applyTaskMutation(state, "update", { id: 2, status });
			expect(result.op).toEqual({
				kind: "error",
				message: "#2 is blocked by unfinished task(s): #1 (pending)",
			});
		}
		const prerequisiteCompleted = applyTaskMutation(state, "update", { id: 1, status: "completed" }).state;
		const result = applyTaskMutation(prerequisiteCompleted, "update", { id: 2, status: "in_progress" });
		expect(result.op).toMatchObject({ kind: "update", id: 2, toStatus: "in_progress", changed: true });
	});

	it("rejects adding an unfinished prerequisite to an active task", () => {
		const state = stateWith(
			task({ id: 1, subject: "active", status: "in_progress" }),
			task({ id: 2, subject: "unfinished prerequisite" }),
		);
		const result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [2] });
		expect(result.op).toEqual({
			kind: "error",
			message: "#1 is blocked by unfinished task(s): #2 (pending)",
		});
	});

	it("flags a no-effect status update (status set to its current value) as changed:false", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "pending" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "pending" });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending", changed: false });
	});

	it("flags a re-sent identical field as changed:false", () => {
		const state = stateWith(task({ id: 1, subject: "x", description: "d" }));
		const result = applyTaskMutation(state, "update", { id: 1, subject: "x", description: "d" });
		expect(result.op).toMatchObject({ kind: "update", changed: false });
	});

	it("flags a blockedBy-only update as changed:true even when status is unchanged", () => {
		const state = stateWith(task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" }));
		const result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [2] });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending", changed: true });
	});

	it("flags a subject-only update on a task with existing deps as changed:true (blockedBy unchanged)", () => {
		// Equal-length blockedBy on both sides — the changed signal comes from subject,
		// not the dependency list, which round-trips identically.
		const state = stateWith(task({ id: 1, subject: "old", blockedBy: [2] }), task({ id: 2, subject: "dep" }));
		const result = applyTaskMutation(state, "update", { id: 1, subject: "new" });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending", changed: true });
		expect(result.state.tasks[0].blockedBy).toEqual([2]);
	});

	it("flags swapping one dependency for another (same length) as changed:true", () => {
		const state = stateWith(
			task({ id: 1, subject: "a", blockedBy: [2] }),
			task({ id: 2, subject: "b" }),
			task({ id: 3, subject: "c" }),
		);
		const result = applyTaskMutation(state, "update", { id: 1, removeBlockedBy: [2], addBlockedBy: [3] });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending", changed: true });
		expect(result.state.tasks[0].blockedBy).toEqual([3]);
	});

	it("rejects self-block via addBlockedBy", () => {
		const state = stateWith(task({ id: 1, subject: "x" }));
		const result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [1] });
		expect(result.op).toEqual({ kind: "error", message: "cannot block #1 on itself" });
	});

	it("rejects adding a failed task as a prerequisite", () => {
		const state = stateWith(
			task({ id: 1, subject: "failed prerequisite", status: "failed" }),
			task({ id: 2, subject: "dependent" }),
		);
		const result = applyTaskMutation(state, "update", { id: 2, addBlockedBy: [1] });
		expect(result.op).toEqual({ kind: "error", message: "addBlockedBy: #1 is failed" });
	});

	it("rejects cycle in blockedBy graph", () => {
		const state = stateWith(task({ id: 1, subject: "a", blockedBy: [2] }), task({ id: 2, subject: "b" }));
		const result = applyTaskMutation(state, "update", { id: 2, addBlockedBy: [1] });
		expect(result.op).toEqual({
			kind: "error",
			message: "addBlockedBy would create a cycle in the blockedBy graph",
		});
	});

	it("drops blockedBy field when merged set becomes empty", () => {
		const state = stateWith(task({ id: 1, subject: "a", blockedBy: [2] }), task({ id: 2, subject: "b" }));
		const result = applyTaskMutation(state, "update", { id: 1, removeBlockedBy: [2] });
		const updated = result.state.tasks[0];
		expect("blockedBy" in updated).toBe(false);
	});

	it("drops metadata key when value is null", () => {
		const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
		const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
		expect(result.state.tasks[0].metadata).toEqual({ b: 2 });
	});

	it("sets and overwrites metadata keys when value is non-null", () => {
		// Covers the merged[k] = v branch (non-null partial merge): a is overwritten,
		// b is preserved, c is added.
		const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
		const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: 99, c: 3 } });
		expect(result.state.tasks[0].metadata).toEqual({ a: 99, b: 2, c: 3 });
	});

	it("collapses metadata to undefined when every key is deleted", () => {
		// Covers the Object.keys(merged).length ? merged : undefined branch where
		// every existing key gets nulled out.
		const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1 } }));
		const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
		expect("metadata" in result.state.tasks[0]).toBe(false);
	});
});

describe("applyTaskMutation — list/get/delete/clear", () => {
	it("list emits Op with includeDeleted flag and optional statusFilter", () => {
		const state = stateWith(
			task({ id: 1, subject: "a", status: "pending" }),
			task({ id: 2, subject: "b", status: "deleted" }),
		);
		const result = applyTaskMutation(state, "list", { includeDeleted: true, status: "deleted" });
		expect(result.op).toEqual({ kind: "list", includeDeleted: true, statusFilter: "deleted" });
		expect(result.state).toBe(state);
	});

	it("delete on already-deleted task errors", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "deleted" }));
		const result = applyTaskMutation(state, "delete", { id: 1 });
		expect(result.op).toEqual({ kind: "error", message: "#1 is already deleted" });
	});

	it("delete emits Op with id + subject", () => {
		const state = stateWith(task({ id: 1, subject: "x" }));
		const result = applyTaskMutation(state, "delete", { id: 1 });
		expect(result.op).toEqual({ kind: "delete", id: 1, subject: "x" });
		expect(result.state.tasks[0].status).toBe("deleted");
	});

	it("clear emits Op with prior count and resets nextId to 1", () => {
		const state = stateWith(task({ id: 5, subject: "x" }));
		const result = applyTaskMutation(state, "clear", {});
		expect(result.op).toEqual({ kind: "clear", count: 1 });
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("get emits Op with the resolved task", () => {
		const state = stateWith(task({ id: 1, subject: "alpha" }));
		const result = applyTaskMutation(state, "get", { id: 1 });
		expect(result.op).toEqual({ kind: "get", task: state.tasks[0] });
	});
});

describe("isTransitionValid", () => {
	it("is idempotent on same→same", () => {
		expect(isTransitionValid("completed", "completed")).toBe(true);
	});

	it("rejects completed → in_progress", () => {
		expect(isTransitionValid("completed", "in_progress")).toBe(false);
	});

	it("allows completed → deleted", () => {
		expect(isTransitionValid("completed", "deleted")).toBe(true);
	});

	it("allows tasks to become failed and makes failed terminal", () => {
		expect(isTransitionValid("pending", "failed")).toBe(true);
		expect(isTransitionValid("in_progress", "failed")).toBe(true);
		expect(isTransitionValid("completed", "failed")).toBe(true);
		expect(isTransitionValid("failed", "failed")).toBe(true);
		expect(isTransitionValid("failed", "pending")).toBe(false);
	});
});
