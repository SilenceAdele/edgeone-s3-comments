/**
 * edgeone-s3-comments - self-hosted comment system (EdgeOne Pages Edge
 * Function) that keeps every comment as an immutable JSON object in an
 * S3-compatible bucket.
 *
 *   GET    /api/comments?p=/posts/foo/   threads + replies          -> 200
 *   GET    /api/count?p=/posts/foo/      comment count              -> 200
 *   POST   /api/comment                  post a comment or reply    -> 201
 *   DELETE /api/comment?p=&id=           admin delete (token)       -> 200
 *   GET    /api/unsubscribe?e=&t=        one-click opt-out          -> 200
 *   GET    /api/health                   config sanity check        -> 200
 *
 * All credentials come from environment variables. Nothing is hardcoded and
 * the health endpoint masks the owner address.
 */

import {
  ValidationError,
  checkDuplicate,
  checkRate,
  countComments,
  createComment,
  deleteComment,
  getComment,
  ipHashOf,
  listComments,
  markDuplicate,
  markRate,
  validateInput,
  type CommentStoreConfig,
  type PublicReply,
} from './_shared/comments.ts';
import {
  isOptedOut,
  markOptOut,
  maskEmail,
  notifyNewComment,
  readMailConfig,
  readMailNotice,
  recordMailNotice,
  unsubscribeToken,
  type MailConfig,
} from './_shared/mail.ts';
import { readS3Config, s3Request, type S3Config } from './_shared/s3.ts';

/** EdgeOne Edge Function context (hand-written to avoid a type dependency). */
interface FnContext {
  request: Request;
  params: Record<string, string | string[]>;
  env: Record<string, string | undefined>;
  waitUntil?: (p: Promise<unknown>) => void;
  eo?: { geo?: unknown; clientIp?: string };
}

const SERVICE = 'edgeone-s3-comments';
const VERSION = '1.0.0';
const PREFIX_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

const RATE_WINDOW_MS = 10 * 60_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/** How long the response waits for the notification before letting it run on. */
const MAIL_HEAD_START_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ServiceConfig extends CommentStoreConfig {
  origins: string[];
  token: string;
  missing: string[];
  warnings: string[];
  mail: MailConfig | null;
}

export const onRequest = async (ctx: FnContext): Promise<Response> => {
  try {
    return await handle(ctx);
  } catch (e) {
    return json({ error: `comment error: ${(e as Error).message || String(e)}` }, 500);
  }
};

async function handle(ctx: FnContext): Promise<Response> {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const cfg = await readConfig(env);
  const cors = corsHeaders(cfg, request);

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (path === '/' || path === '/api/health') {
    return json(await healthPayload(cfg), 200, { ...cors, 'cache-control': 'no-store' });
  }

  if (cfg.missing.length) {
    return json(
      {
        error: `Missing environment variables: ${cfg.missing.join(', ')}`,
        hint:
          'EdgeOne Pages console -> Project -> Settings -> Environment Variables. ' +
          'See .env.example in the repository.',
      },
      500,
      cors,
    );
  }

  if (path === '/api/comment') {
    if (method === 'POST') return handleCreate(ctx, cfg, cors);
    if (method === 'DELETE') return handleDelete(ctx, cfg, url, cors);
    return methodNotAllowed(cors);
  }

  if (path === '/api/comments') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(cors);
    return handleList(ctx, cfg, url, cors);
  }

  if (path === '/api/count') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(cors);
    return handleCount(ctx, cfg, url, cors);
  }

  if (path === '/api/unsubscribe') {
    if (method !== 'GET') return methodNotAllowed(cors);
    return handleUnsubscribe(cfg, url);
  }

  return json({ error: 'Not found' }, 404, cors);
}

// ================= handlers =================

