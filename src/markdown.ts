import { remark } from 'remark';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import { Temporal } from '@js-temporal/polyfill';
import type { Task, PersonalProject, WorkspaceProject } from '@doist/todoist-sdk';
import type {
  Root,
  ListItem,
  List,
  Heading,
  Paragraph,
  PhrasingContent,
  RootContent,
  Parent,
  Text,
} from 'mdast';
import type { ParsedTask } from './types.js';

const processor = remark()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: '*',
    listItemIndent: 'one',
    commonmark: true,
    fences: true,
    resourceLink: true,
  } as const);

export function extractTaskProperties(text: string): {
  content: string;
  attributes: Record<string, string | number>;
  tags: string[];
} {
  let content = text;
  const attributes: Record<string, string | number> = {};
  const tags: string[] = [];

  const attrRegex = /(?:\\\[|\[)(\w+):\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))(?:\\\]|\])/g;
  content = content.replace(
    attrRegex,
    (_match, key: string, q1?: string, q2?: string, unquoted?: string) => {
      const value = q1 ?? q2 ?? unquoted ?? '';
      if (key === 'priority') {
        const val = value.toLowerCase();
        if (val === 'p1') attributes[key] = 4;
        else if (val === 'p2') attributes[key] = 3;
        else if (val === 'p3') attributes[key] = 2;
        else if (val === 'p4') attributes[key] = 1;
        else attributes[key] = parseInt(value, 10);
      } else {
        attributes[key] = value;
      }
      return '';
    },
  );

  const tagRegex = /(^|\s)#([\w/-]+)/g;
  content = content.replace(tagRegex, (_match, space: string, tag: string) => {
    tags.push(tag.trim());
    return space;
  });

  return {
    content: content.trim().replace(/\s+/g, ' '),
    attributes,
    tags,
  };
}

