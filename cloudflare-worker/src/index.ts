import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState, WebSocket } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

// The merged Env interface requires bindings from both branches.
interface Env {
  DB: D1Database;
  WEBSOCKET_SERVER: DurableObjectNamespace<WebSocketServer>;
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

  return c.json({ task: task ? mapRowToResponse(task) : null }, 201);
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

  return c.json({ task: mapRowToResponse(task) });
});

app.delete('/api/tasks/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) {
    return c.json({ error: 'Task ID must be an integer' }, 400);
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

  return c.json({ success: true });
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
  private readonly connections = new Map<WebSocket, ConnectionMetadata>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade request.', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const { 0: client, 1: server } = webSocketPair;

    const url = new URL(request.url);
    const roomId = url.pathname.split('/').filter(Boolean).pop() ?? 'default';
    const connectionId = crypto.randomUUID();

    this.connections.set(server, { roomId, connectionId });
    this.ctx.acceptWebSocket(server, [roomId, connectionId]);

    return new Response(null, { status: 101, webSocket: client });
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

    this.connections.delete(ws);

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
    this.connections.delete(ws);
  }

  private getOrRestoreMetadata(ws: WebSocket): ConnectionMetadata | undefined {
    const metadata = this.connections.get(ws);
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
        this.connections.set(ws, restored);
        return restored;
      }
    } catch (error) {
      console.error('Unable to restore WebSocket metadata', error);
    }

    return undefined;
  }
}