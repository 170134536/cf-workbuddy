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
 *   GET  /admin/api/login/start     begin a WorkBuddy web login
 *   GET  /admin/api/login/poll      poll for the resulting upstream token
 */

const UA_BASE = 'WorkBuddy/';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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

// WorkBuddy rejects unknown user agents on the catalogue endpoint with
// 400 code12403, so the client version is part of every request.
// Accept several spellings for the upstream token, the way edgetunnel accepts
// several for its admin password: a secret set under one name should not be
// silently ignored because the operator picked another.
function upstreamToken(env) {
  return env.UPSTREAM_TOKEN || env.WORKBUDDY_TOKEN || env.TOKEN || '';
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
 * credits == 0 means free right now. An absent or empty value is *unrated*
 * and must never be reported as free.
 */
function creditOf(c) {
  if (c === undefined || c === null || c === '') return null;
  const v = Number(c);
  return Number.isNaN(v) ? null : v;
}

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
    const r = await fetch(`${env.ENDPOINT}/v3/config`, {
      headers: noAuthHeaders(env),
    });
    if (r.ok) {
      const cfg = await r.json();
      const models = cfg && cfg.models;
      if (Array.isArray(models) && models.length) {
        list = [];
        for (const m of models) {
          const id = m.id || m.model;
          if (!id) continue;
          const credits = m.credits !== undefined ? m.credits : m.credit;
          const free = creditOf(credits) === 0;
          const base = m.name || id;
          const label =
            creditOf(credits) === null
              ? base
              : free
                ? `${base} · Free now`
                : `${base} · x${credits}`;
          list.push({
            id,
            name: label,
            free,
            contextWindow: m.contextWindow || m.context_window || 128000,
            maxTokens: m.maxTokens || m.max_tokens || 8192,
          });
        }
        source = 'remote';
      }
    }
  } catch (e) {
    // Fall through to the built-in list.
  }

  if (!list) list = FREE_FALLBACK;

  const freeCount = list.filter((m) => m.free).length;
  // Never expose zero models: if free-only would empty the list, serve all.
  const exposed = env.FREE_ONLY === 'true' && freeCount ? list.filter((m) => m.free) : list;

  const result = {
    at: Date.now(),
    source,
    all: list.length,
    free: freeCount,
    exposed,
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

  // WorkBuddy serves completions under /v2, not /v1. Verified against the
  // working DSH plugin and confirmed by probing: every /v1 variant returns
  // 404 Route Not Found from the upstream.
  const upstream = await fetch(`${env.ENDPOINT}/v2/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'User-Agent': ua(env),
      'Authorization': `Bearer ${upstreamToken(env)}`,
    },
    body,
  });

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
  const j = await r.json().catch(() => ({}));
  if (!j.state) return json({ error: 'no state returned' }, 502);
  return json({ state: j.state, authUrl: j.authUrl || '' });
}

async function loginPoll(env, state) {
  const r = await fetch(`${env.ENDPOINT}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
    headers: noAuthHeaders(env),
  });
  const j = await r.json().catch(() => ({}));
  // 11217 means the user has not finished logging in yet.
  if (j.code === 11217) return json({ status: 'waiting' });

  const token =
    (j.data && (j.data.accessToken || j.data.token)) || j.accessToken || j.token;
  if (!token) {
    return json({ status: 'failed', message: j.msg || j.message || 'no token' });
  }
  // Upstream tokens live in Worker secrets; echo it back so the operator can
  // paste it into the environment. It is not persisted in KV.
  return json({ status: 'ok', token });
}

// -------------------------------------------------------------------- page

