#!/usr/bin/env node
/**
 * Exercise the Worker against a mock Cloudflare runtime.
 *
 * Syntax checking cannot catch a wrong route, a broken auth gate, or a
 * misread response shape, so this drives the real handler with stubbed KV
 * and fetch and asserts on the outcomes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'worker.js'), 'utf8');

// --- mock KV -------------------------------------------------------------
function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(name, type) {
      const v = store.get(name);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(name, value) { store.set(name, value); },
    async delete(name) { store.delete(name); },
    async list({ prefix }) {
      const keys = [];
      for (const k of store.keys()) if (k.startsWith(prefix)) keys.push({ name: k });
      return { keys };
    },
    _store: store,
  };
}

// --- mock fetch ----------------------------------------------------------
let fetchLog = [];
function makeFetch(handlers) {
  return async (url, init) => {
    fetchLog.push({ url, init });
    for (const [pattern, fn] of handlers) {
      if (String(url).includes(pattern)) return fn(url, init);
    }
    return new Response('not found', { status: 404 });
  };
}

async function loadWorker(env, fetchImpl) {
  globalThis.fetch = fetchImpl;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  return mod.default;
}

function req(path, { method = 'GET', headers = {}, body } = {}) {
  return new Request('https://relay.example.com' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
}

const ENV_BASE = {
  ENDPOINT: 'https://www.workbuddy.ai',
  CLIENT_VERSION: '5.5.2',
  FREE_ONLY: 'true',
  REQUIRE_KEY: 'true',
  UPSTREAM_TOKEN: 'upstream-secret',
  ADMIN_PASSWORD: 'adminpw',
};

async function main() {
  console.log('Worker self-test\n');

  // ---------------------------------------------------------- models
  {
    fetchLog = [];
    const cfgModels = {
      models: [
        { id: 'free-1', name: 'Free One', credits: 0 },
        { id: 'paid-1', name: 'Paid One', credits: 1.5 },
        { id: 'unrated', name: 'Unrated', credits: '' },
      ],
    };
    const kv = makeKV();
    const f = makeFetch([['/v3/config', () => new Response(JSON.stringify(cfgModels), { status: 200 })]]);
    const w = await loadWorker(ENV_BASE, f);

    const res = await w.fetch(req('/v1/models', { headers: { authorization: 'Bearer k1' } }), { ...ENV_BASE, KEYS: kv });
    // REQUIRE_KEY is on but no key exists -> must be rejected
    check('models rejects missing key', res.status === 401, 'status ' + res.status);

    await kv.put('key:k1', JSON.stringify({ name: 'test', created: Date.now(), requests: 0 }));
    const res2 = await w.fetch(req('/v1/models', { headers: { authorization: 'Bearer k1' } }), { ...ENV_BASE, KEYS: kv });
    const j = await res2.json();
    const ids = j.data.map((m) => m.id);
    check('models lists only free', ids.length === 1 && ids[0] === 'free-1', JSON.stringify(ids));
    check('unrated excluded from free', !ids.includes('unrated'), JSON.stringify(ids));
  }

  // ---------------------------------------------------------- free-only edge
  {
    const kv = makeKV({ 'key:k1': JSON.stringify({ created: Date.now(), requests: 0 }) });
    const cfgAllPaid = { models: [{ id: 'p', name: 'P', credits: 2 }] };
    const f = makeFetch([['/v3/config', () => new Response(JSON.stringify(cfgAllPaid), { status: 200 })]]);
    const w = await loadWorker(ENV_BASE, f);
    const res = await w.fetch(req('/v1/models', { headers: { authorization: 'Bearer k1' } }), { ...ENV_BASE, KEYS: kv });
    const j = await res.json();
    check('never serves zero models', j.data.length >= 1, 'count ' + j.data.length);
  }

  // ---------------------------------------------------------- chat auth
  {
    const kv = makeKV({ 'key:good': JSON.stringify({ created: Date.now(), requests: 0 }) });
    let sentAuth = null;
    const f = makeFetch([['/v2/chat/completions', (u, i) => {
      sentAuth = i.headers['Authorization'];
      return new Response('data: hi\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }]]);
    const w = await loadWorker(ENV_BASE, f);

    const bad = await w.fetch(req('/v1/chat/completions', { method: 'POST', body: '{}' }), { ...ENV_BASE, KEYS: kv });
    check('chat rejects no key', bad.status === 401, 'status ' + bad.status);

    const ok = await w.fetch(req('/v1/chat/completions', { method: 'POST', body: '{}', headers: { authorization: 'Bearer good' } }), { ...ENV_BASE, KEYS: kv });
    check('chat accepts valid key', ok.status === 200, 'status ' + ok.status);
    check('upstream gets real token', sentAuth === 'Bearer upstream-secret', String(sentAuth));
    const ctype = ok.headers.get('content-type') || '';
    check('stream content-type preserved', ctype.includes('text/event-stream'), ctype);
  }

  // ---------------------------------------------------------- disabled key
  {
    const kv = makeKV({ 'key:off': JSON.stringify({ created: Date.now(), disabled: true }) });
    const f = makeFetch([]);
    const w = await loadWorker(ENV_BASE, f);
    const res = await w.fetch(req('/v1/models', { headers: { authorization: 'Bearer off' } }), { ...ENV_BASE, KEYS: kv });
    check('disabled key rejected', res.status === 401, 'status ' + res.status);
  }

  // ---------------------------------------------------------- admin auth
  {
    const kv = makeKV();
    const f = makeFetch([]);
    const w = await loadWorker(ENV_BASE, f);
    const noAuth = await w.fetch(req('/admin/api/keys'), { ...ENV_BASE, KEYS: kv });
    check('admin api requires session', noAuth.status === 401, 'status ' + noAuth.status);

    const badPw = await w.fetch(req('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) }), { ...ENV_BASE, KEYS: kv });
    check('admin rejects wrong password', badPw.status === 401, 'status ' + badPw.status);

    const good = await w.fetch(req('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'adminpw' }) }), { ...ENV_BASE, KEYS: kv });
    const { token } = await good.json();
    check('admin login returns token', !!token, String(token));

    // -------------------------------------------------------- admin keys
    const created = await w.fetch(req('/admin/api/keys', { method: 'POST', body: JSON.stringify({ name: 'laptop', days: 7 }), headers: { authorization: 'Bearer ' + token } }), { ...ENV_BASE, KEYS: kv });
    const ck = await created.json();
    check('created key has wb- prefix', String(ck.key).startsWith('wb-'), ck.key);
    check('created key has expiry', !!ck.expires, String(ck.expires));

    const listed = await w.fetch(req('/admin/api/keys', { headers: { authorization: 'Bearer ' + token } }), { ...ENV_BASE, KEYS: kv });
    const lj = await listed.json();
    check('key appears in list', lj.keys.some((k) => k.key === ck.key), JSON.stringify(lj.keys));
    check('list carries name', lj.keys.some((k) => k.name === 'laptop'));

    await w.fetch(req('/admin/api/keys/delete', { method: 'POST', body: JSON.stringify({ key: ck.key }), headers: { authorization: 'Bearer ' + token } }), { ...ENV_BASE, KEYS: kv });
    const after = await w.fetch(req('/admin/api/keys', { headers: { authorization: 'Bearer ' + token } }), { ...ENV_BASE, KEYS: kv });
    const aj = await after.json();
    check('revoked key gone', !aj.keys.some((k) => k.key === ck.key));
  }

  // ---------------------------------------------------------- admin page
  {
    const f = makeFetch([]);
    const w = await loadWorker(ENV_BASE, f);
    const res = await w.fetch(req('/admin'), { ...ENV_BASE, KEYS: makeKV() });
    const html = await res.text();
    check('admin page renders', res.status === 200 && html.includes('WorkBuddy Relay'), 'status ' + res.status);
    check('admin page has login handler', html.includes('/admin/api/login'));
  }

  // ---------------------------------------------------------- login flow
  {
    const kv = makeKV();
    const f = makeFetch([
      ['/v2/plugin/auth/state', () => new Response(JSON.stringify({ state: 'st1', authUrl: 'https://wb.example/login' }), { status: 200 })],
      ['/v2/plugin/auth/token', () => new Response(JSON.stringify({ code: 11217 }), { status: 200 })],
    ]);
    const w = await loadWorker(ENV_BASE, f);
    const lg = await w.fetch(req('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'adminpw' }) }), { ...ENV_BASE, KEYS: kv });
    const { token } = await lg.json();
    const s = await w.fetch(req('/admin/api/login/start', { headers: { authorization: 'Bearer ' + token } }), { ...ENV_BASE, KEYS: kv });
    const sj = await s.json();
    check('login start returns authUrl', sj.authUrl === 'https://wb.example/login', JSON.stringify(sj));

    const p = await w.fetch(req('/admin/api/login/poll?state=st1', { headers: { authorization: 'Bearer ' + token } }), { ...ENV_BASE, KEYS: kv });
    const pj = await p.json();
    check('poll reports waiting on 11217', pj.status === 'waiting', JSON.stringify(pj));
  }

  // ------------------------------------------------- usage counting off/on
  {
    // Default: no KV write per request, so the 1,000/day free write budget
    // is not consumed by ordinary traffic.
    const kv = makeKV({ 'key:c1': JSON.stringify({ created: Date.now(), requests: 0 }) });
    const f = makeFetch([['/v2/chat/completions', () => new Response('data: x\n\n', { status: 200 })]]) ;
    const w = await loadWorker(ENV_BASE, f);
    await w.fetch(req('/v1/chat/completions', { method: 'POST', body: '{}', headers: { authorization: 'Bearer c1' } }), { ...ENV_BASE, KEYS: kv });
    const idle = JSON.parse(kv._store.get('key:c1'));
    check('usage not counted by default', (idle.requests || 0) === 0, 'requests ' + idle.requests);

    await w.fetch(req('/v1/chat/completions', { method: 'POST', body: '{}', headers: { authorization: 'Bearer c1' } }), { ...ENV_BASE, KEYS: kv, COUNT_USAGE: 'true' });
    const counted = JSON.parse(kv._store.get('key:c1'));
    check('usage counted when enabled', counted.requests === 1, 'requests ' + counted.requests);
  }

  // ------------------------------------------------- env fallbacks & no-store
  {
    const kv = makeKV();
    const f = makeFetch([]);
    const w = await loadWorker(ENV_BASE, f);

    // A secret set under an alternate name must still be honoured.
    const altLogin = await w.fetch(req('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'altpw' }) }), {
      ENDPOINT: ENV_BASE.ENDPOINT, CLIENT_VERSION: '5.5.2',
      FREE_ONLY: 'true', REQUIRE_KEY: 'true',
      ADMIN: 'altpw', KEYS: kv,
    });
    check('ADMIN fallback accepted', altLogin.status === 200, 'status ' + altLogin.status);

    const page = await w.fetch(req('/admin'), { ...ENV_BASE, KEYS: kv });
    const cc = page.headers.get('cache-control') || '';
    check('admin page not cacheable', cc.includes('no-store'), cc);

    // Upstream token under an alternate name reaches the backend.
    let seen = null;
    const f2 = makeFetch([['/v2/chat/completions', (u, i) => {
      seen = i.headers['Authorization'];
      return new Response('data: x\n\n', { status: 200 });
    }]]);
    const w2 = await loadWorker(ENV_BASE, f2);
    const kv2 = makeKV({ 'key:t': JSON.stringify({ created: Date.now() }) });
    await w2.fetch(req('/v1/chat/completions', { method: 'POST', body: '{}', headers: { authorization: 'Bearer t' } }), {
      ENDPOINT: ENV_BASE.ENDPOINT, CLIENT_VERSION: '5.5.2',
      FREE_ONLY: 'true', REQUIRE_KEY: 'true',
      WORKBUDDY_TOKEN: 'alt-upstream', KEYS: kv2,
    });
    check('WORKBUDDY_TOKEN fallback used', seen === 'Bearer alt-upstream', String(seen));
  }

  // ------------------------------------------------- upstream path guard
  {
    // The upstream serves completions under /v2. A wrong path returns
    // "404 Route Not Found" from WorkBuddy, which is easy to misread as a
    // routing bug in this Worker, so pin the exact URL.
    let hitUrl = null;
    const f = makeFetch([['/v2/chat/completions', (u) => {
      hitUrl = String(u);
      return new Response('data: x\n\n', { status: 200 });
    }]]);
    const w = await loadWorker(ENV_BASE, f);
    const kv = makeKV({ 'key:p': JSON.stringify({ created: Date.now() }) });
    await w.fetch(req('/v1/chat/completions', { method: 'POST', body: '{}', headers: { authorization: 'Bearer p' } }), { ...ENV_BASE, KEYS: kv });
    check('upstream called at /v2', hitUrl === 'https://www.workbuddy.ai/v2/chat/completions', String(hitUrl));
  }

  // ---------------------------------------------------------- 404 + CORS
  {
    const f = makeFetch([]);
    const w = await loadWorker(ENV_BASE, f);
    const res = await w.fetch(req('/nope'), { ...ENV_BASE, KEYS: makeKV() });
    check('unknown route 404', res.status === 404, 'status ' + res.status);
    const opt = await w.fetch(req('/v1/models', { method: 'OPTIONS' }), { ...ENV_BASE, KEYS: makeKV() });
    check('OPTIONS preflight 204', opt.status === 204, 'status ' + opt.status);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
