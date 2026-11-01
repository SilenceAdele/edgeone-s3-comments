/**
 * Comment domain logic on top of S3.
 *
 * Storage layout (everything under one prefix so a single AccessKey scope
 * covers the whole service):
 *
 *   <prefix>/pages/<pageHash>/<id>.json     one immutable comment per object
 *   <prefix>/rl/<ipHash>/<ts>.marker        per-IP posting rate limit
 *   <prefix>/dup/<contentHash>/<bucket>.m   duplicate-content guard
 *
 * The gateway does not support conditional writes, so nothing is ever read,
 * modified and written back: a comment is a single PUT, a delete is a DELETE.
 */

import {
  s3Delete,
  s3Exists,
  s3GetJson,
  s3ListKeys,
  s3PutEmpty,
  s3PutJson,
  type S3Config,
} from './s3.ts';
import { sha256Hex } from './sigv4.ts';

export const ID_RE = /^\d{13}-[0-9a-f]{6}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** A very long thread is still one page; stop scanning after this many objects. */
const MAX_SCAN = 500;
const FETCH_CONCURRENCY = 6;

export interface CommentRecord {
  id: string;
  page: string;
  parentId: string | null;
  name: string;
  email: string;
  website: string;
  content: string;
  notify: boolean;
  createdAt: number;
  ipHash: string;
  ua: string;
}

export interface PublicReply {
  id: string;
  name: string;
  website: string;
  content: string;
  createdAt: number;
  /** Nickname of the comment this one answers, when it is a reply. */
  replyTo: string | null;
}

export interface PublicThread extends PublicReply {
  replies: PublicReply[];
}

export interface CommentStoreConfig {
  s3: S3Config;
  /** Root key prefix, e.g. `comments/v1`. */
  prefix: string;
  ipSalt: string;
  pageSize: number;
  rateWindowMs: number;
  rateMax: number;
}

export class ValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- keys ----------

export function normalizePage(raw: unknown): string {
  let p = typeof raw === 'string' ? raw.trim() : '';
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return '';
    }
  }
  p = p.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (!p || p.length > 512 || CONTROL_RE.test(p)) return '';
  return p;
}

const pageHashCache = new Map<string, string>();

export async function pageHash(page: string): Promise<string> {
  const cached = pageHashCache.get(page);
  if (cached) return cached;
  const hash = (await sha256Hex(page)).slice(0, 32);
  // Bound the cache: a static blog has a few hundred pages at most.
  if (pageHashCache.size > 1000) pageHashCache.clear();
  pageHashCache.set(page, hash);
  return hash;
}

const pagePrefix = (cfg: CommentStoreConfig, hash: string) => `${cfg.prefix}/pages/${hash}/`;
const commentKey = (cfg: CommentStoreConfig, hash: string, id: string) =>
  `${pagePrefix(cfg, hash)}${id}.json`;

