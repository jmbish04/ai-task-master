import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectNamespace, DurableObjectState, R2Bucket, WebSocket } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

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

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

const TASK_ROOM = 'tasks';

type TaskBroadcastMessage = {
  roomId?: string;
  type: 'task_update';
  action: 'created' | 'updated' | 'deleted';
  taskId: number;
  task?: TaskResponse | null;
};

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
app.get('/api/tasks', async (c) => {
  const status = c.req.query('status');
  const priorityParam = c.req.query('priority');
  const search = c.req.query('search');
  const limitParam = c.req.query('limit');
  const offsetParam = c.req.query('offset');

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (status) {
    conditions.push('status = ?');
    bindings.push(status);
  }

  if (priorityParam) {
    const parsedPriority = Number(priorityParam);
    if (!Number.isFinite(parsedPriority)) {
      return c.json({ error: 'Invalid priority filter supplied' }, 400);
    }
    conditions.push('priority = ?');
    bindings.push(parsedPriority);
  }

  if (search) {
    conditions.push('(title LIKE ? OR description LIKE ?)');
    const searchTerm = `%${search}%`;
    bindings.push(searchTerm, searchTerm);
  }

  let query = 'SELECT * FROM tasks';
  if (conditions.length) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }
  query += ' ORDER BY priority DESC, created_at DESC';

  const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 100);
  const offset = Math.max(Number(offsetParam) || 0, 0);
  query += ' LIMIT ? OFFSET ?';
  bindings.push(limit, offset);

  const stmt = c.env.DB.prepare(query).bind(...bindings);
  const { results } = await stmt.all<TaskRow>();

  const tasks = (results ?? []).map(mapRowToResponse);
  return c.json({
    tasks,
    pagination: {
      limit,
      offset,
      count: tasks.length,
    },
  });
});

app.get('/api/tasks/:id', async (c) => {
  const idParam = c.req.param('id');
  const id = parseInt(idParam, 10);
  if (isNaN(id)) {
    return c.json({ error: 'Task ID must be an integer' }, 400);
  }

  const stmt = c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id);
  const task = await stmt.first<TaskRow>();
  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }

  return c.json({ task: mapRowToResponse(task) });
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

app.put('/api/tasks/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Task ID must be an integer' }, 400);
  }

  let payload: TaskPayload;
  try {
    payload = await c.req.json<TaskPayload>();
  } catch (error) {
    console.error('Failed to parse JSON body for PUT /api/tasks/:id', error);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const updates: string[] = [];
  const bindings: unknown[] = [];

  if (payload.title !== undefined) {
    if (!payload.title || !payload.title.trim()) {
      return c.json({ error: 'Title cannot be empty' }, 400);
    }
    updates.push('title = ?');
    bindings.push(payload.title.trim());
  }

  if (payload.description !== undefined) {
    updates.push('description = ?');
    bindings.push(payload.description ?? null);
  }

  if (payload.status !== undefined) {
    updates.push('status = ?');
    bindings.push(payload.status.trim());
  }

  if (payload.priority !== undefined) {
    const priority = Number(payload.priority);
    if (!Number.isFinite(priority)) {
      return c.json({ error: 'Priority must be a valid number' }, 400);
    }
    updates.push('priority = ?');
    bindings.push(priority);
  }

  if (payload.dependencies !== undefined) {
    updates.push('dependencies = ?');
    bindings.push(JSON.stringify(toStringArray(payload.dependencies)));
  }

  if (payload.subtasks !== undefined) {
    updates.push('subtasks = ?');
    bindings.push(JSON.stringify(toStringArray(payload.subtasks)));
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

app.delete('/api/tasks/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Task ID must be an integer' }, 400);
  }

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

  private jobKey(jobId: string): string {
    return `${JOB_KEY_PREFIX}${jobId}`;
  }

  private async getJob(jobId: string): Promise<CodeGenerationJobRecord | null> {
    const stored = await this.ctx.storage.get<CodeGenerationJobRecord>(this.jobKey(jobId));
    return stored ?? null;
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