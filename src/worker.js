/**
 * WorkBuddy relay on Cloudflare Workers.
 *
 * Exposes an OpenAI-compatible endpoint backed by WorkBuddy, with per-key
 * access control managed from a small admin page.
 *
 * Routes
 *   GET  /v1/models                 list models (key required)
 *   POST /v1/chat/completions       relay a chat completion (key required)
 *   GET  /admin                     admin UI (admin password)
 *   POST /admin/api/login           start an admin session
 *   GET  /admin/api/keys            list keys
 *   POST /admin/api/keys            create a key
 *   POST /admin/api/keys/delete     revoke a key
 *   GET  /admin/api/token           report the active upstream token
 *   POST /admin/api/token           save an upstream token
 *   GET  /admin/api/token/verify    test the token against the upstream
 *   GET  /admin/api/login/start     begin a WorkBuddy web login
 *   GET  /admin/api/login/poll      poll for the resulting upstream token
 */

const UA_BASE = 'WorkBuddy/';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// (removed)
//
// These are third-party DNS services that publish batches of Cloudflare edge
// addresses, used to dodge polluted or badly routed anycast answers. They are
// ordinary Cloudflare IPs — verified by probing: every address they return
// serves the Worker with a cf-ray header and a Google Trust Services
// certificate.
//
// A source is a convenience, not an authority: it can go stale or hostile, so
// the test always validates the candidate against our own hostname and lets
// the operator enter an address manually.

// ---------------------------------------------------------------- helpers

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      ...headers,
    },
  });
}

// The upstream token can live in KV (set from the admin page) or in a secret
// (set with `wrangler secret put`). KV wins, so the token can be refreshed
// from the browser without a redeploy — WorkBuddy tokens expire, and
// requiring a CLI round-trip for that would be a poor trade.
//
// Several secret spellings are accepted so an operator who set a differently
// named variable is not silently ignored.
//
// Tokens now live as a list so multiple credentials can be rotated, which is
// how the "请求过于频繁，请稍后重试" limit is worked around: when the
// upstream answers 429/403 or the connection drops, the next token is tried.
// Memoised for the isolate's lifetime — the JWTs are valid for a year, so
// re-reading KV per request costs latency and buys nothing. Cleared when the
// admin page adds or removes a token.
let poolCache = null;
let rrIndex = 0; // round-robin cursor, monotonic within the isolate

/**
 * The full credential list: KV-managed tokens plus the secret fallback.
 * Falls back to the legacy single-value key so existing installs keep
 * working, and to the environment secret when nothing is stored.
 */
async function tokenPool(env) {
  if (poolCache) return poolCache;

  let list = null;
  try {
    const raw = await env.KEYS.get('upstream:tokens');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) list = parsed;
    }
  } catch {
    list = null;
  }

  if (!list) {
    // Legacy single token, kept for compatibility with pre-rotation installs.
    const stored = await env.KEYS.get('upstream:token', 'json');
    if (stored && stored.token) list = [{ ...stored }];
  }

  if (!list) {
    const secret = env.UPSTREAM_TOKEN || env.WORKBUDDY_TOKEN || env.TOKEN || '';
    if (secret) list = [{ token: secret, source: '环境变量', at: null }];
  }

  poolCache = list || [];
  return poolCache;
}

/** Round-robin pick. Returns {token, index} or null when empty. */
async function nextToken(env) {
  const pool = await tokenPool(env);
  if (!pool.length) return null;
  const i = rrIndex++ % pool.length;
  return { token: pool[i].token, index: i, entry: pool[i] };
}

/** The first credential, for single-token callers (catalogue fetch, verify). */
async function upstreamToken(env) {
  const pick = await nextToken(env);
  return pick ? pick.token : '';
}

function adminPassword(env) {
  return env.ADMIN_PASSWORD || env.ADMIN || env.PASSWORD || '';
}

function ua(env) {
  return UA_BASE + (env.CLIENT_VERSION || '5.5.2');
}

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

function noAuthHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': ua(env),
    'X-No-Authorization': 'true',
  };
}

/**
 * Parse the upstream `credits` field.
 *
 * It is a display string, not a number: "x0.00", "x0.34 credits", "x3.31",
 * or "" when unrated. Number("x0.00") is NaN, so treating it numerically
 * marks every model as unknown and quietly disables free-only filtering.
 *
 * Returns 0 for free, a positive number for paid, or null when unrated.
 */
