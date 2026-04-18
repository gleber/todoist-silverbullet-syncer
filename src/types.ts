import type { ListItem } from 'mdast';

export interface TaskMetadata {
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

export interface LoadedState {
  sync_token: string;
  localState: Record<string, TaskMetadata>;
}

export interface SyncCommand {
  type: string;
  tempId?: string;
  temp_id?: string;
  args: Record<string, unknown>;
}

export type ParsedTask = TaskMetadata & {
  id: string | null;
  node: ListItem;
  tempId?: string;
};
