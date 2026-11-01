# edgeone-s3-comments

自建评论服务：部署在 **EdgeOne Pages Functions**，评论数据以**不可变 JSON 对象**的形式存放在 **S3 兼容对象存储**里，配套邮件通知。

- 无数据库、无第三方评论 SaaS，数据在自己桶里
- 每个评论一个对象，只写不改，天然幂等
- 邮件通知：站长收新评论，被回复者收回复提醒
- 前端零依赖，`Comments.vue` 直接对接（见下方接口）

## 接口

| 方法与路径 | 作用 | 说明 |
| --- | --- | --- |
| `GET /api/comments?p=/posts/foo/&limit=20&before=<id>` | 取评论 | 顶层评论按时间倒序，回复按时间正序 |
| `GET /api/count?p=/posts/foo/` | 评论总数 | |
| `POST /api/comment` | 发评论 / 回复 | `text/plain` 或 JSON 或表单皆可，见下 |
| `DELETE /api/comment?p=&id=` | 管理员删除 | 需要 `x-comment-token` 头或 `?token=`，连带删除该评论的直接回复 |
| `GET /?token=` | 状态页 | 和删除接口用同一个 `COMMENT_TOKEN`；未配置时整页返回 404 |
| `GET /api/health` | 配置自检 | 只返回变量名与状态，站长邮箱打码 |

`POST /api/comment` 字段：

```jsonc
{
  "p": "/posts/foo/",      // 文章路径（也接受 path）
  "name": "昵称",          // 1-32 字
  "email": "",             // 可选，仅用于回复通知，永不返回给前端
  "website": "",           // 可选
  "content": "正文",       // 必填，最多 4000 字
  "parentId": null,        // 回复时填被回复评论的 id
  "notify": true,          // 是否接收回复通知
  "nickname2": "",         // 蜜罐字段，必须为空
  "t0": 1730000000000      // 表单渲染时间，早于 2 秒或超过 1 小时会被拒
}
```

## 存储结构

所有对象都在 `COMMENT_PREFIX`（默认 `comments/v1`）之下，这样一把 AccessKey 只需要这一个前缀的权限：

```text
comments/v1/pages/<pageHash>/<id>.json      评论本体（含邮箱，桶必须私有）
comments/v1/rl/<ipHash>/<ts>.marker         每 IP 发帖限流
comments/v1/dup/<authorContentHash>/<minute>.marker 同一人一分钟内重复内容
comments/v1/mail/rl/<emailHash>/<ts>.marker 同一邮箱 10 分钟内只发一封
```

- 页面路径只存 hash，不把 URL 拼进对象键
- IP 只存 `sha256(IP_SALT:ip)` 前 16 位，不落原始地址
- 网关不支持条件写（`If-None-Match` 被忽略），所以全程只做 PUT / DELETE，不做「读-改-写」

## 环境变量

在 EdgeOne Pages 控制台 → 项目 → 设置 → 环境变量里填写；本地开发复制 `.env.example` 为 `.env`。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | 是 | 建议单独建一把，只授权该桶的 `COMMENT_PREFIX` |
| `S3_BUCKET` | 是 | 专用桶，保持私有 |
| `S3_ENDPOINT` | 是 | 仅主机名，不带协议，如 `xxx.s3.cn-north-1.amazonaws.com.cn` |
| `S3_REGION` | 否 | 默认 `cn-north-1` |
| `UA_PREFIX` | 是 | AccessKey 绑定的应用名，网关按 User-Agent 校验 |
| `COMMENT_PREFIX` | 否 | 默认 `comments/v1` |
| `IP_SALT` | 建议 | 生成 IP 哈希；更换等于清空限流状态 |
| `COMMENT_ORIGINS` | 建议 | 允许发评论的来源，逗号分隔，如 `https://blog.zhiyuanzhou.top` |
| `COMMENT_TOKEN` | 建议 | 管理员删除令牌；不配则删除接口关闭 |
| `COMMENT_PAGE_SIZE` | 否 | 默认 20，上限 50 |
| `COMMENT_RATE_MAX` | 否 | 每 IP 10 分钟发帖上限，默认 5 |
| `MAIL_PROVIDER` | 否 | 目前支持 `resend`；留空或 `off` 关闭邮件 |
| `MAIL_API_KEY` | 邮件必填 | Resend API Key |
| `MAIL_FROM` | 邮件必填 | 已验签的发件地址 |
| `MAIL_TO` | 邮件必填 | 站长收件地址（`/api/health` 里显示为 `***@domain`） |
| `MAIL_REPLY_TO` | 否 | 回复邮件时使用的地址 |
| `SITE_URL` / `SITE_NAME` | 否 | 邮件里的站点链接和署名 |

Edge Functions 没有 TCP，发不了 SMTP，所以邮件走 HTTP 接口；要换供应商在 `functions/_shared/mail.ts` 的 `sendMail` 加一个分支即可。

## 部署

1. 建一个**私有**桶，再建 AccessKey，只授权 `COMMENT_PREFIX` 前缀（读写删、ListBucket）。
2. 推送到 GitHub，在 EdgeOne Pages 新建项目导入本仓库：输出目录 `public`，函数目录 `functions`。
3. 填环境变量，绑定自定义域名（如 `comments.zhiyuanzhou.top`）并配好 DNS。
4. 打开 `/api/health`：`ok: true`、`s3Ready: true` 才算通。`UA_PREFIX` 填错时这里会直接报 401/403。
5. 邮件还需要在 Resend 侧验证发件域名并配好 SPF/DKIM。

## 防刷

- 蜜罐字段 `nickname2` + 最短填写时间 2 秒
- 每 IP 10 分钟最多 5 条（只存哈希）
- 同页面同内容 1 分钟内视为重复（跨分钟边界也检查）
- 来源白名单，非白名单站点连 CORS 头都拿不到
- 邮件：同一收件邮箱 10 分钟最多一封

## 本地开发

```bash
cp .env.example .env   # 填好值，别提交
npm run dev            # http://localhost:8788
npm test               # 内存版 S3 网关 + 桩邮件，不需要任何凭据
```

博客本地联调时把评论接口指过来：

```bash
VITE_COMMENTS_API=http://localhost:8788 pnpm docs:dev
```

## 安全约定

- 凭据只从环境变量读取，不写死、不打日志、不出现在 `/api/health`
- `.env`、`*.pem`、`*.key` 等已在 `.gitignore` 中
- 评论对象里含邮箱，桶必须私有，不要开公共读
- 删除接口只认 `COMMENT_TOKEN` 常量时间比较；没配令牌时直接关闭
