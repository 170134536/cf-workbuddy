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
async function upstreamToken(env) {
  const stored = await env.KEYS.get('upstream:token');
  if (stored) return stored;
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
      'Authorization': `Bearer ${await upstreamToken(env)}`,
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
async function saveToken(env, token, source) {
  const expires = decodeExp(token);
  const rec = JSON.stringify({ token, expires, source, at: Date.now() });
  await env.KEYS.put('upstream:token', rec);
  await env.KEYS.delete('models:cache');
  return { expires, source, at: Date.now() };
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
  const { token } = await req.json().catch(() => ({}));
  if (!token || typeof token !== 'string' || token.length < 20) {
    return json({ error: 'token 无效' }, 400);
  }
  const saved = await saveToken(env, token.trim(), '手动填写');
  return json({ ok: true, ...saved });
}

/** Report which token is active and where it came from. */
async function tokenStatus(env) {
  const stored = await env.KEYS.get('upstream:token', 'json');
  const secret = env.UPSTREAM_TOKEN || env.WORKBUDDY_TOKEN || env.TOKEN || '';
  const active = stored ? stored.token : secret;

  return json({
    source: stored ? stored.source : (secret ? '环境变量' : '未配置'),
    managed: !!stored,
    setAt: stored ? stored.at : null,
    expires: stored ? stored.expires : (active ? decodeExp(active) : null),
    length: active ? active.length : 0,
    preview: active ? active.slice(0, 8) + '...' + active.slice(-6) : '',
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
    <input id="pw" type="password" placeholder="请输入管理密码" autocomplete="current-password">
    <button id="login-btn" onclick="doLogin()">登录</button>
    <div class="msg err" id="login-msg"></div>
  </div>

  <div id="main" class="hide">

    <div class="card">
      <h2>上游凭证 <span class="tag" id="tok-tag">读取中</span></h2>
      <div class="sub" style="margin:0">
        中转调用 WorkBuddy 所用的登录凭证。凭证过期后模型列表和对话都会失败，在此更新即可，<b>无需重新部署</b>。
      </div>
      <dl class="kv">
        <dt>来源</dt><dd id="tok-src">—</dd>
        <dt>凭证</dt><dd><code id="tok-prev">—</code></dd>
        <dt>有效期至</dt><dd id="tok-exp">—</dd>
        <dt>更新时间</dt><dd id="tok-at">—</dd>
      </dl>
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

      <label for="manual-tok">或手动填写凭证</label>
      <input id="manual-tok" placeholder="粘贴 WorkBuddy access token" autocomplete="off">
      <button onclick="saveManual()">保存凭证</button>
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
  var pw = document.getElementById('pw').value;
  if (!pw) return;
  document.getElementById('login-btn').disabled = true;
  fetch('/admin/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (o) {
      document.getElementById('login-btn').disabled = false;
      if (o.j.token) {
        T = o.j.token;
        sessionStorage.setItem('wbt', T);
        enterApp();
      } else {
        show('login-msg', 'err', '密码错误，请重试');
      }
    })
    .catch(function (e) {
      document.getElementById('login-btn').disabled = false;
      show('login-msg', 'err', '请求失败：' + esc(e.message));
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
      document.getElementById('tok-src').textContent = j.source || '—';
      document.getElementById('tok-prev').textContent = j.preview || '（未配置）';
      var left = before(j.expires);
      document.getElementById('tok-exp').textContent = j.expires
        ? fmtTime(j.expires) + (left !== null ? '（' + (left > 0 ? '剩余 ' + left + ' 天' : '已过期') + '）' : '')
        : '未知';
      document.getElementById('tok-at').textContent = fmtTime(j.setAt);
      tag.textContent = j.preview ? (left !== null && left < 0 ? '已过期' : '已配置') : '未配置';
      tag.className = 'tag ' + (j.preview ? (left !== null && left < 0 ? 'err' : 'ok') : 'warn');
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
  var v = document.getElementById('manual-tok').value.trim();
  if (!v) return;
  fetch('/admin/api/token', { method: 'POST', headers: Hj(), body: JSON.stringify({ token: v }) })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j.ok) {
        document.getElementById('manual-tok').value = '';
        show('tok-msg', 'ok', '✓ 凭证已保存。' +
          (j.expires ? '有效期至 ' + fmtTime(j.expires) : ''));
        loadToken();
      } else {
        show('tok-msg', 'err', esc(j.error || '保存失败'));
      }
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

if (T) {
  fetch('/admin/api/keys', { headers: H() }).then(function (r) {
    if (r.ok) enterApp(); else sessionStorage.removeItem('wbt');
  });
}
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
      if (p === '/admin/api/token/verify') return tokenVerify(env);
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
