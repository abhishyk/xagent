# xagent

**xagent** is a private, login-protected AI assistant for your custom OS that answers from **your Google Docs** (handbook + source-code documentation) using RAG. Everything runs in **one Cloudflare Worker**:

- **Workers AI** — `@cf/openai/gpt-oss-20b` for answers, `@cf/baai/bge-m3` for embeddings (both configurable)
- **Vectorize** — semantic search over documentation chunks
- **D1** — users, sessions, document/chunk metadata, sync runs, usage counters
- **No chat history is stored.** The current conversation lives only in the browser tab (sent back as recent context so follow-ups work) and disappears on refresh or **New Chat**
- **Static assets** — plain HTML/CSS/vanilla JS UI, served only through the Worker
- **Google Docs API** — service-account sync, credentials kept in Worker secrets

No React, no Node server, no Pages, no external AI APIs.

```
Browser (HTML/CSS/JS)
   │  HttpOnly session cookie
   ▼
Cloudflare Worker ── auth · CSRF · rate limits · static GUI
   ├── /api/chat ──► embed question ─► Vectorize ─► D1 (chunk text) ─► rank/filter ─► GPT-OSS-20B ─► SSE stream
   ├── /api/search ─► Vectorize + D1 only (no generation)
   └── /api/admin/sync ─► Google Drive/Docs API ─► parse ─► chunk ─► embed (new chunks only) ─► Vectorize + D1
```

---

## 1. Project layout

```
wrangler.jsonc               Worker, D1, Vectorize, AI, static assets, vars, cron
migrations/0001_initial.sql  D1 schema
scripts/create-admin.mjs     one-time admin setup (hashes locally, stores hash only)
src/
  index.js                   router, page gating, error handling, scheduled()
  config.js                  every tunable, read from vars
  auth/        login.js logout.js session.js password.js
  security/    authMiddleware.js (auth, admin, CSRF) rateLimit.js validation.js
  api/         chat.js search.js sync.js users.js
  ai/          model.js (streaming + response parsing) embeddings.js rag.js prompts.js
  google/      auth.js (service-account JWT) docs.js (Docs JSON → blocks) chunker.js sync.js
  db/          users.js documents.js
  utils/       http.js crypto.js log.js version.js
public/
  login.html login.js        public login page
  index.html app.js          chat UI (auth required)
  admin.html admin.js        admin panel (admin role required)
  markdown.js common.js      safe markdown + syntax highlighting, shared helpers
  style.css 403.html favicon.svg
test/                        58 tests (node:test) with D1/AI/Vectorize/Google fakes
```

---

## 2. Prerequisites

- Node.js 20+ and npm
- A Cloudflare account (free plan is fine)
- A Google Cloud project (free) and the Google Docs you want indexed

```bash
npm install
npx wrangler login
```

---

## 3. Google service account (one time)

1. Go to **console.cloud.google.com** → create/select a project.
2. **APIs & Services → Library** → enable **Google Docs API** and **Google Drive API**
   (Drive is used only for a cheap `modifiedTime` check so unchanged docs are never downloaded).
3. **IAM & Admin → Service Accounts → Create service account** (no roles needed).
4. Open it → **Keys → Add key → Create new key → JSON**. Keep the file safe; never commit it.
5. **Share every Google Doc** you want indexed with the service account email (e.g. `xagent-sync@your-project.iam.gserviceaccount.com`) as **Viewer**.
   Sharing a folder is not enough for Docs that are not inside it — share each doc or the parent folder that contains them.
6. Collect the document IDs: in `https://docs.google.com/document/d/<THIS_PART>/edit`.

`GOOGLE_DOCUMENT_IDS` accepts either form:

```text
1AbC...xyz:handbook,1DeF...uvw:source_code,1GhI...rst:pxe
```
```json
[{"id":"1AbC...xyz","type":"handbook"},{"id":"1DeF...uvw","type":"source_code","name":"OS Source Docs"}]
```

Types: `handbook, source_code, configuration, troubleshooting, installation, networking, pxe, os, deployment`.
If omitted, the type is inferred from the document title. **Mark source-code docs as `source_code`** — they rank highest (§51) and plain-font code in them is still detected as code.

**Multi-tab documents** are fully supported: every tab (and sub-tab) is read, each tab name becomes the top-level section (`Server › Installation`), and source links open the exact tab and heading. Give tabs meaningful names (not "Tab 1"), and list tabs holding OTP/TOTP seeds, passwords or keys in `GOOGLE_EXCLUDE_TABS` — anything indexed can be quoted to any logged-in user.

