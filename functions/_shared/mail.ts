/**
 * Email notifications over an HTTP provider (Edge Functions have no TCP, so
 * SMTP is not an option).
 *
 * Two messages per event at most:
 *   1. the site owner gets every new comment
 *   2. a reply also notifies the author of the comment being answered
 *
 * Sending is always best-effort: the comment is already in S3, and a mail
 * failure must never turn into a request failure.
 */

import { hmacHex, sha256Hex } from './sigv4.ts';
import { s3Delete, s3GetJson, s3ListKeys, s3PutEmpty, s3PutJson, type S3Config } from './s3.ts';
import type { CommentRecord, CommentStoreConfig } from './comments.ts';

export interface MailConfig {
  /** Only `resend` is implemented; add adapters here when needed. */
  provider: string;
  apiKey: string;
  from: string;
  to: string;
  replyTo: string;
  /** Signs unsubscribe links. Independent from the IP salt. */
  salt: string;
  /** Blog origin used for "view comment" links. */
  siteUrl: string;
  siteName: string;
  /** This service's origin, used for unsubscribe links. */
  apiUrl: string;
}

export interface MailRead {
  mail: MailConfig | null;
  missing: string[];
  warnings: string[];
}

const KNOWN_PROVIDERS = new Set(['resend']);
const MAIL_RATE_WINDOW_MS = 10 * 60_000;

export function readMailConfig(env: Record<string, string | undefined>): MailRead {
  const warnings: string[] = [];
  const provider = (env.MAIL_PROVIDER || '').trim().toLowerCase();

  if (!provider || provider === 'off' || provider === 'none') {
    return { mail: null, missing: [], warnings: ['MAIL_PROVIDER is not set: email notifications are disabled'] };
  }

  const pairs: Array<[string, string | undefined]> = [
    ['MAIL_API_KEY', env.MAIL_API_KEY],
    ['MAIL_FROM', env.MAIL_FROM],
    ['MAIL_TO', env.MAIL_TO],
    ['MAIL_SALT', env.MAIL_SALT],
    ['COMMENT_API_URL', env.COMMENT_API_URL],
  ];
  const missing = pairs.filter(([, v]) => !v).map(([k]) => k);

  if (!KNOWN_PROVIDERS.has(provider)) {
    warnings.push(`MAIL_PROVIDER "${provider}" is not supported yet; notifications disabled`);
    return { mail: null, missing, warnings };
  }
  if (missing.length) {
    warnings.push(`Email notifications disabled: missing ${missing.join(', ')}`);
    return { mail: null, missing, warnings };
  }

  return {
    mail: {
      provider,
      apiKey: env.MAIL_API_KEY!,
      from: env.MAIL_FROM!,
      to: env.MAIL_TO!,
      replyTo: env.MAIL_REPLY_TO || '',
      salt: env.MAIL_SALT!,
      siteUrl: (env.SITE_URL || 'https://blog.zhiyuanzhou.top').replace(/\/+$/, ''),
      siteName: env.SITE_NAME || "zhiyuan.zhou's Blog",
      apiUrl: env.COMMENT_API_URL!.replace(/\/+$/, ''),
    },
    missing: [],
    warnings,
  };
}

// ---------- opt-out ----------

export async function emailHash(email: string): Promise<string> {
  return (await sha256Hex(email.trim().toLowerCase())).slice(0, 32);
}

export async function unsubscribeToken(mail: MailConfig, hash: string): Promise<string> {
  return hmacHex(mail.salt, `unsub:${hash}`);
}

export function unsubscribeUrl(mail: MailConfig, hash: string, token: string): string {
  return `${mail.apiUrl}/api/unsubscribe?e=${hash}&t=${token}`;
}

export async function isOptedOut(store: CommentStoreConfig, hash: string): Promise<boolean> {
  return (await s3GetJson(store.s3, `${store.prefix}/mail/optout/${hash}.json`)) !== null;
}