const ADMIN_HTML = `<!doctype html>
<meta charset="utf-8">
<title>WorkBuddy Relay - Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f6f7f9;color:#1b1f24}
  .wrap{max-width:900px;margin:0 auto;padding:24px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#6a737d;font-size:13px;margin-bottom:24px}
  .card{background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:20px;margin-bottom:16px}
  label{display:block;font-size:13px;font-weight:600;margin:12px 0 6px}
  input{width:100%;padding:9px 11px;border:1px solid #d0d7de;border-radius:6px;font-size:14px;box-sizing:border-box}
  button{margin-top:12px;padding:9px 16px;background:#0969da;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:14px}
  button.sec{background:#6a737d}
  button.danger{background:#cf222e}
  button:disabled{opacity:.6}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #eaeef2}
  th{color:#6a737d;font-weight:600}
  code{background:#f0f2f4;padding:2px 6px;border-radius:4px;font-size:12px;word-break:break-all}
  .msg{margin-top:12px;padding:10px;border-radius:6px;font-size:13px;display:none}
  .msg.ok{background:#dafbe1;color:#1a7f37;display:block}
  .msg.err{background:#ffebe9;color:#cf222e;display:block}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
</style>
<div class="wrap">
  <h1>WorkBuddy Relay</h1>
  <div class="sub">Manage API keys for your OpenAI-compatible relay.</div>

  <div class="card" id="login-card">
    <label>Admin password</label>
    <input id="pw" type="password" placeholder="ADMIN_PASSWORD">
    <button onclick="login()">Sign in</button>
    <div class="msg err" id="login-msg"></div>
  </div>

  <div id="main" style="display:none">
    <div class="card">
      <label>New key</label>
      <div class="row">
        <input id="kname" placeholder="name (optional)" style="flex:2;min-width:160px">
        <input id="kdays" type="number" placeholder="days (blank = never)" style="flex:1;min-width:140px">
      </div>
      <button onclick="createKey()">Generate key</button>
      <div class="msg" id="new-msg"></div>
    </div>

    <div class="card">
      <label>API keys</label>
      <table>
        <thead><tr><th>Name</th><th>Key</th><th>Used</th><th>Expires</th><th></th></tr></thead>
        <tbody id="keys"></tbody>
      </table>
    </div>

    <div class="card">
      <label>Refresh upstream token</label>
      <div class="sub" style="margin:0 0 10px">Opens WorkBuddy login. Copy the resulting
      token into the UPSTREAM_TOKEN secret.</div>
      <button class="sec" onclick="startLogin()">Log in to WorkBuddy</button>
      <div class="msg" id="up-msg"></div>
    </div>
  </div>
</div>
<script>
var T = sessionStorage.getItem('wbt') || '';
function h() { return { Authorization: 'Bearer ' + T }; }
function show(id, cls, text) {
  var e = document.getElementById(id);
  e.className = 'msg ' + cls;
  e.textContent = text;
}
function login() {
  fetch('/admin/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value })
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j.token) {
      T = j.token;
      sessionStorage.setItem('wbt', T);
      document.getElementById('login-card').style.display = 'none';
      document.getElementById('main').style.display = '';
      load();
    } else show('login-msg', 'err', 'Wrong password');
  });
}
function load() {
  fetch('/admin/api/keys', { headers: h() }).then(function (r) { return r.json(); })
    .then(function (j) {
      var tb = document.getElementById('keys');
      tb.innerHTML = '';
      (j.keys || []).forEach(function (k) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + esc(k.name || '-') + '</td>' +
          '<td><code>' + esc(k.key) + '</code></td>' +
          '<td>' + (k.requests || 0) + '</td>' +
          '<td>' + (k.expires ? new Date(k.expires).toLocaleDateString() : 'never') + '</td>' +
          '<td></td>';
        var b = document.createElement('button');
        b.className = 'danger';
        b.textContent = 'Revoke';
        b.onclick = function () { revoke(k.key); };
        tr.lastChild.appendChild(b);
        tb.appendChild(tr);
      });
    });
}
function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function createKey() {
  fetch('/admin/api/keys', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h()),
    body: JSON.stringify({
      name: document.getElementById('kname').value,
      days: document.getElementById('kdays').value || null
    })
  }).then(function (r) { return r.json(); }).then(function (j) {
    show('new-msg', 'ok', 'Key: ' + j.key);
    load();
  });
}
function revoke(k) {
  fetch('/admin/api/keys/delete', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h()),
    body: JSON.stringify({ key: k })
  }).then(load);
}
var st = null;
function startLogin() {
  fetch('/admin/api/login/start', { headers: h() }).then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j.authUrl) { show('up-msg', 'err', 'Failed'); return; }
      st = j.state;
      window.open(j.authUrl, '_blank');
      show('up-msg', 'ok', 'Finish login in the new tab...');
      var n = 0;
      var iv = setInterval(function () {
        if (++n > 100) { clearInterval(iv); show('up-msg', 'err', 'Timed out'); return; }
        fetch('/admin/api/login/poll?state=' + encodeURIComponent(st), { headers: h() })
          .then(function (r) { return r.json(); }).then(function (p) {
            if (p.status === 'ok') {
              clearInterval(iv);
              show('up-msg', 'ok', 'Token: ' + p.token);
            } else if (p.status === 'failed') {
              clearInterval(iv);
              show('up-msg', 'err', p.message || 'Failed');
            }
          });
      }, 3000);
    });
}
if (T) {
  fetch('/admin/api/keys', { headers: h() }).then(function (r) {
    if (r.ok) {
      document.getElementById('login-card').style.display = 'none';
      document.getElementById('main').style.display = '';
      load();
    }
  });
}
</script>`;

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
      if (p === '/admin/api/login/start') return loginStart(env);
      if (p === '/admin/api/login/poll') {
        return loginPoll(env, url.searchParams.get('state') || '');
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
};
