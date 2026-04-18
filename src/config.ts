import 'dotenv/config';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dirFlagIndex = args.indexOf('--dir');
const potentialDir = dirFlagIndex !== -1 ? args[dirFlagIndex + 1] : undefined;

export const OUT_DIR = potentialDir ?? process.cwd();

export const SYNC_MODE =
  (args.includes('--mode')
    ? args[args.indexOf('--mode') + 1]
    : (process.env.SYNC_MODE ?? process.env.MODE)) ?? 'two-way';

export const DRY_RUN = SYNC_MODE === 'dry';

export const TASKS_FILE = join(OUT_DIR, 'TASKS.md');
export const STATE_FILE = join(OUT_DIR, '.todoist-sync-state.json');
export const TASKS_FILE_TMP = `${TASKS_FILE}.tmp`;
export const STATE_FILE_TMP = `${STATE_FILE}.tmp`;
export const SYNC_COMPLETED_MONTHS = parseInt(process.env.SYNC_COMPLETED_MONTHS ?? '3');

const tokenValue = process.env.TODOIST_API_TOKEN;
if (!tokenValue) {
  console.error('TODOIST_API_TOKEN not set');
  process.exit(1);
}
export const TOKEN = tokenValue;

export const ONCE = args.includes('--once');
export const WATCH = args.includes('--watch');
