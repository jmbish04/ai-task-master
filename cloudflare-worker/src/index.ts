import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState, WebSocket } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { apiRoutes } from './routes/api';
import type { Env } from './types';

const textDecoder = new TextDecoder();

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

app.get('/', (c) =>
        c.json({
                message: 'AI Task Master worker is online.',
        }),
);

app.route('/api', apiRoutes);

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

export default app;

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
                const [client, server] = Object.values(webSocketPair) as [WebSocket, WebSocket];

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
