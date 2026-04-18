import { existsSync, writeFileSync } from 'node:fs';
import chokidar from 'chokidar';
import { Temporal } from '@js-temporal/polyfill';
import { ONCE, WATCH, TASKS_FILE } from './config.js';
import { getTimestamp } from './utils.js';
import { tick, lastWriteTime } from './sync.js';

if (!ONCE && !WATCH) {
  console.log(
    'Usage: npx tsx src/index.ts [--once] [--watch] [--dir <path>] [--mode <two-way|up|down|dry>]',
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

if (ONCE) {
  await guardedTick();
}

if (WATCH) {
  let debounceTimer: ReturnType<typeof setTimeout>;
  if (!existsSync(TASKS_FILE)) {
    writeFileSync(TASKS_FILE, '');
  }
  const watcher = chokidar.watch(TASKS_FILE, { persistent: true });

  watcher.on('change', () => {
    if (Temporal.Now.instant().epochMilliseconds - lastWriteTime < 1000) {
      // Ignore changes triggered by our own writes
      return;
    }
    console.log(`[${getTimestamp()}] TASKS_FILE changed, debouncing...`);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void guardedTick();
    }, 2000);
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
