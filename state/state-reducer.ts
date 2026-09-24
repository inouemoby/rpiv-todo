import { MAX_BATCH_SIZE, type NewTaskInput, type Task, type TaskAction, type TaskMutationParams, type TaskStatus } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { deriveBlocks, detectCycle } from "./task-graph.js";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch (compiler-
 * enforced exhaustive). Mirrors the `Effect` pattern in
 * `packages/rpiv-ask-user-question/state/state-reducer.ts:14-30`.
 *
 * `error` carries the message in-band so callers can pattern-match on
 * `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
	| { kind: "create"; taskId: number }
	| { kind: "create_batch"; taskIds: number[] }
	| {
			kind: "update";
			id: number;
			fromStatus: TaskStatus;
			toStatus: TaskStatus;
			changed: boolean;
			failedDependentIds?: number[];
	  }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "delete_batch"; deletedTasks: Array<{ id: number; subject: string }>; all?: boolean }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "get_batch"; tasks: Task[] }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function makeNewTask(input: NewTaskInput, id: number): Task {
	const task: Task = { id, subject: input.subject, status: "pending" };
	if (input.description) task.description = input.description;
	if (input.activeForm) task.activeForm = input.activeForm;
	if (input.blockedBy?.length) task.blockedBy = [...input.blockedBy];
	if (input.owner) task.owner = input.owner;
	if (input.metadata) task.metadata = { ...input.metadata };
	return task;
}

function createTaskBatch(state: TaskState, inputs: NewTaskInput[]): ApplyResult {
	if (inputs.length === 0) return errorResult(state, "tasks must contain at least one item for batch create");
	if (inputs.length > MAX_BATCH_SIZE) return errorResult(state, `create supports at most ${MAX_BATCH_SIZE} tasks per batch`);

	const tasks = [...state.tasks];
	const taskIds: number[] = [];
	for (let index = 0; index < inputs.length; index++) {
		const input = inputs[index];
		if (!input || typeof input.subject !== "string" || !input.subject.trim()) {
			return errorResult(state, `tasks[${index}].subject required for batch create`);
		}
		const id = state.nextId + index;
		for (const dep of input.blockedBy ?? []) {
			if (dep === id) return errorResult(state, `cannot block #${id} on itself`);
			const depTask = tasks.find((task) => task.id === dep);
			if (!depTask) return errorResult(state, `tasks[${index}].blockedBy: #${dep} not found`);
			if (depTask.status === "deleted") return errorResult(state, `tasks[${index}].blockedBy: #${dep} is deleted`);
			if (depTask.status === "failed") return errorResult(state, `tasks[${index}].blockedBy: #${dep} is failed`);
		}
		const created = makeNewTask(input, id);
		tasks.push(created);
		taskIds.push(id);
	}
	return { state: { tasks, nextId: state.nextId + inputs.length }, op: { kind: "create_batch", taskIds } };
}

function deleteTaskBatch(state: TaskState, ids: number[]): ApplyResult {
	if (ids.length === 0) return errorResult(state, "id array must contain at least one id for batch delete");
	if (ids.length > MAX_BATCH_SIZE) return errorResult(state, `delete supports at most ${MAX_BATCH_SIZE} ids per batch`);
	const seen = new Set<number>();
	const selected: Task[] = [];
	for (const id of ids) {
		if (seen.has(id)) return errorResult(state, `duplicate id #${id} in batch delete`);
		seen.add(id);
		const task = state.tasks.find((candidate) => candidate.id === id);
		if (!task) return errorResult(state, `#${id} not found`);
		if (task.status === "deleted") return errorResult(state, `#${id} is already deleted`);
		selected.push(task);
	}
	const deletedIds = new Set(ids);
	return {
		state: {
			tasks: state.tasks.map((task) => deletedIds.has(task.id) ? { ...task, status: "deleted" } : task),
			nextId: state.nextId,
		},
		op: { kind: "delete_batch", deletedTasks: selected.map(({ id, subject }) => ({ id, subject })) },
	};
}

function getTaskBatch(state: TaskState, ids: number[]): ApplyResult {
	if (ids.length === 0) return errorResult(state, "id array must contain at least one id for batch get");
	if (ids.length > MAX_BATCH_SIZE) return errorResult(state, `get supports at most ${MAX_BATCH_SIZE} ids per batch`);
	const seen = new Set<number>();
	const selected: Task[] = [];
	for (const id of ids) {
		if (seen.has(id)) return errorResult(state, `duplicate id #${id} in batch get`);
		seen.add(id);
		const task = state.tasks.find((candidate) => candidate.id === id);
		if (!task) return errorResult(state, `#${id} not found`);
		selected.push(task);
	}
	return { state, op: { kind: "get_batch", tasks: selected } };
}

