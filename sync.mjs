import 'dotenv/config';
import { writeFileSync, readFileSync, appendFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN = process.env.TODOIST_API_TOKEN;
if (!TOKEN) { console.error('TODOIST_API_TOKEN not set'); process.exit(1); }

const API = 'https://api.todoist.com/api/v1';
const hdrs = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const OUT_DIR = join(homedir(), 'Documents', 'Todoist');
const HISTORY_DIR = join(OUT_DIR, 'history');

async function getAll(endpoint) {
  let results = [], cursor = null;
  do {
    const url = cursor ? `${API}${endpoint}?cursor=${cursor}` : `${API}${endpoint}`;
    const res = await fetch(url, { headers: hdrs });
    if (!res.ok) throw new Error(`${endpoint}: ${res.status} ${res.statusText}`);
    const data = await res.json();
    results.push(...data.results);
    cursor = data.next_cursor;
  } while (cursor);
  return results;
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${endpoint}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function apiUpload(filePath) {
  const fileName = basename(filePath);
  const fileData = readFileSync(filePath);
  const boundary = '----FormBoundary' + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header), fileData, Buffer.from(footer)]);
  const res = await fetch(`${API}/uploads`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`/uploads: ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiDelete(endpoint) {
  const res = await fetch(`${API}${endpoint}`, { method: 'DELETE', headers: hdrs });
  if (!res.ok) throw new Error(`${endpoint}: ${res.status} ${await res.text()}`);
}

// --- UPDATE.md parser ---

function parseUpdates(text) {
  return text.split(/^---$/m)
    .map(b => b.trim())
    .filter(b => b && !b.startsWith('#'))
    .map(block => {
      const action = {};
      for (const line of block.split('\n')) {
        const m = line.match(/^(\w[\w_]*):\s*(.+)$/);
        if (m) action[m[1]] = m[2].trim().replace(/\\n/g, '\n');
      }
      return action;
    })
    .filter(a => a.action);
}

function mergeUpdates(actions) {
  const merged = [];
  const updatesByTask = new Map();

  for (const act of actions) {
    if (act.action === 'update' && act.task) {
      const key = `${(act.task || '').toLowerCase()}|${(act.project || '').toLowerCase()}`;
      if (updatesByTask.has(key)) {
        const existing = updatesByTask.get(key);
        for (const [k, v] of Object.entries(act)) {
          if (k === 'add_labels' && existing[k]) {
            existing[k] = `${existing[k]}, ${v}`;
          } else {
            existing[k] = v;
          }
        }
      } else {
        const copy = { ...act };
        updatesByTask.set(key, copy);
        merged.push(copy);
      }
    } else {
      merged.push(act);
    }
  }
  return merged;
}

function findTask(tasks, projects, query, projectName) {
  let candidates = tasks.filter(t =>
    t.content.toLowerCase().includes(query.toLowerCase())
  );
  if (projectName) {
    const proj = projects.find(p => p.name.toLowerCase() === projectName.toLowerCase());
    if (proj) candidates = candidates.filter(t => t.project_id === proj.id);
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return { error: 'No matching task found' };
  return { error: `Ambiguous: ${candidates.length} matches` };
}

async function processUpdates(tasks, projects, sections) {
  const updatePath = join(OUT_DIR, 'UPDATE.md');
  if (!existsSync(updatePath)) return;

  const raw = readFileSync(updatePath, 'utf-8').trim();
  if (!raw) return;

  const actions = mergeUpdates(parseUpdates(raw));
  if (!actions.length) return;

  const results = [];
  const failed = [];

  for (const act of actions) {
    const entry = { ...act, timestamp: new Date().toISOString() };
    try {
      switch (act.action) {
        case 'complete': {
          const match = findTask(tasks, projects, act.task, act.project);
          if (match.error) throw new Error(match.error);
          const labels = new Set(match.labels);
          labels.add('@ai');
          labels.add('@ai-done');
          await apiPost(`/tasks/${match.id}`, { labels: [...labels] });
          entry.status = '✓';
          entry.task_id = match.id;
          break;
        }
        case 'create': {
          const body = { content: act.content, labels: ['@ai'] };
          if (act.project) {
            const proj = projects.find(p => p.name.toLowerCase() === act.project.toLowerCase());
            if (proj) body.project_id = proj.id;
            else throw new Error(`Project not found: ${act.project}`);
          }
          if (act.section) {
            const sec = sections.find(s =>
              s.name.toLowerCase() === act.section.toLowerCase() &&
              (!body.project_id || s.project_id === body.project_id)
            );
            if (sec) { body.section_id = sec.id; body.project_id = sec.project_id; }
            else throw new Error(`Section not found: ${act.section}`);
          }
          if (act.parent) {
            const parentMatch = findTask(tasks, projects, act.parent, act.project);
            if (parentMatch.error) throw new Error(`Parent: ${parentMatch.error}`);
            body.parent_id = parentMatch.id;
          }
          if (act.due) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(act.due)) body.due_date = act.due;
            else body.due_string = act.due;
          }
          if (act.priority) body.priority = 5 - parseInt(act.priority);
          if (act.description) body.description = act.description;
          if (act.labels) {
            const extra = act.labels.split(',').map(l => l.trim());
            body.labels = [...new Set([...body.labels, ...extra])];
          }
          const created = await apiPost('/tasks', body);
          entry.status = '✓';
          entry.task_id = created.id;
          break;
        }
        case 'update': {
          const match = findTask(tasks, projects, act.task, act.project);
          if (match.error) throw new Error(match.error);
          const body = {};
          const labels = match.labels.includes('@ai') ? [...match.labels] : [...match.labels, '@ai'];
          if (act.set_content) body.content = act.set_content;
          if (act.set_due) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(act.set_due)) body.due_date = act.set_due;
            else body.due_string = act.set_due;
          }
          if (act.set_priority) body.priority = 5 - parseInt(act.set_priority);
          if (act.set_description) body.description = act.set_description;
          // Move requires a separate API call
          const moveBody = {};
          if (act.set_project) {
            const proj = projects.find(p => p.name.toLowerCase() === act.set_project.toLowerCase());
            if (!proj) throw new Error(`Project not found: ${act.set_project}`);
            moveBody.project_id = proj.id;
          }
          if (act.set_section) {
            const targetProjectId = moveBody.project_id || match.project_id;
            const sec = sections.find(s =>
              s.name.toLowerCase() === act.set_section.toLowerCase() &&
              s.project_id === targetProjectId
            );
            if (!sec) throw new Error(`Section not found: ${act.set_section}`);
            moveBody.section_id = sec.id;
          }
          if (Object.keys(moveBody).length) {
            await apiPost(`/tasks/${match.id}/move`, moveBody);
          }
          if (act.add_labels) {
            const extra = act.add_labels.split(',').map(l => l.trim());
            labels.push(...extra);
          }
          body.labels = [...new Set(labels)];
          await apiPost(`/tasks/${match.id}`, body);
          entry.status = '✓';
          entry.task_id = match.id;
          break;
        }
        case 'delete': {
          const match = findTask(tasks, projects, act.task, act.project);
          if (match.error) throw new Error(match.error);
          await apiDelete(`/tasks/${match.id}`);
          entry.status = '✓';
          entry.task_id = match.id;
          break;
        }
        case 'attach': {
          const match = findTask(tasks, projects, act.task, act.project);
          if (match.error) throw new Error(match.error);
          if (!act.file) throw new Error('Missing file path');
          if (!existsSync(act.file)) throw new Error(`File not found: ${act.file}`);
          const upload = await apiUpload(act.file);
          await apiPost('/comments', {
            task_id: match.id,
            content: act.comment || 'Attached file',
            attachment: {
              file_name: upload.file_name,
              file_url: upload.file_url,
              file_type: upload.file_type,
              file_size: upload.file_size,
              resource_type: upload.resource_type,
            },
          });
          const labels = new Set(match.labels);
          labels.add('@ai');
          await apiPost(`/tasks/${match.id}`, { labels: [...labels] });
          entry.status = '✓';
          entry.task_id = match.id;
          break;
        }
        default:
          throw new Error(`Unknown action: ${act.action}`);
      }
      results.push(entry);
    } catch (err) {
      entry.status = '✗';
      entry.error = err.message;
      results.push(entry);
      failed.push(act);
    }
  }

  // Write history
  mkdirSync(HISTORY_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let historyMd = `# Executed: ${ts}\n`;
  for (const r of results) {
    historyMd += `\n## ${r.status} ${r.action}: ${r.task || r.content || '?'}\n`;
    if (r.task_id) historyMd += `Task ID: ${r.task_id}\n`;
    if (r.project) historyMd += `Project: ${r.project}\n`;
    if (r.reason) historyMd += `Reason: ${r.reason}\n`;
    if (r.error) historyMd += `Error: ${r.error}\n`;
  }
  writeFileSync(join(HISTORY_DIR, `${ts}.md`), historyMd);

  // Clear UPDATE.md — failures are logged in history
  writeFileSync(updatePath, '# Todoist Updates\n');

  const ok = results.filter(r => r.status === '✓').length;
  const fail = results.filter(r => r.status === '✗').length;
  console.error(`  Updates: ${ok} succeeded, ${fail} failed → history/${ts}.md`);
}

