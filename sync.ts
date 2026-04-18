import { Temporal } from '@js-temporal/polyfill';
import 'dotenv/config';
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { remark } from 'remark';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import chokidar from 'chokidar';
import { v4 as uuidv4 } from 'uuid';
import { TodoistApi, createCommand } from '@doist/todoist-sdk';
import type { Task, PersonalProject, WorkspaceProject } from '@doist/todoist-sdk';
import type {
  Root,
  ListItem,
  List,
  Heading,
  Paragraph,
  PhrasingContent,
  Content,
  Parent,
} from 'mdast';

import fetch from 'node-fetch';

const TOKEN = process.env.TODOIST_API_TOKEN;
if (!TOKEN) {
  console.error('TODOIST_API_TOKEN not set');
  process.exit(1);
}

const api = new TodoistApi(TOKEN, {
  // @ts-ignore
  customFetch: fetch as unknown as typeof globalThis.fetch,
});

const args = process.argv.slice(2);
const dirFlagIndex = args.indexOf('--dir');
const potentialDir = dirFlagIndex !== -1 ? args[dirFlagIndex + 1] : undefined;
const OUT_DIR = potentialDir ?? process.cwd();

const SYNC_MODE =
  (args.includes('--mode')
    ? args[args.indexOf('--mode') + 1]
    : process.env.SYNC_MODE || process.env.MODE) || 'two-way';
const DRY_RUN = SYNC_MODE === 'dry';

function getTimestamp(): string {
  return Temporal.Now.instant().toString();
}

let lastWriteTime = 0;

const TASKS_FILE = join(OUT_DIR, 'TASKS.md');
const STATE_FILE = join(OUT_DIR, '.todoist-sync-state.json');
const TASKS_FILE_TMP = `${TASKS_FILE}.tmp`;
const STATE_FILE_TMP = `${STATE_FILE}.tmp`;
const SYNC_COMPLETED_MONTHS = parseInt(process.env.SYNC_COMPLETED_MONTHS || '3');

interface TaskMetadata {
  content: string;
  checked: boolean;
  projectId: string | null;
  parentId: string | null;
  priority: number;
  labels: string[];
  dueString: string | null;
  completedDate: string | null;
  description: string;
}

interface LoadedState {
  sync_token: string;
  localState: Record<string, TaskMetadata>;
}

interface SyncCommand {
  type: string;
  tempId?: string;
  temp_id?: string;
  args: Record<string, any>;
}

async function fetchCompletedTasks(monthsBack: number): Promise<Task[]> {
  const now = Temporal.Now.instant();
  const since = now.toZonedDateTimeISO('UTC').subtract({ months: monthsBack }).toInstant();

  const sinceStr = since.toString();
  const untilStr = now.toString();

  let allCompleted: Task[] = [];
  let cursor: string | null = null;

  do {
    const data = await api.getCompletedTasksByCompletionDate({
      since: sinceStr,
      until: untilStr,
      limit: 100,
      cursor: cursor ?? undefined,
    });
    if (data.items) {
      allCompleted = allCompleted.concat(data.items);
    }
    cursor = data.nextCursor ?? null;
  } while (cursor);

  return allCompleted;
}

