import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectNamespace, DurableObjectState, R2Bucket, WebSocket } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { validator } from 'hono/validator';

// The merged Env interface requires bindings from both branches.
interface Env {
  DB: D1Database;
  WEBSOCKET_SERVER: DurableObjectNamespace<WebSocketServer>;
  AI: Ai;
  CODE_BUCKET: R2Bucket;
  CODE_GENERATOR: DurableObjectNamespace<CodeGeneratorDO>;
}

// Types and helpers from codex/complete-epic-0002-and-update-tasks
type TaskRow = {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  dependencies: string | null;
  subtasks: string | null;
  created_at: string;
  updated_at: string;
};

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

type TaskPayload = {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: number;
  dependencies?: unknown;
  subtasks?: unknown;
};

type TaskUpdateBody = {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: number;
  dependencies?: string[];
  subtasks?: string[];
};

type TaskStatusUpdateBody = {
  status: string;
};

type TaskListQuery = {
  page: number;
  limit: number;
  status?: string;
  priority?: number;
  search?: string;
};

type TaskListResponse = {
  success: true;
  data: {
    tasks: TaskResponse[];
  };
  tasks: TaskResponse[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
};

type TaskItemResponse = {
  success: true;
  data: {
    task: TaskResponse;
  };
  task: TaskResponse;
};

type McpRequest = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: string | number | null;
};

type McpSuccessResponse = {
  jsonrpc: '2.0';
  result: {
    status: 'ok';
    version: string;
    capabilities: string[];
  };
  id: string | number | null;
};

type McpErrorResponse = {
  jsonrpc: '2.0';
  error: {
    code: number;
    message: string;
  };
  id: string | number | null;
};

type CodeGenerationJobStatus = 'queued' | 'running' | 'completed' | 'failed';

type CodeGenerationJobRecord = {
  jobId: string;
  taskId: number;
  status: CodeGenerationJobStatus;
  createdAt: string;
  updatedAt: string;
  progress: number;
  resultKey?: string;
  error?: string;
  taskSnapshot?: TaskResponse | null;
  metadata?: Record<string, unknown>;
};

type StartGenerationPayload = {
  jobId: string;
  taskId: number;
  task?: TaskResponse;
  initiator?: string;
  options?: Record<string, unknown>;
};

type PersistedArtifact = {
  content: string | ArrayBuffer | ReadableStream;
  extension?: string;
  contentType?: string;
  metadata?: Record<string, string>;
};

const JOB_KEY_PREFIX = 'job:';

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item)).filter((item) => item.length > 0);
};

const safeParseJsonArray = (value: string | null): string[] => {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
};

const mapRowToResponse = (row: TaskRow): TaskResponse => ({
  id: row.id,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: row.priority,
  dependencies: safeParseJsonArray(row.dependencies),
  subtasks: safeParseJsonArray(row.subtasks),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// From main branch
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type AppContext = Context<{ Bindings: Env }>;

const bufferToHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const createStrongEtag = async (payload: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(payload));
  return `"${bufferToHex(digest)}"`;
};

const matchesEtag = (header: string | null, etag: string): boolean => {
  if (!header) {
    return false;
  }

  const candidates = header.split(',').map((value) => value.trim());
  return candidates.includes('*') || candidates.includes(etag);
};

const respondWithJson = async <T>(
  c: AppContext,
  payload: T,
  status = 200,
  cacheSeconds = 60,
): Promise<Response> => {
  const serialized = JSON.stringify(payload);
  const etag = await createStrongEtag(serialized);

  if (matchesEtag(c.req.header('If-None-Match'), etag)) {
    const notModified = c.body(null, 304);
    notModified.headers.set('ETag', etag);
    if (cacheSeconds > 0) {
      notModified.headers.set('Cache-Control', `public, max-age=${cacheSeconds}`);
    }
    return notModified;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ETag: etag,
  };

  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  }

  return c.newResponse(serialized, status, headers);
};

const app = new Hono<{ Bindings: Env }>();

