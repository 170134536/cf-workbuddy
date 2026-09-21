# cf-workbuddy

A Cloudflare Worker that turns WorkBuddy into an **OpenAI-compatible endpoint**
you can use from anywhere, with **generated API keys** for access control.

- `GET /v1/models` — list models (free-only by default)
- `POST /v1/chat/completions` — relay a chat completion, **streamed through**
- `/admin` — a small page to create, list, and revoke keys

Built for the Workers free tier: no paid features required.

## Why Workers

| | |
|---|---|
| Requests | 100,000/day on the free plan |
| CPU | 10 ms/invocation — streaming keeps usage near zero since the Worker mostly waits on the upstream |
| KV | 100k reads / 1k writes / 1 GB — ample for keys plus a cached model list |
| Cold start | ~5 ms across 330+ locations |

Streaming matters here: WorkBuddy only serves SSE, and Workers passes a
response body through without buffering it, so the Worker never holds the
whole completion in memory.

## Deploy

### 1. Prerequisites

```bash
npm install
npx wrangler login
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create KEYS
```

Copy the returned `id` into `wrangler.toml`, replacing
`PASTE_YOUR_KV_NAMESPACE_ID_HERE`.

### 3. Set secrets

```bash
npx wrangler secret put UPSTREAM_TOKEN   # your WorkBuddy access token
npx wrangler secret put ADMIN_PASSWORD   # password for /admin
```

To get a WorkBuddy token, either run the login flow on `/admin` after
deploying, or use the existing helper:

```bash
workbuddy-ctl login-start    # on a machine that has it
```

### 4. Deploy

```bash
npm run deploy
```

Wrangler prints the URL, e.g. `https://cf-workbuddy.<account>.workers.dev`.

## Using it

```bash
curl https://cf-workbuddy.<account>.workers.dev/v1/models \
  -H 'Authorization: Bearer wb-xxxx'
```

```bash
curl https://cf-workbuddy.<account>.workers.dev/v1/chat/completions \
  -H 'Authorization: Bearer wb-xxxx' \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","stream":true,
       "messages":[{"role":"system","content":"You are helpful."},
                   {"role":"user","content":"hi"}]}'
```

In any OpenAI client:

```
Base URL: https://cf-workbuddy.<account>.workers.dev/v1
API key:  wb-xxxx
```

> WorkBuddy is streaming-only and requires the first message to be a `system`
> message. Non-streaming clients will receive an SSE body they must parse.

## Managing keys

Open `https://cf-workbuddy.<account>.workers.dev/admin`, sign in with
`ADMIN_PASSWORD`, and generate keys. Each key can have:

| Field | Meaning |
|---|---|
| `name` | A label, such as the device it is for |
| `days` | Expiry in days; blank means never |
| disabled | Revoked keys are rejected immediately |

Keys are prefixed `wb-` and shown once at creation. Usage counters are
best-effort diagnostics (KV is eventually consistent), not a billing source.

The admin page can also start a WorkBuddy web login and display the resulting
token, which you then paste into the `UPSTREAM_TOKEN` secret:

```bash
npx wrangler secret put UPSTREAM_TOKEN
```

## Configuration

`wrangler.toml` `[vars]`:

| Var | Default | Meaning |
|---|---|---|
| `ENDPOINT` | `https://www.workbuddy.ai` | Upstream base URL |
| `CLIENT_VERSION` | `5.5.2` | Sent as `WorkBuddy/<v>`; the catalogue rejects unknown UAs |
| `FREE_ONLY` | `true` | Expose only currently-free models |
| `REQUIRE_KEY` | `true` | Require a key on `/v1/*` |

Secrets: `UPSTREAM_TOKEN`, `ADMIN_PASSWORD`.

## Free vs paid models

Free/paid is decided by the `credits` field: `0` means free. A missing or
empty value is **unrated** and is deliberately never reported as free.

If free-only filtering would leave zero models, the full list is served
instead so the endpoint is never empty.

## API endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /v1/models` | key | Exposed models |
| `GET /models/refresh` | key | Bypass the 6-hour catalogue cache |
| `POST /v1/chat/completions` | key | Relay a completion |
| `GET /admin` | — | Admin UI |
| `POST /admin/api/login` | — | Start an admin session |
| `GET/POST /admin/api/keys` | session | List / create keys |
| `POST /admin/api/keys/delete` | session | Revoke a key |
| `GET /admin/api/login/start` | session | Begin a WorkBuddy login |
| `GET /admin/api/login/poll` | session | Poll for the upstream token |

## Local development

```bash
npm install
npx wrangler kv namespace create KEYS   # then set the id
echo 'UPSTREAM_TOKEN=xxx' > .dev.vars
echo 'ADMIN_PASSWORD=yyy' >> .dev.vars
npm run dev
```

## Tests

```bash
npm test
```

Drives the real Worker handler against a mock KV and fetch, covering auth
gates, free-model filtering, key lifecycle, and the login flow (23 checks).

## Licence

MIT
