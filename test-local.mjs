/**
 * Local end-to-end test. No credentials, no network: an in-memory S3 gateway
 * stands in for the real one (including its quirks: User-Agent gating,
 * directory markers, unreadable marker keys) and a stub captures outgoing
 * mail instead of calling Resend.
 *
 *   node test-local.mjs
 */

import { createHash } from 'node:crypto';
import { onRequest } from './functions/[[...path]].ts';
import { ID_RE } from './functions/_shared/comments.ts';

const BUCKET = 'comments-test';
const UA_PREFIX = 'S3Drive';
const GATEWAY = 's3.test';

// ================= fake gateway =================

class FakeGateway {
  constructor() {
    this.objects = new Map();
    this.listCalls = 0;
  }

  keyOf(url) {
    const root = `/${BUCKET}`;
    if (url.pathname === root) return '';
    if (!url.pathname.startsWith(root + '/')) throw new Error(`bad path ${url.pathname}`);
    return url.pathname
      .slice(root.length + 1)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
  }

  async handle(url, init) {
    const headers = new Headers(init.headers || {});
    const ua = headers.get('user-agent') || '';
    const auth = headers.get('authorization') || '';

    if (!ua.startsWith(UA_PREFIX)) return new Response('bad user agent', { status: 403 });
    if (!/SignedHeaders=host;x-amz-content-sha256;x-amz-date/.test(auth)) {
      return new Response('SignatureDoesNotMatch', { status: 401 });
    }

    const method = (init.method || 'GET').toUpperCase();
    const key = this.keyOf(url);

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      this.listCalls++;
      return new Response(this.listXml(url.searchParams.get('prefix') || ''), {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }

    if (method === 'GET') {
      if (key.endsWith('/')) return new Response('InternalError', { status: 500 });
      if (!this.objects.has(key)) return new Response('NoSuchKey', { status: 404 });
      return new Response(this.objects.get(key), { status: 200 });
    }

    if (method === 'HEAD') {
      return new Response(null, { status: this.objects.has(key) ? 200 : 404 });
    }

    if (method === 'PUT') {
      const body = init.body ? await new Response(init.body).text() : '';
      this.objects.set(key, body);
      // The real gateway materialises a zero-byte marker for every parent prefix.
      const parts = key.split('/');
      for (let i = 1; i < parts.length; i++) {
        const marker = parts.slice(0, i).join('/') + '/';
        if (!this.objects.has(marker)) this.objects.set(marker, '');
      }
      return new Response(null, { status: 200, headers: { etag: '"fake"' } });
    }

    if (method === 'DELETE') {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response('not implemented', { status: 501 });
  }

  listXml(prefix) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const contents = keys
      .map((k) => `<Contents><Key>${xmlEscape(k)}</Key><Size>${this.objects.get(k).length}</Size></Contents>`)
      .join('');
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<ListBucketResult><Name>${BUCKET}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
      `<KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys>` +
      `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`
    );
  }
}

const xmlEscape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ================= stubs =================

const gateway = new FakeGateway();
const mails = [];
// Set to a promise to freeze the provider mid-send: `mails` only grows once the
// send is allowed to finish, so a test can tell "attempted" from "delivered".
let mailHold = null;
const mailAttempts = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'api.resend.com') {
    const payload = JSON.parse(init.body);
    mailAttempts.push(payload);
    if (mailHold) await mailHold;
    mails.push(payload);
    return new Response(JSON.stringify({ id: `mail_${mails.length}` }), { status: 200 });
  }
  if (url.hostname === GATEWAY) return gateway.handle(url, init);
  throw new Error(`unexpected fetch to ${url.hostname}`);
};

// ================= env =================

const ENV = {
  AWS_ACCESS_KEY_ID: 'AKIDTESTONLY',
  AWS_SECRET_ACCESS_KEY: 'SECRETTESTONLY',
  S3_BUCKET: BUCKET,
  S3_ENDPOINT: `https://${GATEWAY}`,
  S3_REGION: 'cn-north-1',
  UA_PREFIX,
  COMMENT_PREFIX: 'comments/v1',
  IP_SALT: 'ip-salt-for-test',
  COMMENT_ORIGINS: 'https://blog.test',
  COMMENT_TOKEN: 'admin-token',
  COMMENT_PAGE_SIZE: '20',
  COMMENT_RATE_MAX: '5',
  MAIL_PROVIDER: 'resend',
  MAIL_API_KEY: 're_test_key',
  MAIL_FROM: 'no-reply@blog.test',
  MAIL_TO: 'owner@blog.test',
  SITE_URL: 'https://blog.test',
  SITE_NAME: 'Test Blog',
};

// ================= harness =================

let passed = 0;
let failed = 0;

