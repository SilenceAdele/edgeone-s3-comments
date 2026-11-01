/**
 * Pages served at "/" by the edge function.
 *
 * The status page used to be public/index.html, which the platform hands out
 * before the function runs. It shows the bucket, endpoint and mail state, so it
 * now sits behind COMMENT_TOKEN — the same credential the admin delete uses.
 * Without the token the visitor gets a token prompt, not the details.
 */

export interface StatusPageData {
  ok: boolean;
  service: string;
  version: string;
  prefix: string;
  bucket: string | null;
  endpoint: string | null;
  s3Ready: boolean;
  s3Error?: string;
  pageSize: number;
  rate: { windowMs: number; max: number };
  origins: string[];
  mail: { enabled: boolean; provider?: string; owner?: string };
  deleteEndpoint: boolean;
  missing: string[];
  warnings: string[];
  time: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const esc = (value: unknown): string =>
  String(value ?? '—').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const TOKENS = `
    :root{color-scheme:light;--brand:#409eff;--ink:#2c3e50;--muted:#5b6674}
    *{box-sizing:border-box}
    body{margin:0;font:15px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}
    h1{margin:0;color:var(--brand)}`;

const STATUS_STYLE = `
    :root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1f2328;--muted:#6b7280;
          --line:#e5e7eb;--accent:#2563eb;--code:#f3f4f6;--ok:#1a7f37;--okbg:#e7f7ee;
          --bad:#d64545;--badbg:#fdecec;--warnbg:#fff8ec;--warnfg:#8a5a00}
    @media (prefers-color-scheme:dark){
      :root{--bg:#16181d;--card:#1f2228;--fg:#e6e8eb;--muted:#9aa1ac;--line:#2e333c;
            --accent:#7aa7ff;--code:#262a31;--ok:#6ee7a0;--okbg:#16301f;--bad:#ff8f8f;
            --badbg:#3a1e1e;--warnbg:#332a17;--warnfg:#e6c07b}
    }
    *{box-sizing:border-box}
    body{margin:0;padding:56px 20px;background:var(--bg);color:var(--fg);
         font:15px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif}
    main{max-width:720px;margin:0 auto}
    h1{margin:0 0 4px;font-size:22px}
    p.lead{margin:0 0 28px;color:var(--muted)}
    section{background:var(--card);border:1px solid var(--line);border-radius:10px;
            padding:18px 20px;margin-bottom:16px}
    h2{margin:0 0 10px;font-size:14px;font-weight:600;color:var(--muted);
       letter-spacing:.04em;text-transform:uppercase}
    table{width:100%;border-collapse:collapse;font-size:14px}
    td{padding:6px 0;border-bottom:1px solid var(--line);vertical-align:top}
    tr:last-child td{border-bottom:0}
    td:first-child{width:46%;white-space:nowrap}
    code{background:var(--code);border-radius:4px;padding:1px 5px;
         font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
    a{color:var(--accent);text-decoration:none}
    a:hover{text-decoration:underline}
    .pill{display:inline-block;margin:0 0 12px;padding:2px 10px;border-radius:999px;font-size:12px}
    .pill.ok{background:var(--okbg);color:var(--ok)}
    .pill.bad{background:var(--badbg);color:var(--bad)}
    .warn{margin:12px 0 0;padding:10px 12px;border-left:3px solid #f0a020;background:var(--warnbg);
          border-radius:4px;font-size:12px;color:var(--warnfg)}
    .warn:empty{display:none}
    p.meta{margin:28px 0 0;color:var(--muted);font-size:13px}`;

const GATE_STYLE = `${TOKENS}
    html,body{height:100%}
    body{display:grid;place-items:center;overflow:hidden;color:var(--ink);
         background:
           radial-gradient(42rem 36rem at 16% 10%,#bfdcff 0%,rgba(191,220,255,0) 62%),
           radial-gradient(38rem 32rem at 84% 18%,#ded2ff 0%,rgba(222,210,255,0) 60%),
           radial-gradient(34rem 30rem at 52% 96%,#c9f0dd 0%,rgba(201,240,221,0) 62%),
           #e9f0f8}
    body::before{content:'';position:fixed;inset:-20%;z-index:0;filter:blur(46px);
                 background:
                   radial-gradient(16rem 16rem at 30% 32%,rgba(64,158,255,.30),transparent 70%),
                   radial-gradient(14rem 14rem at 70% 62%,rgba(160,120,255,.24),transparent 70%)}
    form.card{position:relative;z-index:1;width:min(360px,calc(100vw - 40px));padding:26px 26px 22px;
              border-radius:16px;border:1px solid rgba(255,255,255,.8);
              background:rgba(255,255,255,.62);
              -webkit-backdrop-filter:blur(18px) saturate(160%);
              backdrop-filter:blur(18px) saturate(160%);
              box-shadow:0 24px 60px rgba(44,62,80,.16),0 2px 8px rgba(44,62,80,.05)}
    h1{margin:0 0 6px;font-size:17px}
    p.lead{margin:0 0 18px;color:var(--muted);font-size:13px}
    p.error{margin:0 0 14px;padding:8px 10px;border-radius:8px;background:rgba(253,236,236,.92);
            color:#d64545;font-size:12px}
    label{display:block;margin:0 0 6px;font-size:12px;color:var(--muted)}
    .field{position:relative}
    input{width:100%;padding:11px 44px 11px 12px;border-radius:10px;border:1px solid rgba(64,158,255,.3);
          background:rgba(255,255,255,.92);color:var(--ink);outline:none;
          font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
          transition:border-color .15s,box-shadow .15s}
    input::placeholder{color:#a9b4c0}
    input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(64,158,255,.16)}
    .peek{position:absolute;top:50%;right:8px;transform:translateY(-50%);display:grid;place-items:center;
          width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;
          color:var(--muted);cursor:pointer}
    .peek:hover{background:rgba(64,158,255,.1);color:var(--brand)}
    .peek svg{display:block;width:17px;height:17px}
    .peek .eye-off{display:none}
    .peek.shown .eye{display:none}
    .peek.shown .eye-off{display:block}
    button.go{width:100%;margin-top:14px;padding:11px 12px;border:0;border-radius:10px;color:#fff;
              font-size:14px;font-weight:600;cursor:pointer;
              background:linear-gradient(180deg,#5aa9ff,#3d92f5);
              box-shadow:0 6px 16px rgba(61,146,245,.32)}
    button.go:hover{filter:brightness(1.04)}
    button.go:active{transform:translateY(1px)}`;

const shell = (style: string, title: string, body: string): string => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${style}
</style>
</head>
<body>
${body}
</body>
</html>`;

const row = (label: string, value: unknown): string =>
  `<tr><td>${esc(label)}</td><td><code>${esc(value)}</code></td></tr>`;

const apiRow = (signature: string, description: string): string =>
  `<tr><td><code>${esc(signature)}</code></td><td>${esc(description)}</td></tr>`;

const entryRow = (href: string, description: string): string =>
  `<tr><td><a href="${esc(href)}">${esc(href)}</a></td><td>${esc(description)}</td></tr>`;

export function statusPage(h: StatusPageData): string {
  const mail = h.mail.enabled ? `${h.mail.provider} · ${h.mail.owner}` : '未开启';
  const details = [
    row('版本', h.version),
    row('bucket', h.bucket),
    row('endpoint', h.endpoint),
    row('prefix', h.prefix),
    row('S3 连通', h.s3Ready ? 'ok' : h.s3Error || 'failed'),
    row('每页条数', h.pageSize),
    row('限流', `${h.rate.max} 条 / ${Math.round(h.rate.windowMs / 60000)} 分钟`),
    row('允许来源', h.origins.join(', ') || '不限'),
    row('邮件通知', mail),
    row('删除接口', h.deleteEndpoint ? '已开启' : '未配置 COMMENT_TOKEN'),
    h.missing.length ? row('缺少变量', h.missing.join(', ')) : '',
  ].join('\n        ');

  return shell(
    STATUS_STYLE,
    'edgeone-s3-comments',
    `<main>
  <h1>edgeone-s3-comments</h1>
  <p class="lead">自建评论服务 · EdgeOne Pages Edge Function + S3</p>

