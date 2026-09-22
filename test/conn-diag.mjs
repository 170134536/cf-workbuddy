#!/usr/bin/env node
/**
 * Locate the Connection error: is it the connect (before any byte), the
 * stream (mid-generation), or a timeout? Each has a different fix.
 */

const BASE = 'https://kz007.ccwu.cc';

// Robust fetch helper: retries a couple of times to get a session at all.
async function rf(url, init, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(40000) }); }
    catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, 500)); }
  }
}

// --- login + mint a key ---
const login = await rf(BASE + '/admin/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: '170134536' }),
});
const { token: sid } = await login.json();
const AH = { Authorization: 'Bearer ' + sid, 'Content-Type': 'application/json' };
const c = await rf(BASE + '/admin/api/keys', {
  method: 'POST', headers: AH, body: JSON.stringify({ name: 'conn-diag', days: 1 }),
});
const { key } = await c.json();

const body = JSON.stringify({
  model: 'deepseek-v4.1-flash', stream: true,
  messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Reply with exactly: OK' }],
});

const N = 20;
let ok = 0;
const fail = { connect: 0, stream: 0, timeout: 0, http: 0, other: 0 };
const cols = {};
const ttfbs = [];

for (let i = 1; i <= N; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60000),
    });
    const ray = r.headers.get('cf-ray') || '?';
    cols[ray.split('-')[1]] = (cols[ray.split('-')[1]] || 0) + 1;

    if (r.status !== 200) { fail.http++; console.log(`  #${i}  HTTP ${r.status}`); continue; }

    // Read the whole stream, tracking whether it dies partway.
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let got = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!got || got === value.length) { /* first chunk */ }
      }
      ok++;
      ttfbs.push(Date.now() - t0);
    } catch (e) {
      if (e.name === 'TimeoutError') fail.timeout++;
      else fail.stream++;
      console.log(`  #${i}  stream-err ${e.name || e.message} after ${got} bytes`);
    }
  } catch (e) {
    const name = e.name || (e.cause && e.cause.code) || e.message;
    if (name === 'TimeoutError' || /timeout/i.test(String(name))) fail.timeout++;
    else if (e.cause && (e.cause.code === 'ECONNRESET' || e.cause.code === 'ECONNREFUSED' || e.cause.code === 'EPIPE')) fail.connect++;
    else fail.other++;
    console.log(`  #${i}  fetch-err ${name}`);
  }
  await new Promise(r => setTimeout(r, 200));
}

ttfbs.sort((a, b) => a - b);
console.log('\n=== result ===');
console.log('  success: ' + ok + '/' + N + '  (' + (ok / N * 100).toFixed(0) + '%)');
console.log('  failures: connect=' + fail.connect + ' stream=' + fail.stream +
  ' timeout=' + fail.timeout + ' http=' + fail.http + ' other=' + fail.other);
console.log('  edge colos: ' + JSON.stringify(cols));
if (ttfbs.length) console.log('  ttfbs p50 ' + ttfbs[Math.floor(ttfbs.length * 0.5)] +
  'ms  p90 ' + ttfbs[Math.floor(ttfbs.length * 0.9)] + 'ms');

// cleanup
await rf(BASE + '/admin/api/keys/delete', { method: 'POST', headers: AH, body: JSON.stringify({ key }) });