function creditOf(c) {
  if (c === undefined || c === null) return null;
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;

  const s = String(c).trim();
  if (!s) return null;                       // "" -> unrated
  const m = s.match(/(\d+(?:\.\d+)?)/);      // first number anywhere
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

const isFree = (m) => creditOf(m.credits !== undefined ? m.credits : m.credit) === 0;

const FREE_FALLBACK = [
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · Free now' },
  { id: 'hy4-preview-f', name: 'Hy4 preview · Free now' },
  { id: 'hy3', name: 'Hy3 · Free now' },
];

// ------------------------------------------------------------ model table

async function fetchModels(env, force) {
  const cached = await env.KEYS.get('models:cache', 'json');
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;

  let list = null;
  let source = 'fallback';

  try {
    // The catalogue requires the bearer token: without it the upstream
    // answers 200 with data.models = null, which looks like success but
    // yields nothing.
    const tok = await upstreamToken(env);
    const r = await fetch(`${env.ENDPOINT}/v3/config`, {
      headers: tok
        ? { ...noAuthHeaders(env), Authorization: `Bearer ${tok}` }
        : noAuthHeaders(env),
    });
    if (r.ok) {
      const raw = await r.json();
      // Responses are enveloped as {code, msg, requestId, data}; the models
      // live under data, not at the top level.
      const cfg = raw && raw.data ? raw.data : raw;
      const models = cfg && cfg.models;
      if (Array.isArray(models) && models.length) {
        list = [];
        for (const m of models) {
          const id = m.id || m.model;
          if (!id) continue;
          const credits = m.credits !== undefined ? m.credits : m.credit;
          const v = creditOf(credits);
          const free = v === 0;
          const base = m.name || id;
          // Label free models by name and paid ones with their rate, so the
          // two variants that share an upstream name stay distinguishable.
          const label =
            v === null ? base : free ? `${base} · 免费` : `${base} · ${String(credits).trim()}`;
          list.push({
            id,
            name: label,
            free,
            credits: v,
            contextWindow: m.maxInputTokens || m.contextWindow || m.context_window || 128000,
            maxTokens: m.maxOutputTokens || m.maxTokens || m.max_tokens || 8192,
          });
        }
        source = 'remote';
      }
    }
  } catch (e) {
    // Fall through to the built-in list.
  }

  if (!list) list = FREE_FALLBACK;

  const freeList = list.filter((m) => m.free);
  const freeCount = freeList.length;

  // Free-only must never widen to the paid list. An earlier version fell back
  // to serving every model when no free one was found, which is exactly the
  // case where spending money is most likely — a parse failure would have
  // silently exposed 19 paid models.
  //
  // If free-only yields nothing, serve nothing: an empty list makes the
  // caller stop, while a paid list makes it spend.
  const exposed = env.FREE_ONLY === 'true' ? freeList : list;
  const note =
    env.FREE_ONLY === 'true' && freeCount === 0
      ? '当前没有免费模型可用，已按免费模式返回空列表。如需强制放行全部模型，请在管理页关闭「仅免费」。'
      : '';

  // Side table holding only the permitted ids. The chat path reads this
  // instead of the full catalogue, so a request does not pay to parse every
  // model just to check one name.
  await env.KEYS.put('free:ids', JSON.stringify(freeList.map((m) => m.id)));

  const result = {
    at: Date.now(),
    source,
    all: list.length,
    free: freeCount,
    freeOnly: env.FREE_ONLY === 'true',
    exposed,
    note,
  };
  await env.KEYS.put('models:cache', JSON.stringify(result));
  return result;
}

// ------------------------------------------------------------------- auth

async function keyRecord(env, key) {
  if (!key) return null;
  return env.KEYS.get(`key:${key}`, 'json');
}

async function authorized(req, env) {
  if (env.REQUIRE_KEY !== 'true') return { ok: true };
  const rec = await keyRecord(env, bearer(req));
  if (!rec) return { ok: false };
  if (rec.disabled) return { ok: false, reason: 'disabled' };
  if (rec.expires && Date.now() > rec.expires) return { ok: false, reason: 'expired' };
  return { ok: true, rec };
}

// Hash then compare: a plain string comparison of the password leaks length
// and content through timing, and MD5MD5 (as edgetunnel does) is not a
// security primitive either. A digest of both sides is compared instead.
//
// This is defence in depth, not the primary control — the admin password is
// already a Worker secret, and Workers itself terminates TLS.
async function digest(text) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let s = '';
  for (const x of new Uint8Array(b)) s += x.toString(16).padStart(2, '0');
  return s;
}

async function safeEqual(a, b) {
  const ha = await digest(String(a));
  const hb = await digest(String(b));
  // Both digests are fixed-length hex, so a character loop cannot leak
  // length, and XOR-accumulating avoids an early exit on first difference.
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

// The admin session is a random token stored in KV, not a signed cookie:
// Workers has no multi-user identity, and this keeps the code dependency-free.
// Unlike edgetunnel's MD5MD5 cookie, the value here is not derived from the
// password, so rotating the password cannot be replayed by an old cookie.
async function adminSession(env, req) {
  const key = bearer(req);
  if (!key) return false;
  const s = await env.KEYS.get(`admin:${key}`);
  if (!s) return false;
  if (Date.now() > Number(s)) return false;
  return true;
}

function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += b.toString(16).padStart(2, '0');
  return s;
}

// ------------------------------------------------------------------ routes

/**
 * The ids permitted under free-only, memoised per isolate.
 *
 * Rebuilding the catalogue means a round trip to WorkBuddy, so this reads the
 * side table written alongside it. When that is missing (first run, or cleared
 * because a token changed) it falls back to building the list once.
 */
let freeIdsCache = null;

async function freeIds(env) {
  if (freeIdsCache) return freeIdsCache;

  const raw = await env.KEYS.get('free:ids');
  if (raw) {
    try {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids) && ids.length) {
        freeIdsCache = ids;
        return ids;
      }
    } catch {
      // fall through and rebuild
    }
  }

  const c = await fetchModels(env, true);
  const ids = c.exposed.map((m) => m.id);
  if (ids.length) freeIdsCache = ids;
  return ids;
}

async function handleModels(env, force) {
  const c = await fetchModels(env, force);
  return json({
    object: 'list',
    data: c.exposed.map((m) => ({ id: m.id, object: 'model', owned_by: 'workbuddy' })),
  });
}

/**
 * Relay a chat completion. The upstream response is always SSE, so it is
 * returned as a stream rather than buffered: buffering would both break the
 * streaming contract and risk the Worker's wall-clock limit.
 */
