# edgeone-s3-comments

A self-hosted comment system that runs as an **EdgeOne Pages Edge Function** and stores every comment as an **immutable JSON object** in an **S3-compatible bucket**. Optional email notifications on top.

- No database, no third-party comment SaaS — the data stays in your own bucket
- One object per comment, write-once, so no read-modify-write races
- Email: the site owner is notified of every comment, and a reply also notifies the comment's author
- Zero frontend dependencies; a single `Comments.vue` talks to the JSON API

## How it works

```
browser ──> EdgeOne Pages Edge Function ──> S3-compatible bucket
                    │
                    └──> mail provider (HTTP API, best effort)
```

The function is `functions/[[...path]].ts` and handles every route. `public/` only holds `robots.txt` (the status page lives in the function so it can be token-gated).

## Requirements

- Node.js >= 22 (the function is plain `.ts`, run through Node's built-in type stripping — no build step)
- An EdgeOne Pages project
- A private S3-compatible bucket + an access key scoped to one prefix

## Configuration

All configuration comes from environment variables. Nothing is baked into the code, and no secret is ever logged or returned by `/api/health`.

Locally, copy `.env.example` to `.env` and fill it in; `npm run dev` reads that file.

In production, set the same names in **EdgeOne Pages console → Project → Settings → Environment Variables**, then redeploy.

### S3 storage (required)

| Variable | Required | Default | What to put there |
| --- | --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | yes | — | Access key ID scoped to this bucket/prefix |
| `AWS_SECRET_ACCESS_KEY` | yes | — | The matching secret (shown once at creation) |
| `S3_BUCKET` | yes | — | Bucket name, e.g. `blog-comments`. Keep it private. |
| `S3_ENDPOINT` | yes | — | Hostname only, **no scheme**, e.g. `s3.cstcloud.cn` or `xxx.s3.cn-north-1.amazonaws.com.cn` |
| `S3_REGION` | no | `cn-north-1` | The region your provider reports (used for SigV4 signing) |
| `UA_PREFIX` | no | `S3Drive` | App name the access key is bound to; some gateways reject a mismatched `User-Agent` |

**Where to get them**

1. `S3_BUCKET` — open your object-storage console, create a bucket, copy its name. Do not enable public read: comment objects contain visitor emails.
2. `S3_ENDPOINT` / `S3_REGION` — shown on the bucket's "overview / connection" panel. Take the endpoint host and strip `https://`; if you can open the bucket with an S3 client using only the host, that is the value.
3. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — in the console's access-key / app page, create a key bound to this bucket. If the console asks for permissions, grant list/get/put/delete **only on the `COMMENT_PREFIX` path** (plus `ListBucket` with that prefix). Copy the secret immediately; it is not shown again.
4. `UA_PREFIX` — only relevant when your gateway binds a key to an application name (CSTCloud's S3 behind S3Drive does; it requires `User-Agent: <AppName> ...`). Use the exact app name. Plain AWS S3, Cloudflare R2 and MinIO do not check this, so the default is fine.

The gateway check is the usual cause of `403` from S3 — `/api/health` will say `S3 403` and hint at `UA_PREFIX`.

### Comment behaviour (recommended)

| Variable | Required | Default | What to put there |
| --- | --- | --- | --- |
| `COMMENT_PREFIX` | no | `comments/v1` | Root key prefix. Scope the access key to this prefix. |
| `IP_SALT` | recommended | fixed fallback | Random string used to hash visitor IPs. Generate with `openssl rand -hex 16`. Changing it resets all rate-limit state. |
| `COMMENT_ORIGINS` | recommended | empty (any site) | Comma-separated allowed origins, no trailing slash, e.g. `https://blog.example.com`. An empty list means any site can post. |
| `COMMENT_TOKEN` | recommended | empty (disabled) | Admin token for `DELETE /api/comment` **and** the `/?token=` status page. Generate with `openssl rand -hex 24`. When unset, the delete endpoint returns 404 and the status page is closed. |
| `COMMENT_PAGE_SIZE` | no | `20` | Comments per page, clamped to 1–50 |
| `COMMENT_RATE_MAX` | no | `5` | Posts per IP per 10 minutes, clamped to 1–50 |

`IP_SALT` is never echoed anywhere; it only turns an IP into `sha256(IP_SALT:ip)[0..16]`.

### Email notifications (optional)

Leave `MAIL_PROVIDER` empty to disable them entirely. Edge Functions have no TCP, so SMTP is not an option; mail goes out over an HTTP API.

| Variable | Required | Default | What to put there |
| --- | --- | --- | --- |
| `MAIL_PROVIDER` | no | empty (off) | `resend` enables it; `off`/`none`/empty disables it |
| `MAIL_API_KEY` | yes when enabled | — | Resend API key |
| `MAIL_FROM` | yes when enabled | — | A sender on a domain you verified in Resend, e.g. `comments@example.com` |
| `MAIL_TO` | yes when enabled | — | Owner inbox for new-comment notifications. Masked as `***@example.com` on `/api/health`. |
| `MAIL_REPLY_TO` | no | empty | Reply-To header on outgoing mail |
| `SITE_URL` | no | blog default | Blog origin used in email links (no trailing slash) |
| `SITE_NAME` | no | blog default | Blog name shown in the email signature |

**Where to get them**

1. Create a free Resend account, then **Domains → add your domain** and publish the SPF/DKIM DNS records it shows. Only verified domains can send.
2. **API Keys → Create**, scope *Sending access*. The key starts with `re_` and is shown once.
3. `MAIL_FROM` must use that verified domain; a local-part like `comments@` is fine.
4. Set `MAIL_TO` to the inbox you actually read.

Delivery is best effort: a mail failure never turns into an API error, and the comment is already saved. `/api/health` exposes `mail.last`, a small status record explaining the most recent send or skip (`reply: same author`, `reply: rate limited`, `reply: parent left no email`, …) without any address.

## API

| Method & path | Purpose | Notes |
| --- | --- | --- |
| `GET /api/comments?p=/posts/foo/&limit=20&before=<id>` | List a page's comments | Top-level comments newest-first, replies oldest-first |
| `GET /api/count?p=/posts/foo/` | Comment count | |
| `POST /api/comment` | Create a comment or reply | Accepts `text/plain`, JSON or form data |
| `DELETE /api/comment?p=&id=` | Admin delete | `x-comment-token` header or `?token=`; also deletes the comment's direct replies |
| `GET /?token=` | Status page | Same token as delete; 404 when `COMMENT_TOKEN` is unset |
| `GET /api/health` | Config self-check | Names and statuses only; owner address masked |

`POST /api/comment` body:

```jsonc
{
  "p": "/posts/foo/",      // page path (also accepts "path")
  "name": "Alice",         // 1-32 chars
  "email": "",             // optional, reply notifications only, never returned to clients
  "website": "",           // optional
  "content": "Hi",         // required, up to 4000 chars
  "parentId": null,        // id of the comment being replied to
  "notify": true,          // whether to receive reply notifications
  "nickname2": "",         // honeypot, must stay empty
  "t0": 1730000000000      // form render time; rejected if <2 s or >1 h old
}
```

A comment object stores the author's `email`; the public API never returns it, and the bucket must stay private.

## Storage layout

Everything lives under `COMMENT_PREFIX` so one access key can cover the whole service:

```text
comments/v1/pages/<pageHash>/<id>.json         comment body (contains email; keep the bucket private)
comments/v1/rl/<ipHash>/<ts>.marker            per-IP posting rate limit
comments/v1/dup/<authorContentHash>/<bucket>.m per-author duplicate guard (1 minute)
comments/v1/mail/rl/<emailHash>/<ts>.marker    one mail per address per 10 minutes
comments/v1/mail/last.json                     last mail attempt, surfaced by /api/health
```

- Page paths are hashed; the URL never appears in an object key
- IPs are stored only as `sha256(IP_SALT:ip)[0..16]` — no raw addresses
- The gateway ignores conditional writes (`If-None-Match`), so the service only does PUT and DELETE, never read-modify-write

## Deployment

1. Create a **private** bucket and an access key limited to `COMMENT_PREFIX` (list/get/put/delete + `ListBucket` on that prefix).
2. Push this repository to GitHub and import it in EdgeOne Pages: output directory `public`, functions directory `functions`.
3. Add the environment variables above, attach your custom domain (e.g. `comments.example.com`), and create the DNS record the console shows.
4. Open `/api/health`: `ok: true` and `s3Ready: true` means credentials, bucket, endpoint and `UA_PREFIX` all work.
5. Optionally verify a sending domain in Resend and set the `MAIL_*` variables.

Pushing to GitHub does **not** deploy. Each change needs a deploy from the EdgeOne console (or your configured CI).

## Local development

```bash
cp .env.example .env   # fill in real values; .env is gitignored
npm run dev            # http://localhost:8788 (override with PORT=)
npm test               # 80 tests, in-memory S3 gateway + stub mailer, no credentials needed
```

`npm run dev` reads `.env`, serves `public/` statically, and loads the function with Node 22+ type stripping, so edits need a restart only if you change imports.

To point the blog's dev server at it:

```bash
VITE_COMMENTS_API=http://localhost:8788 pnpm docs:dev
```

## Anti-spam

- Honeypot field `nickname2` + minimum 2-second form fill time
- Per-IP limit: 5 comments / 10 minutes (hashed only)
- Duplicate guard: same author + same page + same content within 1 minute is rejected (checks both sides of the minute boundary)
- Origin allowlist; non-allowed sites don't even get CORS headers
- Mail throttle: one message per recipient address per 10 minutes

## Troubleshooting

`/api/health` is the first stop:

- `missing` lists variable **names** that are absent or look like placeholders
- `s3Ready: false` with `S3 401/403` → wrong key, or `UA_PREFIX` doesn't match the app the key is bound to
- `s3Ready: false` with `S3 404` → wrong `S3_BUCKET` or `S3_ENDPOINT`
- `mail.last` explains the last notification decision; `enabled: false` means `MAIL_PROVIDER` or one of `MAIL_API_KEY`/`MAIL_FROM`/`MAIL_TO` is missing
- `warnings` covers soft issues (no `IP_SALT`, empty `COMMENT_ORIGINS`, invalid prefix fallback)

The status page at `/?token=…` shows the same data as a card layout.

## Security notes

- Credentials come only from environment variables; never committed, never logged, never returned by `/api/health`
- `.env`, `*.pem`, `*.key`, `secrets.conf` are gitignored; `.env.example` lists names only
- Comment objects contain emails — the bucket must stay private
- The delete endpoint and status page use the same `COMMENT_TOKEN`, compared in constant time; both are closed when it is unset
- Rotate `MAIL_API_KEY` and the S3 secret if either ever appears in a screenshot or log