export async function markOptOut(store: CommentStoreConfig, hash: string): Promise<void> {
  await s3PutJson(store.s3, `${store.prefix}/mail/optout/${hash}.json`, { at: Date.now() });
}

/** One notification per address per 10 minutes, whatever the page. */
async function mailRateOk(store: CommentStoreConfig, hash: string, now: number): Promise<boolean> {
  const keys = await s3ListKeys(store.s3, `${store.prefix}/mail/rl/${hash}/`);
  const cutoff = now - MAIL_RATE_WINDOW_MS;
  const stale: string[] = [];
  let recent = 0;
  for (const key of keys) {
    if (key.endsWith('/')) continue;
    const stamp = Number(key.slice(key.lastIndexOf('/') + 1).replace(/\.marker$/, ''));
    if (!Number.isFinite(stamp)) continue;
    if (stamp >= cutoff) recent++;
    else stale.push(key);
  }
  if (stale.length) {
    await Promise.allSettled(stale.slice(0, 50).map((key) => s3Delete(store.s3, key)));
  }
  return recent === 0;
}

async function markMailRate(store: CommentStoreConfig, hash: string, now: number): Promise<void> {
  await s3PutEmpty(store.s3, `${store.prefix}/mail/rl/${hash}/${String(now).padStart(13, '0')}.marker`);
}

// ---------- provider ----------

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function sendViaResend(cfg: MailConfig, msg: OutgoingMail): Promise<void> {
  // The comment request waits on this call, so the budget stays well under the
  // platform's own request timeout even with two sends. `AbortSignal.timeout()`
  // is not implemented on EdgeOne's runtime, hence the manual controller.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: cfg.from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));

  if (!res.ok) {
    // Status only: the body can echo request fields back into logs.
    throw new Error(`mail provider responded ${res.status}`);
  }
}

export async function sendMail(cfg: MailConfig, msg: OutgoingMail): Promise<void> {
  if (cfg.provider === 'resend') return sendViaResend(cfg, msg);
  throw new Error(`unsupported mail provider: ${cfg.provider}`);
}

// ---------- templates ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pageUrl(mail: MailConfig, page: string): string {
  return `${mail.siteUrl}${page === '/' ? '/' : page}`;
}

function excerpt(content: string, max = 40): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

interface MailShell {
  title: string;
  lines: string[];
  cta: { label: string; url: string };
  footer?: string;
}

function renderShell(shell: MailShell): { html: string; text: string } {
  const html = `
<div style="font:14px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#2c3e50;max-width:560px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 16px;font-size:18px;color:#3a8ee6">${escapeHtml(shell.title)}</h2>
  ${shell.lines
    .map(
      (line) =>
        `<p style="margin:0 0 12px;padding:12px 14px;background:#f7f9fc;border-left:3px solid #409eff;border-radius:4px;white-space:pre-wrap">${escapeHtml(line)}</p>`,
    )
    .join('\n  ')}
  <p style="margin:20px 0">
    <a href="${escapeHtml(shell.cta.url)}" style="display:inline-block;padding:9px 18px;background:#409eff;color:#fff;text-decoration:none;border-radius:4px">${escapeHtml(shell.cta.label)}</a>
  </p>
  <p style="margin:20px 0 0;font-size:12px;color:#8a94a6">${escapeHtml(shell.footer || '')}</p>
</div>`.trim();

  const text = [
    shell.title,
    '',
    ...shell.lines.map((line) => `> ${line.replace(/\n/g, '\n> ')}`),
    '',
    `${shell.cta.label}: ${shell.cta.url}`,
    '',
    shell.footer || '',
  ].join('\n');

  return { html, text };
}