app.use(
  '/api/*',
  cors({
    origin: ['http://localhost:3000', 'https://yourdomain.com'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);

const TASK_ROOM = 'tasks';

type TaskBroadcastMessage = {
  roomId?: string;
  type: 'task_update';
  action: 'created' | 'updated' | 'deleted';
  taskId: number;
  task?: TaskResponse | null;
};

type TaskParam = {
  id: number;
};

const taskParamValidator = validator('param', (value): TaskParam => {
  const id = Number(value?.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new HTTPException(400, { message: 'Task ID must be a positive integer.' });
  }

  return { id };
});

const listQueryValidator = validator('query', (value): TaskListQuery => {
  const rawPage = value?.page ?? '1';
  const rawLimit = value?.limit ?? '20';

  const page = Number.parseInt(rawPage, 10);
  if (!Number.isFinite(page) || page < 1) {
    throw new HTTPException(400, { message: 'Invalid page parameter. Page must be a positive integer.' });
  }

  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new HTTPException(400, { message: 'Invalid limit parameter. Limit must be a positive integer.' });
  }

  const sanitized: TaskListQuery = {
    page,
    limit: Math.min(limit, 100),
  };

  if (typeof value?.status === 'string' && value.status.trim().length > 0) {
    sanitized.status = value.status.trim();
  }

  if (typeof value?.priority === 'string' && value.priority.trim().length > 0) {
    const parsedPriority = Number(value.priority);
    if (!Number.isFinite(parsedPriority)) {
      throw new HTTPException(400, { message: 'Invalid priority parameter. Priority must be numeric.' });
    }
    sanitized.priority = parsedPriority;
  }

  if (typeof value?.search === 'string' && value.search.trim().length > 0) {
    sanitized.search = value.search.trim();
  }

  return sanitized;
});

const updateTaskBodyValidator = validator('json', (value): TaskUpdateBody => {
  if (!value || typeof value !== 'object') {
    throw new HTTPException(400, { message: 'Request body must be a JSON object.' });
  }

  const payload = value as Record<string, unknown>;
  const sanitized: TaskUpdateBody = {};

  if ('title' in payload) {
    if (typeof payload.title !== 'string' || payload.title.trim().length === 0) {
      throw new HTTPException(400, { message: 'Title must be a non-empty string when provided.' });
    }
    sanitized.title = payload.title.trim();
  }

  if ('description' in payload) {
    const description = payload.description;
    if (description !== null && typeof description !== 'string') {
      throw new HTTPException(400, { message: 'Description must be a string or null.' });
    }
    sanitized.description = description === null ? null : description.trim();
  }

  if ('status' in payload) {
    if (typeof payload.status !== 'string' || payload.status.trim().length === 0) {
      throw new HTTPException(400, { message: 'Status must be a non-empty string when provided.' });
    }
    sanitized.status = payload.status.trim();
  }

  if ('priority' in payload) {
    const priority = Number(payload.priority);
    if (!Number.isFinite(priority)) {
      throw new HTTPException(400, { message: 'Priority must be a valid number.' });
    }
    sanitized.priority = priority;
  }

  if ('dependencies' in payload) {
    if (!Array.isArray(payload.dependencies)) {
      throw new HTTPException(400, { message: 'Dependencies must be an array of strings.' });
    }
    sanitized.dependencies = payload.dependencies.map((item) => String(item)).filter((item) => item.trim().length > 0);
  }

  if ('subtasks' in payload) {
    if (!Array.isArray(payload.subtasks)) {
      throw new HTTPException(400, { message: 'Subtasks must be an array of strings.' });
    }
    sanitized.subtasks = payload.subtasks.map((item) => String(item)).filter((item) => item.trim().length > 0);
  }

  if (Object.keys(sanitized).length === 0) {
    throw new HTTPException(400, { message: 'No valid fields provided for update.' });
  }

  return sanitized;
});

const statusBodyValidator = validator('json', (value): TaskStatusUpdateBody => {
  if (!value || typeof value !== 'object') {
    throw new HTTPException(400, { message: 'Request body must be a JSON object.' });
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.status !== 'string' || payload.status.trim().length === 0) {
    throw new HTTPException(400, { message: 'Status is required and must be a non-empty string.' });
  }

  return { status: payload.status.trim() };
});

const broadcastTaskUpdate = async (env: Env, message: TaskBroadcastMessage): Promise<void> => {
  try {
    const stub = env.WEBSOCKET_SERVER.getByName('broadcast');
    await stub.fetch('https://do.websocket/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...message, roomId: message.roomId ?? TASK_ROOM }),
    });
  } catch (error) {
    console.error('Failed to broadcast task update', error);
  }
};

// Using the root route from 'main'
app.get('/', (c) =>
  c.json({
    message: 'AI Task Master worker is online.',
  }),
);

// --- Task API routes from codex/complete-epic-0002-and-update-tasks ---
app.get('/api/tasks', listQueryValidator, async (c) => {
  const { page, limit, status, priority, search } = c.req.valid('query');

  const conditions: string[] = [];
  const filterBindings: unknown[] = [];

  if (status) {
    conditions.push('status = ?');
    filterBindings.push(status);
  }

  if (priority !== undefined) {
    conditions.push('priority = ?');
    filterBindings.push(priority);
  }

  if (search) {
    conditions.push('(title LIKE ? OR description LIKE ?)');
    const searchTerm = `%${search}%`;
    filterBindings.push(searchTerm, searchTerm);
  }

  const whereClause = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const listStmt = c.env.DB.prepare(
    `SELECT * FROM tasks${whereClause} ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...filterBindings, limit, offset);

  const countStmt = c.env.DB.prepare(`SELECT COUNT(*) as total FROM tasks${whereClause}`).bind(
    ...filterBindings,
  );

  const [{ results }, countRow] = await Promise.all([
    listStmt.all<TaskRow>(),
    countStmt.first<{ total: number }>(),
  ]);

  const total = countRow?.total ?? 0;
  const tasks = (results ?? []).map(mapRowToResponse);
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  const response: TaskListResponse = {
    success: true,
    data: {
      tasks,
    },
    tasks,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasMore: page * limit < total,
    },
  };

  return respondWithJson(c, response);
});

app.get('/api/tasks/:id', taskParamValidator, async (c) => {
  const { id } = c.req.valid('param');

  const stmt = c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id);
  const task = await stmt.first<TaskRow>();
  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const taskResponse = mapRowToResponse(task);

  const response: TaskItemResponse = {
    success: true,
    data: {
      task: taskResponse,
    },
    task: taskResponse,
  };

  return respondWithJson(c, response);
});

app.post('/api/tasks', async (c) => {
  let payload: TaskPayload;
  try {
    payload = await c.req.json<TaskPayload>();
  } catch (error) {
    console.error('Failed to parse JSON body for POST /api/tasks', error);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!payload.title || !payload.title.trim()) {
    return c.json({ error: 'Task title is required' }, 400);
  }

  const title = payload.title.trim();
  const description = payload.description ?? null;
  const status = payload.status?.trim() || 'pending';
  const priority = Number(payload.priority ?? 1);
  if (!Number.isFinite(priority)) {
    return c.json({ error: 'Priority must be a valid number' }, 400);
  }

  const dependencies = JSON.stringify(toStringArray(payload.dependencies));
  const subtasks = JSON.stringify(toStringArray(payload.subtasks));

  const insertStmt = c.env.DB.prepare(
    `INSERT INTO tasks (title, description, status, priority, dependencies, subtasks)
      VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(title, description, status, priority, dependencies, subtasks);

  const result = await insertStmt.run();
  if (!result.success) {
    console.error('Failed to insert task', result);
    return c.json({ error: 'Failed to create task' }, 500);
  }

  const taskId = Number(result.lastInsertRowId);
  const taskStmt = c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId);
  const task = await taskStmt.first<TaskRow>();
  const responseTask = task ? mapRowToResponse(task) : null;

  if (responseTask) {
    const broadcastPromise = broadcastTaskUpdate(c.env, {
      type: 'task_update',
      action: 'created',
      taskId,
      task: responseTask,
    });

    if (c.executionCtx) {
      c.executionCtx.waitUntil(broadcastPromise);
    } else {
      broadcastPromise.catch((error) => {
        console.error('Failed to dispatch creation broadcast', error);
      });
    }
  }

  return c.json({ task: responseTask }, 201);
});

app.put('/api/tasks/:id', taskParamValidator, updateTaskBodyValidator, async (c) => {
  const { id } = c.req.valid('param');
  const payload = c.req.valid('json') as TaskUpdateBody;

  const updates: string[] = [];
  const bindings: unknown[] = [];

  if (payload.title !== undefined) {
    updates.push('title = ?');
    bindings.push(payload.title);
  }

  if (payload.description !== undefined) {
    updates.push('description = ?');
    bindings.push(payload.description ?? null);
  }

  if (payload.status !== undefined) {
    updates.push('status = ?');
    bindings.push(payload.status);
  }

  if (payload.priority !== undefined) {
    updates.push('priority = ?');
    bindings.push(payload.priority);
  }

  if (payload.dependencies !== undefined) {
    updates.push('dependencies = ?');
    bindings.push(JSON.stringify(payload.dependencies));
  }

  if (payload.subtasks !== undefined) {
    updates.push('subtasks = ?');
    bindings.push(JSON.stringify(payload.subtasks));
  }

  if (!updates.length) {
    return c.json({ error: 'No valid fields provided for update' }, 400);
  }

  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  const updateSql = `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`;
  const updateStmt = c.env.DB.prepare(updateSql).bind(...bindings, id);
  const result = await updateStmt.run();

  if (!result.success) {
    console.error('Failed to update task', result);
    return c.json({ error: 'Failed to update task' }, 500);
  }

  if (result.changes === 0) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const taskStmt = c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id);
  const task = await taskStmt.first<TaskRow>();
  if (!task) {
    return c.json({ error: 'Task not found after update' }, 404);
  }

  const responseTask = mapRowToResponse(task);
  const broadcastPromise = broadcastTaskUpdate(c.env, {
    type: 'task_update',
    action: 'updated',
    taskId: id,
    task: responseTask,
  });

  if (c.executionCtx) {
    c.executionCtx.waitUntil(broadcastPromise);
  } else {
    broadcastPromise.catch((error) => {
      console.error('Failed to dispatch update broadcast', error);
    });
  }

  return c.json({ task: responseTask });
});