async function pushLocalCommands(
  commands: SyncCommand[],
): Promise<{ tempIdMapping: Record<string, string> }> {
  if (commands.length === 0) return { tempIdMapping: {} };

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would push ${commands.length} commands to Todoist.`);
    return { tempIdMapping: {} };
  }

  const syncCommands = commands.map((cmd) => {
    const commandArgs = { ...cmd.args };

    // SDK expects specific shapes for some commands in the Sync API.
    if (cmd.type === 'item_complete' && !commandArgs.completedAt) {
      commandArgs.completedAt = Temporal.Now.instant().toString();
    }

    return createCommand(cmd.type as any, commandArgs, cmd.tempId ?? cmd.temp_id);
  });

  try {
    const response = await api.sync({ commands: syncCommands });
    return { tempIdMapping: response.tempIdMapping ?? {} };
  } catch (e) {
    console.error(`[${getTimestamp()}] Sync batch failed:`, e);
    return { tempIdMapping: {} };
  }
}

function loadState(): LoadedState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    } catch (e) {
      console.error('Error parsing state file, resetting state:', e);
    }
  }
  return {
    sync_token: '*',
    localState: {},
  };
}

const processor = remark()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '*',
    listItemIndent: 'one',
    commonmark: true,
    fences: true,
    resourceLink: true,
  } as any);

function extractTaskProperties(text: string): {
  content: string;
  attributes: Record<string, string | number>;
  tags: string[];
} {
  let content = text;
  const attributes: Record<string, string | number> = {};
  const tags: string[] = [];

  // Extract attributes: [key: value] or [key: "value"]
  // Specifically handle both escaped and unescaped brackets in case the file has either.
  const attrRegex = /(?:\\\[|\[)(\w+):\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))(?:\\\]|\])/g;
  content = content.replace(attrRegex, (_match, key, q1, q2, unquoted) => {
    const value = q1 ?? q2 ?? unquoted ?? '';
    if (key === 'priority') {
      attributes[key] = parseInt(value, 10);
    } else {
      attributes[key] = value;
    }
    return '';
  });

  // Extract tags: #tag
  const tagRegex = /(^|\s)#([\w/-]+)/g;
  content = content.replace(tagRegex, (_match, space, tag) => {
    tags.push(tag.trim());
    return space;
  });

  return {
    content: content.trim().replace(/\s+/g, ' '),
    attributes,
    tags,
  };
}

function formatTaskWithAttributes(task: {
  content: string;
  labels?: string[];
  priority?: number;
  dueString?: string | null;
  completedDate?: string | null;
  id?: string | null;
}): string {
  const parts = [task.content];

  if (task.labels && task.labels.length > 0) {
    parts.push(...task.labels.map((l) => `#${l}`));
  }

  if (task.priority && task.priority > 1) {
    parts.push(`[priority: ${task.priority}]`);
  }

  if (task.dueString) {
    // Dates are strings, wrap in quotes
    parts.push(`[due: "${task.dueString}"]`);
  }

  if (task.id) {
    // Task IDs are strings like '6X4Vw2Hfmg73Q2XR', wrap in quotes
    parts.push(`[id: "${task.id}"]`);
  }

  if (task.completedDate) {
    parts.push(`[completed: "${task.completedDate}"]`);
  }

  return parts.join(' ');
}

function parseTasks(
  markdownString: string,
  projects: (PersonalProject | WorkspaceProject)[] = [],
): {
  ast: Root;
  tasks: (TaskMetadata & { id: string | null; node: ListItem; tempId?: string })[];
} {
  const ast = processor.parse(markdownString);
  const tasks: (TaskMetadata & { id: string | null; node: ListItem; tempId?: string })[] = [];

  const inboxProject =
    projects.find((p) => (p as PersonalProject).inboxProject) || projects[0] || null;
  let currentProjectId = inboxProject ? inboxProject.id : null;
  const projectNameToId = new Map(projects.map((p) => [p.name.toLowerCase(), p.id]));

  function parseList(
    listNode: List,
    projectId: string | null,
    parentId: string | null = null,
  ): void {
    for (const listItem of listNode.children) {
      if (listItem.type !== 'listItem') continue;

      let firstParaText = '';
      const descriptionLines: string[] = [];
      let subList: List | null = null;
      let id: string | null = null;

      for (const child of listItem.children) {
        if (child.type === 'paragraph') {
          let paraText = '';
          for (const phr of child.children) {
            if ('value' in phr) paraText += phr.value;
          }
          if (!firstParaText) {
            firstParaText = paraText;
          } else {
            descriptionLines.push(paraText);
          }
        } else if (child.type === 'list') {
          subList = child;
        }
      }

      const { content, attributes, tags } = extractTaskProperties(firstParaText);
      id = attributes.id ? String(attributes.id) : null;
      const priority = (attributes.priority as number) || 1;
      const dueString = (attributes.due as string) || null;
      const completedDate = (attributes.completed as string) || null;
      const description = descriptionLines.join('\n');

      if (listItem.checked === null) listItem.checked = false;

      const task = {
        content,
        id,
        checked: !!listItem.checked,
        projectId,
        parentId,
        priority,
        labels: tags,
        dueString,
        completedDate,
        description,
        node: listItem,
      };
      tasks.push(task);

      if (subList) {
        parseList(subList, projectId, id);
      }
    }
  }

  for (const node of ast.children) {
    if (node.type === 'heading' && node.depth === 1) {
      const hNode = node;
      const text = hNode.children
        .map((c: any) => c.value || '')
        .join('')
        .trim()
        .toLowerCase();
      if (projectNameToId.has(text)) {
        currentProjectId = projectNameToId.get(text) ?? null;
      }
    } else if (node.type === 'list') {
      parseList(node, currentProjectId);
    }
  }

  return { ast, tasks };
}

