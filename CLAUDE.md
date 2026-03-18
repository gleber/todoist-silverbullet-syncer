# Todoist Sync

Node.js script that syncs Todoist tasks to markdown and processes updates from agents.

## Architecture

- `sync.mjs` — single script, runs every 5 min via launchd (`com.c8664.todoist-sync`)
- Todoist API v1 (`https://api.todoist.com/api/v1`), token in `.env`
- SSL: corporate proxy (Sixt/Cato) requires `NODE_EXTRA_CA_CERTS=/Users/c8664/.ssl/combined-ca.pem`

## What the script does (in order)

1. Reads `~/Documents/Todoist/UPDATE.md` and executes actions (create/complete/update/delete/attach)
2. Re-fetches all tasks from Todoist API
3. Writes `~/Documents/Todoist/LIST.md` with current open tasks
4. Appends timestamp to `log.txt`

## Key files

| File | Location | Purpose |
|------|----------|---------|
| `sync.mjs` | This repo | Main script |
| `.env` | This repo | `TODOIST_API_TOKEN` |
| `log.txt` | This repo | Run log, latest at bottom |
| `LIST.md` | `~/Documents/Todoist/` | Read-only task list |
| `UPDATE.md` | `~/Documents/Todoist/` | Agent-writable actions |
| `AGENTS.md` | `~/Documents/Todoist/` | Spec for agents interacting with tasks |
| `history/` | `~/Documents/Todoist/` | Processed action logs |
| Plist | `~/Library/LaunchAgents/com.c8664.todoist-sync.plist` | launchd config |

## API quirks

- Responses are paginated: `{ results, next_cursor }`
- Moving tasks to a different project/section requires `POST /tasks/{id}/move` (separate from update)
- Comments use `attachment` field (not `file_attachment`) for file uploads
- Priority is inverted: API 4=P1, 3=P2, 2=P3, 1=P4
- Sort fields: `child_order` (tasks/projects), `section_order` (sections)

## Labels convention

- `@ai` — task was created or modified by the sync system
- `@ai-done` — agent marked task as complete, pending user review

## Running manually

```bash
NODE_EXTRA_CA_CERTS=/Users/c8664/.ssl/combined-ca.pem node sync.mjs
```

## launchd management

```bash
launchctl load ~/Library/LaunchAgents/com.c8664.todoist-sync.plist
launchctl unload ~/Library/LaunchAgents/com.c8664.todoist-sync.plist
launchctl list | grep todoist
```
