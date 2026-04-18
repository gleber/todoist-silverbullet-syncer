# Todoist Sync

TypeScript/Node script that provides a robust two-way sync between Todoist and a local Markdown file (`TASKS.md`), processing and reconciling changes made by either agents or humans. It uses SilverBullet markdown as output.

## Architecture

- Uses `npm run dev` (runs `src/index.ts` under `tsx`) out of the box to watch files using `chokidar` and synchronizes every minute.
- Todoist SDK (`@doist/todoist-sdk`), token supplied in `.env`
- Fully migrated to strict TypeScript, featuring modularized domains (`src/api.ts`, `src/markdown.ts`, `src/sync.ts`, etc.).
- Converts `mdast` natively locally back-and-forth into Todoist representations maintaining ID tracking entirely from within the Markdown using simple property structures `[id: "XYZ"]`.

## What the script does (in order of a tick)

1. Fetches current state from Todoist API (`api.sync()` for items/projects) and recently completed items via `api.getCompletedTasksByCompletionDate()`.
2. Reads `TASKS.md` locally and builds an Abstract Syntax Tree using `mdast`.
3. Compares localized MD attributes (`[priority: 2]`, `#tags`, `[completed: "2024"]`) to remote truths to calculate the exact mutation instructions (moves, checks, edits, deletes).
4. Submits updates remotely in batches.
5. Reapplies the finalized authoritative truth from Todoist back into the `TASKS.md`.

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | The continuous run loop and CLI parameter processor (`--once`, `--watch`) |
| `src/sync.ts` | Central algorithmic synchronization processing `tick()` |
| `src/markdown.ts` | Handling local tree-parsing and remote modifications stringified over the AST  |
| `src/types.ts` | Explicit core models (`TaskMetadata`, `ParsedTask`, `LoadedState`, etc.) |
| `TASKS.md` | Primary storage medium and target location. Modifications must happen here directly! |
| `.todoist-sync-state.json` | Used for retaining mappings inside sync logic boundaries |

## API quirks

- Moving tasks to a different project/section conditionally uses `parentId` locally or skips entirely to just reassign `projectId`.
- Sync SDK API commands expect `args: Record<string, unknown>` and must not carry unknown payloads so strictly typed structures are observed globally.
- Completing a task generates `[completed: "YYYY-MM-DD"]` into the AST automatically locally.

## Labels convention

By default standard tags act as labels directly `#work` becoming `'work'`.

## Running manually

```bash
# Run one immediate check and sync tick
npm run sync -- --once

# Live-watch modes polling
npm run dev
# or
npm run sync -- --watch
```