app.delete('/api/tasks/:id', taskParamValidator, async (c) => {
  const { id } = c.req.valid('param');

  const existingStmt = c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id);
  const existingTask = await existingStmt.first<TaskRow>();
  if (!existingTask) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const deleteStmt = c.env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id);
  const result = await deleteStmt.run();

  if (!result.success) {
    console.error('Failed to delete task', result);
    return c.json({ error: 'Failed to delete task' }, 500);
  }

  if (result.changes === 0) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const broadcastPromise = broadcastTaskUpdate(c.env, {
    type: 'task_update',
    action: 'deleted',
    taskId: id,
    task: mapRowToResponse(existingTask),
  });

  if (c.executionCtx) {
    c.executionCtx.waitUntil(broadcastPromise);
  } else {
    broadcastPromise.catch((error) => {
      console.error('Failed to dispatch delete broadcast', error);
    });
  }

  return c.json({ success: true });
});

app.post('/api/tasks/:id/status', taskParamValidator, statusBodyValidator, async (c) => {
  const { id } = c.req.valid('param');
  const { status } = c.req.valid('json') as TaskStatusUpdateBody;

  const existingStmt = c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id);
  const existingTask = await existingStmt.first<TaskRow>();
  if (!existingTask) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const updateStmt = c.env.DB.prepare(
    "UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).bind(status, id);
  const updateResult = await updateStmt.run();

  if (!updateResult.success) {
    console.error('Failed to update task status', updateResult);
    return c.json({ error: 'Failed to update task status' }, 500);
  }

  const refreshedStmt = c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id);
  const refreshedTask = await refreshedStmt.first<TaskRow>();
  if (!refreshedTask) {
    return c.json({ error: 'Task not found after status update' }, 404);
  }

  const responseTask = mapRowToResponse(refreshedTask);
  const broadcastPromise = broadcastTaskUpdate(c.env, {
    type: 'task_update',
    action: 'updated',
    taskId: id,
    task: responseTask,
  });

  if (c.executionCtx) {
    c.executionCtx.waitUntil(broadcastPromise);
  } else {
    broadcastPromise.catch((error) => {
      console.error('Failed to broadcast task status update', error);
    });
  }

  return c.json({
    success: true,
    data: {
      task: responseTask,
    },
  });
});

