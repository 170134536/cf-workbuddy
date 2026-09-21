#!/usr/bin/env node
/**
 * Final baseline after all deployment-side optimisations.
 * Reports p50/p90, failure rate, and chat TTFB so the gains are measured
 * rather than assumed.
 */

const BASE = 'https://kz007.ccwu.cc';
const ADMIN = 'leahdizon';

const N = 25;
let ok = 0, err = 0;
const times = [];
const errs = {};

for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/admin', { signal: AbortSignal.timeout(20000) });
    await r.text();
    times.push(Date.now() - t0);
    ok++;
  } catch (e) {
    err++;
    const k = e.cause?.code || e.name;
    errs[k] = (errs[k] || 0) + 1;
  }
  await new Promise((r) => setTimeout(r, 100));
}

times.sort((a, b) => a - b);
const p50 = times[Math.floor(times.length * 0.5)] ?? 0;
const p90 = times[Math.floor(times.length * 0.9)] ?? 0;
const p95 = times[Math.floor(times.length * 0.95)] ?? 0;

console.log('=== plain requests (/admin, no upstream) ===');
console.log('  success ' + ok + '/' + N + '   fail ' + err + '  (' + (err / N * 100).toFixed(0) + '%)');
console.log('  min ' + (times[0] ?? '-') + 'ms  p50 ' + p50 + 'ms  p90 ' + p90 + 'ms  p95 ' + p95 + 'ms');
for (const [k, v] of Object.entries(errs)) console.log('  err ' + k + ' x' + v);

// chat: measure TTFB, and note upstream generation dominates
console.log('\n=== chat TTFB ===');
const login = await fetch(BASE + '/admin/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: ADMIN }), signal: AbortSignal.timeout(30000),
});
const { token } = await login.json();
const AH = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const c = await fetch(BASE + '/admin/api/keys', {
  method: 'POST', headers: AH, body: JSON.stringify({ name: 'final', days: 1 }),
  signal: AbortSignal.timeout(30000),
});
const { key } = await c.json();

const body = JSON.stringify({
  model: 'deepseek-v4.1-flash', stream: true,
  messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Reply with exactly: OK' }],
});

const ttfbs = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(60000),
    });
    // first chunk read time
    const reader = r.body.getReader();
    await reader.read();
    const ms = Date.now() - t0;
    ttfbs.push(ms);
    console.log('  #' + (i + 1) + '  TTFB ' + ms + 'ms  HTTP ' + r.status);
    await reader.cancel().catch(() => {});
  } catch (e) {
    console.log('  #' + (i + 1) + '  ERR ' + (e.cause?.code || e.message));
  }
  await new Promise((r) => setTimeout(r, 300));
}
ttfbs.sort((a, b) => a - b);
if (ttfbs.length) console.log('  chat TTFB p50 ' + ttfbs[Math.floor(ttfbs.length / 2)] + 'ms');

await fetch(BASE + '/admin/api/keys/delete', {
  method: 'POST', headers: AH, body: JSON.stringify({ key }),
  signal: AbortSignal.timeout(30000),
});
