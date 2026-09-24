import type { TaskStatus } from "../tool/types.js";

/**
 * Allowed forward transitions per source status. `completed` can only move to
 * a terminal outcome; both `failed` and `deleted` are terminal statuses.
 *
 * Idempotent same→same is checked separately in `isTransitionValid` so this
 * table only enumerates actual transitions.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "failed", "deleted"]),
	in_progress: new Set(["pending", "completed", "failed", "deleted"]),
	completed: new Set(["failed", "deleted"]),
	failed: new Set(),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}
