import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';

type TaskResponse = {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  dependencies: string[];
  subtasks: string[];
  createdAt: string;
  updatedAt: string;
};

const resetDatabase = async () => {
  const statements = [
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 1,
      dependencies TEXT NOT NULL DEFAULT '[]',
      subtasks TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)',
    'CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)',
    'DELETE FROM tasks',
  ];

  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
};

describe('AI Task Master worker', () => {
  beforeEach(async () => {
    await resetDatabase();
    Object.assign(env, {
      AI: {
        run: vi.fn(async () => ({
          response: JSON.stringify({
            analysis: 'Investigated issue.',
            root_cause: 'Root cause summary.',
            recommended_steps: ['Step one', 'Step two'],
            risk_level: 'medium',
          }),
        })),
      } satisfies Ai,
    });
  });

  it('responds with an online status message at the root route', async () => {
    const request = new Request('https://example.com/');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: 'AI Task Master worker is online.',
    });
  });

  it('creates and lists tasks via the API', async () => {
    const createRequest = new Request('https://example.com/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Integration test task',
        description: 'Ensure POST /api/tasks works correctly.',
        priority: 2,
      }),
    });

    const createCtx = createExecutionContext();
    const createResponse = await worker.fetch(createRequest, env, createCtx);
    await waitOnExecutionContext(createCtx);

    expect(createResponse.status).toBe(201);

    const listResponse = await SELF.fetch(new Request('https://example.com/api/tasks'));
    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json<{ tasks: TaskResponse[] }>();
    expect(listPayload.tasks).toHaveLength(1);
    const [createdTask] = listPayload.tasks;
    expect(createdTask.title).toBe('Integration test task');
    expect(createdTask.priority).toBe(2);
  });

  it('resolves issues using the AI binding stub', async () => {
    const createRequest = new Request('https://example.com/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Task needing help' }),
    });
    const createCtx = createExecutionContext();
    const createResponse = await worker.fetch(createRequest, env, createCtx);
    await waitOnExecutionContext(createCtx);
    const taskListResponse = await SELF.fetch(new Request('https://example.com/api/tasks'));
    const { tasks } = await taskListResponse.json<{ tasks: TaskResponse[] }>();
    const targetTask = tasks[0];

    const resolveRequest = new Request(`https://example.com/api/tasks/${targetTask.id}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ issue: 'The task is blocked' }),
    });
    const resolveCtx = createExecutionContext();
    const resolveResponse = await worker.fetch(resolveRequest, env, resolveCtx);
    await waitOnExecutionContext(resolveCtx);

    expect(resolveResponse.status).toBe(200);
    const { resolution } = await resolveResponse.json<{
      resolution: {
        analysis: string;
        rootCause: string | null;
        recommendedSteps: string[];
        riskLevel: string | null;
        model: string;
        raw: string;
      };
    }>();

    expect(resolution.analysis).toContain('Investigated issue');
    expect(resolution.recommendedSteps).toContain('Step one');
    expect(resolution.model).toBe('@cf/meta/llama-3.1-8b-instruct');
    expect(vi.mocked(env.AI.run)).toHaveBeenCalled();
  });
});
