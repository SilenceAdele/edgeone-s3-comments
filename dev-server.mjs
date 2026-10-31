/**
 * Local dev server: runs the Edge Function on Node so the blog's dev server can
 * talk to it at http://localhost:8788. Values come from `.env` (never printed).
 *
 *   cp .env.example .env   # fill it in
 *   npm run dev
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { onRequest } from './functions/[[...path]].ts';

const PORT = Number(process.env.PORT || 8788);
const PUBLIC_DIR = join(import.meta.dirname, 'public');

async function loadEnv() {
  const env = { ...process.env };
  if (!existsSync('.env')) return env;
  const raw = await readFile('.env', 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const env = await loadEnv();
const pending = new Set();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file)) return false;

  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function toRequest(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else if (value !== undefined) headers.set(name, value);
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req;
    init.duplex = 'half';
  }
  return new Request(`http://${req.headers.host || `localhost:${PORT}`}${req.url}`, init);
}

const server = createServer(async (req, res) => {
  try {
    if (await serveStatic(req, res)) return;

    const response = await onRequest({
      request: toRequest(req),
      params: {},
      env,
      waitUntil: (job) => {
        const tracked = Promise.resolve(job).finally(() => pending.delete(tracked));
        pending.add(tracked);
      },
    });

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`dev server error: ${e?.message || e}`);
  }
});

server.listen(PORT, () => {
  console.log(`edgeone-s3-comments dev server -> http://localhost:${PORT}`);
  console.log(`health: http://localhost:${PORT}/api/health`);
  if (!env.AWS_ACCESS_KEY_ID) console.log('note: no S3 credentials in .env, health will report missing');
});