function stringifyTasks(ast: Root): string {
  return processor.stringify(ast).replace(/\\([\[\]])/g, '$1');
}

function applyRemoteChanges(
  ast: Root,
  tasks: (TaskMetadata & { id: string | null; node: ListItem })[],
  remoteTruth: Task[],
  projects: (PersonalProject | WorkspaceProject)[] = [],
): void {
  const taskMap = new Map<string, TaskMetadata & { id: string | null; node: ListItem }>();
  for (const t of tasks) {
    if (t.id) taskMap.set(t.id, t);
  }

  const processedIds = new Set<string>();

  for (const item of remoteTruth) {
    processedIds.add(item.id);
    const task = taskMap.get(item.id);
    const content = formatTaskWithAttributes({
      content: item.content,
      labels: item.labels || [],
      priority: item.priority || 1,
      dueString: item.due?.string || item.due?.date || null,
      completedDate: (item as any).completedAt
        ? (typeof (item as any).completedAt === 'string'
            ? (item as any).completedAt
            : Temporal.Instant.fromEpochMilliseconds(
                new Date((item as any).completedAt).getTime(),
              ).toString()
          ).slice(0, 10)
        : null,
      id: item.id,
    });

    const children: PhrasingContent[] = [{ type: 'text', value: content }];

    if (task) {
      task.node.checked = !!item.checked;
      let firstParaIndex = -1;
      let listIndex = -1;
      for (let i = 0; i < task.node.children.length; i++) {
        const child = task.node.children[i];
        if (child?.type === 'paragraph' && firstParaIndex === -1) firstParaIndex = i;
        else if (child?.type === 'list' && listIndex === -1) listIndex = i;
      }

      if (firstParaIndex !== -1) {
        const firstPara = task.node.children[firstParaIndex] as Paragraph;
        firstPara.children = children;
      }

      const endLimit = listIndex !== -1 ? listIndex : task.node.children.length;
      task.node.children.splice(firstParaIndex + 1, endLimit - (firstParaIndex + 1));

      if (item.description) {
        task.node.children.splice(firstParaIndex + 1, 0, {
          type: 'paragraph',
          children: [{ type: 'text', value: item.description }],
        });
      }

      // Check if anything actually changed to log it
      const changed =
        task.checked !== !!item.checked ||
        task.content !== item.content ||
        task.priority !== (item.priority || 1) ||
        JSON.stringify(task.labels) !== JSON.stringify(item.labels || []) ||
        task.dueString !== (item.due?.string || item.due?.date || null) ||
        task.description !== (item.description || '');

      if (changed) {
        console.log(`[Local] Updating task: "${item.content}" (${item.id})`);
      }
    } else {
      console.log(`[Local] New task: "${item.content}" (${item.id})`);
      let targetParent: Root | List = ast;
      if (item.projectId) {
        const proj = projects.find((p) => p.id === item.projectId);
        if (proj) {
          targetParent = ensureProjectHeading(ast, proj.name);
        }
      }

      const listNode = findMainList(targetParent);
      const newNode: ListItem = {
        type: 'listItem',
        checked: !!item.checked,
        children: [
          {
            type: 'paragraph',
            children,
          },
        ],
      };
      if (item.description) {
        newNode.children.push({
          type: 'paragraph',
          children: [{ type: 'text', value: item.description }],
        });
      }
      listNode.children.push(newNode);
    }
  }

  // Remove tasks that are no longer present in remote truth (and not recently created locally)
  for (const task of tasks) {
    if (task.id && !processedIds.has(task.id)) {
      console.log(`[Local] Removing task: "${task.content}" (${task.id})`);
      const parent = findParent(ast, task.node);
      if (parent) {
        parent.children = parent.children.filter((c: any) => c !== task.node);
      }
    }
  }
}