export function ownerMail(
  mail: MailConfig,
  comment: CommentRecord,
  parent: CommentRecord | null,
): OutgoingMail {
  const url = pageUrl(mail, comment.page);
  const title = parent
    ? `新回复：${comment.name} 回复了 ${parent.name}`
    : `新评论：${comment.name}`;
  const { html, text } = renderShell({
    title,
    lines: [
      `文章：${comment.page}`,
      `昵称：${comment.name}`,
      ...(comment.website ? [`网址：${comment.website}`] : []),
      ...(parent ? [`原评论（${parent.name}）：${parent.content}`] : []),
      `内容：${comment.content}`,
      `时间：${new Date(comment.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    ],
    cta: { label: '查看评论', url },
    footer: `来自 ${mail.siteName}`,
  });

  return {
    to: mail.to,
    subject: `【${mail.siteName}】${excerpt(title, 60)}`,
    html,
    text,
  };
}

export function replyMail(
  mail: MailConfig,
  reply: CommentRecord,
  parent: CommentRecord,
  hash: string,
  token: string,
): OutgoingMail {
  const url = pageUrl(mail, reply.page);
  const { html, text } = renderShell({
    title: `${reply.name} 回复了你的评论`,
    lines: [
      `你的评论：${parent.content}`,
      `回复内容：${reply.content}`,
    ],
    cta: { label: '查看并回复', url },
    footer: `你收到这封邮件是因为在本站评论时填写了邮箱。不想再收到通知：${unsubscribeUrl(mail, hash, token)}`,
  });

  return {
    to: parent.email,
    subject: `【${mail.siteName}】${reply.name} 回复了你在《${excerpt(reply.page, 30)}》的评论`,
    html,
    text,
  };
}

// ---------- orchestration ----------

export interface NotifyResult {
  ownerSent: boolean;
  replySent: boolean;
  skipped: string[];
}

export async function notifyNewComment(opts: {
  mail: MailConfig;
  store: CommentStoreConfig;
  comment: CommentRecord;
  parent: CommentRecord | null;
  now?: number;
}): Promise<NotifyResult> {
  const { mail, store, comment, parent } = opts;
  const now = opts.now ?? Date.now();
  const skipped: string[] = [];
  let ownerSent = false;
  let replySent = false;

  try {
    await sendMail(mail, ownerMail(mail, comment, parent));
    ownerSent = true;
  } catch (e) {
    skipped.push(`owner: ${(e as Error).message}`);
  }

  if (!parent) return { ownerSent, replySent, skipped };

  const parentEmail = (parent.email || '').trim();
  if (!parentEmail) skipped.push('reply: parent left no email');
  else if (!parent.notify) skipped.push('reply: parent opted out of replies');
  else if (parent.email.toLowerCase() === (comment.email || '').toLowerCase()) {
    skipped.push('reply: same author');
  } else {
    const hash = await emailHash(parentEmail);
    try {
      if (await isOptedOut(store, hash)) skipped.push('reply: unsubscribed');
      else if (!(await mailRateOk(store, hash, now))) skipped.push('reply: rate limited');
      else {
        const token = await unsubscribeToken(mail, hash);
        await sendMail(mail, replyMail(mail, comment, parent, hash, token));
        await markMailRate(store, hash, now);
        replySent = true;
      }
    } catch (e) {
      skipped.push(`reply: ${(e as Error).message}`);
    }
  }

  return { ownerSent, replySent, skipped };
}

/**
 * The notification outcome is otherwise invisible from the outside: a failed
 * send must not fail the comment request, so nothing surfaces it. Keeping the
 * last one in S3 lets `/api/health` answer "did we even try, and what said no".
 */
export async function recordMailNotice(
  store: CommentStoreConfig,
  notice: NotifyResult & { at: string },
): Promise<void> {
  await s3PutJson(store.s3, `${store.prefix}/mail/last.json`, notice);
}

export async function readMailNotice(
  store: CommentStoreConfig,
): Promise<(NotifyResult & { at: string }) | null> {
  return s3GetJson<NotifyResult & { at: string }>(store.s3, `${store.prefix}/mail/last.json`);
}

/** Owner address is never exposed verbatim on a public health endpoint. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return '***';
  return `***@${email.slice(at + 1)}`;
}

export type { S3Config };