async function handleCreate(
  ctx: FnContext,
  cfg: ServiceConfig,
  cors: Record<string, string>,
): Promise<Response> {
  if (!originAllowed(cfg, ctx.request)) {
    return json({ error: 'Origin not allowed' }, 403, cors);
  }

  const body = await readLooseBody(ctx.request);
  const now = Date.now();

  let input;
  try {
    input = validateInput(body, now);
  } catch (e) {
    return fail(e, cors);
  }

  const ipHash = await ipHashOf(cfg.ipSalt, clientIp(ctx));
  const [rateOk, duplicate] = await Promise.all([
    checkRate(cfg, ipHash, now),
    checkDuplicate(cfg, input.page, input.content, now),
  ]);
  if (!rateOk) {
    return json({ error: '评论太频繁，请稍后再试' }, 429, cors);
  }
  if (duplicate) {
    return json({ error: '请勿重复提交相同内容' }, 409, cors);
  }

  // The UI only nests one level, but a reply can still point at another reply:
  // walk up so storage keeps a flat two-level tree.
  let parent = null;
  if (input.parentId) {
    parent = await getComment(cfg, input.page, input.parentId);
    if (!parent) return json({ error: '回复的评论不存在' }, 404, cors);

    let root = parent;
    let guard = 0;
    while (root.parentId && guard++ < 10) {
      const up = await getComment(cfg, input.page, root.parentId);
      if (!up) break;
      root = up;
    }
    input = { ...input, parentId: root.id };
  }

  const record = await createComment(cfg, input, {
    ipHash,
    ua: ctx.request.headers.get('user-agent') || '',
    now,
  });

  await Promise.all([
    markRate(cfg, ipHash, now),
    markDuplicate(cfg, input.page, input.content, now),
  ]);

  if (cfg.mail) {
    // The comment is already stored, so the reader must not wait on two
    // outbound sends: their bucket round-trips pushed a reply past the
    // platform's request budget and the browser hung with no response at all.
    // The notification gets a short head start inside the request and is then
    // handed to the platform to finish.
    const at = new Date(now).toISOString();
    const notice = notifyNewComment({
      mail: cfg.mail,
      store: cfg,
      comment: record,
      parent,
    })
      .then((result) => recordMailNotice(cfg, { ...result, at }))
      .catch(() => {});

    await Promise.race([notice, sleep(MAIL_HEAD_START_MS)]);
    ctx.waitUntil?.(notice);
  }

  const created: PublicReply = {
    id: record.id,
    name: record.name,
    website: record.website,
    content: record.content,
    createdAt: record.createdAt,
    replyTo: parent ? parent.name : null,
  };

  return json({ ok: true, comment: created }, 201, cors);
}