function ensureProjectHeading(ast: Root, projectName: string): List {
  let foundHeading = null;
  let nextList: List | null = null;

  for (let i = 0; i < ast.children.length; i++) {
    const node = ast.children[i];
    if (node?.type === 'heading' && node.depth === 1) {
      const hNode = node;
      const text = hNode.children
        .map((c: any) => c.value || '')
        .join('')
        .trim()
        .toLowerCase();
      if (text === projectName.toLowerCase()) {
        foundHeading = node;
        const nextNode = ast.children[i + 1];
        if (nextNode?.type === 'list') {
          nextList = nextNode;
        } else {
          nextList = { type: 'list', ordered: false, start: null, spread: false, children: [] };
          ast.children.splice(i + 1, 0, nextList);
        }
        break;
      }
    }
  }

  if (!foundHeading) {
    const heading: Heading = {
      type: 'heading',
      depth: 1,
      children: [{ type: 'text', value: projectName }],
    };
    nextList = { type: 'list', ordered: false, start: null, spread: false, children: [] };
    ast.children.push(heading);
    ast.children.push(nextList);
  }

  return nextList!;
}

function findParent(root: Root, target: ListItem): Parent | null {
  let found: Parent | null = null;
  visit(root, (node: Root | Content) => {
    if ('children' in node && (node.children as unknown[]).includes(target)) {
      found = node as Parent;
    }
  });
  return found;
}

function findMainList(ast: Root | List): List {
  let listNode: List | null = null;
  visit(ast, 'list', (node) => {
    if (!listNode) listNode = node;
  });
  if (!listNode) {
    listNode = { type: 'list', ordered: false, start: null, spread: false, children: [] };
    if ('children' in ast) {
      (ast.children as unknown[]).push(listNode);
    }
  }
  return listNode;
}

