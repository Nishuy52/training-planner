// Types `env` from 'cloudflare:test' (Cloudflare.Env) with the Worker's bindings.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    LIVE: DurableObjectNamespace<import('../src/live/durable').LiveSessionObject>;
  }
}
