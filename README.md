# rpiv-todo

A Pi extension for tracking multi-step work. It adds a `todo` tool, a `/todos` command, and a live task panel above the editor. Task state is stored in the conversation, so it survives `/reload` and compaction.

## Install

```bash
pi install git:github.com/inouemoby/rpiv-todo
```

Restart Pi after installing.

## Usage

Ask the agent to track work with several steps. The panel shows pending, in-progress, completed, and failed tasks as they change. Press `ctrl+shift+t` to collapse or expand it; run `/todos` to print the full list.

Tasks can be ordered with `blockedBy` dependencies. The extension validates dependencies and keeps task state separate for each session and conversation branch. It does not write task data to external files.

## Configuration

Optional: create `~/.config/rpiv-todo/config.json` or `$XDG_CONFIG_HOME/rpiv-todo/config.json`.

```json
{
  "maxWidgetLines": 12,
  "collapseKey": "ctrl+shift+t"
}
```

| Setting | Description |
|---------|-------------|
| `maxWidgetLines` | Overlay row limit; minimum `3`, default `12`. |
| `collapseKey` | Collapse/expand shortcut. Set to `"off"` to disable; changing it requires `/reload`. |
| `guidance` | Optional prompt snippet and guidelines for how the agent uses todos; changes require `/reload`. |

The config is read-only from the extension. See [configuration details](docs/configuration.md).

## Requirements

- Pi Agent `0.87.0` or newer for task continuation hooks.
- Interactive UI for the overlay and `/todos`; the `todo` tool also works in headless sessions.
- Optional [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) for localized UI.

See the [todo tool reference](docs/tool-schema.md) and [overlay guide](docs/overlay.md).

## License

MIT
