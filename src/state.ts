import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { STATE_FILE, STATE_FILE_TMP, TASKS_FILE, TASKS_FILE_TMP } from './config.js';
import type { LoadedState } from './types.js';

export function loadState(): LoadedState {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as LoadedState;
    } catch (e) {
      console.error('Error parsing state file, resetting state:', e);
    }
  }
  return {
    sync_token: '*',
    localState: {},
  };
}

export function saveState(newState: LoadedState): void {
  writeFileSync(STATE_FILE_TMP, JSON.stringify(newState, null, 2));
  renameSync(STATE_FILE_TMP, STATE_FILE);
}

export function saveTasksFile(markdown: string): void {
  writeFileSync(TASKS_FILE_TMP, markdown);
  renameSync(TASKS_FILE_TMP, TASKS_FILE);
}

export function readTasksFile(): string {
  if (existsSync(TASKS_FILE)) {
    return readFileSync(TASKS_FILE, 'utf-8');
  }
  return '';
}
