#!/usr/bin/env node
// Tiny CLI for the training API behind Cloudflare Access, using the service token.
//
//   node app/scripts/api.mjs GET /api/routing-context?days=8
//   node app/scripts/api.mjs POST /api/routes @route.json
//   node app/scripts/api.mjs PUT /api/route-assignments '{"assignments":[]}'
//
// Credentials: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET and APP_URL from the
// environment, else from app/.env.replan (written by app/scripts/store-service-token.sh).
// Prints the response JSON on stdout. Non-2xx: status + body on stderr, exit 1. Never prints secrets.
// Exit codes: 0 ok, 1 HTTP / network failure, 2 usage or configuration error.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequest, parseEnvFile, redact, resolveConfig } from './api-lib.mjs';

const USAGE = "usage: node app/scripts/api.mjs <GET|POST|PUT|DELETE> <path> [@file.json | 'inline json']";
const ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../.env.replan');

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function main(argv) {
  const [method, path, bodyArg] = argv;
  if (!method || !path || argv.length > 3) throw new Exit(2, USAGE);

  let config;
  try {
    const fileVars = existsSync(ENV_FILE) ? parseEnvFile(readFileSync(ENV_FILE, 'utf8')) : {};
    config = resolveConfig(process.env, fileVars);
  } catch (e) {
    throw new Exit(2, `api.mjs: ${e.message}`);
  }
  const secrets = [config.clientId, config.clientSecret];

  let body;
  if (bodyArg !== undefined && bodyArg.startsWith('@')) {
    try {
      body = readFileSync(bodyArg.slice(1), 'utf8');
    } catch (e) {
      throw new Exit(2, `api.mjs: cannot read ${bodyArg.slice(1)}: ${e.code ?? e.message}`);
    }
  } else {
    body = bodyArg;
  }

  let req;
  try {
    req = buildRequest(method, path, body, config);
  } catch (e) {
    throw new Exit(2, `api.mjs: ${e.message}`);
  }

  let res;
  try {
    res = await fetch(req.url, req.init);
  } catch (e) {
    throw new Exit(1, redact(`api.mjs: ${req.init.method} ${req.url} failed: ${e.cause?.message ?? e.message}`, secrets));
  }

  const text = await res.text();
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON (e.g. an Access login page); print as is
  }

  if (res.status < 200 || res.status >= 300) {
    let hint = '';
    if (res.status >= 300 && res.status < 400) hint = ' (Access redirected to login: the service token was not accepted; check the Access policy has a Service Auth rule for it)';
    else if (res.status === 403) hint = ' (forbidden: Access or the Worker rejected the request)';
    throw new Exit(1, redact(`HTTP ${res.status} ${req.init.method} ${new URL(req.url).pathname}${hint}\n${pretty.slice(0, 4000)}`, secrets));
  }
  process.stdout.write(`${redact(pretty, secrets)}\n`);
}

// Set exitCode rather than calling process.exit(): exiting while fetch's sockets close trips a libuv
// assertion on Windows (Node 24).
try {
  await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`${e instanceof Exit ? e.message : `api.mjs: ${e?.message ?? e}`}\n`);
  process.exitCode = e instanceof Exit ? e.code : 1;
}
