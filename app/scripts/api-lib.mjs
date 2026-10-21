// Pure helpers for scripts/api.mjs (no Node imports, so the Workers test pool can load them).

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/** Parses KEY=VALUE lines (dotenv subset): blank lines and # comments skipped, optional `export `, optional matching quotes. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Environment variables win over the file. Throws (without echoing values) when something is missing or unsafe. */
export function resolveConfig(env, fileVars = {}) {
  const pick = (k) => (env[k] !== undefined && env[k] !== '' ? env[k] : fileVars[k]);
  const rawUrl = pick('APP_URL');
  if (!rawUrl) {
    throw new Error('APP_URL not set (env or app/.env.replan), e.g. https://training.<your-subdomain>.workers.dev; run app/scripts/store-service-token.sh');
  }
  const appUrl = rawUrl.replace(/\/+$/, '');
  let u;
  try {
    u = new URL(appUrl);
  } catch {
    throw new Error('APP_URL is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new Error('APP_URL must be https (refusing to send the service token in clear text)');
  const clientId = pick('CF_ACCESS_CLIENT_ID');
  const clientSecret = pick('CF_ACCESS_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET not set (env or app/.env.replan; run app/scripts/store-service-token.sh)');
  }
  return { appUrl: u.origin, clientId, clientSecret };
}

/**
 * Normalises the API path. Accepts `/api/x` and `api/x`, and repairs Git Bash's MSYS path conversion,
 * which turns `/api/state` into `C:/Program Files/Git/api/state` before Node sees it.
 */
export function normalizePath(p) {
  let path = String(p ?? '');
  const mangled = /^[A-Za-z]:[\\/].*?(\/api(?:[/?].*)?)$/.exec(path.replace(/\\/g, '/'));
  if (mangled) path = mangled[1];
  if (!path.startsWith('/')) path = `/${path}`;
  if (!/^\/api(?:[/?]|$)/.test(path)) throw new Error(`path must start with /api (got "${p}")`);
  return path;
}

/** Builds the fetch() arguments. `body` is a JSON string (validated and re-serialised) or undefined. */
export function buildRequest(method, path, body, config) {
  const m = String(method ?? '').toUpperCase();
  if (!METHODS.has(m)) throw new Error(`method must be one of ${[...METHODS].join(', ')}`);
  const url = new URL(normalizePath(path), config.appUrl);
  if (url.origin !== config.appUrl) throw new Error('path must stay on APP_URL');
  const headers = {
    'CF-Access-Client-Id': config.clientId,
    'CF-Access-Client-Secret': config.clientSecret,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const init = { method: m, headers, redirect: 'manual' };
  if (body !== undefined) {
    if (m === 'GET' || m === 'DELETE') throw new Error(`${m} takes no body`);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`body is not valid JSON: ${e.message}`);
    }
    init.body = JSON.stringify(parsed);
  } else if (m === 'POST' || m === 'PUT') {
    init.body = '{}';
  }
  return { url: url.toString(), init };
}

/** Replaces every occurrence of the given secrets so nothing printed can leak them. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out;
}
