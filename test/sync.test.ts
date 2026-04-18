import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Task, Project } from '@doist/todoist-sdk';
import type { LoadedState, SyncCommand, TaskMetadata } from '../src/types.js';

const mockConfig = vi.hoisted(() => ({
  SYNC_MODE: 'two-way',
  DRY_RUN: false,
  OUT_DIR: '/tmp',
  SYNC_COMPLETED_MONTHS: 3,
}));
vi.mock('../src/config.js', () => mockConfig);

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
}));

const { mockApiSync, mockFetchCompletedTasks, mockPushLocalCommands } = vi.hoisted(() => ({
  mockApiSync: vi.fn(),
  mockFetchCompletedTasks: vi.fn(),
  mockPushLocalCommands: vi.fn(),
}));

vi.mock('../src/api.js', () => ({
  api: { sync: (...args: any[]) => mockApiSync(...args) },
  fetchCompletedTasks: (...args: any[]) => mockFetchCompletedTasks(...args),
  pushLocalCommands: (...args: any[]) => mockPushLocalCommands(...args),
}));

const { mockLoadState, mockSaveState, mockReadTasksFile, mockSaveTasksFile } = vi.hoisted(() => ({
  mockLoadState: vi.fn(),
  mockSaveState: vi.fn(),
  mockReadTasksFile: vi.fn(),
  mockSaveTasksFile: vi.fn(),
}));

vi.mock('../src/state.js', () => ({
  loadState: (...args: any[]) => mockLoadState(...args),
  saveState: (...args: any[]) => mockSaveState(...args),
  readTasksFile: (...args: any[]) => mockReadTasksFile(...args),
  saveTasksFile: (...args: any[]) => mockSaveTasksFile(...args),
}));

// We must import tick *after* setting up mocks because of ESM hoisting rules.
import { tick } from '../src/sync.js';

