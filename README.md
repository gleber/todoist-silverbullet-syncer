# todoist-sync

Let Claude Code (cowork mode) read and manage your Todoist tasks — without building an MCP integration.

A Node script syncs Todoist to local markdown files every 5 minutes via launchd. Agents interact with Todoist by reading `LIST.md` and writing actions to `UPDATE.md` — plain files that any tool can access. No MCP server, no API keys in the agent, no custom tooling. Just files.

## How it works

1. Reads `~/Documents/Todoist/UPDATE.md` and executes actions (create/complete/update/delete/attach)
2. Re-fetches all tasks from Todoist API
3. Writes `~/Documents/Todoist/LIST.md` with current open tasks
4. Appends timestamp + task count to `log.txt`

## Setup

```bash
cp .env.example .env  # add TODOIST_API_TOKEN
npm install
```

Load the launchd job (runs every 5 min):

```bash
launchctl load ~/Library/LaunchAgents/com.c8664.todoist-sync.plist
```

## Manual run

```bash
node sync.mjs
```

If behind a corporate VPN/proxy that intercepts TLS:

```bash
NODE_EXTRA_CA_CERTS=/path/to/your/ca-bundle.pem node sync.mjs
```

## UPDATE.md format

Write action blocks separated by `---`. Processed once, then cleared.

```
action: create
content: Buy milk
project: Personal
due: tomorrow
priority: 2

---

action: complete
task: Buy milk
project: Personal

---

action: update
task: Some task
project: Work
set_due: 2026-04-01
add_labels: @waiting

---

action: delete
task: Old task

---

action: attach
task: Some task
file: /path/to/file.pdf
comment: Here's the report
```

### Supported fields

| Field | Actions | Notes |
|-------|---------|-------|
| `content` | create | Task title |
| `project` | all | Project name (case-insensitive) |
| `section` | create | Section name |
| `parent` | create | Parent task (substring match) |
| `due` | create | Date (`YYYY-MM-DD`) or natural string |
| `priority` | create, update | 1–4 (1=lowest) |
| `description` | create, update (via `set_description`) | |
| `labels` | create | Comma-separated |
| `add_labels` | update | Adds to existing labels |
| `set_content` | update | Rename task |
| `set_due` | update | Change due date |
| `set_project` | update | Move to project |
| `set_section` | update | Move to section |
| `file` | attach | Absolute path |
| `comment` | attach | Comment text (default: "Attached file") |

## Files

| File | Purpose |
|------|---------|
| `sync.mjs` | Main script |
| `.env` | `TODOIST_API_TOKEN` |
| `log.txt` | Run log (latest at bottom) |
| `~/Documents/Todoist/LIST.md` | Read-only task list (generated) |
| `~/Documents/Todoist/UPDATE.md` | Agent-writable actions |
| `~/Documents/Todoist/AGENTS.md` | Spec for agent integration |
| `~/Documents/Todoist/history/` | Per-run action logs |

## Labels

- `@ai` — task created or modified by this system
- `@ai-done` — agent marked complete, pending review