async function handleChat(req, env) {
  const body = await req.text();

  // Free-only has to be enforced here, not just in the model listing. A
  // client can request any model id directly, so filtering the list alone
  // would still allow a paid model to be invoked and billed.
  if (env.FREE_ONLY === 'true') {
    let model = null;
    try {
      model = JSON.parse(body).model;
    } catch {
      return json({ error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } }, 400);
    }
    // The full catalogue cache is several kilobytes and lists all 23 models;
    // parsing it on every request just to test one id is wasted work on the
    // hot path. freeIds() keeps only the permitted ids, small enough that the
    // check costs one short KV read instead of a large JSON parse.
    const allowed = await freeIds(env);
    if (!allowed.includes(model)) {
      return json({
        error: {
          message: `模型「${model}」不是当前免费模型，已按仅免费模式拒绝。可用：` +
            allowed.join(', '),
          type: 'invalid_request_error',
          code: 'model_not_free',
        },
      }, 403);
    }
  }

  // WorkBuddy serves completions under /v2, not /v1. Verified against the
  // working DSH plugin and confirmed by probing: every /v1 variant returns
  // 404 Route Not Found from the upstream.
  //
  // Cross-border drops and per-credential rate limits are real (measured ~4%
  // ECONNRESET; "请求过于频繁" 429s are why multiple tokens exist), so the
  // request is attempted against each credential in the pool until one
  // actually answers. Only connection failures and 429/403 from the upstream
  // rotate; an answered HTTP status — even 500 — is returned as-is, because
  // the model may have started generating.
  const endpoint = `${env.ENDPOINT}/v2/chat/completions`;
  const baseHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'User-Agent': ua(env),
  };

  const pool = await tokenPool(env);
  if (!pool.length) {
    return json({ error: { message: '未配置上游凭证', type: 'server_error' } }, 503);
  }

  const started = new Set();
  let upstream;
  let lastRotatable = false; // last answer was 429/403, safe to rotate away
  let lastError = null;

  for (let attempt = 0; attempt < pool.length * 2; attempt++) {
    const pick = await nextToken(env);
    if (started.has(pick.index)) break; // every credential tried once
    started.add(pick.index);

    try {
      upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { ...baseHeaders, Authorization: `Bearer ${pick.token}` },
        body,
      });

      const rotatable = upstream.status === 429 || upstream.status === 403;
      lastRotatable = rotatable;
      if (!rotatable) break;
      lastError = upstream.status;
      // Drain the body so the socket is reusable before rotating.
      await upstream.body?.cancel?.().catch(() => {});
    } catch (e) {
      lastError = e;
      lastRotatable = false;
      // connection failure — rotate to the next credential
    }
  }

  // Every credential was tried and every answer was rotatable (or every
  // connection failed). The last response's body has been consumed, so it
  // cannot be relayed — answer with a clear error instead.
  if (!upstream || lastRotatable) {
    const msg = lastRotatable
      ? `上游限流（HTTP ${lastError}），已尝试全部凭证仍被拒绝`
      : '上游连接失败，已尝试全部凭证';
    const status = lastRotatable ? lastError : 502;
    return json({ error: { message: msg, type: 'upstream_error' } }, status);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
}

// ------------------------------------------------------------- admin login

async function adminLogin(req, env) {
  const { password } = await req.json().catch(() => ({}));
  if (!password || !(await safeEqual(password, adminPassword(env)))) {
    return json({ error: 'bad password' }, 401);
  }
  const token = randomToken(32);
  // Sessions last 12 hours.
  await env.KEYS.put(`admin:${token}`, String(Date.now() + 12 * 3600 * 1000), {
    expirationTtl: 12 * 3600,
  });
  return json({ token });
}

async function listKeys(env) {
  const list = await env.KEYS.list({ prefix: 'key:' });
  const out = [];
  for (const k of list.keys) {
    const rec = await env.KEYS.get(k.name, 'json');
    if (!rec) continue;
    out.push({
      key: k.name.slice(4),
      name: rec.name || '',
      created: rec.created,
      expires: rec.expires || null,
      disabled: !!rec.disabled,
      requests: rec.requests || 0,
      lastUsed: rec.lastUsed || null,
    });
  }
  out.sort((a, b) => (b.created || 0) - (a.created || 0));
  return json({ keys: out });
}

async function createKey(req, env) {
  const { name, days } = await req.json().catch(() => ({}));
  const key = 'wb-' + randomToken(16);
  const rec = {
    name: name || '',
    created: Date.now(),
    expires: days ? Date.now() + Number(days) * 86400000 : null,
    disabled: false,
    requests: 0,
  };
  await env.KEYS.put(`key:${key}`, JSON.stringify(rec));
  return json({ key, ...rec });
}

async function deleteKey(req, env) {
  const { key } = await req.json().catch(() => ({}));
  if (!key) return json({ error: 'key required' }, 400);
  await env.KEYS.delete(`key:${key}`);
  return json({ ok: true });
}

