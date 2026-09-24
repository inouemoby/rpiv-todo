# @juicesharp/rpiv-todo

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-todo.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo">
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/cover.png" alt="rpiv-todo — a persistent todo overlay for Pi Agent, showing a task panel with completed, in-progress, and pending rows" width="50%">
  </a>
</div>

Give the model a task list you can see. `rpiv-todo` adds a `todo` tool, a
`/todos` command, and a live panel above the editor to
[Pi Agent](https://github.com/badlogic/pi-mono), so you always know what the
agent is doing now, what it finished, and what is queued. The list is rebuilt
from the conversation itself, so it survives `/reload` and compaction — useful
on long research → design → implement sessions.

## Install

```sh
pi install npm:@juicesharp/rpiv-todo
```

Restart your Pi session.

## Quick start

Run `/todos` after the restart to confirm the extension is loaded. On a fresh
session it prints:

```
No todos yet. Ask the agent to add some!
```

Then ask for something with several steps — "add a repository layer with tests,
and track it as todos". The model calls `todo` and the panel appears above your
input box, updating as work moves:

![Todo overlay panel: a Todos (2/7) heading above two struck-through completed rows, one in-progress row with its activity label, and four pending rows](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/overlay.jpg)

Press `ctrl+shift+t` to collapse the panel to its heading plus a one-line hint,
and again to expand it. Run `/todos` at any time to print the full list grouped
by status.

## What you get

- **The plan stays on screen.** A panel above the editor shows every task with a
  status glyph, the label of whatever is in progress, and a `Todos (done/total)`
  heading — you never have to ask the agent where it is.
- **Tasks survive `/reload` and compaction.** Each tool call carries the full
  post-mutation snapshot, and the list is replayed from the session branch. No
  disk writes, nothing to lose.
- **Batch operations reuse the existing actions.** `create` accepts either one
  task or a `tasks` array (up to 100), and `delete` accepts one numeric `id`, an
  array of ids, or `"all"` in that same `id` field. `"all"` tombstones all
  active tasks while preserving history and the id counter.
- **In-progress tasks get a low-priority nudge.** After a completed run, if an
  `in_progress` task remains and no other message is queued, the extension sends
  one user follow-up asking the agent to continue, including each task's ID,
  subject, and available details. Other task states do not trigger it.
- **Finished outcomes get out of the way.** Completed and failed rows stay
  visible for the rest of the turn, then disappear from the overlay at the start
  of the next one. Their statuses remain available through `/todos`.
- **The overlay never eats your terminal.** Past the row budget it drops
  completed and failed tasks before unfinished work, then reports hidden counts.
- **The agent can sequence work, not just list it.** `blockedBy` dependencies are
  validated before anything is written — dangling ids, deleted/failed
  dependencies, self-blocks, and cycles are rejected. A failed task also fails
  its dependent tasks.
- **Parallel sessions stay separate.** Task state is keyed by session, so a
  detached or child session can neither read nor overwrite the foreground list.
- **Localized UI, no setup required.** Nine locales ship with the package and
  activate when [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
  is installed; without it, everything falls back to English.

## Suggested TODO workflow

This is reference guidance for people using the extension; it is not injected into
Pi's prompt.

- Define the actual deliverables, authorization, and decisions needed before
  creating tasks. Ask first if a required boundary is unclear.
- Use `todo` for work with three or more steps or when the user gives multiple
  tasks.
- Mark a task `in_progress` before starting it and `completed` as soon as it is
  done. Keep only one task `in_progress` at a time.
- If work is blocked or validation fails, investigate, fix, and try reasonable
  alternatives; do not mark unresolved work `completed`.
- Mark a specific task `failed` only after reasonable implementation,
  debugging, investigation, and alternative approaches still cannot move it
  forward. Use `todo({ action: "update", id, status: "failed" })`.

## Configuration

Optional. Create `~/.config/rpiv-todo/config.json` (or
`$XDG_CONFIG_HOME/rpiv-todo/config.json` if you set that variable):

```json
{
  "maxWidgetLines": 8,
  "collapseKey": "alt+t"
}
```

| Setting | What it does | Default |
| --- | --- | --- |
| `maxWidgetLines` | Content rows the overlay may use, heading included. Minimum `3`. Applies on the next repaint. Pi's tool-output expansion mode shows all tasks. | `12` |
| `collapseKey` | Key that collapses and expands the panel, in Pi keybinding form (`alt+o`, `ctrl+shift+t`). Set `"off"` to register no shortcut. Needs `/reload` to rebind. | `"ctrl+shift+t"` |
| `guidance` | Replaces the built-in instructions the extension gives the model about when and how to use the todo list. Needs `/reload`. | _(built-ins)_ |

A missing or malformed file falls back to these defaults. `rpiv-todo` only reads
this file — it never writes one. Full semantics:
[Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/docs/configuration.md).

## Reference

- [`todo` tool reference](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/docs/tool-schema.md)
  — every `todo` parameter, the status machine, the response envelope, and the
  exact error strings.
- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/docs/configuration.md)
  — config file resolution, option validation rules, and the accepted keybinding
  grammar.
- [Overlay and `/todos`](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/docs/overlay.md)
  — overlay lifecycle, glyphs, overflow behavior, `/todos` output, and
  localization.

## Requirements

- Pi Agent `0.87.0` or newer for `agent_before_settle` support. No API key,
  no model selection, no native dependencies.
- An interactive session for the panel and `/todos`. Headless runs still get the
  `todo` tool; nothing is rendered.
- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
  is an optional peer — install it for a localized UI, skip it for English.

## Related

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
  ([source](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-i18n))
  — localizes this extension's UI chrome and adds a `/languages` picker.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi)
  ([source](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-pi))
  — the umbrella package that installs this extension alongside its siblings.

## License

MIT — see [LICENSE](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-todo/LICENSE).
