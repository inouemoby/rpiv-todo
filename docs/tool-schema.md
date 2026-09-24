# `todo` tool reference

Complete parameter schema, status machine, response envelope, and error strings
for the `todo` tool registered by
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo).

## Actions

| Action | Required params | What it does |
| --- | --- | --- |
| `create` | `subject` | Adds a task in `pending`, assigns the next id. |
| `update` | `id` + at least one mutable field | Changes status, fields, or dependencies. |
| `list` | — | Returns all tasks, optionally filtered by `status`. |
| `get` | `id` | Returns one task with its `blockedBy` and reverse `blocks` edges. |
| `delete` | `id` | Tombstones the task (`status: "deleted"`); it is not removed. |
| `clear` | — | Drops every task and resets the id counter to `1`. |

## Parameters

```ts
todo({
  action: "create" | "update" | "list" | "get" | "delete" | "clear",

  // create-only
  subject?: string,                   // required for create
  blockedBy?: number[],               // initial dependency ids

  // create + update
  description?: string,               // long-form detail
  activeForm?: string,                // present-continuous label shown while in_progress
  owner?: string,                     // agent/owner assigned to this task
  metadata?: Record<string, unknown>, // on update, a null value deletes that key

  // update-only
  addBlockedBy?: number[],            // additive merge into blockedBy
  removeBlockedBy?: number[],         // additive removal from blockedBy

  // update / get / delete
  id?: number,

  // update (sets this task's status) or list (filters by status)
  status?: "pending" | "in_progress" | "completed" | "failed" | "deleted",

  // list-only
  includeDeleted?: boolean,           // default false — hides tombstones
})
```

`update` merges `metadata` key by key into the existing record; passing `null`
for a key removes it, and emptying the record drops the field entirely.
`addBlockedBy` and `removeBlockedBy` are additive — do not resend the whole
array.

## Status transitions

| From | Allowed targets |
| --- | --- |
| `pending` | `in_progress`, `completed`, `failed`, `deleted` |
| `in_progress` | `pending`, `completed`, `failed`, `deleted` |
| `completed` | `failed`, `deleted` |
| `failed` | _(terminal)_ |
| `deleted` | _(terminal)_ |

A transition to the current status is always accepted and reported as a no-op.
`failed` is terminal. Setting a task to `failed` also fails its downstream
tasks recursively. The `delete` action keeps a task as a tombstone so historic
`blockedBy` references still resolve; deleted tombstones are hidden from `list`
unless you pass `includeDeleted: true`.

## Dependencies

`blockedBy` holds the ids this task waits on. Validation runs before the state
is mutated, so a rejected call leaves the list untouched:

- a dependency id that does not exist is rejected;
- a dependency that is already tombstoned is rejected;
- blocking a task on itself is rejected;
- an `addBlockedBy` that would close a cycle in the graph is rejected;
- a failed task cannot be added as a prerequisite.

A task may enter `in_progress` or `completed` only when every task in its
`blockedBy` list is completed. This prevents starting downstream work before its
prerequisites.

`get` also reports the reverse edges as a `blocks:` line, derived from the other
tasks' `blockedBy` arrays.

## Return envelope

```ts
{
  content: [{ type: "text", text: string }], // human-readable summary of the op
  details: {                                 // full snapshot — replay reads this back
    action: TaskAction,
    params: Record<string, unknown>,
    tasks: Array<{
      id: number,
      subject: string,
      description?: string,
      activeForm?: string,
      status: "pending" | "in_progress" | "completed" | "failed" | "deleted",
      blockedBy?: number[],
      owner?: string,
      metadata?: Record<string, unknown>,
    }>,
    nextId: number,
    error?: string,                          // present only on a rejected call
  }
}
```

`details` is the persistence format. Every successful call embeds the complete
post-mutation snapshot, and the session-lifecycle handlers rebuild state by
walking the branch and taking the last snapshot they find — which is why tasks
survive `/reload` and compaction without any disk writes.

## Content strings

| Situation | `content[0].text` |
| --- | --- |
| Created | `Created #3: Write the parser (pending)` |
| Updated with a status change | `Updated #3 (pending → in_progress)` |
| Updated without a status change | `Updated #3` |
| Update that changed nothing | `No change: #3 already matches the requested values (status: in_progress)` |
| Deleted | `Deleted #3: Write the parser` |
| Cleared | `Cleared 7 tasks` |
| `list` row | `[in_progress] #3 Write the parser (writing the parser) ⛓ #1,#2` |
| `list` with nothing to show | `No tasks` |
| Any rejection | `Error: <message>` |

The `No change` reply exists so a model that re-issues an identical update sees
that it was a no-op instead of a fresh `Updated #N`.

## Error messages

| Message | Cause |
| --- | --- |
| `subject required for create` | `create` without a non-blank `subject`. |
| `blockedBy: #N not found` | `create` naming an unknown dependency. |
| `blockedBy: #N is deleted` | `create` naming a tombstoned dependency. |
| `id required for update` / `get` / `delete` | `id` omitted. |
| `#N not found` | No task with that id. |
| `update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy` | `update` with only an `id`. |
| `illegal transition completed → in_progress` | Target status not reachable from the current one. |
| `#N is blocked by unfinished task(s): …` | A task is being started/completed, or given a new prerequisite, before all prerequisites are completed. |
| `blockedBy: #N is failed` / `addBlockedBy: #N is failed` | A failed task cannot be used as a prerequisite. |
| `cannot block #N on itself` | `addBlockedBy` includes the task's own id. |
| `addBlockedBy: #N not found` / `is deleted` | Unknown or tombstoned dependency. |
| `addBlockedBy would create a cycle in the blockedBy graph` | The edge would close a cycle. |
| `#N is already deleted` | `delete` on a tombstone. |

Errors are returned in-band: `content` carries `Error: …` and `details.error`
carries the bare message. Task state is unchanged.

## Prompt guidance

The tool ships a `promptSnippet` and `promptGuidelines` telling the model when
to open a list, to keep exactly one task `in_progress`, to mark work completed
immediately rather than in batches, how `failed` cascades only through dependent
tasks, and the literal `update {id, status}` call shape for changing a task's
status. A task cannot start or complete before its prerequisites are completed.
Both are overridable — see
[configuration.md](./configuration.md#guidance).

## Low-priority continuation

After a normally completed agent run, the extension queues one user-message
follow-up if any task in the current session is still `in_progress`. The message
includes each active task's subject, description, and active form. It first
checks for messages or a continuation already queued by another plugin; when
one exists, it stays quiet. `pending`, `completed`, `deleted`, and `failed`
tasks do not trigger the reminder. If the task remains `in_progress`, the check
runs again when the next agent run settles.
