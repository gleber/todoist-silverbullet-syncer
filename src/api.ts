import { TodoistApi, createCommand } from '@doist/todoist-sdk';
import type { Task } from '@doist/todoist-sdk';
import { Temporal } from '@js-temporal/polyfill';
import fetch from 'node-fetch';
import { TOKEN, DRY_RUN } from './config.js';
import type { SyncCommand } from './types.js';
import { getTimestamp } from './utils.js';

export const api = new TodoistApi(TOKEN, {
  // @ts-expect-error Types of node-fetch and native fetch are slightly different
  customFetch: fetch as unknown as typeof globalThis.fetch,
});

export async function fetchCompletedTasks(monthsBack: number): Promise<Task[]> {
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
    allCompleted = allCompleted.concat(data.items);
    cursor = data.nextCursor ?? null;
  } while (cursor);

  return allCompleted;
}

export async function pushLocalCommands(
  commands: SyncCommand[],
): Promise<{ tempIdMapping: Record<string, string> }> {
  if (commands.length === 0) return { tempIdMapping: {} };

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would push ${String(commands.length)} commands to Todoist.`);
    return { tempIdMapping: {} };
  }

  const syncCommands = commands.map((cmd) => {
    const commandArgs = { ...cmd.args };

    // SDK expects specific shapes for some commands in the Sync API.
    if (cmd.type === 'item_complete' && !commandArgs.completedAt) {
      commandArgs.completedAt = getTimestamp();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createCommand(cmd.type as any, commandArgs, cmd.tempId ?? cmd.temp_id);
  });

  try {
    const response = await api.sync({ commands: syncCommands });
    const rawMapping = response.tempIdMapping ?? {};
    const tempIdMapping: Record<string, string> = {};

    // Restore the mangled mapping keys to our original tempIds
    const originalTempIds = commands.map(c => c.tempId).filter(Boolean) as string[];
    const normalizedMap = new Map<string, string>();
    for (const original of originalTempIds) {
      normalizedMap.set(original.replace(/-/g, '').toLowerCase(), original);
    }

    for (const [key, value] of Object.entries(rawMapping)) {
      const normalizedKey = key.replace(/-/g, '').toLowerCase();
      const original = normalizedMap.get(normalizedKey);
      if (original) {
        tempIdMapping[original] = value;
      } else {
        tempIdMapping[key] = value; // Fallback
      }
    }

    return { tempIdMapping };
  } catch (e) {
    console.error(`[${getTimestamp()}] Sync batch failed:`, e);
    return { tempIdMapping: {} };
  }
}