describe('Todoist Sync Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.SYNC_MODE = 'two-way';
    mockConfig.DRY_RUN = false;

    // Default API mocks
    mockApiSync.mockResolvedValue({ projects: [], items: [] });
    mockFetchCompletedTasks.mockResolvedValue([]);
    mockPushLocalCommands.mockResolvedValue({ tempIdMapping: {} });

    // Default state mocks
    mockLoadState.mockReturnValue({ sync_token: '*', localState: {} });
    mockReadTasksFile.mockReturnValue('');
  });

  it('scenario 1: fetches remote tasks and creates local markdown when local is empty', async () => {
    const remoteItem = {
      id: 'task-1',
      content: 'Remote Task',
      projectId: 'proj-1',
      checked: false,
      priority: 1,
      labels: [],
      due: null,
      description: '',
      isCompleted: false,
      parentId: null,
      assigneeId: null,
      assignerId: null,
      commentCount: 0,
      createdAt: '',
      creatorId: 'u-1',
      labelsList: [],
      order: 1,
      sectionId: null,
      url: '',
    } as unknown as Task;
    mockApiSync.mockResolvedValue({
      projects: [{ id: 'proj-1', name: 'Inbox', isShared: false, url: '', color: '', viewStyle: 'list', isFavorite: false }],
      items: [remoteItem],
    });

    await tick();

    // Verifications
    expect(mockSaveTasksFile).toHaveBeenCalledOnce();
    const savedMarkdown = mockSaveTasksFile.mock.calls[0][0] as string;
    expect(savedMarkdown).toContain('Remote Task');
    expect(savedMarkdown).toContain('[id: "task-1"]');

    expect(mockSaveState).toHaveBeenCalledOnce();
    const savedState = mockSaveState.mock.calls[0][0] as LoadedState;
    expect(savedState.localState['task-1']).toStrictEqual({
      content: 'Remote Task',
      projectId: 'proj-1',
      checked: false,
      priority: 1,
      labels: [],
      dueString: null,
      completedDate: null,
      description: '',
      parentId: null
    });
  });

  it('scenario 2: parses local new task and adds to Todoist', async () => {
    mockReadTasksFile.mockReturnValue(`* [ ] Local New Task`);
    mockPushLocalCommands.mockImplementation((commands) => {
      if (commands.length > 0 && commands[0].tempId) {
        return Promise.resolve({ tempIdMapping: { [commands[0].tempId]: 'task-real-1' } });
      }
      return Promise.resolve({ tempIdMapping: {} });
    });
    
    await tick();

    expect(mockPushLocalCommands).toHaveBeenCalledOnce();
    const commands = mockPushLocalCommands.mock.calls[0][0] as SyncCommand[];
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe('item_add');
    expect(commands[0].args.content).toBe('Local New Task');
    
    // Test that the ID mapping was successfully applied to Markdown
    expect(mockSaveTasksFile).toHaveBeenCalledOnce();
    const savedMarkdown = mockSaveTasksFile.mock.calls[0][0] as string;
    expect(savedMarkdown).toContain('[id: "task-real-1"]');
  });

  it('scenario 3: updates remote task properties when changed locally', async () => {
    mockLoadState.mockReturnValue({
      sync_token: '*',
      localState: {
        'task-1': { content: 'Old Task', checked: false, projectId: null, priority: 1, labels: [], dueString: null, description: '', completedDate: null, parentId: null }
      }
    });
    mockReadTasksFile.mockReturnValue(`* [ ] New Title [id: "task-1"]`);
    
    const remoteItem = {
      id: 'task-1', content: 'Old Task', checked: false, projectId: 'proj-1', priority: 1, labels: [], due: null, description: '', isCompleted: false, parentId: null, assigneeId: null, assignerId: null, commentCount: 0, createdAt: '', creatorId: '1', labelsList: [], order: 1, sectionId: null, url: '',
    } as unknown as Task;
    mockApiSync.mockResolvedValue({ projects: [], items: [remoteItem] });

    await tick();

    expect(mockPushLocalCommands).toHaveBeenCalledOnce();
    const commands = mockPushLocalCommands.mock.calls[0][0] as SyncCommand[];
    expect(commands[0].type).toBe('item_update');
    expect(commands[0].args.id).toBe('task-1');
    expect(commands[0].args.content).toBe('New Title');
    
    // Ensure markdown correctly reflects local override
    expect(mockSaveTasksFile).toHaveBeenCalledOnce();
    const savedMarkdown = mockSaveTasksFile.mock.calls[0][0] as string;
    expect(savedMarkdown).toContain('New Title');
  });

  it('scenario 4: marks remote task as completed when checked locally', async () => {
    mockLoadState.mockReturnValue({
      sync_token: '*',
      localState: {
        'task-1': { content: 'Task', checked: false, projectId: null, priority: 1, labels: [], dueString: null, description: '', completedDate: null, parentId: null }
      }
    });
    mockReadTasksFile.mockReturnValue(`* [x] Task [id: "task-1"]`);
    mockApiSync.mockResolvedValue({ projects: [], items: [{ id: 'task-1', content: 'Task', checked: false } as Task] });

    await tick();

    expect(mockPushLocalCommands).toHaveBeenCalledOnce();
    const commands = mockPushLocalCommands.mock.calls[0][0] as SyncCommand[];
    // One command for complete
    expect(commands.find(c => c.type === 'item_complete')).toBeDefined();
    
    // Updates markdown state to include completed date since it was newly completed
    expect(mockSaveTasksFile).toHaveBeenCalledOnce();
    const savedMarkdown = mockSaveTasksFile.mock.calls[0][0] as string;
    expect(savedMarkdown).toMatch(/\[completed: "\d{4}-\d{2}-\d{2}"\]/);
  });

  it('scenario 5: completes local task when marked completed remotely', async () => {
    mockLoadState.mockReturnValue({
      sync_token: '*',
      localState: {
        'task-1': { content: 'Task', checked: false, projectId: null, priority: 1, labels: [], dueString: null, description: '', completedDate: null, parentId: null }
      }
    });
    mockReadTasksFile.mockReturnValue(`* [ ] Task [id: "task-1"]`);
    
    // Mock complete item fetching. Remotely it is checked.
    mockApiSync.mockResolvedValue({ projects: [], items: [] });
    mockFetchCompletedTasks.mockResolvedValue([{ id: 'task-1', content: 'Task', completedAt: new Date().getTime() } as any]);

    await tick();

    expect(mockPushLocalCommands).toHaveBeenCalledWith([]);
    expect(mockSaveTasksFile).toHaveBeenCalledOnce();
    const savedMarkdown = mockSaveTasksFile.mock.calls[0][0] as string;
    expect(savedMarkdown).toContain('* [x] Task');
  });

  it('scenario 6: deletes local task if removed remotely', async () => {
    mockLoadState.mockReturnValue({
      sync_token: '*',
      localState: {
        'task-1': { content: 'Task', checked: false, projectId: null, priority: 1, labels: [], dueString: null, description: '', completedDate: null, parentId: null }
      }
    });
    mockReadTasksFile.mockReturnValue(`* [ ] Task [id: "task-1"]`);
    
    mockApiSync.mockResolvedValue({ projects: [], items: [] });
    mockFetchCompletedTasks.mockResolvedValue([]);

    await tick();

    expect(mockSaveTasksFile).toHaveBeenCalledOnce();
    const savedMarkdown = mockSaveTasksFile.mock.calls[0][0] as string;
    expect(savedMarkdown).toBe(''); // Task should be fully deleted from markdown
  });

  it('scenario 7: pushes item_delete if deleted locally', async () => {
    mockLoadState.mockReturnValue({
      sync_token: '*',
      localState: {
        'task-1': { content: 'Old Task', checked: false, projectId: null, priority: 1, labels: [], dueString: null, description: '', completedDate: null, parentId: null }
      }
    });
    mockReadTasksFile.mockReturnValue(``); // Task disappeared
    
    mockApiSync.mockResolvedValue({ projects: [], items: [{ id: 'task-1', content: 'Old Task', checked: false } as Task] });

    await tick();

    expect(mockPushLocalCommands).toHaveBeenCalledOnce();
    const commands = mockPushLocalCommands.mock.calls[0][0] as SyncCommand[];
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe('item_delete');
    expect(commands[0].args.id).toBe('task-1');
  });

  it('scenario 8: gracefully resolves conflicts when item changed locally and remotely', async () => {
    mockLoadState.mockReturnValue({
      sync_token: '*',
      localState: {
        'task-1': { content: 'Base Content', checked: false, projectId: null, priority: 1, labels: [], dueString: null, description: '', completedDate: null, parentId: null }
      }
    });
    mockReadTasksFile.mockReturnValue(`* [ ] Changed Locally [id: "task-1"]`);
    
    const remoteItem = {
      id: 'task-1', content: 'Changed Remotely', checked: false, projectId: 'proj-1', priority: 1, labels: [], due: null, description: '', isCompleted: false, parentId: null, assigneeId: null, assignerId: null, commentCount: 0, createdAt: '', creatorId: '1', labelsList: [], order: 1, sectionId: null, url: '',
    } as unknown as Task;
    mockApiSync.mockResolvedValue({ projects: [], items: [remoteItem] });

    await tick();

    // In conflict, the local one loses its ID and gets "(Conflict)" suffix.
    // And the remote one is inserted independently.
    expect(mockSaveTasksFile).toHaveBeenCalledOnce();
    const savedMarkdown = mockSaveTasksFile.mock.calls[0][0] as string;
    expect(savedMarkdown).toContain('Changed Locally (Conflict)');
    expect(savedMarkdown).not.toContain('Changed Locally (Conflict) [id:');
    expect(savedMarkdown).toContain('Changed Remotely [id: "task-1"]');
  });

  it('scenario 9: mode down - does not push local changes', async () => {
    mockConfig.SYNC_MODE = 'down';
    mockLoadState.mockReturnValue({
      sync_token: '*',
      localState: {
        'task-1': { content: 'Task', checked: false, projectId: null, priority: 1, labels: [], dueString: null, description: '', completedDate: null, parentId: null }
      }
    });
    mockReadTasksFile.mockReturnValue(`* [ ] Edited Task [id: "task-1"]`);
    
    mockApiSync.mockResolvedValue({ projects: [], items: [{ id: 'task-1', content: 'Task', checked: false } as Task] });

    await tick();

    expect(mockPushLocalCommands).toHaveBeenCalledWith([]); // No commands pushed
  });

  it('scenario 10: mode up - does not save remote updates to markdown', async () => {
    mockConfig.SYNC_MODE = 'up';
    mockReadTasksFile.mockReturnValue(`* [ ] Local New Task`);
    mockPushLocalCommands.mockResolvedValue({ tempIdMapping: { temp_fake: 'task-real-1' } });
    
    await tick();

    expect(mockPushLocalCommands).toHaveBeenCalledOnce();
    expect(mockSaveTasksFile).not.toHaveBeenCalled(); // Skipping local file updates
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('scenario 11: removes duplicate task IDs from local markdown during sync', async () => {
    mockReadTasksFile.mockReturnValue(`* [ ] Duplicate 1 [id: "task-dup"]\n* [ ] Duplicate 2 [id: "task-dup"]`);
    mockApiSync.mockResolvedValue({ projects: [], items: [] });
    
    await tick();
    
    expect(mockSaveTasksFile).toHaveBeenCalledOnce();
    const savedMarkdown = mockSaveTasksFile.mock.calls[0][0] as string;
    const occurrences = (savedMarkdown.match(/task-dup/g) || []).length;
    expect(occurrences).toBe(0);
  });
});
