# `todo` tool reference

Complete parameter schema, status machine, response envelope, and error strings
for the `todo` tool registered by
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo).

## Actions

| Action | Required params | What it does |
| --- | --- | --- |
| `create` | `subject` or `tasks` | Adds one pending task or atomically adds a batch of up to 100. |
| `update` | numeric `id` + at least one mutable field | Changes status, fields, or dependencies. |
| `list` | — | Returns all tasks, optionally filtered by `status`. |
| `get` | numeric `id` or an id array | Returns one or several tasks with their `blockedBy` and reverse `blocks` edges. |
| `delete` | `id` | Tombstones one id, an id array, or all active tasks through the same parameter. |

## Parameters

```ts
todo({
  action: "create" | "update" | "list" | "get" | "delete",

  // create-only
  subject?: string,                   // required for create
  blockedBy?: number[],               // initial dependency ids

  // create batch (same create action)
  tasks?: Array<{                      // 1–100 items; each requires subject
    subject: string,
    description?: string,
    activeForm?: string,
    blockedBy?: number[],              // existing ids or earlier items in this batch
    owner?: string,
    metadata?: Record<string, unknown>,
  }>,

  // create + update (batch-create fields are nested in tasks[])
  description?: string,               // long-form detail
  activeForm?: string,                // present-continuous label shown while in_progress
  owner?: string,                     // agent/owner assigned to this task
  metadata?: Record<string, unknown>, // on update, a null value deletes that key

  // update-only
  addBlockedBy?: number[],            // additive merge into blockedBy
  removeBlockedBy?: number[],         // additive removal from blockedBy

  // update / get / delete; get accepts number or number[], delete also accepts "all"
  id?: number | number[] | "all",

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

`create` with `tasks` validates all 1–100 items before committing any, and
assigns ids in input order. `blockedBy` may refer to existing tasks or earlier
items in the same batch. `get` with an id array validates all 1–100 unique ids
before returning details in input order; deleted tombstones are included just
like scalar `get`. `delete` with an id array requires 1–100 unique, active ids
and validates the whole array before tombstoning any task. `id: "all"`
tombstones every active task while retaining existing tombstones and the current
id counter. All batch forms reuse the existing `create`, `get`, or `delete`
action; there are no extra actions.

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
- a batch create accepts dependencies on existing tasks or earlier items in its own `tasks` array; later items are not visible yet.

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
| Batch created through `create` | `Created 2 tasks:` followed by each new id and subject |
| Batch deleted through `delete` | `Deleted 2 tasks:` followed by each id and subject |
| `delete` with `id: "all"` | `Deleted all 7 tasks` (active tasks become tombstones) |
| `list` row | `[in_progress] #3 Write the parser (writing the parser) ⛓ #1,#2` |
| `list` with nothing to show | `No tasks` |
| Any rejection | `Error: <message>` |

The `No change` reply exists so a model that re-issues an identical update sees
that it was a no-op instead of a fresh `Updated #N`.

## Error messages

| Message | Cause |
| --- | --- |
| `subject required for create` | `create` without a non-blank `subject`. |
| `create accepts either one task or tasks[], not both` | A call mixes single-task fields with a batch. |
| `tasks must contain at least one item for batch create` | `create` receives an empty `tasks` array. |
| `tasks[N].subject required for batch create` | A batch item has a missing or blank subject. |
| `create supports at most 100 tasks per batch` | The create batch exceeds the supported limit. |
| `id array must contain at least one id for batch delete` | `delete` receives an empty id array. |
| `duplicate id #N in batch delete` | An id appears more than once in the delete array. |
| `delete supports at most 100 ids per batch` | The delete array exceeds the supported limit. |
| `blockedBy: #N not found` | `create` naming an unknown dependency. |
| `blockedBy: #N is deleted` | `create` naming a tombstoned dependency. |
| `tasks[N].blockedBy: #M not found` / `is deleted` / `is failed` | A batch-created task has an invalid prerequisite. |
| `id required for update` / `get` / `delete` | `id` omitted. |
| `#N not found` | No task with that id, including an id in a delete array. |
| `update requires at least one mutable field: subject, description, activeForm, status, owner, metadata, addBlockedBy, or removeBlockedBy` | `update` with only an `id`. |
| `illegal transition completed → in_progress` | Target status not reachable from the current one. |
| `#N is blocked by unfinished task(s): …` | A task is being started/completed, or given a new prerequisite, before all prerequisites are completed. |
| `blockedBy: #N is failed` / `addBlockedBy: #N is failed` | A failed task cannot be used as a prerequisite. |
| `cannot block #N on itself` | `addBlockedBy` includes the task's own id. |
| `addBlockedBy: #N not found` / `is deleted` | Unknown or tombstoned dependency. |
| `addBlockedBy would create a cycle in the blockedBy graph` | The edge would close a cycle. |
| `#N is already deleted` | `delete` or its id array includes a tombstone. |
| `delete id must be a number, number array, or all` | `delete` receives an unsupported id value. |
| `update requires one numeric id` | A non-scalar id is passed to `update`. |
| `get requires one numeric id or a number array` | `get` receives `"all"` or another unsupported id type. |
| `id array must contain at least one id for batch get` / `duplicate id #N in batch get` / `get supports at most 100 ids per batch` | Invalid batch `get` targets. |

Errors are returned in-band: `content` carries `Error: …` and `details.error`
carries the bare message. Task state is unchanged.

## Prompt guidance

The tool ships a `promptSnippet` and `promptGuidelines` telling the model when
to open a list, to keep exactly one task `in_progress`, to pass multiple create
records in `create.tasks`, to retrieve multiple task details through `get.id`,
to target one/many/all tasks through `delete.id`, to
mark work completed immediately rather than in batches, how `failed` cascades
only through dependent tasks, and the literal `update {id, status}` call shape. A task cannot start or complete before its prerequisites are completed.
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
