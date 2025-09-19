import type { DurableObjectNamespace } from 'cloudflare:workers';

export interface Env {
        DB: D1Database;
        WEBSOCKET_SERVER: DurableObjectNamespace;
        AI: Ai;
}