app.post('/api/tasks/:id/resolve', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Task ID must be an integer' }, 400);
  }

  let payload: { issue?: string };
  try {
    payload = await c.req.json<{ issue?: string }>();
  } catch (error) {
    console.error('Failed to parse JSON body for POST /api/tasks/:id/resolve', error);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const issue = payload.issue?.trim();
  if (!issue) {
    return c.json({ error: 'Issue description is required' }, 400);
  }

  const taskStmt = c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id);
  const task = await taskStmt.first<TaskRow>();
  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const taskDetails = mapRowToResponse(task);
  const prompt = [
    'You are the AI Task Master assistant helping engineers resolve issues.',
    'Analyze the task details and the reported issue. Provide actionable recommendations.',
    '',
    `Task ID: ${taskDetails.id}`,
    `Title: ${taskDetails.title}`,
    `Description: ${taskDetails.description ?? 'No description provided.'}`,
    `Status: ${taskDetails.status}`,
    `Priority: ${taskDetails.priority}`,
    `Dependencies: ${taskDetails.dependencies.length ? taskDetails.dependencies.join(', ') : 'None'}`,
    `Subtasks: ${taskDetails.subtasks.length ? taskDetails.subtasks.join(', ') : 'None'}`,
    '',
    `Issue reported: ${issue}`,
    '',
    'Respond with a strict JSON object containing the keys:',
    "analysis (string)",
    "root_cause (string)",
    "recommended_steps (array of strings in execution order)",
    "risk_level (string with one of: low, medium, high)",
    'The JSON must be valid and should not include any additional commentary.',
  ].join('\n');

  let aiResponse: { response?: string };
  try {
    aiResponse = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', { prompt });
  } catch (error) {
    console.error('Workers AI resolve request failed', error);
    return c.json({ error: 'Failed to analyze issue with AI' }, 502);
  }

  const rawContent =
    typeof aiResponse?.response === 'string'
      ? aiResponse.response
      : typeof (aiResponse as unknown) === 'string'
        ? (aiResponse as unknown as string)
        : '';

  const normalizedContent = rawContent.replace(/```json\s*|```/gi, '').trim();
  let parsed: Record<string, unknown> | undefined;
  if (normalizedContent) {
    try {
      parsed = JSON.parse(normalizedContent);
    } catch (error) {
      console.warn('Unable to parse AI response as JSON; returning raw output', error);
    }
  }

  const analysis = typeof parsed?.analysis === 'string' ? parsed.analysis : normalizedContent || rawContent;
  const rootCause =
    typeof parsed?.root_cause === 'string'
      ? parsed.root_cause
      : typeof parsed?.rootCause === 'string'
        ? parsed.rootCause
        : null;
  const recommendedStepsSource = Array.isArray(parsed?.recommended_steps)
    ? parsed?.recommended_steps
    : Array.isArray(parsed?.recommendedSteps)
      ? parsed?.recommendedSteps
      : [];
  const recommendedSteps = recommendedStepsSource.map((step) => String(step)).filter((step) => step.length > 0);
  const riskLevel =
    typeof parsed?.risk_level === 'string'
      ? parsed.risk_level
      : typeof parsed?.riskLevel === 'string'
        ? parsed.riskLevel
        : null;

  return c.json({
    task: taskDetails,
    issue,
    resolution: {
      analysis: analysis || 'No analysis available.',
      rootCause,
      recommendedSteps,
      riskLevel,
      model: '@cf/meta/llama-3.1-8b-instruct',
      raw: rawContent,
    },
  });
});