async function tick(): Promise<void> {
  console.log(`[${getTimestamp()}] Starting sync tick (Mode: ${SYNC_MODE})...`);
  mkdirSync(OUT_DIR, { recursive: true });
  const state = loadState();

  console.log(`[${getTimestamp()}] Fetching state via sync API...`);
  const syncResult = await api.sync({ resourceTypes: ['items', 'projects'], syncToken: '*' });
  const projects = syncResult.projects || [];
  const activeItems = syncResult.items || [];

  console.log(`[${getTimestamp()}] Fetching completed tasks...`);
  const completedItems = await fetchCompletedTasks(SYNC_COMPLETED_MONTHS);

  const remoteTruth = new Map<string, Task>();

  activeItems.forEach((item) => remoteTruth.set(item.id, item));
  completedItems.forEach((item) => remoteTruth.set(item.id, { ...item, checked: true }));

  console.log(
    `[${getTimestamp()}] Remote truth: ${remoteTruth.size} items, ${projects.length} projects`,
  );

  const inbox = projects.find((p) => (p as PersonalProject).inboxProject) || projects[0] || null;

  const markdownText = existsSync(TASKS_FILE) ? readFileSync(TASKS_FILE, 'utf-8') : '';
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
          if (prevState?.checked !== task.checked) {
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

          const updateArgs: Record<string, any> = { id: task.id };
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
            const targetProjectId = task.projectId || (inbox ? inbox.id : null);
            if (targetProjectId) {
              localCommands.push({
                type: 'item_move',
                // Use parentId if available, otherwise projectId as per SDK union type
                args: task.parentId
                  ? { id: task.id, parentId: task.parentId }
                  : { id: task.id, projectId: targetProjectId },
              });
              console.log(
                `[Todoist] Moving task: "${task.content}" (${task.id}) to ${task.parentId ? 'parent ' + task.parentId : 'project ' + targetProjectId}`,
              );
            }
          }
        }
      } else {
        const tempId = uuidv4();
        task.tempId = tempId;
        tempIdToNode.set(tempId, task.node);

        console.log(`[Todoist] Adding task: "${task.content}"`);
        const commandArgs: Record<string, any> = {
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
          if (!task.completedDate) {
            task.completedDate = Temporal.Now.plainDateISO().toString();
          }
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

  const localChangedIds = new Set(localCommands.map((c) => c.args.id).filter((id) => id));
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
    // In 'two-way' and 'down' modes, apply all remote changes to the local markdown.
    applyRemoteChanges(ast, currentTasks, filteredRemoteChanges, projects);
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
  const { tasks: finalTasks } = parseTasks(finalMarkdown, projects);
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
        console.log(`[${getTimestamp()}] Saving changes to ${TASKS_FILE}...`);
        writeFileSync(TASKS_FILE_TMP, finalMarkdown);
        renameSync(TASKS_FILE_TMP, TASKS_FILE);
      }

      writeFileSync(STATE_FILE_TMP, JSON.stringify(newState, null, 2));
      renameSync(STATE_FILE_TMP, STATE_FILE);
    }
  } else if (SYNC_MODE === 'up') {
    console.log(`[${getTimestamp()}] 'up' mode: Todoist updated, skipping local file updates.`);
  }

  console.log(`[${getTimestamp()}] Sync complete.`);
}

const once = args.includes('--once');
const watch = args.includes('--watch');

if (!once && !watch) {
  console.log(
    'Usage: npx tsx sync.ts [--once] [--watch] [--dir <path>] [--mode <two-way|up|down|dry>]',
  );
  process.exit(1);
}

let tickInProgress = false;
async function guardedTick(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    await tick();
  } catch (err) {
    console.error('Tick failed:', err);
  } finally {
    tickInProgress = false;
  }
}

if (once) {
  await guardedTick();
}

if (watch) {
  let debounceTimer: NodeJS.Timeout;
  if (!existsSync(TASKS_FILE)) {
    writeFileSync(TASKS_FILE, '');
  }
  const watcher = chokidar.watch(TASKS_FILE, { persistent: true });

  watcher.on('change', () => {
    if (Temporal.Now.instant().epochMilliseconds - lastWriteTime < 1000) {
      // 1 second
      // Ignore changes triggered by our own writes
      return;
    }
    console.log(`[${getTimestamp()}] TASKS_FILE changed, debouncing...`);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void guardedTick();
    }, 2000); // 2 seconds
  });

  process.stdin.on('data', () => {
    console.log(`[${getTimestamp()}] Manual resync triggered...`);
    void guardedTick();
  });

  setInterval(
    () => {
      void guardedTick();
    },
    1 * 60 * 1000,
  ); // 1 minute
  await guardedTick();
  console.log(
    `[${getTimestamp()}] Watching ${TASKS_FILE} for changes (press Enter to force sync)...`,
  );
}