**How to write docs for best results**
- Use real Google Docs headings (Title / Heading 1–3). Sections, citations and deep links follow them.
- Put code in a monospace font (Courier New, Consolas, Roboto Mono, …), in a 1×1 table "code box", or between literal ```` ``` ```` lines.
- Write `File: path/to/boot_manager.cpp` just above a code block to attach the file name.
- Put versions in titles/headings, e.g. `<Name>OS 2.x Deployment Handbook`, `PXE (OS 1.4)` or `Version: 2.4`.

---

## 4. Cloudflare setup & deployment

```bash
# 4.1 D1 database → copy the printed database_id into wrangler.jsonc ("database_id")
npx wrangler d1 create xagent

# 4.2 Vectorize index (dimensions MUST match EMBEDDING_MODEL; bge-m3 = 1024)
npx wrangler vectorize create xagent-docs --dimensions=1024 --metric=cosine

# 4.3 Production schema
npm run db:migrate:remote          # = wrangler d1 migrations apply DB --remote

# 4.4 Secrets (paste values when prompted)
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_PRIVATE_KEY      # the "private_key" value from the JSON key, incl. BEGIN/END lines
npx wrangler secret put GOOGLE_DOCUMENT_IDS     # can also be a plain var; it is not sensitive

# 4.5 First admin (prompts for a password; only the PBKDF2 hash reaches D1)
npm run create-admin:remote -- --username admin

# 4.6 Deploy
npm run deploy
```

Open the `*.workers.dev` URL → you will see only the login page.
Then **Admin → Sync Now** to index your documents.

### Custom domain (optional)
Your domain's zone must be on Cloudflare. Either uncomment `routes` in `wrangler.jsonc`:

```jsonc
"routes": [ { "pattern": "ai.example.com", "custom_domain": true } ]
```

and `npm run deploy`, or use **Workers & Pages → xagent → Settings → Domains & Routes → Add → Custom domain**.
Optionally disable the `workers.dev` route in the same screen so only the custom domain serves the app.

### Alternative admin bootstrap (no local tooling)
Set `ADMIN_INITIAL_USERNAME` and `ADMIN_INITIAL_PASSWORD` as secrets. On the first login attempt **while the users table is empty**, the Worker hashes the password into D1. They are ignored once any user exists, and the admin panel shows a warning until you delete them:

```bash
npx wrangler secret delete ADMIN_INITIAL_USERNAME
npx wrangler secret delete ADMIN_INITIAL_PASSWORD
```

---

## 5. Local development

Workers AI and Vectorize have **no local simulation**; `wrangler.jsonc` marks them `"remote": true`, so `wrangler dev` uses your real AI + Vectorize index (needs `wrangler login`), while D1 runs locally.

```bash
cp .dev.vars.example .dev.vars        # fill in Google values
npm run db:migrate:local
npm run create-admin:local -- --username admin
npm run dev                            # http://localhost:8787
```

On `http://localhost` the cookie is `xagent_sid` (no `Secure` flag); on HTTPS it is `__Host-xagent_sid` with `Secure`.
Local D1 is separate from production — sync once locally to fill the local `documents` table. (Vectorize is shared because it is remote; use a separate index name for dev if you want isolation.)

What you can test locally: login/logout, sessions, chat streaming, RAG, follow-up context, search mode, admin sync, user management.

---

## 6. Configuration (`wrangler.jsonc` → `vars`)

| Variable | Default | Purpose |
|---|---|---|
| `AI_MODEL` | `@cf/openai/gpt-oss-20b` | Chat model (any Workers AI text-generation model) |
| `REASONING_EFFORT` | *(empty)* | Optional `low`/`medium`/`high`; empty = model default. `low` saves tokens |
| `MAX_OUTPUT_TOKENS` | `2048` | Includes reasoning tokens for gpt-oss |
| `TEMPERATURE` | `0.3` | |
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Embedding model |
| `EMBEDDING_DIMENSIONS` | `1024` | Must equal the Vectorize index dimensions |
| `TOP_K` | `6` | Chunks sent to the model (1–20) |
| `MIN_SIMILARITY` | `0.45` | Cosine threshold; below it → "No sufficiently relevant documentation found" |
| `MAX_CONTEXT_CHARS` / `MAX_CONTEXT_TOKENS` | `14000` / `4000` | Context budget (the smaller wins, ≈4 chars/token) |
| `MAX_MESSAGE_LENGTH` | `12000` | Max characters per question (logs/code pastes) |
| `MAX_HISTORY_MESSAGES` | `8` | Max recent turns (sent by the browser, never stored) passed to the model |
| `DAILY_AI_LIMIT` | `50` | Global generations per UTC day (`0` = unlimited) |
| `CHAT_RATE_LIMIT_PER_MINUTE` | `8` | Per-user chat requests per minute |
| `SESSION_DURATION` | `12` | Session lifetime in hours |
| `PASSWORD_ITERATIONS` | `100000` | PBKDF2 iterations for new hashes (Workers max: 100000) |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `1800` / `200` | Characters per text chunk / overlap |
| `EMBED_BATCH_SIZE` | `20` | Texts per embedding call |
| `MAX_EMBED_PER_STEP` | `60` | New chunks embedded per sync request (keeps each request small) |
| `GOOGLE_EXCLUDE_TABS` | *(empty)* | Comma-separated tab names never indexed (e.g. `otp, RegionWise TOPT`). Child tabs are skipped too |