app.post('/api/tasks/:id/generate-code', async (c) => {
  const idParam = c.req.param('id');
  const taskId = Number(idParam);
  if (!Number.isInteger(taskId)) {
    return c.json({ error: 'Task ID must be an integer' }, 400);
  }

  const taskStmt = c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId);
  const task = await taskStmt.first<TaskRow>();
  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const jobId = crypto.randomUUID();
  const taskSnapshot = mapRowToResponse(task);

  const stub = c.env.CODE_GENERATOR.get(c.env.CODE_GENERATOR.idFromName(jobId));
  const payload: StartGenerationPayload = {
    jobId,
    taskId,
    task: taskSnapshot,
  };

  let durableResponse: Response;
  try {
    durableResponse = await stub.fetch('https://code-generator/start-generation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('Failed to contact CodeGeneratorDO for job start', error);
    return c.json({ error: 'Failed to initiate code generation job' }, 502);
  }

  let durableJson: unknown = null;
  try {
    durableJson = await durableResponse.json();
  } catch (error) {
    console.warn('CodeGeneratorDO did not return JSON payload', error);
  }

  if (!durableResponse.ok) {
    const body = typeof durableJson === 'object' && durableJson !== null ? durableJson : { error: 'Failed to queue job' };
    return c.json(body, durableResponse.status);
  }

  return c.json(
    {
      jobId,
      taskId,
      status: 'started',
      message: 'Code generation initiated',
      job: (durableJson as { job?: CodeGenerationJobRecord })?.job ?? null,
    },
    202,
  );
});

