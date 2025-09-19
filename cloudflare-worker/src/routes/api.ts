import { Hono } from 'hono';

import type { Env } from '../types';

export const apiRoutes = new Hono<{ Bindings: Env }>();

apiRoutes.get('/health', (c) =>
        c.json({
                status: 'ok',
                service: 'ai-task-master',
                timestamp: new Date().toISOString(),
        }),
);

apiRoutes.get('/version', (c) =>
        c.json({
                version: '1.0.0',
        }),
);