  <section>
    <h2>入口</h2>
    <table>
      ${entryRow('/', '状态页，需要 TOKEN（本页）')}
      ${entryRow('/api/health', '配置检查：缺哪些变量、S3 是否可用')}
    </table>
  </section>

  <section>
    <h2>接口</h2>
    <table>
      ${apiRow('GET /api/comments?p=/path/&limit=20', '顶层评论 + 回复，按时间排序')}
      ${apiRow('GET /api/count?p=/path/', '文章评论总数')}
      ${apiRow('POST /api/comment', '发评论 / 回复，text/plain 或 JSON 或表单')}
      ${apiRow('DELETE /api/comment?p=&id=', '管理员删除，需 TOKEN，连带直接回复')}
      ${apiRow('GET /api/health', '配置自检，站长邮箱打码')}
    </table>
  </section>

  <section>
    <h2>运行状态</h2>
    <div class="pill ${h.ok ? 'ok' : 'bad'}">${h.ok ? '运行正常' : '需要配置'}</div>
    <table>
      ${details}
    </table>
    <div class="warn">${esc(h.warnings.join('；'))}</div>
  </section>

  <p class="lead">
    评论以不可变 JSON 对象存放在你自己的 S3 兼容存储中；对象里含邮箱，所以桶必须私有，接口从不返回邮箱。
  </p>
  <p class="meta">读取于 ${esc(h.time)}</p>
</main>`,
  );
}

/**
 * The token prompt. It submits back to "/" as a GET so the result survives a
 * reload, and it never echoes what was typed.
 */
export function statusGatePage(opts: { message: string; error?: string }): string {
  const error = opts.error ? `<p class="error">${esc(opts.error)}</p>` : '';

  return shell(
    GATE_STYLE,
    '需要访问令牌',
    `<form class="card" method="get" action="/">
  <h1>需要访问令牌</h1>
  <p class="lead">${esc(opts.message)}</p>
  ${error}
  <label for="token">管理员令牌</label>
  <div class="field">
    <input id="token" name="token" type="password" placeholder="TOKEN"
           autocomplete="current-password" autocapitalize="off" spellcheck="false" autofocus>
    <button type="button" class="peek" id="peek" aria-label="显示令牌" title="显示令牌">
      <svg class="eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
      <svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 3l18 18"></path>
        <path d="M10.6 6.7A9.9 9.9 0 0 1 12 6.6c6.4 0 10 5.4 10 5.4a17 17 0 0 1-3.2 3.8"></path>
        <path d="M6.5 8.3A17 17 0 0 0 2 12s3.6 5.4 10 5.4c1.2 0 2.3-.2 3.3-.6"></path>
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path>
      </svg>
    </button>
  </div>
  <button type="submit" class="go">进入</button>
</form>
<script>
  var input = document.getElementById('token');
  var peek = document.getElementById('peek');
  peek.addEventListener('click', function () {
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    peek.classList.toggle('shown', show);
    peek.setAttribute('aria-label', show ? '隐藏令牌' : '显示令牌');
    peek.title = show ? '隐藏令牌' : '显示令牌';
    input.focus();
  });
</script>`,
  );
}

export function statusNoticePage(title: string, message: string): string {
  return shell(
    STATUS_STYLE,
    title,
    `<main>
  <h1>${esc(title)}</h1>
  <p class="lead">${esc(message)}</p>
</main>`,
  );
}