// Begin a WorkBuddy web login: the caller opens authUrl, then polls.
async function loginStart(env) {
  const r = await fetch(`${env.ENDPOINT}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: noAuthHeaders(env),
  });
  const text = await r.text();
  let raw = {};
  try {
    raw = JSON.parse(text);
  } catch {
    // Surface the raw body: an upstream block page (Cloudflare challenge,
    // WAF, HTML error) parses as nothing and would otherwise look like an
    // empty response.
    return json({
      error: '上游返回非 JSON',
      http: r.status,
      ctype: r.headers.get('content-type') || '',
      raw: text.slice(0, 400),
    }, 502);
  }
  // Enveloped response: {code, msg, requestId, data:{state, authUrl}}.
  const d = raw.data || raw;
  if (!d.state) {
    return json({
      error: '上游未返回 state',
      http: r.status,
      upstream: raw.msg || raw.message || '',
      code: raw.code,
    }, 502);
  }
  return json({ state: d.state, authUrl: d.authUrl || '' });
}

function tokenFrom(j) {
  const d = j.data || {};
  return d.accessToken || d.token || d.access_token || j.accessToken || j.token || '';
}

function decodeExp(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p.exp ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Persist a token so the admin UI can refresh it without a redeploy. */
async function saveToken(env, token, source, name = '') {
  const expires = decodeExp(token);
  const pool = await tokenPool(env);
  // Avoid duplicate entries: saving the same credential twice is a mistake,
  // not a second account.
  const dup = pool.find((e) => e.token === token);
  if (dup) {
    dup.source = source;
    if (name) dup.name = name;
    dup.at = Date.now();
  } else {
    pool.push({ token, expires, source, name, at: Date.now() });
  }
  await env.KEYS.put('upstream:tokens', JSON.stringify(pool));
  // The legacy key is superseded; drop it so the fallback never resurrects
  // an old single token next to the list.
  await env.KEYS.delete('upstream:token');
  poolCache = null; // drop the memoised list so the next request re-reads
  await env.KEYS.delete('models:cache');
  await env.KEYS.delete('free:ids');
  return { expires, source, name, at: Date.now(), total: pool.length };
}

/** Remove one credential by its position in the pool. */
async function removeToken(env, index) {
  const pool = await tokenPool(env);
  const i = Number(index);
  if (!(i >= 0) || i >= pool.length) {
    return json({ error: '凭证序号无效' }, 400);
  }
  const removed = pool.splice(i, 1)[0];
  if (pool.length) {
    await env.KEYS.put('upstream:tokens', JSON.stringify(pool));
  } else {
    // Last credential gone; clear the key so the secret fallback takes over.
    await env.KEYS.delete('upstream:tokens');
  }
  poolCache = null;
  await env.KEYS.delete('models:cache');
  await env.KEYS.delete('free:ids');
  return json({ ok: true, removed: removed.source || '凭证', total: pool.length });
}

async function loginPoll(env, state) {
  const r = await fetch(`${env.ENDPOINT}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
    headers: noAuthHeaders(env),
  });
  const j = await r.json().catch(() => ({}));
  // 11217 means the user has not finished logging in yet.
  if (j.code === 11217) return json({ status: 'waiting' });

  const token = tokenFrom(j);
  if (!token) {
    return json({ status: 'failed', message: j.msg || j.message || '上游未返回 token' });
  }
  const saved = await saveToken(env, token, '网页登录');
  return json({ status: 'ok', token, ...saved });
}

/** Accept a token pasted by the operator. */
async function putToken(req, env) {
  const { token, name } = await req.json().catch(() => ({}));
  if (!token || typeof token !== 'string' || token.length < 20) {
    return json({ error: 'token 无效' }, 400);
  }
  const saved = await saveToken(env, token.trim(), '手动填写', typeof name === 'string' ? name.trim() : '');
  return json({ ok: true, ...saved });
}

/** Drop one credential from the pool. */
async function deleteToken(req, env) {
  const { index } = await req.json().catch(() => ({}));
  return removeToken(env, index);
}

/** Report the credential pool: how many, sources, and masks. */
async function tokenStatus(env) {
  const pool = await tokenPool(env);
  const secret = env.UPSTREAM_TOKEN || env.WORKBUDDY_TOKEN || env.TOKEN || '';

  return json({
    total: pool.length,
    secretConfigured: !!secret,
    entries: pool.map((e) => ({
      index: pool.indexOf(e),
      source: e.source || '未知',
      name: e.name || '',
      setAt: e.at || null,
      expires: e.expires || (e.token ? decodeExp(e.token) : null),
      length: e.token ? e.token.length : 0,
      preview: e.token ? e.token.slice(0, 8) + '...' + e.token.slice(-6) : '',
    })),
  });
}

/** Test the active token against the upstream catalogue. */
async function tokenVerify(env) {
  const tok = await upstreamToken(env);
  if (!tok) return json({ ok: false, message: '未配置 token' });

  const t0 = Date.now();
  try {
    // The catalogue needs the bearer token: called without it the upstream
    // still answers 200, but with data.models = null.
    const r = await fetch(`${env.ENDPOINT}/v3/config`, {
      headers: { ...noAuthHeaders(env), Authorization: `Bearer ${tok}` },
    });
    const ms = Date.now() - t0;
    if (r.status === 401 || r.status === 403) {
      return json({ ok: false, http: r.status, ms, message: 'token 无效或已过期' });
    }
    if (!r.ok) {
      return json({ ok: false, http: r.status, ms, message: '上游返回 ' + r.status });
    }
    const j = await r.json().catch(() => ({}));
    const d = j.data || j;
    const n = Array.isArray(d.models) ? d.models.length : 0;
    await env.KEYS.delete('models:cache');
    return json({
      ok: n > 0,
      http: r.status,
      ms,
      models: n,
      message: n > 0
        ? '凭证有效，共 ' + n + ' 个模型'
        : '凭证被接受但未返回模型（可能已失效或权限不足）',
    });
  } catch (e) {
    return json({ ok: false, ms: Date.now() - t0, message: '请求失败: ' + String(e) });
  }
}