// --- LIST.md renderer ---

const priorityLabel = (p) => p > 1 ? `**P${5 - p}** ` : '';

function renderTask(task, childrenMap, depth = 0) {
  const indent = '  '.repeat(depth);
  const pri = priorityLabel(task.priority);
  let lines = [`${indent}- [ ] ${pri}${task.content}`];

  if (task.due) {
    const recur = task.due.is_recurring ? ` (${task.due.string})` : '';
    lines.push(`${indent}  Due: ${task.due.date}${recur}`);
  }
  if (task.labels.length) {
    lines.push(`${indent}  Labels: ${task.labels.join(', ')}`);
  }
  if (task.description) {
    lines.push(`${indent}  ${task.description}`);
  }

  const children = childrenMap.get(task.id) || [];
  children.sort((a, b) => a.child_order - b.child_order);
  for (const child of children) {
    lines.push(renderTask(child, childrenMap, depth + 1));
  }

  return lines.join('\n');
}

function renderList(projects, tasks, sections) {
  const sectionsByProject = new Map();
  for (const s of sections) {
    if (!sectionsByProject.has(s.project_id)) sectionsByProject.set(s.project_id, []);
    sectionsByProject.get(s.project_id).push(s);
  }
  for (const arr of sectionsByProject.values()) arr.sort((a, b) => a.section_order - b.section_order);

  const childrenMap = new Map();
  const rootTasks = [];
  for (const t of tasks) {
    if (t.parent_id) {
      if (!childrenMap.has(t.parent_id)) childrenMap.set(t.parent_id, []);
      childrenMap.get(t.parent_id).push(t);
    } else {
      rootTasks.push(t);
    }
  }

  const tasksByProject = new Map();
  for (const t of rootTasks) {
    if (!tasksByProject.has(t.project_id)) tasksByProject.set(t.project_id, []);
    tasksByProject.get(t.project_id).push(t);
  }
  for (const arr of tasksByProject.values()) arr.sort((a, b) => a.child_order - b.child_order);

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let md = `# Todoist Tasks\n\n_Synced: ${now}_\n`;

  const sortedProjects = projects
    .filter(p => tasksByProject.has(p.id))
    .sort((a, b) => a.child_order - b.child_order);

  for (const project of sortedProjects) {
    md += `\n## ${project.name}\n\n`;
    const projectTasks = tasksByProject.get(project.id) || [];
    const projectSections = sectionsByProject.get(project.id) || [];

    const noSection = projectTasks.filter(t => !t.section_id);
    if (noSection.length) {
      md += noSection.map(t => renderTask(t, childrenMap)).join('\n\n') + '\n';
    }

    for (const section of projectSections) {
      const sectionTasks = projectTasks.filter(t => t.section_id === section.id);
      if (!sectionTasks.length) continue;
      md += `\n### ${section.name}\n\n`;
      md += sectionTasks.map(t => renderTask(t, childrenMap)).join('\n\n') + '\n';
    }
  }

  return { md, now, count: tasks.length };
}

// --- Main ---

try {
  mkdirSync(OUT_DIR, { recursive: true });

  const [projects, tasks, sections] = await Promise.all([
    getAll('/projects'),
    getAll('/tasks'),
    getAll('/sections'),
  ]);

  // Process updates first (before re-syncing list)
  await processUpdates(tasks, projects, sections);

  // Re-fetch after updates to get fresh state
  const [freshProjects, freshTasks, freshSections] = await Promise.all([
    getAll('/projects'),
    getAll('/tasks'),
    getAll('/sections'),
  ]);

  const { md, now, count } = renderList(freshProjects, freshTasks, freshSections);
  writeFileSync(join(OUT_DIR, 'LIST.md'), md);

  // Append to run log
  appendFileSync(join(import.meta.dirname, 'log.txt'), `${now} — ${count} tasks\n`);

  console.error(`[${now}] Synced ${count} tasks to ${join(OUT_DIR, 'LIST.md')}`);
} catch (err) {
  console.error('Sync failed:', err.message);
  process.exit(1);
}
