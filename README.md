# todoist-sync

A robust, two-way synchronizer between Todoist and a local Markdown file.

This tool allows AI agents and humans to manage Todoist tasks by directly reading and editing a single Markdown file (`TASKS.md`). It uses the Todoist v1 Sync API for efficient updates and Markdown AST parsing for lossless file modification.

## How it works

1.  **Two-Way Sync**: Changes made in `TASKS.md` (new tasks, checked/unchecked, content updates, deletions) are pushed to Todoist.
2.  **Conflict Resolution**: If a task is modified both locally and remotely, the local version is "forked" (ID removed and marked as conflict), and the remote version is applied.
3.  **Atomic Writes**: Uses temporary files and moves to ensure your state and tasks files are never corrupted.
4.  **Watch Mode**: Can run as a daemon, watching the file for changes and polling Todoist for remote updates.

## Setup

1.  Install dependencies:
    ```bash
    npm install
    ```
2.  Configure environment:
    ```bash
    cp .env.example .env
     # Edit .env and add your TODOIST_API_TOKEN
    ```

## CLI Usage

### Options

*   `--dir <path>`: Specify the directory where `TASKS.md` and state are stored. Defaults to the current directory.

### Once-off Synchronize
Runs a single reconciliation "tick" and exits.
```bash
npm run sync -- --once --dir ./my-tasks
```

### Watch/Daemon Mode
Watches `TASKS.md` for local changes (with debounce) and polls Todoist every minute.
```bash
npm run dev
# or
npm run sync -- --watch
```

## Task Format

Tasks are stored in `TASKS.md` as a simple Markdown list:

```markdown
* [ ] Buy milk [id: "123456"]
* [x] Finished task [id: "789012"] [completed: "2026-04-18"]
* [ ] New local task
```

*   **New Tasks**: Simply add a new list item. The synchronizer will assign it a real Todoist ID on the next tick.
*   **Completing Tasks**: Change `[ ]` to `[x]`.
*   **Deleting Tasks**: Remove the line from the file.
*   **Updating Content**: Change the text after the checkbox.

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main execution entry point |
| `src/` | Holds the split modular codebase (`sync`, `api`, `markdown`, etc.) |
| `.env` | `TODOIST_API_TOKEN` |
| `TASKS.md` | The live task list. Edit this file! |
| `.todoist-sync-state.json` | Internal sync state (sync token + local cache) |

## For AI Agents

Agents can interact with Todoist by:
1.  Reading `TASKS.md` to see current tasks.
2.  Modifying `TASKS.md` directly.
3.  The agent should ensure `npm run dev` is running or trigger `npm run sync -- --once` after making changes if they want immediate synchronization.