Secrets: `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_DOCUMENT_IDS`, optional `ADMIN_INITIAL_USERNAME` / `ADMIN_INITIAL_PASSWORD`.
Bindings: `DB` (D1), `VECTORIZE`, `AI`, `ASSETS`.

**Changing the embedding model:** create a new Vectorize index with the new dimensions, point `wrangler.jsonc` at it, update `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS`, deploy, then **Sync Now**. Chunk ids include the model name, so everything is re-embedded automatically and old rows are cleaned up.

### Optional scheduled sync
Set `"triggers": { "crons": ["0 */6 * * *"] }` and deploy. The cron run uses the Drive `modifiedTime` check, so unchanged docs cost one tiny API call and zero embeddings. Manual **Sync Now** always remains available.

---

## 7. How it works

**Sync (incremental).** For each configured doc: Drive `modifiedTime` check → skip if unchanged. Otherwise download the Docs JSON (including tabs), convert to blocks (headings with anchors, lists, tables, code from monospace/fences/code boxes), split into heading-aware chunks (code kept intact up to 2× chunk size, split at function boundaries beyond that), and extract `file_name`, `language`, `class_name`, `function_name`, `module`, `version`.
Chunk ids are `hash(doc + section + content + embedding model)`, so only **new or edited** chunks are embedded; removed chunks are deleted from Vectorize and D1 **after** all new ones are indexed (no gap in the knowledge base). Large docs sync over several small requests (`MAX_EMBED_PER_STEP`) and resume where they left off. Docs removed from `GOOGLE_DOCUMENT_IDS` are purged at the end of a run. Failures are stored per document and per run and never wipe existing vectors.

**Answering.** The question (plus the previous user turn, so follow-ups like "why does it fail after reboot?" retrieve correctly) is embedded; Vectorize returns candidates; full chunk data comes from D1; results below `MIN_SIMILARITY` are dropped; chunks labelled with a different OS version than the one asked about are dropped; ranking boosts `source_code` > specific docs > handbook; the top `TOP_K` within the context budget become `[S1]…[Sn]`.
The model sees: system prompt → recent turns from the browser → `<documentation_context>` / `<source_code_context>` (explicitly marked as data, wrapper tags neutralised inside content) → `<user_question>`. The answer streams to the browser; sources shown are only those actually retrieved (and, if the model cited any, only the cited ones), with deep links to the Google Docs heading.

---

## 8. Security summary

| Area | Implementation |
|---|---|
| Passwords | PBKDF2-SHA256, 100k iterations, 16-byte salt, constant-time compare; dummy hash for unknown users |
| Sessions | 256-bit random token in `HttpOnly; Secure; SameSite=Strict; __Host-` cookie; D1 stores only SHA-256(token); server-side expiry; logout and disable delete sessions |
| Access control | Every request hits the Worker first (`run_worker_first`); chat/admin pages and scripts are never served without a session; role read from D1 only; 401 vs 403 |
| CSRF | SameSite=Strict + Origin/Referer check + required `X-Requested-With` header on all state-changing calls |
| Brute force / abuse | Login throttling per IP and per username; per-user chat/search rate limits; global daily AI budget |
| Input | JSON-only bodies with size caps, length limits, strict ID/username validation, parameterised SQL everywhere |
| XSS | Strict CSP (`script-src 'self'`, no inline), markdown renderer escapes everything and only links http(s)/mailto, DOM built with `textContent` |
| Prompt injection | Retrieved docs wrapped and labelled as data; closing tags inside content neutralised; system prompt forbids following embedded instructions |
| Secrets | Google key only in Worker secrets; never returned by any API, never stored in D1/Vectorize, never logged |
| Logging | Structured events with a whitelist of safe fields (no passwords, keys, tokens or document text) |
| Errors | Generic messages to clients, no stack traces |