async function handleList(
  ctx: FnContext,
  cfg: ServiceConfig,
  url: URL,
  cors: Record<string, string>,
): Promise<Response> {
  const page = url.searchParams.get('p') || url.searchParams.get('path') || '';
  const limit = clamp(Number(url.searchParams.get('limit') || cfg.pageSize), 1, MAX_PAGE_SIZE);
  const before = url.searchParams.get('before') || null;

  try {
    const result = await listComments(cfg, page, limit, before);
    const headers = { ...cors, 'cache-control': 'no-store' };
    if (ctx.request.method.toUpperCase() === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return json(result, 200, headers);
  } catch (e) {
    return fail(e, cors);
  }
}

async function handleCount(
  ctx: FnContext,
  cfg: ServiceConfig,
  url: URL,
  cors: Record<string, string>,
): Promise<Response> {
  const page = url.searchParams.get('p') || url.searchParams.get('path') || '';
  try {
    const count = await countComments(cfg, page);
    const headers = { ...cors, 'cache-control': 'no-store' };
    if (ctx.request.method.toUpperCase() === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return json({ page, count }, 200, headers);
  } catch (e) {
    return fail(e, cors);
  }
}

async function handleDelete(
  ctx: FnContext,
  cfg: ServiceConfig,
  url: URL,
  cors: Record<string, string>,
): Promise<Response> {
  if (!cfg.token) {
    return json(
      { error: 'Delete disabled: COMMENT_TOKEN is not configured' },
      403,
      cors,
    );
  }
  const provided = ctx.request.headers.get('x-comment-token') || url.searchParams.get('token') || '';
  if (!safeEqual(provided, cfg.token)) return json({ error: 'Unauthorized' }, 401, cors);

  const id = url.searchParams.get('id') || '';
  const page = url.searchParams.get('p') || url.searchParams.get('path') || '';

  try {
    const deleted = await deleteComment(cfg, page, id);
    return json({ ok: true, deleted }, 200, { ...cors, 'cache-control': 'no-store' });
  } catch (e) {
    return fail(e, cors);
  }
}

async function handleUnsubscribe(cfg: ServiceConfig, url: URL): Promise<Response> {
  if (!cfg.mail) {
    return html('通知已停用', '本站目前没有开启邮件通知，无需退订。', 410);
  }

  const hash = url.searchParams.get('e') || '';
  const token = url.searchParams.get('t') || '';
  const expected = await unsubscribeToken(cfg.mail, hash);
  if (!hash || !safeEqual(token, expected)) {
    return html('链接无效', '这个退订链接无效或已被修改，请从原始邮件中重新打开。', 400);
  }

  if (!(await isOptedOut(cfg, hash))) await markOptOut(cfg, hash);
  return html('已退订', '该邮箱不会再收到评论回复通知。如需恢复，请在评论时重新勾选通知。', 200);
}

// ================= config =================

async function readConfig(env: Record<string, string | undefined>): Promise<ServiceConfig> {
  const { config, missing } = readS3Config(env);
  const warnings: string[] = [];

  let prefix = (env.COMMENT_PREFIX || 'comments/v1').replace(/^\/+|\/+$/g, '');
  if (!PREFIX_RE.test(prefix) || prefix.includes('..')) {
    warnings.push(`COMMENT_PREFIX "${prefix}" is invalid; falling back to "comments/v1"`);
    prefix = 'comments/v1';
  }

  const ipSalt = env.IP_SALT || '';
  if (!ipSalt) warnings.push('IP_SALT is not set: IP hashes use a fixed fallback salt');

  let pageSize = Number(env.COMMENT_PAGE_SIZE || DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(pageSize)) pageSize = DEFAULT_PAGE_SIZE;
  pageSize = Math.min(Math.max(Math.floor(pageSize), 1), MAX_PAGE_SIZE);

  let rateMax = Number(env.COMMENT_RATE_MAX || 5);
  if (!Number.isFinite(rateMax) || rateMax < 1) rateMax = 5;
  rateMax = Math.min(Math.floor(rateMax), 50);

  const origins = (env.COMMENT_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!origins.length) {
    warnings.push('COMMENT_ORIGINS is empty: any site may post comments to this endpoint');
  }

  const mailRead = readMailConfig(env);
  warnings.push(...mailRead.warnings);

  return {
    s3: (config as S3Config) || emptyS3(),
    missing,
    prefix,
    ipSalt: ipSalt || `${prefix}:no-ip-salt`,
    pageSize,
    rateWindowMs: RATE_WINDOW_MS,
    rateMax,
    origins,
    token: env.COMMENT_TOKEN || '',
    mail: mailRead.mail,
    warnings,
  };
}

/** Placeholder so `cfg` is always shaped like a config; `missing` blocks use. */
function emptyS3(): S3Config {
  return {
    accessKeyId: '',
    secretAccessKey: '',
    bucket: '',
    host: '',
    region: 'cn-north-1',
    uaPrefix: 'S3Drive',
  };
}

async function healthPayload(cfg: ServiceConfig) {
  const s3 = await probeS3(cfg);
  return {
    ok: cfg.missing.length === 0 && s3.s3Ready,
    service: SERVICE,
    version: VERSION,
    prefix: cfg.prefix,
    bucket: cfg.s3.bucket || null,
    endpoint: cfg.s3.host || null,
    uaPrefix: cfg.s3.uaPrefix,
    ...s3,
    pageSize: cfg.pageSize,
    rate: { windowMs: cfg.rateWindowMs, max: cfg.rateMax },
    origins: cfg.origins,
    mail: cfg.mail
      ? {
          enabled: true,
          provider: cfg.mail.provider,
          from: cfg.mail.from,
          // Never echo the owner address: this endpoint is public.
          owner: maskEmail(cfg.mail.to),
          // Skip reasons are status strings only — no address, no key.
          last: await readMailNotice(cfg).catch(() => null),
        }
      : { enabled: false },
    deleteEndpoint: !!cfg.token,
    missing: cfg.missing,
    warnings: cfg.warnings,
    time: new Date().toISOString(),
  };
}

/**
 * One cheap LIST proves the whole chain: key, secret, bucket, endpoint and the
 * UA prefix the gateway gates on.
 */
async function probeS3(cfg: ServiceConfig): Promise<{ s3Ready: boolean; s3Error?: string }> {
  if (cfg.missing.length) {
    return { s3Ready: false, s3Error: `missing: ${cfg.missing.join(', ')}` };
  }
  try {
    const res = await s3Request(cfg.s3, {
      method: 'GET',
      key: '',
      query: { 'list-type': '2', 'max-keys': '1', prefix: `${cfg.prefix}/` },
    });
    if (res.ok) return { s3Ready: true };
    const hint =
      res.status === 401 || res.status === 403
        ? ' (UA_PREFIX must be the app name the AccessKey is bound to)'
        : '';
    return { s3Ready: false, s3Error: `S3 ${res.status}${hint}` };
  } catch (e) {
    return { s3Ready: false, s3Error: (e as Error).message || String(e) };
  }
}

// ================= helpers =================

function corsHeaders(cfg: ServiceConfig, request: Request): Record<string, string> {
  const base: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, x-comment-token',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  const origin = (request.headers.get('origin') || '').replace(/\/+$/, '');
  if (!cfg.origins.length) return { ...base, 'access-control-allow-origin': '*' };
  if (origin && cfg.origins.includes(origin)) {
    return { ...base, 'access-control-allow-origin': origin };
  }
  // No allow-origin header: a cross-site reader gets nothing usable.
  return base;
}

function originAllowed(cfg: ServiceConfig, request: Request): boolean {
  if (!cfg.origins.length) return true;
  const origin = (request.headers.get('origin') || '').replace(/\/+$/, '');
  if (origin) return cfg.origins.includes(origin);
  const ref = request.headers.get('referer') || '';
  try {
    return cfg.origins.includes(new URL(ref).origin.replace(/\/+$/, ''));
  } catch {
    return false;
  }
}

function clientIp(ctx: FnContext): string {
  const eoIp = ctx.eo?.clientIp;
  if (eoIp) return eoIp;
  const headers = ctx.request.headers;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return (
    headers.get('eo-connecting-ip') ||
    headers.get('true-client-ip') ||
    headers.get('x-client-ip') ||
    headers.get('x-real-ip') ||
    headers.get('cf-connecting-ip') ||
    '0.0.0.0'
  );
}

function collectStrings(value: unknown, out: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // JSON bodies carry real booleans and numbers (`t0`, `notify`); both are
    // accepted as if they were form strings.
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/**
 * Accepts whatever a form or a beacon happens to send: a JSON object, a
 * urlencoded body, or a bare `p=/path/` string. `text/plain` JSON is preferred
 * on the client because it stays a CORS-simple request (no preflight).
 */
async function readLooseBody(request: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const raw = await request.text();
    if (!raw) return out;
    if (raw.trimStart().startsWith('{')) {
      try {
        return collectStrings(JSON.parse(raw), out);
      } catch {
        /* fall through to form parsing */
      }
    }
    for (const [k, v] of new URLSearchParams(raw)) if (v) out[k] = v;
  } catch {
    /* malformed body: fall back to the query string */
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function fail(e: unknown, cors: Record<string, string>): Response {
  if (e instanceof ValidationError) return json({ error: e.message }, e.status, cors);
  throw e;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function methodNotAllowed(cors: Record<string, string>): Response {
  return json({ error: 'Method Not Allowed' }, 405, cors);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function html(title: string, message: string, status: number): Response {
  const body = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f9fc;color:#2c3e50;
       font:15px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}
  main{max-width:420px;padding:32px;text-align:center;background:#fff;border-radius:10px;
       box-shadow:0 2px 16px rgba(44,62,80,.08)}
  h1{margin:0 0 12px;font-size:18px;color:#409eff}
  p{margin:0;color:#5b6674}
</style>
<main><h1>${title}</h1><p>${message}</p></main>`;
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}