app.get('/api/jobs/:jobId/status', async (c) => {
  const rawJobId = c.req.param('jobId') ?? '';
  const jobId = rawJobId.trim();
  if (!jobId) {
    return c.json({ error: 'jobId is required' }, 400);
  }

  const stub = c.env.CODE_GENERATOR.get(c.env.CODE_GENERATOR.idFromName(jobId));

  let durableResponse: Response;
  try {
    durableResponse = await stub.fetch(`https://code-generator/status/${encodeURIComponent(jobId)}`);
  } catch (error) {
    console.error('Failed to query CodeGeneratorDO for job status', error);
    return c.json({ error: 'Failed to retrieve job status' }, 502);
  }

  let durableJson: unknown = null;
  try {
    durableJson = await durableResponse.json();
  } catch (error) {
    console.warn('CodeGeneratorDO returned non-JSON response for status', error);
  }

  if (!durableResponse.ok) {
    const body = typeof durableJson === 'object' && durableJson !== null ? durableJson : { error: 'Job status unavailable' };
    return c.json(body, durableResponse.status);
  }

  return c.json(durableJson ?? { job: null });
});

app.post('/mcp', async (c) => {
  let payload: McpRequest;
  try {
    payload = await c.req.json<McpRequest>();
  } catch (error) {
    console.error('Invalid MCP payload received', error);
    const response: McpErrorResponse = {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Invalid JSON payload' },
      id: null,
    };
    return c.json(response, 400);
  }

  if (payload.jsonrpc !== '2.0' || typeof payload.method !== 'string' || payload.method.trim().length === 0) {
    const response: McpErrorResponse = {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid MCP request' },
      id: payload.id ?? null,
    };
    return c.json(response, 400);
  }

  const response: McpSuccessResponse = {
    jsonrpc: '2.0',
    result: {
      status: 'ok',
      version: '1.0',
      capabilities: ['task_management', 'ai_assistance'],
    },
    id: payload.id ?? null,
  };

  return c.json(response);
});

// --- WebSocket route from main branch ---
app.get('/ws/:roomId', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade request.' }, 426);
  }

  const roomId = c.req.param('roomId') ?? 'default';
  const durableId = c.env.WEBSOCKET_SERVER.idFromName(roomId);
  const stub = c.env.WEBSOCKET_SERVER.get(durableId);

  const forwardRequest = new Request(`https://do.websocket/${roomId}`, c.req.raw);
  return stub.fetch(forwardRequest);
});

