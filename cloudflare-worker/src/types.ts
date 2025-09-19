import type { DurableObjectNamespace, R2Bucket } from 'cloudflare:workers';

export interface Env {
        DB: D1Database;
        WEBSOCKET_SERVER: DurableObjectNamespace;
        AI: Ai;
        CODE_BUCKET: R2Bucket;
        CODE_GENERATOR: DurableObjectNamespace;
}