const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`  ok   ${msg}`);
  } else {
    failed++;
    console.log(`  FAIL ${msg}`);
  }
};

const eq = (actual, expected, msg) =>
  ok(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

const section = (name) => console.log(`\n${name}`);

async function call(method, pathAndQuery, { body, headers = {}, env = ENV, ip = '198.51.100.7' } = {}) {
  const init = { method, headers: { origin: 'https://blog.test', 'x-forwarded-for': ip, ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'text/plain';
  }

  const jobs = [];
  const request = new Request(`https://comments.test${pathAndQuery}`, init);
  const response = await onRequest({
    request,
    params: {},
    env,
    waitUntil: (job) => jobs.push(job),
  });
  await Promise.allSettled(jobs);

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html or empty */
  }
  return { status: response.status, json, text, headers: response.headers };
}

const commentBody = (over = {}) => ({
  p: '/posts/hello-world/',
  name: 'Reader',
  email: 'reader@blog.test',
  content: 'Nice article, thanks for sharing.',
  ...over,
});

const t0 = () => Date.now() - 5000;

// ================= tests =================

section('config surface');
{
  const res = await call('GET', '/api/health', { env: {} });
  eq(res.status, 200, 'health answers even without env');
  eq(res.json.ok, false, 'health reports not ok');
  ok(res.json.missing.includes('AWS_ACCESS_KEY_ID'), 'health lists missing variable names only');

  const healthy = await call('GET', '/api/health');
  eq(healthy.json.ok, true, 'health ok with full env');
  eq(healthy.json.s3Ready, true, 'S3 probe passes through the fake gateway');
  eq(healthy.json.mail.enabled, true, 'mail reported as enabled');
  eq(healthy.json.mail.owner, '***@blog.test', 'owner address is masked');
  ok(!healthy.text.includes('owner@blog.test'), 'owner address never appears in health output');
  ok(!healthy.text.includes('SECRETTESTONLY'), 'secret key never appears in health output');
  ok(!healthy.text.includes('re_test_key'), 'mail api key never appears in health output');
  ok(!healthy.text.includes('admin-token'), 'admin token never appears in health output');

  const gated = await call('GET', '/api/health', { env: { ...ENV, UA_PREFIX: 'WrongApp' } });
  eq(gated.json.s3Ready, false, 'wrong UA_PREFIX is detected by the probe');
  ok(/40[13]/.test(gated.json.s3Error || ''), 'probe reports the status it got back');
}

section('status page');
{
  const anonymous = await call('GET', '/');
  eq(anonymous.status, 401, 'the status page asks for the token');
  ok(!anonymous.text.includes('blog@blog.test'), 'the refusal shows no service details');
  ok(anonymous.text.includes('name="token"'), 'the refusal offers a token field');
  ok(anonymous.text.includes('type="password"'), 'the token field is masked');

  const wrong = await call('GET', '/?token=nope');
  eq(wrong.status, 401, 'a wrong token is refused');
  ok(wrong.text.includes('令牌不正确'), 'a wrong token says so');
  ok(!wrong.text.includes('nope'), 'the refusal never echoes the attempt');

  const viaQuery = await call('GET', '/?token=admin-token');
  eq(viaQuery.status, 200, 'the token may come in the query for a browser');
  ok(viaQuery.text.includes('edgeone-s3-comments'), 'the page renders the service name');
  ok(viaQuery.text.includes('***@blog.test'), 'the owner address stays masked');
  ok(!viaQuery.text.includes('owner@blog.test'), 'the page never prints the owner address');
  ok(!viaQuery.text.includes('admin-token'), 'the page never echoes the token');

  const viaHeader = await call('GET', '/', { headers: { 'x-comment-token': 'admin-token' } });
  eq(viaHeader.status, 200, 'the header opens it too');

  const closed = await call('GET', '/', { env: { ...ENV, COMMENT_TOKEN: '' } });
  eq(closed.status, 404, 'without COMMENT_TOKEN the page stays hidden');
  ok(!closed.text.includes('name="token"'), 'the disabled page offers no token field');
}

section('root entry');
{
  // The platform routes "/" to functions/index.ts only; keep that file wired up.
  const { onRequest: rootEntry } = await import('./functions/index.ts');
  eq(typeof rootEntry, 'function', 'functions/index.ts exports the handler');

  const response = await rootEntry({
    request: new Request('https://comments.test/', {
      method: 'GET',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    }),
    params: {},
    env: ENV,
    waitUntil: () => {},
  });
  const text = await response.text();
  eq(response.status, 401, 'the root path hits the same token gate');
  ok(text.includes('name="token"'), 'the root entry renders the token form');
}

section('input guards');
{
  const badOrigin = await call('POST', '/api/comment', {
    body: commentBody({ t0: t0() }),
    headers: { origin: 'https://evil.test' },
  });
  eq(badOrigin.status, 403, 'foreign origin rejected');

  const honeypot = await call('POST', '/api/comment', {
    body: commentBody({ nickname2: 'bot', t0: t0() }),
  });
  eq(honeypot.status, 400, 'honeypot rejected');

  const tooFast = await call('POST', '/api/comment', { body: commentBody({ t0: Date.now() }) });
  eq(tooFast.status, 400, 'submission faster than 2s rejected');

  const noPage = await call('POST', '/api/comment', { body: commentBody({ p: '', t0: t0() }) });
  eq(noPage.status, 400, 'missing page path rejected');

  const badEmail = await call('POST', '/api/comment', {
    body: commentBody({ email: 'not-an-email', t0: t0() }),
  });
  eq(badEmail.status, 400, 'malformed email rejected');
}

section('posting');
let parentId = '';
const mailBase = mails.length;
{
  const created = await call('POST', '/api/comment', { body: commentBody({ t0: t0() }) });
  eq(created.status, 201, 'comment accepted');
  ok(ID_RE.test(created.json.comment.id), 'id is timestamp-ordered and well formed');
  eq(created.json.comment.content, 'Nice article, thanks for sharing.', 'content echoed back');
  ok(!('email' in created.json.comment), 'email is not echoed to the browser');
  parentId = created.json.comment.id;

  const reply = await call('POST', '/api/comment', {
    body: commentBody({
      name: 'Owner',
      email: 'owner@blog.test',
      content: 'Glad you liked it.',
      parentId,
      t0: t0(),
    }),
  });
  eq(reply.status, 201, 'reply accepted');
  eq(reply.json.comment.replyTo, 'Reader', 'reply names the comment it answers');

  const list = await call('GET', '/api/comments?p=/posts/hello-world/');
  eq(list.status, 200, 'list ok');
  eq(list.json.total, 2, 'two comments counted');
  eq(list.json.threads.length, 1, 'one thread');
  eq(list.json.threads[0].replies.length, 1, 'thread contains the reply');
  ok(!list.text.includes('reader@blog.test'), 'list never exposes author emails');

  const count = await call('GET', '/api/count?p=/posts/hello-world/');
  eq(count.json.count, 2, 'count endpoint agrees');

  const duplicate = await call('POST', '/api/comment', {
    body: commentBody({ t0: t0() }),
    ip: '198.51.100.8',
  });
  eq(duplicate.status, 409, 'identical content within a minute rejected');
}

section('email notifications');
{
  eq(mails.length - mailBase, 3, 'one owner mail per comment plus one reply mail');
  eq(mails[mailBase].to[0], 'owner@blog.test', 'owner is notified of a new comment');
  eq(mails[mailBase + 1].to[0], 'owner@blog.test', 'owner is notified of a reply');
  eq(mails[mailBase + 2].to[0], 'reader@blog.test', 'author of the answered comment is notified');
  ok(mails[mailBase + 2].text.includes('Glad you liked it.'), 'reply mail carries the reply text');
  ok(mails[mailBase].text.includes('reader@blog.test'), 'owner mail carries the commenter address');
  ok(!mails[mailBase + 2].text.includes('owner@blog.test'), 'reply mail leaks no other address');
  ok(!mails[mailBase + 2].text.includes('unsubscribe'), 'reply mail offers no unsubscribe link');

  const before = mails.length;
  const third = await call('POST', '/api/comment', {
    body: commentBody({
      name: 'Third',
      email: 'third@blog.test',
      content: 'Me too!',
      parentId,
      t0: t0(),
    }),
    ip: '198.51.100.20',
  });
  eq(third.status, 201, 'third comment accepted');
  eq(mails.length, before + 1, 'the second reply to the same address is throttled away');
  eq(mails[mails.length - 1].to[0], 'owner@blog.test', 'the skipped one was the reader mail');
}

section('replying to your own comment');
{
  const before = mails.length;
  const ip = '198.51.100.88';
  const thread = await call('POST', '/api/comment', {
    body: commentBody({
      p: '/posts/self-reply/',
      name: 'Self',
      email: 'self@blog.test',
      content: 'Ask a question, answer it myself.',
      t0: t0(),
    }),
    ip,
  });
  eq(thread.status, 201, 'self-thread comment accepted');

  const selfReply = await call('POST', '/api/comment', {
    body: commentBody({
      p: '/posts/self-reply/',
      name: 'Self',
      email: 'self@blog.test',
      content: 'And here is the follow-up.',
      parentId: thread.json.comment.id,
      t0: t0(),
    }),
    ip,
  });
  eq(selfReply.status, 201, 'reply from the same address accepted');

  const added = mails.slice(before);
  eq(added.length, 2, 'a self-reply sends the two owner mails and nothing else');
  ok(
    added.every((m) => m.to[0] === 'owner@blog.test'),
    'nobody is mailed about their own reply',
  );
}

section('duplicate guard is per author');
{
  const same = { p: '/posts/dup-authors/', content: '收到', t0: t0() };

  const first = await call('POST', '/api/comment', {
    body: commentBody({ ...same, name: 'A', email: 'a@blog.test' }),
    ip: '198.51.100.91',
  });
  eq(first.status, 201, 'first author may post');

  const repeat = await call('POST', '/api/comment', {
    body: commentBody({ ...same, name: 'A', email: 'a@blog.test' }),
    ip: '198.51.100.92',
  });
  eq(repeat.status, 409, 'the same author repeating it within a minute is rejected');

  const other = await call('POST', '/api/comment', {
    body: commentBody({ ...same, name: 'B', email: 'b@blog.test' }),
    ip: '198.51.100.93',
  });
  eq(other.status, 201, 'a different author may say the same thing');
}

section('notification does not hold the comment');
{
  const delivered = mails.length;
  let release;
  mailHold = new Promise((resolve) => (release = resolve));

  const jobs = [];
  const startedAt = Date.now();
  const response = await onRequest({
    request: new Request('https://comments.test/api/comment', {
      method: 'POST',
      headers: {
        origin: 'https://blog.test',
        'content-type': 'text/plain',
        'x-forwarded-for': '198.51.100.77',
      },
      body: JSON.stringify(
        commentBody({ p: '/posts/notify-timing/', content: 'Provider is frozen mid-send', t0: t0() }),
      ),
    }),
    params: {},
    env: ENV,
    waitUntil: (job) => jobs.push(job),
  });
  const elapsed = Date.now() - startedAt;

  eq(response.status, 201, 'comment accepted while the provider never answers');
  ok(elapsed < 5_000, `response stayed inside the head-start budget (${elapsed}ms)`);
  eq(mails.length, delivered, 'nothing counted as delivered during the freeze');

  release();
  await Promise.allSettled(jobs);
  ok(mails.length > delivered, 'the frozen send still goes out after the response');
  mailHold = null;
}

section('rate limit');
{
  const tight = { ...ENV, COMMENT_RATE_MAX: '2' };
  const ip = '203.0.113.9';
  const send = (i) =>
    call('POST', '/api/comment', {
      body: commentBody({ p: '/posts/rate-limit/', content: `rate test ${i}`, t0: t0() }),
      env: tight,
      ip,
    });

  const statuses = [(await send(1)).status, (await send(2)).status, (await send(3)).status];
  eq(statuses.join(','), '201,201,429', 'third post inside the window is throttled');
}

section('marker cleanup');
{
  const ip = '203.0.113.77';
  const hash = createHash('sha256').update(`ip-salt-for-test:${ip}`).digest('hex').slice(0, 16);
  const stale = `comments/v1/rl/${hash}/0000000000001.marker`;
  gateway.objects.set(stale, '');

  const res = await call('POST', '/api/comment', {
    body: commentBody({ p: '/posts/cleanup/', content: 'cleanup test', t0: t0() }),
    ip,
  });
  eq(res.status, 201, 'post still succeeds before cleanup');
  ok(!gateway.objects.has(stale), 'stale rate marker removed instead of accumulating');
}

section('admin delete');
{
  const anonymous = await call('DELETE', `/api/comment?p=/posts/hello-world/&id=${parentId}`);
  eq(anonymous.status, 401, 'delete without token rejected');

  const wrong = await call('DELETE', `/api/comment?p=/posts/hello-world/&id=${parentId}`, {
    headers: { 'x-comment-token': 'nope' },
  });
  eq(wrong.status, 401, 'delete with wrong token rejected');

  const deleted = await call('DELETE', `/api/comment?p=/posts/hello-world/&id=${parentId}`, {
    headers: { 'x-comment-token': 'admin-token' },
  });
  eq(deleted.status, 200, 'delete with token accepted');
  eq(deleted.json.deleted, 3, 'thread cascades: parent plus two replies');

  const after = await call('GET', '/api/comments?p=/posts/hello-world/');
  eq(after.json.total, 0, 'page is empty afterwards');
}

section('routing');
{
  eq((await call('GET', '/api/nope')).status, 404, 'unknown path is 404');
  eq((await call('PUT', '/api/comment', { body: '{}' })).status, 405, 'unsupported method is 405');
  const preflight = await call('OPTIONS', '/api/comment');
  eq(preflight.status, 204, 'preflight answered');
  eq(
    preflight.headers.get('access-control-allow-headers'),
    'content-type, x-comment-token',
    'preflight allows the admin header',
  );
}

// ================= summary =================

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
