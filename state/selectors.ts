import type { Task, TaskStatus } from "../tool/types.js";
import type { TaskState } from "./state.js";

/** Tasks excluding deleted tombstones — the canonical "what's visible". */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((t) => t.status !== "deleted");
}

/**
 * Group visible tasks by status. `/todos` displays failed, completed,
 * in-progress, then pending counts in its header.
 */
export interface TasksByStatus {
	pending: readonly Task[];
	inProgress: readonly Task[];
	completed: readonly Task[];
	failed: readonly Task[];
}
export function selectTasksByStatus(state: TaskState): TasksByStatus {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((t) => t.status === "pending"),
		inProgress: visible.filter((t) => t.status === "in_progress"),
		completed: visible.filter((t) => t.status === "completed"),
		failed: visible.filter((t) => t.status === "failed"),
	};
}

/** Total counts for the overlay heading (`Todos (n/m)`) and `/todos` header. */
export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
	failed: number;
}
export function selectTodoCounts(state: TaskState): TodoCounts {
	const groups = selectTasksByStatus(state);
	return {
		total: groups.pending.length + groups.inProgress.length + groups.completed.length + groups.failed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		completed: groups.completed.length,
		failed: groups.failed.length,
	};
}

/**
 * Whether any visible task carries a `blockedBy` reference. The overlay uses
 * this to gate the `#id` prefix on per-task rows — without at least one
 * `⛓ #N` suffix, the per-row id has no anchor.
 */
export function selectShowTaskIds(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.blockedBy && t.blockedBy.length > 0);
}

/**
 * Resolve a task's subject by id from the live state for renderCall's
 * accent label. `undefined` when the id is unknown — caller falls back to
 * `#id` plain rendering.
 */
export function selectTaskSubjectById(state: TaskState, id: number): string | undefined {
	return state.tasks.find((t) => t.id === id)?.subject;
}

/**
 * Overlay layout decision. Completed and failed tasks are treated as terminal
 * display outcomes and dropped before pending/in-progress work. `budget` is the
 * body-slot count (caller passes `getMaxWidgetLines() - 1` to reserve the
 * heading row); on overflow the selector reserves one more slot for the summary.
 */
export interface OverlayLayout {
	visible: readonly Task[];
	hiddenCompleted: number;
	hiddenFailed: number;
	truncatedTail: number;
	truncatedByStatus: { pending: number; inProgress: number };
}
export function selectOverlayLayout(state: TaskState, budget: number): OverlayLayout {
	const all = selectVisibleTasks(state);
	if (all.length <= budget) {
		return {
			visible: all,
			hiddenCompleted: 0,
			hiddenFailed: 0,
			truncatedTail: 0,
			truncatedByStatus: { pending: 0, inProgress: 0 },
		};
	}
	const innerBudget = budget - 1;
	const terminal = all.filter((t) => t.status === "completed" || t.status === "failed");
	const nonTerminal = all.filter((t) => t.status !== "completed" && t.status !== "failed");
	const totalCompleted = all.filter((t) => t.status === "completed").length;
	const totalFailed = all.filter((t) => t.status === "failed").length;
	if (nonTerminal.length <= innerBudget) {
		const kept = new Set<Task>(nonTerminal);
		for (const task of terminal) {
			if (kept.size >= innerBudget) break;
			kept.add(task);
		}
		const visible = all.filter((t) => kept.has(t));
		const shownCompleted = visible.filter((t) => t.status === "completed").length;
		const shownFailed = visible.filter((t) => t.status === "failed").length;
		return {
			visible,
			hiddenCompleted: totalCompleted - shownCompleted,
			hiddenFailed: totalFailed - shownFailed,
			truncatedTail: 0,
			truncatedByStatus: { pending: 0, inProgress: 0 },
		};
	}
	const visible = nonTerminal.slice(0, innerBudget);
	const truncated = nonTerminal.slice(innerBudget);
	return {
		visible,
		hiddenCompleted: totalCompleted,
		hiddenFailed: totalFailed,
		truncatedTail: truncated.length,
		truncatedByStatus: {
			pending: truncated.filter((t) => t.status === "pending").length,
			inProgress: truncated.filter((t) => t.status === "in_progress").length,
		},
	};
}

/**
 * Helper: whether any visible task is `pending` or `in_progress`. The overlay
 * uses this to pick the heading icon (`accent`+`●` vs `dim`+`○`).
 */
export function selectHasActive(state: TaskState): boolean {
	return selectVisibleTasks(state).some((t) => t.status === "in_progress" || t.status === "pending");
}

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["pending", "in_progress"]);