// 
// -------------------------------------------------------------------- page

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>WorkBuddy 中转 · 管理</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
       margin:0;background:#f5f6f8;color:#1b1f24}
  .wrap{max-width:940px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:21px;margin:0 0 6px;letter-spacing:.3px}
  h2{font-size:15px;margin:0 0 4px}
  .sub{color:#6a737d;font-size:13px;margin-bottom:22px}
  .card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:22px;margin-bottom:16px}
  .card h2{display:flex;align-items:center;gap:8px}
  .tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;
       background:#eef1f4;color:#57606a;letter-spacing:.2px}
  .tag.ok{background:#dafbe1;color:#1a7f37}
  .tag.warn{background:#fff8c5;color:#9a6700}
  .tag.err{background:#ffebe9;color:#cf222e}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;color:#24292f}
  input{width:100%;padding:10px 12px;border:1px solid #d0d7de;border-radius:7px;
        font-size:14px;font-family:inherit;background:#fff}
  input:focus{outline:2px solid #0969da22;border-color:#0969da}
  button{margin-top:12px;padding:9px 18px;background:#0969da;color:#fff;border:0;
         border-radius:7px;cursor:pointer;font-size:14px;font-family:inherit;font-weight:500}
  button:hover{background:#0860c4}
  button:disabled{opacity:.55;cursor:not-allowed}
  button.sec{background:#6e7781}
  button.sec:hover{background:#57606a}
  button.danger{background:#cf222e}
  button.danger:hover{background:#a40e26}
  button.mini{margin:0;padding:5px 12px;font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #eaeef2;vertical-align:middle}
  th{color:#6a737d;font-weight:600;font-size:12px;letter-spacing:.3px}
  tr:last-child td{border-bottom:0}
  code{background:#f0f2f4;padding:3px 7px;border-radius:5px;font-size:12px;
       word-break:break-all;font-family:ui-monospace,Consolas,monospace}
  .msg{margin-top:12px;padding:11px 13px;border-radius:7px;font-size:13px;
       display:none;line-height:1.6;word-break:break-all}
  .msg.ok{background:#dafbe1;color:#1a7f37;display:block}
  .msg.err{background:#ffebe9;color:#cf222e;display:block}
  .msg.info{background:#ddf4ff;color:#0969da;display:block}
  .msg.warn{background:#fff8c5;color:#9a6700;display:block}
  .row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:4px}
  .row>div{flex:1;min-width:150px}
  .row>div.grow{flex:2;min-width:220px}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;margin-top:12px}
  .kv dt{color:#6a737d}
  .kv dd{margin:0;word-break:break-all}
  .tok-row{display:flex;gap:10px;align-items:center;padding:10px 0;border-top:1px solid #eaeef2}
  .tok-row:first-child{border-top:none}
  .danger{color:#d1242f!important;border-color:#d1242f}
  .steps{font-size:13px;color:#57606a;margin:10px 0 0;padding-left:20px;line-height:1.9}
  .steps li{margin:0}
  .hide{display:none!important}
  a{color:#0969da}
  .hint{font-size:12px;color:#6a737d;margin-top:8px;line-height:1.7}
</style>
<div class="wrap">
  <h1>WorkBuddy 中转</h1>
  <div class="sub">OpenAI 兼容接口 · API Key 管理与上游凭证维护</div>

  <div class="card" id="login-card">
    <h2>登录管理面板</h2>
    <label for="pw">管理密码</label>
    <input id="pw" type="password" placeholder="请输入管理密码" autocomplete="new-password" spellcheck="false">
    <button id="login-btn" onclick="doLogin()">登录</button>
    <div class="msg" id="login-msg"></div>
  </div>

  <div id="main" class="hide">

    <div class="card">
      <h2>上游凭证 <span class="tag" id="tok-tag">读取中</span></h2>
      <div class="sub" style="margin:0">
        中转调用 WorkBuddy 所用的登录凭证，<b>支持多个凭证轮换使用</b>：调用时依次轮换，
        某个凭证被限流（「请求过于频繁」）或失效时自动换下一个，全部失败才报错。
        凭证过期后模型列表和对话都会失败，在此更新即可，<b>无需重新部署</b>。
      </div>
      <div id="tok-list"></div>
      <div class="row">
        <button class="sec" onclick="verifyToken()" id="verify-btn">检测凭证</button>
        <button class="sec" onclick="startLogin()" id="wblogin-btn">用 WorkBuddy 账号登录</button>
      </div>
      <div class="msg" id="tok-msg"></div>

      <div id="login-flow" class="hide">
        <ol class="steps">
          <li>已自动打开登录页（若未打开，请点下方链接）</li>
          <li>在该页面完成 WorkBuddy 账号登录</li>
          <li>本页面会自动取得并保存凭证，无需手动复制</li>
        </ol>
        <div style="margin-top:10px">
          <a id="auth-link" href="#" target="_blank" rel="noopener">手动打开登录页 →</a>
        </div>
        <div style="margin-top:14px">
          <button class="sec" onclick="cancelLogin()">取消</button>
        </div>
      </div>

      <label for="manual-tok">添加凭证（可粘贴多个，每行一个，自动加入轮换池）</label>
      <input id="manual-tok" placeholder="粘贴 WorkBuddy access token（每行一个）" autocomplete="off">
      <div class="row" style="margin-top:8px">
        <div class="grow">
          <label for="manual-name">备注（可选）</label>
          <input id="manual-name" placeholder="例如：账号 A / 小号 2" autocomplete="off">
        </div>
      </div>
      <button onclick="saveManual()">添加凭证</button>
    </div>

    <div class="card">
      <h2>生成 API Key</h2>
      <div class="sub" style="margin:0">给每台设备分配独立 Key，可单独吊销，互不影响。</div>
      <div class="row">
        <div class="grow">
          <label for="kname">备注名称</label>
          <input id="kname" placeholder="例如：我的笔记本">
        </div>
        <div>
          <label for="kdays">有效期（天）</label>
          <input id="kdays" type="number" min="1" placeholder="留空=永久">
        </div>
      </div>
      <button onclick="createKey()" id="create-btn">生成 Key</button>
      <div class="msg" id="new-msg"></div>
    </div>

    <div class="card">
      <h2>已有 API Key <span class="tag" id="key-count">0</span></h2>
      <table>
        <thead>
          <tr><th>备注</th><th>Key</th><th>到期</th><th style="width:80px"></th></tr>
        </thead>
        <tbody id="keys"></tbody>
      </table>
      <div class="msg info" id="keys-empty">暂无 Key，请在上方生成。</div>
    </div>

    <div class="card">
      <h2>接口地址</h2>
      <dl class="kv">
        <dt>Base URL</dt><dd><code id="api-base">—</code></dd>
        <dt>模型列表</dt><dd><code id="api-models">—</code></dd>
        <dt>对话接口</dt><dd><code id="api-chat">—</code></dd>
      </dl>
      <div class="hint">
        在任意 OpenAI 兼容客户端中填入 Base URL 与生成的 Key 即可使用。
        注意：WorkBuddy 仅支持流式（<code>stream: true</code>），且首条消息必须为 <code>system</code>。
      </div>
    </div>
  </div>

  </div>
</div>
<script>
var T = sessionStorage.getItem('wbt') || '';
var pollTimer = null;

function H() { return { Authorization: 'Bearer ' + T }; }
function Hj() { return { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }; }

function show(id, cls, html) {
  var e = document.getElementById(id);
  e.className = 'msg ' + cls;
  e.innerHTML = html;
}
function hide(id) { document.getElementById(id).className = 'msg'; }
function esc(s) {
  var d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function fmtTime(ms) {
  if (!ms) return '—';
  var d = new Date(ms);
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function before(ms) {
  if (!ms) return null;
  return Math.round((ms - Date.now()) / 86400000);
}

function doLogin() {
  var input = document.getElementById('pw');
  var btn = document.getElementById('login-btn');
  var pw = input.value.trim();

  // Empty input is the most common miss and used to fail silently, which
  // reads as "the page is broken" rather than "type something".
  if (!pw) {
    show('login-msg', 'err', '✗ 请先输入管理密码');
    input.focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = '登录中…';
  show('login-msg', 'info', '正在验证密码…');

  fetch('/admin/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (o) {
      btn.disabled = false;
      btn.textContent = '登录';
      if (o.j.token) {
        T = o.j.token;
        sessionStorage.setItem('wbt', T);
        show('login-msg', 'ok', '✓ 密码正确，正在进入管理面板…');
        // Give the confirmation a moment to be read before the panel swaps in.
        setTimeout(enterApp, 350);
      } else if (o.s === 401) {
        show('login-msg', 'err', '✗ 密码错误，请重新输入');
        input.value = '';
        input.focus();
      } else {
        show('login-msg', 'err', '✗ 登录失败（HTTP ' + o.s + '）：' + esc(o.j.error || '未知错误'));
        input.focus();
      }
    })
    .catch(function (e) {
      btn.disabled = false;
      btn.textContent = '登录';
      show('login-msg', 'err', '✗ 请求失败：' + esc(e.message));
    });
}

document.getElementById('pw').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') doLogin();
});

function enterApp() {
  document.getElementById('login-card').classList.add('hide');
  document.getElementById('main').classList.remove('hide');
  document.getElementById('api-base').textContent = location.origin + '/v1';
  document.getElementById('api-models').textContent = location.origin + '/v1/models';
  document.getElementById('api-chat').textContent = location.origin + '/v1/chat/completions';
  loadToken();
  loadKeys();
}

function loadToken() {
  fetch('/admin/api/token', { headers: H() })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var tag = document.getElementById('tok-tag');
      var list = document.getElementById('tok-list');
      list.innerHTML = '';
      var entries = j.entries || [];
      tag.textContent = entries.length ? entries.length + ' 个凭证' : '未配置';
      tag.className = 'tag ' + (entries.length ? 'ok' : 'warn');

      if (!entries.length) {
        var empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = j.secretConfigured ? '使用环境变量中的凭证（不在列表中显示）' : '尚未配置凭证';
        list.appendChild(empty);
        return;
      }

      entries.forEach(function (e) {
        var row = document.createElement('div');
        row.className = 'tok-row';
        var left = before(e.expires);
        var leftTxt = e.expires
          ? (left !== null ? (left > 0 ? '剩余 ' + left + ' 天' : '已过期') : '')
          : '';
        row.innerHTML =
          '<div class="grow">' +
            '<div><code>' + esc(e.preview || '—') + '</code> ' +
              (e.name ? '<b>' + esc(e.name) + '</b>' : '') +
              '<span class="tag ' + (left !== null && left < 0 ? 'err' : 'ok') + '">' +
                esc(e.source || '') + '</span></div>' +
            '<div class="sub" style="margin:4px 0 0">' +
              '添加于 ' + esc(fmtTime(e.setAt)) +
              (e.expires ? ' · 有效期至 ' + esc(fmtTime(e.expires)) + ' ' + esc(leftTxt) : '') +
            '</div>' +
          '</div>' +
          '<button class="sec danger" onclick="removeTokenEntry(' + e.index + ')">删除</button>';
        list.appendChild(row);
      });
    });
}

function removeTokenEntry(index) {
  if (!confirm('确定删除该凭证？删除后轮换池将少一个可用凭证。')) return;
  fetch('/admin/api/token/delete', {
    method: 'POST',
    headers: Hj(),
    body: JSON.stringify({ index: index }),
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      show('tok-msg', j.ok ? 'ok' : 'err', j.ok ? '✓ 已删除' : esc(j.error || '删除失败'));
      if (j.ok) loadToken();
    })
    .catch(function (e) {
      show('tok-msg', 'err', '请求失败：' + esc(e.message));
    });
}

function verifyToken() {
  var b = document.getElementById('verify-btn');
  b.disabled = true;
  show('tok-msg', 'info', '正在检测…');
  fetch('/admin/api/token/verify', { headers: H() })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      b.disabled = false;
      show('tok-msg', j.ok ? 'ok' : 'err',
        (j.ok ? '✓ ' : '✗ ') + esc(j.message) + (j.ms ? '（' + j.ms + ' ms）' : ''));
      if (j.ok) loadToken();
    })
    .catch(function (e) {
      b.disabled = false;
      show('tok-msg', 'err', '请求失败：' + esc(e.message));
    });
}

function startLogin() {
  var b = document.getElementById('wblogin-btn');
  b.disabled = true;
  show('tok-msg', 'info', '正在向 WorkBuddy 申请登录会话…');
  fetch('/admin/api/login/start', { headers: H() })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      b.disabled = false;
      if (!j.authUrl) {
        show('tok-msg', 'err', '申请失败：' + esc(j.error || '上游未返回登录地址'));
        return;
      }
      document.getElementById('auth-link').href = j.authUrl;
      document.getElementById('login-flow').classList.remove('hide');
      show('tok-msg', 'info', '请在新打开的页面完成登录，本页会自动获取凭证。');
      window.open(j.authUrl, '_blank');
      pollLogin(j.state, 0);
    })
    .catch(function (e) {
      b.disabled = false;
      show('tok-msg', 'err', '请求失败：' + esc(e.message));
    });
}

function pollLogin(state, n) {
  if (n > 100) {
    show('tok-msg', 'err', '等待超时，请重新点击登录。');
    document.getElementById('login-flow').classList.add('hide');
    return;
  }
  pollTimer = setTimeout(function () {
    fetch('/admin/api/login/poll?state=' + encodeURIComponent(state), { headers: H() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.status === 'ok') {
          document.getElementById('login-flow').classList.add('hide');
          show('tok-msg', 'ok', '✓ 凭证已获取并保存，模型列表已刷新。');
          loadToken();
        } else if (j.status === 'failed') {
          document.getElementById('login-flow').classList.add('hide');
          show('tok-msg', 'err', '登录失败：' + esc(j.message || '未知原因'));
        } else {
          pollLogin(state, n + 1);
        }
      })
      .catch(function () { pollLogin(state, n + 1); });
  }, 3000);
}

function cancelLogin() {
  if (pollTimer) clearTimeout(pollTimer);
  document.getElementById('login-flow').classList.add('hide');
  hide('tok-msg');
}

function saveManual() {
  var raw = document.getElementById('manual-tok').value.trim();
  if (!raw) return;
  var name = document.getElementById('manual-name').value.trim();
  // Support several tokens at once, one per line: all join the rotation pool.
  // NOTE: this lives inside a template literal, so the regex backslashes are
  // doubled — otherwise they would be emitted as real CR/LF characters into
  // the browser script and the whole script block would fail to parse (which
  // is exactly how "clicking login does nothing" happened).
  var tokens = raw.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!tokens.length) return;

  var box = show('tok-msg', 'info', '正在添加 ' + tokens.length + ' 个凭证…');
  var done = 0, failed = 0;
  var chain = Promise.resolve();
  tokens.forEach(function (t) {
    chain = chain.then(function () {
      return fetch('/admin/api/token', {
        method: 'POST',
        headers: Hj(),
        body: JSON.stringify({ token: t, name: name }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.ok) done++; else failed++;
      }).catch(function () { failed++; });
    });
  });
  chain.then(function () {
    var msg = '✓ 已添加 ' + done + ' 个凭证，轮换池共 ' + done + ' 个。' +
      (failed ? ' ' + failed + ' 个失败（可能是重复或格式错误）。' : '');
    show('tok-msg', done ? 'ok' : 'err', msg);
    document.getElementById('manual-tok').value = '';
    document.getElementById('manual-name').value = '';
    loadToken();
  });
}

function loadKeys() {
  fetch('/admin/api/keys', { headers: H() })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var tb = document.getElementById('keys');
      var list = j.keys || [];
      tb.innerHTML = '';
      document.getElementById('key-count').textContent = list.length;
      document.getElementById('keys-empty').className = list.length ? 'msg' : 'msg info';
      list.forEach(function (k) {
        var tr = document.createElement('tr');
        var left = before(k.expires);
        var expTxt = k.expires
          ? fmtTime(k.expires).slice(0, 10) + (left !== null && left < 0 ? '（已过期）' : '')
          : '永久';
        tr.innerHTML =
          '<td>' + esc(k.name || '未命名') + '</td>' +
          '<td><code>' + esc(k.key) + '</code></td>' +
          '<td>' + esc(expTxt) + '</td>' +
          '<td></td>';
        var b = document.createElement('button');
        b.className = 'danger mini';
        b.textContent = '吊销';
        b.onclick = function () {
          if (!confirm('确定吊销该 Key？使用它的设备将立即失效。')) return;
          revoke(k.key);
        };
        tr.lastChild.appendChild(b);
        tb.appendChild(tr);
      });
    });
}

function createKey() {
  var b = document.getElementById('create-btn');
  b.disabled = true;
  fetch('/admin/api/keys', {
    method: 'POST',
    headers: Hj(),
    body: JSON.stringify({
      name: document.getElementById('kname').value,
      days: document.getElementById('kdays').value || null
    })
  }).then(function (r) { return r.json(); })
    .then(function (j) {
      b.disabled = false;
      document.getElementById('kname').value = '';
      document.getElementById('kdays').value = '';
      show('new-msg', 'ok', '✓ 已生成，请立即保存：<br><code>' + esc(j.key) + '</code>');
      loadKeys();
    });
}

function revoke(k) {
  fetch('/admin/api/keys/delete', { method: 'POST', headers: Hj(), body: JSON.stringify({ key: k }) })
    .then(function () { loadKeys(); });
}

// Restore a previous session on load. Without this, refreshing the page threw
// away a perfectly valid session and dumped the operator back on the password
// screen, which reads as "login is broken". A stale token is cleared quietly
// so the password form is presented cleanly.
(function restore() {
  if (!T) { document.getElementById('pw').focus(); return; }
  fetch('/admin/api/token', { headers: H() })
    .then(function (r) {
      if (r.status === 401) {
        sessionStorage.removeItem('wbt');
        T = '';
        document.getElementById('pw').focus();
        return null;
      }
      return r.json().then(function () { enterApp(); });
    })
    .catch(function () {
      // Network blip: leave the session alone rather than logging the user out.
      document.getElementById('pw').focus();
    });
})();

</script>
</html>`;

// ----------------------------------------------------------------- router

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      } });
    }

    // ---- admin UI ----
    if (p === '/admin' || p === '/admin/') {
      return new Response(ADMIN_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // The admin page must never be cached by a browser or an
          // intermediate: a stale copy can keep serving after a redeploy.
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      });
    }

    if (p === '/admin/api/login') return adminLogin(req, env);

    // Everything below the login endpoint requires an admin session.
    if (p.startsWith('/admin/api/')) {
      if (!(await adminSession(env, req))) return json({ error: 'unauthorized' }, 401);

      if (p === '/admin/api/keys' && req.method === 'GET') return listKeys(env);
      if (p === '/admin/api/keys' && req.method === 'POST') return createKey(req, env);
      if (p === '/admin/api/keys/delete') return deleteKey(req, env);
      if (p === '/admin/api/token' && req.method === 'GET') return tokenStatus(env);
      if (p === '/admin/api/token' && req.method === 'POST') return putToken(req, env);
      if (p === '/admin/api/token/delete') return deleteToken(req, env);
      if (p === '/admin/api/token/verify') return tokenVerify(env);
      if (p === '/admin/api/login/start') return loginStart(env);
      if (p === '/admin/api/login/poll') {
        return loginPoll(env, url.searchParams.get('state') || '');
      }
      // The edge that answered and where the Worker actually ran. With Smart
      // Placement these differ: the edge follows the client, the execution
      // follows the backend. The trace round-trip reveals the execution colo
      // because that is the colo the outbound request lands in.
      if (p === '/admin/api/colo') {
        let execColo = '';
        try {
          const tr = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
            signal: AbortSignal.timeout(5000),
          });
          const text = await tr.text();
          execColo = (text.match(/^colo=(.+)$/m) || [])[1] || '';
        } catch { /* non-fatal */ }
        return json({
          edge: (req.cf && req.cf.colo) || '?',
          edgeCity: (req.cf && req.cf.city) || '',
          country: (req.cf && req.cf.country) || '',
          execution: execColo || '(查询失败)',
        });
      }
      return json({ error: 'no route' }, 404);
    }

    // ---- OpenAI-compatible API ----
    // Model listing is gated the same way as chat: it reveals which models
    // are available, and an unauthenticated list is an unnecessary leak.
    if (p === '/v1/models' || p === '/models' || p === '/models/refresh') {
      const auth = await authorized(req, env);
      if (!auth.ok) {
        return json({ error: { message: 'invalid api key', type: 'auth_error' } }, 401);
      }
      return handleModels(env, p === '/models/refresh');
    }

    if (p === '/v1/chat/completions' || p === '/chat/completions') {
      const auth = await authorized(req, env);
      if (!auth.ok) {
        return json({ error: { message: 'invalid api key', type: 'auth_error' } }, 401);
      }
      if (auth.rec) {
        // Counters are skipped by default. The free KV tier allows only 1,000
        // writes per day, so incrementing on every request would exhaust the
        // whole quota after ~1,000 calls and start failing. Enable only when
        // the write budget is understood.
        if (env.COUNT_USAGE === 'true') {
          auth.rec.requests = (auth.rec.requests || 0) + 1;
          auth.rec.lastUsed = Date.now();
          await env.KEYS.put(`key:${bearer(req)}`, JSON.stringify(auth.rec));
        }
      }
      return handleChat(req, env);
    }

    return json({ error: { message: 'no route ' + p } }, 404);
  },

  /**
   * Scheduled keep-alive.
   *
   * Cloudflare evicts an idle isolate, and the first request after that pays
   * to load and parse the whole script again — measured at ~2.5s on this
   * Worker versus ~0.3-0.8s warm. A cheap self-request on a schedule keeps
   * one warm, which is the single largest latency win available here.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      fetch('https://' + (env.WORKER_HOST || 'kz007.ccwu.cc') + '/admin')
        .then((r) => r.text())
        .catch(() => {}),
    );
  },
};