---

## 9. Free-tier notes (check Cloudflare's current pricing pages)

- **Workers Free**: 100k requests/day, **10 ms CPU per request** (with some burst tolerance). Everything waits on I/O (D1, AI, Vectorize, Google) which does not count as CPU. The two CPU-heavier operations are kept small:
  - Login (PBKDF2 100k iterations) — if you ever see error **1102** on login, lower `PASSWORD_ITERATIONS` (existing hashes keep working because the count is stored per hash) or move to Workers Paid.
  - Sync — each request processes one document and at most `MAX_EMBED_PER_STEP` new chunks; lower it if large docs hit the limit.
- **Workers AI Free**: a daily neuron allowance. A typical RAG answer (~6k input tokens incl. context, ~1–1.5k output incl. reasoning) costs roughly 0.15–0.2 cents, so the free allowance covers on the order of 50–70 answers/day; hence `DAILY_AI_LIMIT=50`. Embeddings are very cheap. Setting `REASONING_EFFORT=low` stretches the budget further. When the limit is reached users see "Today's AI usage limit has been reached. Please try again later." — nothing switches to a paid API.
- **Vectorize Free**: stored-dimension and queried-dimension monthly allowances. With 1024-dim vectors a few thousand chunks (several MB of docs) fit comfortably; for much larger corpora use a 768-dim (`bge-base-en-v1.5`) or 384-dim (`bge-small-en-v1.5`) model.
- **D1 Free**: generous for 1–2 users; chunk text is stored there (one row per chunk).
- Vectorize is eventually consistent: newly synced chunks become searchable a few seconds after a sync.

---

## 10. Tests

```bash
npm test
```

58 tests run the real Worker code against faithful local fakes (D1 via `node:sqlite`, Workers AI, Vectorize, static assets, Google OAuth/Drive/Docs with real RS256 JWT verification):

- **Auth**: valid/invalid login, disabled user, expired session, logout invalidation, forged cookies, brute-force throttling, bootstrap admin, unauthorized API (401), user on admin API (403), page gating, client-supplied role ignored
- **Security**: SQL injection, XSS in markdown, CSRF (missing header / foreign origin), prompt-injection wrapping, request size limits, no secrets in responses or logs
- **Google Docs sync**: initial sync, multiple documents, unchanged doc (no download, no embeddings), updated doc (only the changed chunk re-embedded, stale chunk removed), resumable large-doc sync, failure handling, removal of unconfigured docs
- **RAG/AI**: source-code answer with citations & deep links, irrelevant question → no-docs path, follow-up context (browser-held, validated), no chat data persisted, version-aware retrieval, daily limit, rate limit, AI failure, Vectorize failure, long log paste, search mode, streaming parser shapes

Manual end-to-end checklist after deploying:
1. Open the site logged out → login page only; `curl -X POST https://<host>/api/chat` → 401.
2. Log in as a normal user → `/admin` shows 403; `/api/admin/users` → 403.
3. Admin → Sync Now → documents show `synced` with chunk counts.
4. Ask a question covered by a doc → streamed answer with `[S#]` badges and clickable sources.
5. Ask something unrelated → "No sufficiently relevant documentation found." and a clearly-labelled general answer.
6. Edit one paragraph in a Google Doc → Sync Now → that doc shows 1 new / 1 removed chunk.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Sync: "Permission denied … Share it (Viewer) with the service account" | Share the doc with the service-account email; enable Docs API |
| Sync: "Google token request failed (400)" | `GOOGLE_PRIVATE_KEY` malformed — paste the full key including BEGIN/END lines |
| "Embedding dimension X does not match EMBEDDING_DIMENSIONS" | Index/model mismatch — see *Changing the embedding model* |
| Every answer says no relevant documentation | Run a sync; wait a few seconds; try lowering `MIN_SIMILARITY` (e.g. 0.38) |
| Login returns error 1102 | Free-plan CPU limit — lower `PASSWORD_ITERATIONS` (see §9) |
| `wrangler dev` asks for an API token | Run `npx wrangler login` (AI/Vectorize are remote bindings) |
| Answers cut off | Raise `MAX_OUTPUT_TOKENS` or set `REASONING_EFFORT=low` |
