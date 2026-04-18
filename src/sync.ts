import assert from 'node:assert';
import { mkdirSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { Temporal } from '@js-temporal/polyfill';
import type { Task, PersonalProject, WorkspaceProject } from '@doist/todoist-sdk';
import type { ListItem } from 'mdast';
import { OUT_DIR, SYNC_MODE, SYNC_COMPLETED_MONTHS, DRY_RUN } from './config.js';
import { getTimestamp } from './utils.js';
import { api, fetchCompletedTasks, pushLocalCommands } from './api.js';
import { loadState, saveState, readTasksFile, saveTasksFile } from './state.js';
import {
  parseTasks,
  applyRemoteChanges,
  formatTaskWithAttributes,
  stringifyTasks,
} from './markdown.js';
import type { SyncCommand, TaskMetadata } from './types.js';

export let lastWriteTime = 0;

export async function tick(): Promise<void> {
  console.log(`[${getTimestamp()}] Starting sync tick (Mode: ${SYNC_MODE})...`);
  mkdirSync(OUT_DIR, { recursive: true });
  const state = loadState();

  console.log(`[${getTimestamp()}] Fetching state via sync API...`);
  const syncResult = await api.sync({ resourceTypes: ['items', 'projects'], syncToken: '*' });
  const projects = syncResult.projects ?? [];
  const activeItems = syncResult.items ?? [];

  console.log(`[${getTimestamp()}] Fetching completed tasks...`);
  const completedItems = await fetchCompletedTasks(SYNC_COMPLETED_MONTHS);

  const remoteTruth = new Map<string, Task>();

  activeItems.forEach((item) => remoteTruth.set(item.id, item));
  completedItems.forEach((item) => remoteTruth.set(item.id, { ...item, checked: true }));

  console.log(
    `[${getTimestamp()}] Remote truth: ${String(remoteTruth.size)} items, ${String(projects.length)} projects`,
  );

  const inbox = projects.find((p) => 'inboxProject' in p && p.inboxProject) ?? projects[0] ?? null;

  const markdownText = readTasksFile();
  const { ast, tasks: currentTasks } = parseTasks(markdownText, projects);

  const localCommands: SyncCommand[] = [];
  const tempIdToNode = new Map<string, ListItem>();

  if (SYNC_MODE !== 'down') {
    const currentTaskIds = new Set<string>();
    for (const task of currentTasks) {
      if (task.id) {
        currentTaskIds.add(task.id);
        const prevState = state.localState[task.id];
        const changed =
          prevState?.content !== task.content ||
          prevState.checked !== task.checked ||
          prevState.priority !== task.priority ||
          JSON.stringify(prevState.labels) !== JSON.stringify(task.labels) ||
          prevState.dueString !== task.dueString ||
          prevState.description !== task.description ||
          prevState.projectId !== task.projectId ||
          prevState.parentId !== task.parentId ||
          prevState.completedDate !== task.completedDate;

        if (changed) {
          if (prevState && prevState.checked !== task.checked) {
            localCommands.push({
              type: task.checked ? 'item_complete' : 'item_uncomplete',
              args: {
                id: task.id,
                ...(task.checked ? { completedAt: getTimestamp() } : {}),
              },
            });
            console.log(
              `[Todoist] ${task.checked ? 'Completing' : 'Uncompleting'} task: "${task.content}" (${task.id})`,
            );
            if (task.checked && !task.completedDate) {
              task.completedDate = Temporal.Now.plainDateISO().toString();
            } else if (!task.checked) {
              task.completedDate = null;
            }
          }

          const updateArgs: Record<string, unknown> = { id: task.id };
          if (prevState?.content !== task.content) updateArgs.content = task.content;
          if (prevState?.priority !== task.priority) updateArgs.priority = task.priority;
          if (!prevState || JSON.stringify(prevState.labels) !== JSON.stringify(task.labels))
            updateArgs.labels = task.labels;
          if (prevState?.dueString !== task.dueString) updateArgs.due = { string: task.dueString };
          if (prevState?.description !== task.description)
            updateArgs.description = task.description;

          if (Object.keys(updateArgs).length > 1) {
            localCommands.push({ type: 'item_update', args: updateArgs });
            console.log(`[Todoist] Updating task: "${task.content}" (${task.id})`);
          }

          if (prevState?.projectId !== task.projectId || prevState.parentId !== task.parentId) {
            const targetProjectId = task.projectId ?? (inbox ? inbox.id : null);
            if (targetProjectId !== null || task.parentId !== null) {
              localCommands.push({
                type: 'item_move',
                args: task.parentId
                  ? { id: task.id, parentId: task.parentId }
                  : { id: task.id, projectId: targetProjectId },
              });
              console.log(
                `[Todoist] Moving task: "${task.content}" (${task.id}) to ${task.parentId ? 'parent ' + task.parentId : 'project ' + String(targetProjectId)}`,
              );
            }
          }
        }
      } else {
        const tempId = uuidv4();
        task.tempId = tempId;
        tempIdToNode.set(tempId, task.node);

        console.log(`[Todoist] Adding task: "${task.content}"`);
        const commandArgs: Record<string, unknown> = {
          content: task.content,
          projectId: task.projectId ?? (inbox ? inbox.id : null),
          parentId: task.parentId,
          priority: task.priority,
          labels: task.labels,
          description: task.description,
        };
        if (task.dueString) commandArgs.due = { string: task.dueString };

        localCommands.push({ type: 'item_add', tempId, args: commandArgs });
        if (task.checked) {
          localCommands.push({
            type: 'item_complete',
            args: { id: tempId, completedAt: getTimestamp() },
          });
          console.log(`[Todoist] Completing new task: "${task.content}"`);
          task.completedDate ??= Temporal.Now.plainDateISO().toString();
        }
      }
    }

    for (const id of Object.keys(state.localState)) {
      if (!currentTaskIds.has(id)) {
        localCommands.push({ type: 'item_delete', args: { id } });
        const localTask = state.localState[id];
        if (localTask) {
          console.log(`[Todoist] Deleting task: "${localTask.content}" (${id})`);
        }
      }
    }
  }

  const localChangedIds = new Set(
    localCommands.map((c) => String(c.args.id)).filter((id) => id && id !== 'undefined'),
  );
  const filteredRemoteChanges: Task[] = [];
  for (const [id, remote] of remoteTruth) {
    if (localChangedIds.has(id)) {
      const localTask = currentTasks.find((t) => t.id === id);
      if (localTask) {
        localTask.content += ' (Conflict)';
        localTask.id = null;
      }
    }
    filteredRemoteChanges.push(remote);
  }

  if (SYNC_MODE !== 'up') {
    applyRemoteChanges(
      ast,
      currentTasks,
      filteredRemoteChanges,
      projects as (PersonalProject | WorkspaceProject)[],
    );
  }

  const { tempIdMapping } = await pushLocalCommands(localCommands);

  for (const [tempId, realId] of Object.entries(tempIdMapping)) {
    const node = tempIdToNode.get(tempId);
    if (node?.children[0]?.type === 'paragraph') {
      const task = currentTasks.find((t) => t.tempId === tempId);
      if (task) {
        task.id = realId;
        node.children[0].children = [{ type: 'text', value: formatTaskWithAttributes(task) }];
      }
    }
  }

  const finalMarkdown = stringifyTasks(ast);
  const { tasks: finalTasks } = parseTasks(
    finalMarkdown,
    projects as (PersonalProject | WorkspaceProject)[],
  );

  const seenIds = new Set<string>();
  for (const t of finalTasks) {
    if (t.id) {
      assert(!seenIds.has(t.id), `Duplicate task ID found in final TASKS.md: ${t.id}`);
      seenIds.add(t.id);
    }
  }

  const newLocalState: Record<string, TaskMetadata> = {};
  for (const t of finalTasks) {
    if (t.id) {
      newLocalState[t.id] = {
        content: t.content,
        checked: t.checked,
        projectId: t.projectId,
        parentId: t.parentId,
        priority: t.priority,
        labels: t.labels,
        dueString: t.dueString,
        completedDate: t.completedDate,
        description: t.description,
      };
    }
  }

  if (!DRY_RUN && SYNC_MODE !== 'up') {
    const markdownChanged = finalMarkdown !== markdownText;
    const newState = { sync_token: '*', localState: newLocalState };
    const stateChanged = JSON.stringify(newState) !== JSON.stringify(state);

    if (markdownChanged || stateChanged) {
      if (markdownChanged) {
        lastWriteTime = Temporal.Now.instant().epochMilliseconds;
        console.log(`[${getTimestamp()}] Saving changes to TASKS.md...`);
        saveTasksFile(finalMarkdown);
      }
      saveState(newState);
    }
  } else if (SYNC_MODE === 'up') {
    console.log(`[${getTimestamp()}] 'up' mode: Todoist updated, skipping local file updates.`);
  }

  console.log(`[${getTimestamp()}] Sync complete.`);
}