// General handlers from codex/complete-epic-0002-and-update-tasks
app.onError((err, c) => {
  console.error('Unhandled error in Worker', err);
  return c.json({ error: 'Internal Server Error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not Found' }, 404));

export default app;

// --- WebSocket Durable Object from main branch ---
type ConnectionMetadata = {
  roomId: string;
  connectionId: string;
};

export class WebSocketServer extends DurableObject {
  private readonly sessions = new Map<WebSocket, ConnectionMetadata>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const webSocketPair = new WebSocketPair();
      const { 0: client, 1: server } = webSocketPair;

      const url = new URL(request.url);
      const roomId = url.pathname.split('/').filter(Boolean).pop() ?? 'default';
      const connectionId = crypto.randomUUID();

      this.sessions.set(server, { roomId, connectionId });
      this.ctx.acceptWebSocket(server, [roomId, connectionId]);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === 'POST') {
      const url = new URL(request.url);
      if (url.pathname === '/broadcast') {
        return this.handleBroadcast(request);
      }
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    let payload: TaskBroadcastMessage & { [key: string]: unknown };
    try {
      payload = await request.json<TaskBroadcastMessage & { [key: string]: unknown }>();
    } catch (error) {
      console.error('Invalid broadcast payload received', error);
      return Response.json({ error: 'Invalid broadcast payload' }, { status: 400 });
    }

    const roomId = typeof payload.roomId === 'string' && payload.roomId.trim().length > 0 ? payload.roomId.trim() : 'default';
    const message = JSON.stringify({ ...payload, roomId });

    const sockets = this.ctx.getWebSockets(roomId);
    let delivered = 0;

    for (const socket of sockets) {
      const metadata = this.getOrRestoreMetadata(socket);
      if (!metadata) {
        continue;
      }

      try {
        socket.send(message);
        delivered += 1;
      } catch (error) {
        console.error('Failed to deliver broadcast message', error);
        try {
          socket.close(1011, 'Broadcast delivery failure.');
        } catch (closeError) {
          console.error('Failed to close socket after broadcast failure', closeError);
        }
        this.sessions.delete(socket);
      }
    }

    return Response.json({ success: true, delivered });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const metadata = this.getOrRestoreMetadata(ws);
    if (!metadata) {
      ws.close(1011, 'Connection metadata unavailable.');
      return;
    }

    const body = typeof message === 'string' ? message : textDecoder.decode(message);
    const peers = this.ctx.getWebSockets(metadata.roomId);

    for (const peer of peers) {
      if (peer === ws) {
        continue;
      }

      try {
        peer.send(
          JSON.stringify({
            type: 'message',
            connectionId: metadata.connectionId,
            body,
          }),
        );
      } catch (error) {
        console.error('Failed to relay WebSocket message', error);
      }
    }

    try {
      ws.send(
        JSON.stringify({
          type: 'ack',
          body,
        }),
      );
    } catch (error) {
      console.error('Failed to acknowledge WebSocket message', error);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const metadata = this.getOrRestoreMetadata(ws);
    if (!metadata) {
      return;
    }

    this.sessions.delete(ws);

    const peers = this.ctx.getWebSockets(metadata.roomId);
    for (const peer of peers) {
      if (peer === ws) {
        continue;
      }

      try {
        peer.send(
          JSON.stringify({
            type: 'disconnect',
            connectionId: metadata.connectionId,
            code,
            reason,
            clean: wasClean,
          }),
        );
      } catch (error) {
        console.error('Failed to notify peers about disconnect', error);
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error encountered', error);
    ws.close(1011, 'WebSocket error encountered.');
    this.sessions.delete(ws);
  }

  private getOrRestoreMetadata(ws: WebSocket): ConnectionMetadata | undefined {
    const metadata = this.sessions.get(ws);
    if (metadata) {
      return metadata;
    }

    try {
      const tags = this.ctx.getTags(ws);
      if (tags.length >= 2) {
        const restored: ConnectionMetadata = {
          roomId: tags[0],
          connectionId: tags[1],
        };
        this.sessions.set(ws, restored);
        return restored;
      }
    } catch (error) {
      console.error('Unable to restore WebSocket metadata', error);
    }

    return undefined;
  }
}

export class CodeGeneratorDO extends DurableObject {
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    if (request.method === 'POST' && segments[0] === 'start-generation') {
      return this.handleStartGeneration(request);
    }

    if (request.method === 'GET' && segments[0] === 'status' && segments[1]) {
      return this.handleStatusRequest(segments[1]);
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleStartGeneration(request: Request): Promise<Response> {
    let payload: StartGenerationPayload;
    try {
      payload = await request.json<StartGenerationPayload>();
    } catch (error) {
      console.error('Invalid job payload received by CodeGeneratorDO', error);
      return Response.json({ error: 'Invalid job payload' }, { status: 400 });
    }

    const jobId = payload.jobId?.trim();
    const taskId = Number(payload.taskId);

    if (!jobId) {
      return Response.json({ error: 'jobId is required' }, { status: 400 });
    }

    if (!Number.isFinite(taskId)) {
      return Response.json({ error: 'taskId must be a number' }, { status: 400 });
    }

    const existing = await this.getJob(jobId);
    if (existing) {
      return Response.json({ job: existing, message: 'Job already exists' }, { status: 200 });
    }

    const now = new Date().toISOString();
    const job: CodeGenerationJobRecord = {
      jobId,
      taskId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      progress: 0,
      taskSnapshot: payload.task ?? null,
      metadata: payload.options,
    };

    await this.putJob(job);

    this.ctx.waitUntil(this.processJob(job, payload));

    return Response.json({ job }, { status: 202 });
  }

  private async handleStatusRequest(jobId: string): Promise<Response> {
    const normalizedId = jobId.trim();
    if (!normalizedId) {
      return Response.json({ error: 'jobId is required' }, { status: 400 });
    }

    const job = await this.getJob(normalizedId);
    if (!job) {
      return Response.json({ error: 'Job not found' }, { status: 404 });
    }

    return Response.json({ job });
  }

  private async processJob(job: CodeGenerationJobRecord, _payload: StartGenerationPayload): Promise<void> {
    try {
      await this.updateJob(job.jobId, {
        status: 'running',
        progress: Math.max(job.progress, 0),
      });

      // Placeholder: actual AI code generation will be implemented in TASK-014.
      // This method establishes the lifecycle hooks and error handling so that
      // future implementations can focus on generation logic.
    } catch (error) {
      console.error('Failed to transition job into running state', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.updateJob(job.jobId, {
        status: 'failed',
        error: message,
      });
    }
  }

  private async getJob(): Promise<CodeGenerationJobRecord | null> {
    // The job data can be stored under a constant key as the DO instance is unique per job.
    return this.ctx.storage.get<CodeGenerationJobRecord>('job');
  }

  private async putJob(job: CodeGenerationJobRecord): Promise<void> {
    await this.ctx.storage.put(this.jobKey(job.jobId), job);
  }

  private async updateJob(
    jobId: string,
    updates: Partial<Omit<CodeGenerationJobRecord, 'jobId' | 'taskId' | 'createdAt'>>,
  ): Promise<CodeGenerationJobRecord | null> {
    const existing = await this.getJob(jobId);
    if (!existing) {
      return null;
    }

    const next: CodeGenerationJobRecord = {
      ...existing,
      ...updates,
      progress: this.normalizeProgress(updates.progress ?? existing.progress),
      updatedAt: new Date().toISOString(),
    };

    await this.putJob(next);
    return next;
  }

  private normalizeProgress(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.min(Math.max(value, 0), 100);
  }

  private buildResultKey(taskId: number, jobId: string, extension?: string): string {
    const ext = extension?.replace(/[^\w.-]/g, '') || 'txt';
    return `tasks/${taskId}/generated_code${ext.startsWith('.') ? ext : `.${ext}`}`;
  }

  private async persistResult(
    jobId: string,
    taskId: number,
    artifact: PersistedArtifact,
  ): Promise<string> {
    const key = this.buildResultKey(taskId, jobId, artifact.extension);
    await this.env.CODE_BUCKET.put(key, artifact.content, {
      httpMetadata: artifact.contentType ? { contentType: artifact.contentType } : undefined,
      customMetadata: {
        jobId,
        taskId: String(taskId),
        ...(artifact.metadata ?? {}),
      },
    });

    await this.updateJob(jobId, { resultKey: key, progress: 100, status: 'completed' });
    return key;
  }
}