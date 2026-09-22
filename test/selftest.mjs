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
  // Cache-bust the data URL. The module map keys on the full URL, so reusing
  // a constant one returns the first instance forever and a later test would
  // silently exercise a stale module.
  const url = 'data:text/javascript;base64,' +
    Buffer.from(src).toString('base64') + '#t=' + (++loadSeq);
  const mod = await import(url);
  return mod.default;
}
let loadSeq = 0;

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
      code: 0,
      msg: 'OK',
      data: {
        // Real shapes: credits is a display string, not a number.
        models: [
          { id: 'free-1', name: 'Free One', credits: 'x0.00' },
          { id: 'paid-1', name: 'Paid One', credits: 'x1.50 credits' },
          { id: 'paid-2', name: 'Cheap', credits: 'x0.03' },
          { id: 'unrated', name: 'Auto', credits: '' },
        ],
      },
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
    // Covered in detail by the free-only safety block below.
  }

  // ---------------------------------------------------------- chat auth
  {
    const kv = makeKV({ 'key:good': JSON.stringify({ created: Date.now(), requests: 0 }) });
    let sentAuth = null;
    const f = makeFetch([['/v3/config', () => new Response(JSON.stringify({ code: 0, data: { models: [{ id: 'm', credits: 'x0.00' }] } }), { status: 200 })],
      ['/v2/chat/completions', (u, i) => {
      sentAuth = i.headers['Authorization'];
      return new Response('data: hi\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }]]);
    const w = await loadWorker(ENV_BASE, f);

    const bad = await w.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }) }), { ...ENV_BASE, KEYS: kv });
    check('chat rejects no key', bad.status === 401, 'status ' + bad.status);

    const ok = await w.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }), headers: { authorization: 'Bearer good' } }), { ...ENV_BASE, KEYS: kv });
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
    check('admin page renders', res.status === 200 && html.includes('WorkBuddy 中转'), 'status ' + res.status);
    check('admin page has login handler', html.includes('/admin/api/login'));

    // The inline <script> is embedded in a template literal. A single
    // un-escaped backslash sequence (e.g. /\r?\n/) gets emitted as real CR/LF
    // characters and silently breaks the ENTIRE script — every button on the
    // page stops working, which reads as "clicking login does nothing". Pin
    // that the generated script actually parses.
    const sm = html.match(/<script>([\s\S]*?)<\/script>/);
    check('admin page script extracted', !!sm, 'script block found');
    if (sm) {
      let parses = false;
      try {
        new Function(sm[1]); // parse-only; throws SyntaxError on the bad regex
        parses = true;
      } catch {
        parses = false;
      }
      check('admin page script parses', parses, 'generated <script> must be valid JS');
    }
  }

  // ---------------------------------------------------------- login flow
  {
    const kv = makeKV();
    const f = makeFetch([
      ['/v2/plugin/auth/state', () => new Response(JSON.stringify({ code: 0, data: { state: 'st1', authUrl: 'https://wb.example/login' } }), { status: 200 })]
      ,['/v2/plugin/auth/token', () => new Response(JSON.stringify({ code: 11217 }), { status: 200 })],
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
    const f = makeFetch([['/v3/config', () => new Response(JSON.stringify({ code: 0, data: { models: [{ id: 'm', credits: 'x0.00' }] } }), { status: 200 })],
      ['/v2/chat/completions', () => new Response('data: x\n\n', { status: 200 })]]) ;
    const w = await loadWorker(ENV_BASE, f);
    await w.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }), headers: { authorization: 'Bearer c1' } }), { ...ENV_BASE, KEYS: kv });
    const idle = JSON.parse(kv._store.get('key:c1'));
    check('usage not counted by default', (idle.requests || 0) === 0, 'requests ' + idle.requests);

    await w.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }), headers: { authorization: 'Bearer c1' } }), { ...ENV_BASE, KEYS: kv, COUNT_USAGE: 'true' });
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
    const f2 = makeFetch([['/v3/config', () => new Response(JSON.stringify({ code: 0, data: { models: [{ id: 'm', credits: 'x0.00' }] } }), { status: 200 })],
      ['/v2/chat/completions', (u, i) => {
      seen = i.headers['Authorization'];
      return new Response('data: x\n\n', { status: 200 });
    }]]);
    const w2 = await loadWorker(ENV_BASE, f2);
    const kv2 = makeKV({ 'key:t': JSON.stringify({ created: Date.now() }) });
    await w2.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }), headers: { authorization: 'Bearer t' } }), {
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
    const f = makeFetch([['/v3/config', () => new Response(JSON.stringify({ code: 0, data: { models: [{ id: 'm', credits: 'x0.00' }] } }), { status: 200 })],
      ['/v2/chat/completions', (u) => {
      hitUrl = String(u);
      return new Response('data: x\n\n', { status: 200 });
    }]]);
    const w = await loadWorker(ENV_BASE, f);
    const kv = makeKV({ 'key:p': JSON.stringify({ created: Date.now() }) });
    await w.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }), headers: { authorization: 'Bearer p' } }), { ...ENV_BASE, KEYS: kv });
    check('upstream called at /v2', hitUrl === 'https://www.workbuddy.ai/v2/chat/completions', String(hitUrl));
  }

  // ------------------------------------------------- token management
  {
    const kv = makeKV();
    const f = makeFetch([]);
    const w = await loadWorker(ENV_BASE, f);

    const lg = await w.fetch(req('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'adminpw' }) }), { ...ENV_BASE, KEYS: kv });
    const { token: sid } = await lg.json();
    const A = { Authorization: 'Bearer ' + sid };

    // Status reflects the secret before anything is stored in KV.
    const st0 = await w.fetch(req('/admin/api/token', { headers: A }), { ...ENV_BASE, KEYS: kv });
    const j0 = await st0.json();
    check('token status falls back to secret',
      j0.total === 1 && j0.entries[0].source === '环境变量' && j0.secretConfigured === true,
      JSON.stringify(j0));

    // A token must be stored, and KV must then take precedence.
    const put = await w.fetch(req('/admin/api/token', { method: 'POST', headers: A, body: JSON.stringify({ token: 'x'.repeat(40) }) }), { ...ENV_BASE, KEYS: kv });
    const jp = await put.json();
    check('token saved to KV', jp.ok === true, JSON.stringify(jp));

    const st1 = await w.fetch(req('/admin/api/token', { headers: A }), { ...ENV_BASE, KEYS: kv });
    const j1 = await st1.json();
    check('KV token overrides secret', j1.total === 2 && j1.entries[1].length === 40, JSON.stringify(j1));

    // The stored token is what reaches the upstream.
    let seen = null;
    const f2 = makeFetch([['/v3/config', () => new Response(JSON.stringify({ code: 0, data: { models: [{ id: 'm', credits: 'x0.00' }] } }), { status: 200 })],
      ['/v2/chat/completions', (u, i) => {
      seen = i.headers['Authorization'];
      return new Response('data: y\n\n', { status: 200 });
    }]]);
    const w2 = await loadWorker(ENV_BASE, f2);
    const kv2 = makeKV({ 'upstream:token': JSON.stringify({ token: 'stored-token-value-abcdefghij', source: '旧版单值' }) });
    await w2.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }), headers: { authorization: 'Bearer k' } }), { ...ENV_BASE, KEYS: kv2, REQUIRE_KEY: 'false' });
    check('stored token used upstream', seen === 'Bearer stored-token-value-abcdefghij', String(seen));

    // Junk must be rejected rather than stored.
    const bad = await w.fetch(req('/admin/api/token', { method: 'POST', headers: A, body: JSON.stringify({ token: 'short' }) }), { ...ENV_BASE, KEYS: kv });
    check('rejects too-short token', bad.status === 400, 'status ' + bad.status);

    // Saving a token must invalidate the cached model list. The session here
    // must be minted against kv3: a session from another KV is not valid, and
    // reusing one would make this pass for the wrong reason.
    const kv3 = makeKV({ 'models:cache': JSON.stringify({ at: Date.now(), exposed: [] }) });
    const w3 = await loadWorker(ENV_BASE, makeFetch([]));
    const lg3 = await w3.fetch(req('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'adminpw' }) }), { ...ENV_BASE, KEYS: kv3 });
    const { token: sid3 } = await lg3.json();
    const A3 = { Authorization: 'Bearer ' + sid3 };

    const save3 = await w3.fetch(req('/admin/api/token', { method: 'POST', headers: A3, body: JSON.stringify({ token: 'y'.repeat(40) }) }), { ...ENV_BASE, KEYS: kv3 });
    check('token save accepted with own session', (await save3.json()).ok === true);

    const stc = await w3.fetch(req('/admin/api/token', { headers: A3 }), { ...ENV_BASE, KEYS: kv3 });
    check('token endpoints gated by session', (await w3.fetch(req('/admin/api/token'), { ...ENV_BASE, KEYS: kv3 })).status === 401);
    check('token status readable after save', (await stc.json()).entries.length >= 1);
    check('model cache cleared on save', kv3._store.get('models:cache') === undefined);
  }

  // ------------------------------------------------- token rotation on 429
  {
    // The whole point of multiple credentials: when the upstream answers 429
    // (「请求过于频繁」) or drops the connection, the next token is tried
    // and the client gets the successful answer instead of an error.
    const kv = makeKV({ 'key:r': JSON.stringify({ created: Date.now() }) });
    const seen = [];
    const rateLimited = (u, i) => {
      seen.push(i.headers['Authorization']);
      const n = seen.length;
      // First credential rate-limited, second answers, third never reached.
      const code = n === 1 ? 429 : n === 2 ? 200 : 500;
      return new Response(code === 200 ? 'data: ok\n\n' : 'rate limited', {
        status: code,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    // Seed two stored tokens, then rotate: the 429 must retry with token B.
    const w = await loadWorker(ENV_BASE, makeFetch([['/v2/chat/completions', rateLimited]]));
    const tokens = JSON.stringify([
      { token: 'token-a-aaaaaaaaaaaaaaaa', source: '手动填写', at: Date.now() },
      { token: 'token-b-bbbbbbbbbbbbbbbb', source: '手动填写', at: Date.now() },
    ]);
    const kvr = makeKV({ 'key:r': JSON.stringify({ created: Date.now() }), 'upstream:tokens': tokens, 'free:ids': JSON.stringify(['m']) });
    const res = await w.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }), headers: { authorization: 'Bearer r' } }), { ...ENV_BASE, KEYS: kvr, REQUIRE_KEY: 'false' });
    check('429 rotates to next credential', res.status === 200, 'status ' + res.status);
    check('first attempt used token A', seen[0] === 'Bearer token-a-aaaaaaaaaaaaaaaa', String(seen[0]));
    check('second attempt used token B', seen[1] === 'Bearer token-b-bbbbbbbbbbbbbbbb', String(seen[1]));

    // All credentials rate-limited -> the 429 is what the client sees.
    const kv429 = makeKV({ 'key:r': JSON.stringify({ created: Date.now() }), 'upstream:tokens': tokens, 'free:ids': JSON.stringify(['m']) });
    const seen2 = [];
    const w2 = await loadWorker(ENV_BASE, makeFetch([['/v2/chat/completions', (u, i) => {
      seen2.push(i.headers['Authorization']);
      return new Response('limited', { status: 429 });
    }]]));
    const res2 = await w2.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm' }), headers: { authorization: 'Bearer r' } }), { ...ENV_BASE, KEYS: kv429, REQUIRE_KEY: 'false' });
    check('all limited returns 429', res2.status === 429, 'status ' + res2.status);
    check('both credentials were tried', seen2.length === 2, 'tries ' + seen2.length);

    // Delete one credential leaves the other intact.
    const kvDel = makeKV({ 'key:r': JSON.stringify({ created: Date.now() }), 'upstream:tokens': tokens });
    const w3 = await loadWorker(ENV_BASE, makeFetch([]));
    const lg3 = await w3.fetch(req('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'adminpw' }) }), { ...ENV_BASE, KEYS: kvDel });
    const { token: sid3 } = await lg3.json();
    const del = await w3.fetch(req('/admin/api/token/delete', { method: 'POST', headers: { Authorization: 'Bearer ' + sid3 }, body: JSON.stringify({ index: 1 }) }), { ...ENV_BASE, KEYS: kvDel });
    check('delete credential works', (await del.json()).ok === true);
    const left = JSON.parse(kvDel._store.get('upstream:tokens'));
    check('only one credential remains', left.length === 1 && left[0].token === 'token-a-aaaaaaaaaaaaaaaa', JSON.stringify(left.map((e) => e.token)));
  }

  // ------------------------------------------------- upstream envelope shape
  {
    // WorkBuddy wraps every response as {code,msg,requestId,data}. Reading the
    // payload from the top level silently yields nothing while looking
    // successful, so pin both shapes here.
    let sawAuth = null;
    const f = makeFetch([['/v3/config', (u, i) => {
      sawAuth = i.headers['Authorization'];
      return new Response(JSON.stringify({ code: 0, data: { models: [{ id: 'm1', credits: 0 }] } }), { status: 200 });
    }]]);
    const w = await loadWorker(ENV_BASE, f);
    const kv = makeKV({ 'key:k': JSON.stringify({ created: Date.now() }) });
    const r = await w.fetch(req('/v1/models', { headers: { authorization: 'Bearer k' } }), { ...ENV_BASE, KEYS: kv });
    const j = await r.json();
    check('models read from data envelope', j.data.length === 1 && j.data[0].id === 'm1', JSON.stringify(j.data));
    check('catalogue call carries token', sawAuth === 'Bearer upstream-secret', String(sawAuth));

    // A bare (un-enveloped) body must still work, so an upstream change in
    // either direction does not break the listing. Fresh KV, otherwise the
    // cached list from the check above is served and nothing is fetched.
    const f2 = makeFetch([['/v3/config', () => new Response(JSON.stringify({ models: [{ id: 'bare', credits: 0 }] }), { status: 200 })]]);
    const w2 = await loadWorker(ENV_BASE, f2);
    const kv2 = makeKV({ 'key:k': JSON.stringify({ created: Date.now() }) });
    const r2 = await w2.fetch(req('/v1/models', { headers: { authorization: 'Bearer k' } }), { ...ENV_BASE, KEYS: kv2 });
    check('bare response also accepted', (await r2.json()).data[0].id === 'bare');

    // login/start must unwrap data.state too.
    const f3 = makeFetch([['/v2/plugin/auth/state', () => new Response(JSON.stringify({ code: 0, data: { state: 's9', authUrl: 'https://wb/x' } }), { status: 200 })]]);
    const w3 = await loadWorker(ENV_BASE, f3);
    const lg = await w3.fetch(req('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: 'adminpw' }) }), { ...ENV_BASE, KEYS: kv });
    const sid = (await lg.json()).token;
    const ls = await w3.fetch(req('/admin/api/login/start', { headers: { authorization: 'Bearer ' + sid } }), { ...ENV_BASE, KEYS: kv });
    const lj = await ls.json();
    check('login start unwraps data.state', ls.status === 200 && lj.state === 's9' && lj.authUrl === 'https://wb/x', JSON.stringify(lj));
  }

  // ---------------------------------------------------------- free-only safety
  {
    const cfg = {
      code: 0,
      data: {
        models: [
          { id: 'freeA', credits: 'x0.00' },
          { id: 'paidB', credits: 'x2.00 credits' },
          { id: 'unratedC', credits: '' },
        ],
      },
    };
    const mk = () => makeFetch([['/v3/config', () => new Response(JSON.stringify(cfg), { status: 200 })],
      ['/v2/chat/completions', () => new Response('data: ok\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })]]);
    const w = await loadWorker(ENV_BASE, mk());
    const kv = makeKV({ 'key:z': JSON.stringify({ created: Date.now() }) });
    const H = { authorization: 'Bearer z' };

    // Listing must contain the free model and nothing else.
    const lr = await w.fetch(req('/v1/models', { headers: H }), { ...ENV_BASE, KEYS: kv });
    const ids = (await lr.json()).data.map((m) => m.id);
    check('free-only lists only free', ids.length === 1 && ids[0] === 'freeA', JSON.stringify(ids));

    // Requesting a paid model directly must be refused: filtering the listing
    // alone would still let a caller invoke and pay for one.
    const pr = await w.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'paidB' }), headers: H }), { ...ENV_BASE, KEYS: kv });
    check('paid model rejected on chat', pr.status === 403, 'status ' + pr.status);
    check('paid rejection names the model', (await pr.json()).error.code === 'model_not_free');

    // An unrated model is not free either.
    const ur = await w.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'unratedC' }), headers: H }), { ...ENV_BASE, KEYS: kv });
    check('unrated model rejected on chat', ur.status === 403, 'status ' + ur.status);

    // The free model still goes through.
    const fr = await w.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'freeA' }), headers: H }), { ...ENV_BASE, KEYS: kv });
    check('free model accepted on chat', fr.status === 200, 'status ' + fr.status);

    // Malformed JSON must 400 rather than crash the handler.
    const br = await w.fetch(req('/v1/chat/completions', { method: 'POST', body: '{not json', headers: H }), { ...ENV_BASE, KEYS: kv });
    check('malformed body rejected', br.status === 400, 'status ' + br.status);

    // With FREE_ONLY off, paid models pass through.
    const w2 = await loadWorker(ENV_BASE, mk());
    const kv2 = makeKV({ 'key:z': JSON.stringify({ created: Date.now() }) });
    const pr2 = await w2.fetch(req('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'paidB' }), headers: H }), { ...ENV_BASE, KEYS: kv2, FREE_ONLY: 'false' });
    check('paid allowed when free-only off', pr2.status === 200, 'status ' + pr2.status);
  }

  // ------------------------------------------------- no free models => empty
  {
    // If nothing is free, the listing must be empty. An earlier version fell
    // back to serving every model, which would expose paid ones precisely
    // when a parse failure made the free set look empty.
    const allPaid = { code: 0, data: { models: [{ id: 'p1', credits: 'x1.00' }, { id: 'p2', credits: 'x2.00' }] } };
    const f = makeFetch([['/v3/config', () => new Response(JSON.stringify(allPaid), { status: 200 })]]);
    const w = await loadWorker(ENV_BASE, f);
    const kv = makeKV({ 'key:z': JSON.stringify({ created: Date.now() }) });
    const r = await w.fetch(req('/v1/models', { headers: { authorization: 'Bearer z' } }), { ...ENV_BASE, KEYS: kv });
    const j = await r.json();
    check('no free models yields empty list', j.data.length === 0, 'count ' + j.data.length);

    const cache = JSON.parse(kv._store.get('models:cache'));
    check('result records freeOnly flag', cache.freeOnly === true && cache.all === 2 && cache.free === 0);
    check('result carries an explanatory note', typeof cache.note === 'string' && cache.note.length > 0);
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