function sameNumberList(a: number[] | undefined, b: number[] | undefined): boolean {
	const x = a ?? [];
	const y = b ?? [];
	return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameRecord(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function failDependents(tasks: readonly Task[], taskId: number): { tasks: Task[]; failedIds: number[] } {
	const blocks = deriveBlocks(tasks);
	const indexes = new Map(tasks.map((task, index) => [task.id, index]));
	const nextTasks = [...tasks];
	const queue = [taskId];
	const visited = new Set<number>();
	const failedIds: number[] = [];

	while (queue.length > 0) {
		const currentId = queue.shift()!;
		if (visited.has(currentId)) continue;
		visited.add(currentId);

		for (const dependentId of blocks.get(currentId) ?? []) {
			const index = indexes.get(dependentId);
			if (index === undefined) continue;
			const dependent = nextTasks[index];
			if (!dependent) continue;

			if (dependent.status !== "deleted" && dependent.status !== "failed") {
				nextTasks[index] = { ...dependent, status: "failed" };
				failedIds.push(dependentId);
			}
			queue.push(dependentId);
		}
	}

	return { tasks: nextTasks, failedIds };
}

/**
 * Did this `update` change anything? Compares the task before/after the params
 * are applied. A no-effect update — `status` set to its current value, or any
 * field re-sent unchanged — returns false, letting the response envelope say
 * "No change" instead of "Updated #N". Without this, a no-op update is
 * indistinguishable from a real mutation, which can drive a model to re-issue
 * the same call in a loop.
 *
 * blockedBy is order-sensitive (the reducer preserves insertion order);
 * metadata round-trips through JSON persistence, so JSON-equality is the
 * operative notion of "changed".
 */
function taskChanged(before: Task, after: Task): boolean {
	return (
		before.subject !== after.subject ||
		before.status !== after.status ||
		before.description !== after.description ||
		before.activeForm !== after.activeForm ||
		before.owner !== after.owner ||
		!sameNumberList(before.blockedBy, after.blockedBy) ||
		!sameRecord(before.metadata, after.metadata)
	);
}

/**
 * Pure reducer: (state, action, params) → (state, op). The response envelope (`tool/response-envelope.ts`) owns
 * formatting, the store (`state/store.ts`) owns commit.
 *
 * Validation is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition legality,
 * dangling/deleted blockedBy, self-block, cycles). Decision: validation stays
 * in-reducer.
 */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			if (params.tasks !== undefined) {
				if (
					params.subject !== undefined ||
					params.description !== undefined ||
					params.activeForm !== undefined ||
					params.blockedBy !== undefined ||
					params.owner !== undefined ||
					params.metadata !== undefined
				) {
					return errorResult(state, "create accepts either one task or tasks[], not both");
				}
				if (!Array.isArray(params.tasks)) return errorResult(state, "tasks must be an array for batch create");
				return createTaskBatch(state, params.tasks);
			}
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
					if (depTask.status === "failed") return errorResult(state, `blockedBy: #${dep} is failed`);
				}
			}
			const newTask = makeNewTask({
				subject: params.subject,
				description: params.description,
				activeForm: params.activeForm,
				blockedBy: params.blockedBy,
				owner: params.owner,
				metadata: params.metadata,
			}, state.nextId);
			return {
				state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}


		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			if (typeof params.id !== "number") return errorResult(state, "update requires one numeric id");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation)
				return errorResult(
					state,
					"update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy",
				);

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (depTask.status === "failed") return errorResult(state, `addBlockedBy: #${dep} is failed`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			const dependenciesChanged = !sameNumberList(current.blockedBy, newBlockedBy);
			const effectiveStatus = params.status ?? current.status;
			const requiresCompletedDependencies =
				(effectiveStatus === "in_progress" || effectiveStatus === "completed") &&
				(params.status !== undefined || dependenciesChanged);
			if (requiresCompletedDependencies) {
				const unfinished = newBlockedBy.flatMap((depId) => {
					const task = state.tasks.find((candidate) => candidate.id === depId);
					return task?.status !== "completed" ? [{ depId, task }] : [];
				});
				if (unfinished.length > 0) {
					const labels = unfinished.map(({ depId, task }) =>
						task ? `#${task.id} (${task.status})` : `#${depId} (missing)`,
					);
					return errorResult(state, `#${current.id} is blocked by unfinished task(s): ${labels.join(", ")}`);
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			const cascade = newStatus === "failed" ? failDependents(newTasks, updated.id) : undefined;
			const finalTasks = cascade?.tasks ?? newTasks;
			const failedDependentIds = cascade?.failedIds ?? [];
			return {
				state: { tasks: finalTasks, nextId: state.nextId },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: newStatus,
					changed: taskChanged(current, updated) || failedDependentIds.length > 0,
					...(failedDependentIds.length > 0 ? { failedDependentIds } : {}),
				},
			};
		}

		case "list": {
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			if (Array.isArray(params.id)) return getTaskBatch(state, params.id);
			if (typeof params.id !== "number") return errorResult(state, "get requires one numeric id or a number array");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			if (params.id === "all") {
				const activeTasks = state.tasks.filter((task) => task.status !== "deleted");
				return {
					state: {
						tasks: state.tasks.map((task) => task.status === "deleted" ? task : { ...task, status: "deleted" }),
						nextId: state.nextId,
					},
					op: {
						kind: "delete_batch",
						deletedTasks: activeTasks.map(({ id, subject }) => ({ id, subject })),
						all: true,
					},
				};
			}
			if (Array.isArray(params.id)) return deleteTaskBatch(state, params.id);
			if (typeof params.id !== "number") return errorResult(state, "delete id must be a number, number array, or all");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}


	}
}