export function formatTaskWithAttributes(task: {
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

  const priorityMap: Record<number, string> = {
    4: 'p1',
    3: 'p2',
    2: 'p3',
    1: 'p4',
  };
  if (task.priority && task.priority > 1) {
    parts.push(`[priority: ${priorityMap[task.priority] || String(task.priority)}]`);
  }

  if (task.dueString) {
    parts.push(`[due: "${task.dueString}"]`);
  }

  if (task.id) {
    parts.push(`[id: "${task.id}"]`);
  }

  if (task.completedDate) {
    parts.push(`[completed: "${task.completedDate}"]`);
  }

  return parts.join(' ');
}

export function parseTasks(
  markdownString: string,
  projects: (PersonalProject | WorkspaceProject)[] = [],
): {
  ast: Root;
  tasks: ParsedTask[];
} {
  const ast = processor.parse(markdownString);
  const tasks: ParsedTask[] = [];

  const inboxProject =
    projects.find((p) => 'inboxProject' in p && p.inboxProject) ?? projects[0] ?? null;
  let currentProjectId = inboxProject ? inboxProject.id : null;
  const projectNameToId = new Map(projects.map((p) => [p.name.toLowerCase(), p.id]));

  function parseList(
    listNode: List,
    projectId: string | null,
    parentId: string | null = null,
  ): void {
    for (const listItem of listNode.children) {
      let firstParaText = '';
      const descriptionLines: string[] = [];
      let subList: List | null = null;
      let id: string | null = null;

      for (const child of listItem.children) {
        if (child.type === 'paragraph') {
          let paraText = '';
          for (const phr of child.children) {
            if ('value' in phr) {
              paraText += (phr as Text).value;
            }
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
      const priority = (attributes.priority as number | undefined) ?? 1;
      const dueString = (attributes.due as string | undefined) ?? null;
      const completedDate = (attributes.completed as string | undefined) ?? null;
      const description = descriptionLines.join('\n');

      if (listItem.checked === null) listItem.checked = false;

      const task: ParsedTask = {
        content,
        id,
        checked: Boolean(listItem.checked),
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
        .map((c) => ('value' in c ? (c as Text).value : ''))
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

export function stringifyTasks(ast: Root): string {
  // eslint-disable-next-line no-useless-escape
  return processor.stringify(ast).replace(/\\([\[\]])/g, '$1');
}

type CompletedTaskDetails = Task & { completedAt?: string | number | Date };

export function applyRemoteChanges(
  ast: Root,
  tasks: ParsedTask[],
  remoteTruth: Task[],
  projects: (PersonalProject | WorkspaceProject)[] = [],
  fullRemoteTruthIds?: Set<string>,
): void {
  const taskMap = new Map<string, ParsedTask>();
  for (const t of tasks) {
    if (t.id) taskMap.set(t.id, t);
  }

  const processedIds = new Set<string>();

  for (const item of remoteTruth) {
    processedIds.add(item.id);
    const task = taskMap.get(item.id);

    const completeItem = item as CompletedTaskDetails;
    let computedCompletedDate: string | null = null;

    if (completeItem.completedAt) {
      if (typeof completeItem.completedAt === 'string') {
        computedCompletedDate = completeItem.completedAt.slice(0, 10);
      } else if (completeItem.completedAt instanceof Date) {
        computedCompletedDate = Temporal.Instant.fromEpochMilliseconds(
          completeItem.completedAt.getTime(),
        )
          .toString()
          .slice(0, 10);
      } else if (typeof completeItem.completedAt === 'number') {
        computedCompletedDate = Temporal.Instant.fromEpochMilliseconds(completeItem.completedAt)
          .toString()
          .slice(0, 10);
      }
    }

    const content = formatTaskWithAttributes({
      content: item.content,
      labels: item.labels,
      priority: item.priority,
      dueString: item.due ? item.due.string || item.due.date : null,
      completedDate: computedCompletedDate,
      id: item.id,
    });

    const children: PhrasingContent[] = [{ type: 'text', value: content }];

    if (task) {
      task.node.checked = item.checked;
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

      const didChange =
        task.checked !== item.checked ||
        task.content !== item.content ||
        task.priority !== item.priority ||
        JSON.stringify(task.labels) !== JSON.stringify(item.labels) ||
        task.dueString !== (item.due ? item.due.string || item.due.date : null) ||
        task.description !== item.description;

      if (didChange) {
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
        checked: item.checked,
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

  for (const task of tasks) {
    const isDuplicate = task.id !== null && taskMap.get(task.id) !== task;
    const isDeletedRemotely = fullRemoteTruthIds 
        ? !fullRemoteTruthIds.has(task.id as string) 
        : !processedIds.has(task.id as string);
        
    if (task.id && (isDeletedRemotely || isDuplicate)) {
      console.log(
        `[Local] Removing ${isDuplicate ? 'duplicate ' : ''}task: "${task.content}" (${task.id})`,
      );
      const parent = findParent(ast, task.node);
      if (parent) {
        parent.children = parent.children.filter((c) => c !== task.node);
      }
    }
  }
}

export function ensureProjectHeading(ast: Root, projectName: string): List {
  let foundHeading = null;
  let nextList: List | null = null;

  for (let i = 0; i < ast.children.length; i++) {
    const node = ast.children[i];
    if (node?.type === 'heading' && node.depth === 1) {
      const hNode = node;
      const text = hNode.children
        .map((c) => ('value' in c ? (c as Text).value : ''))
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

  if (!nextList) throw new Error('Unreachable');
  return nextList;
}

export function findParent(root: Root, target: ListItem): Parent | null {
  let found: Parent | null = null;
  visit(root, (node: RootContent | Root) => {
    if ('children' in node && (node.children as unknown[]).includes(target)) {
      found = node as Parent;
    }
  });
  return found;
}

export function findMainList(ast: Root | List): List {
  let listNode: List | null = null as List | null;
  visit(ast, 'list', (node) => {
    listNode ??= node;
  });
  if (listNode === null) {
    listNode = { type: 'list', ordered: false, start: null, spread: false, children: [] };
    if ('children' in ast) {
      (ast.children as RootContent[]).push(listNode);
    }
  }
  return listNode;
}
