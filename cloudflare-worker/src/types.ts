import type { DurableObjectNamespace } from 'cloudflare:workers';

export interface Env {
        WEBSOCKET_SERVER: DurableObjectNamespace;
}