export function newId(now: number, rand = crypto.getRandomValues(new Uint8Array(3))): string {
  // 13-digit zero-padded milliseconds + 6 hex chars keeps keys sortable by time.
  const stamp = String(now).padStart(13, '0');
  const suffix = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${stamp}-${suffix}`;
}

// ---------- validation ----------

export interface CommentInput {
  page: string;
  parentId: string | null;
  name: string;
  email: string;
  website: string;
  content: string;
  notify: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RawBody {
  p?: string;
  path?: string;
  name?: string;
  email?: string;
  website?: string;
  content?: string;
  parentId?: string;
  notify?: string | boolean;
  nickname2?: string;
  t0?: string;
}

/**
 * `nickname2` is the honeypot (a real form leaves it empty) and `t0` is when
 * the form was rendered: humans need at least a couple of seconds to type.
 */
export function validateInput(body: RawBody, now: number): CommentInput {
  const hp = typeof body.nickname2 === 'string' ? body.nickname2.trim() : '';
  if (hp) throw new ValidationError('提交被拒绝', 400);

  const t0 = Number(body.t0);
  if (!Number.isFinite(t0) || now - t0 < 2000) throw new ValidationError('提交太快了，请稍后再试', 400);
  if (now - t0 > 3_600_000) throw new ValidationError('页面停留过久，请刷新后重试', 400);

  const page = normalizePage(body.p ?? body.path);
  if (!page) throw new ValidationError('缺少文章路径', 400);

  const name = (body.name || '').trim();
  if (!name || name.length > 32) throw new ValidationError('昵称需为 1-32 个字符', 400);
  if (CONTROL_RE.test(name)) throw new ValidationError('昵称包含非法字符', 400);

  const email = (body.email || '').trim();
  if (email && (email.length > 128 || !EMAIL_RE.test(email))) {
    throw new ValidationError('邮箱格式不正确', 400);
  }

  let website = (body.website || '').trim();
  if (website) {
    if (website.length > 200) throw new ValidationError('网址过长', 400);
    if (!website.includes('://')) website = 'https://' + website;
    try {
      const u = new URL(website);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      throw new ValidationError('网址格式不正确', 400);
    }
  }

  const content = (body.content || '').trim();
  if (!content) throw new ValidationError('评论内容不能为空', 400);
  if (content.length > 4000) throw new ValidationError('评论内容最多 4000 字', 400);

  let parentId: string | null = null;
  if (body.parentId) {
    if (!ID_RE.test(String(body.parentId))) throw new ValidationError('回复目标无效', 400);
    parentId = String(body.parentId);
  }

  const flag = body.notify;
  const notify = flag === false || flag === 'false' || flag === '0' || flag === 'off' ? false : true;

  return { page, parentId, name, email, website, content, notify };
}

// ---------- rate limit / duplicate guards ----------

export async function checkRate(
  cfg: CommentStoreConfig,
  ipHash: string,
  now: number,
): Promise<boolean> {
  const keys = await s3ListKeys(cfg.s3, `${cfg.prefix}/rl/${ipHash}/`);
  const cutoff = now - cfg.rateWindowMs;
  const stale: string[] = [];
  let recent = 0;
  for (const key of keys) {
    if (key.endsWith('/')) continue; // directory marker
    const stamp = Number(key.slice(key.lastIndexOf('/') + 1).replace(/\.marker$/, ''));
    if (!Number.isFinite(stamp)) continue;
    if (stamp >= cutoff) recent++;
    else stale.push(key);
  }
  // Self-cleaning: a marker older than the window carries no information, so
  // the prefix cannot grow without bound over the life of the service.
  if (stale.length) {
    await Promise.allSettled(stale.slice(0, 50).map((key) => s3Delete(cfg.s3, key)));
  }
  return recent < cfg.rateMax;
}

export async function markRate(cfg: CommentStoreConfig, ipHash: string, now: number): Promise<void> {
  await s3PutEmpty(cfg.s3, `${cfg.prefix}/rl/${ipHash}/${String(now).padStart(13, '0')}.marker`);
}

const dupKey = async (cfg: CommentStoreConfig, page: string, content: string) =>
  `${cfg.prefix}/dup/${(await sha256Hex(`${page}\n${content.trim().toLowerCase()}`)).slice(0, 32)}`;

export async function checkDuplicate(
  cfg: CommentStoreConfig,
  page: string,
  content: string,
  now: number,
): Promise<boolean> {
  const base = await dupKey(cfg, page, content);
  const bucket = Math.floor(now / 60_000);
  // The previous minute is checked too: a resubmit that straddles the boundary
  // would otherwise land in a fresh bucket and slip through. Both probes run at
  // once — each bucket round-trip costs seconds from the edge.
  const hits = await Promise.all([
    s3Exists(cfg.s3, `${base}/${bucket}.marker`),
    s3Exists(cfg.s3, `${base}/${bucket - 1}.marker`),
  ]);
  return hits[0] || hits[1];
}

export async function markDuplicate(
  cfg: CommentStoreConfig,
  page: string,
  content: string,
  now: number,
): Promise<void> {
  const base = await dupKey(cfg, page, content);
  await s3PutEmpty(cfg.s3, `${base}/${Math.floor(now / 60_000)}.marker`);
}

// ---------- writes ----------

export async function ipHashOf(ipSalt: string, ip: string): Promise<string> {
  return (await sha256Hex(`${ipSalt}:${ip}`)).slice(0, 16);
}

export async function createComment(
  cfg: CommentStoreConfig,
  input: CommentInput,
  meta: { ipHash: string; ua: string; now: number },
): Promise<CommentRecord> {
  const hash = await pageHash(input.page);
  const record: CommentRecord = {
    id: newId(meta.now),
    page: input.page,
    parentId: input.parentId,
    name: input.name,
    email: input.email,
    website: input.website,
    content: input.content,
    notify: input.notify,
    createdAt: meta.now,
    ipHash: meta.ipHash,
    ua: meta.ua.slice(0, 200),
  };
  await s3PutJson(cfg.s3, commentKey(cfg, hash, record.id), record);
  return record;
}

export async function getComment(
  cfg: CommentStoreConfig,
  page: string,
  id: string,
): Promise<CommentRecord | null> {
  if (!ID_RE.test(id)) return null;
  const hash = await pageHash(normalizePage(page));
  return s3GetJson<CommentRecord>(cfg.s3, commentKey(cfg, hash, id));
}

export async function deleteComment(
  cfg: CommentStoreConfig,
  rawPage: string,
  id: string,
): Promise<number> {
  const page = normalizePage(rawPage);
  if (!page) throw new ValidationError('缺少文章路径', 400);
  if (!ID_RE.test(id)) throw new ValidationError('评论 ID 无效', 400);

  const hash = await pageHash(page);
  await s3Delete(cfg.s3, commentKey(cfg, hash, id));

  // One-level nesting is enforced by the UI, but be thorough: drop direct
  // children too so a deleted thread cannot leave orphans behind.
  const records = await loadPageRecords(cfg, hash);
  const children = records.filter((r) => r.parentId === id).map((r) => r.id);
  await Promise.all(children.map((childId) => s3Delete(cfg.s3, commentKey(cfg, hash, childId))));

  return 1 + children.length;
}

// ---------- reads ----------

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function loadPageRecords(cfg: CommentStoreConfig, hash: string): Promise<CommentRecord[]> {
  const keys = (await s3ListKeys(cfg.s3, pagePrefix(cfg, hash)))
    .filter((k) => k.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, MAX_SCAN);

  const records = await mapLimit(keys, FETCH_CONCURRENCY, async (key) => {
    try {
      return await s3GetJson<CommentRecord>(cfg.s3, key);
    } catch {
      return null; // one unreadable object must not blank the whole thread
    }
  });

  return records.filter((r): r is CommentRecord => !!r && ID_RE.test(r.id) && !!r.content);
}

function toPublic(record: CommentRecord, replyTo: string | null): PublicReply {
  return {
    id: record.id,
    name: record.name,
    website: record.website,
    content: record.content,
    createdAt: record.createdAt,
    replyTo,
  };
}

export interface ListResult {
  total: number;
  threads: PublicThread[];
  hasMore: boolean;
  next: string | null;
}

/**
 * Returns top-level threads (newest first) with their replies (oldest first),
 * paginated by thread so a reply never gets separated from its parent.
 */
export async function listComments(
  cfg: CommentStoreConfig,
  rawPage: string,
  limit: number,
  before: string | null,
): Promise<ListResult> {
  const page = normalizePage(rawPage);
  if (!page) throw new ValidationError('缺少文章路径', 400);

  const records = await loadPageRecords(cfg, await pageHash(page));
  const byId = new Map(records.map((r) => [r.id, r]));

  const roots: CommentRecord[] = [];
  const children = new Map<string, CommentRecord[]>();

  for (const record of records) {
    if (!record.parentId) {
      roots.push(record);
      continue;
    }
    // Walk up to the thread root; a reply to a reply belongs to the same thread.
    let root = byId.get(record.parentId);
    let guard = 0;
    while (root?.parentId && guard++ < 10) root = byId.get(root.parentId);
    if (!root || root.parentId) {
      roots.push(record); // parent aged out of the scan window: show it standalone
      continue;
    }
    const bucket = children.get(root.id);
    if (bucket) bucket.push(record);
    else children.set(root.id, [record]);
  }

  roots.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  let start = 0;
  if (before && ID_RE.test(before)) {
    start = roots.findIndex((r) => r.id < before);
    if (start < 0) start = roots.length;
  }
  const slice = roots.slice(start, start + limit);
  const hasMore = start + limit < roots.length;

  const threads: PublicThread[] = slice.map((root) => {
    const replies = (children.get(root.id) || [])
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((reply) => {
        const parent = reply.parentId ? byId.get(reply.parentId) : null;
        return toPublic(reply, parent ? parent.name : null);
      });
    return { ...toPublic(root, null), replies };
  });

  return {
    total: records.length,
    threads,
    hasMore,
    next: hasMore && slice.length ? slice[slice.length - 1].id : null,
  };
}

export async function countComments(cfg: CommentStoreConfig, rawPage: string): Promise<number> {
  const page = normalizePage(rawPage);
  if (!page) throw new ValidationError('缺少文章路径', 400);
  const keys = await s3ListKeys(cfg.s3, pagePrefix(cfg, await pageHash(page)));
  return keys.filter((k) => k.endsWith('.json')).length;
}
