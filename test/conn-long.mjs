#!/usr/bin/env node
/**
 * Long-stream test: the earlier diag used "Reply OK" (stream ~50ms). Real use
 * is long answers streaming for tens of seconds over the AMS cross-border hop,
 * which is where mid-stream disconnects actually bite. Measure that.
 */

const BASE = 'https://kz007.ccwu.cc';
async function rf(url, init, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(40000) }); }
    catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, 500)); }
  }
}

const login = await rf(BASE + '/admin/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: '170134536' }),
});
const { token: sid } = await login.json();
const AH = { Authorization: 'Bearer ' + sid, 'Content-Type': 'application/json' };
const { key } = await rf(BASE + '/admin/api/keys', {
  method: 'POST', headers: AH, body: JSON.stringify({ name: 'long-diag', days: 1 }),
}).then(r => r.json());

const body = JSON.stringify({
  model: 'deepseek-v4.1-flash', stream: true,
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: '写一篇约 800 字的科普短文，介绍中国高铁的发展历程，分段落。' },
  ],
});

const N = 8;
let ok = 0, midStream = 0, connectErr = 0, timeout = 0;
const dur = [];
const bytes = [];

for (let i = 1; i <= N; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(90000),
    });
    if (r.status !== 200) { console.log(`  #${i} HTTP ${r.status}`); continue; }

    const reader = r.body.getReader();
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
      }
      ok++;
      dur.push(Date.now() - t0);
      bytes.push(n);
      console.log(`  #${i} 完成  ${n}B  ${Date.now() - t0}ms`);
    } catch (e) {
      if (e.name === 'TimeoutError') timeout++;
      else midStream++;
      console.log(`  #${i} 中断  ${e.name || e.message}  @${n}B`);
    }
  } catch (e) {
    const code = e.cause && e.cause.code;
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') connectErr++;
    else if (/timeout/i.test(String(e.name || e.message))) timeout++;
    else { console.log(`  #${i} 其他 ${e.name || e.message}`); }
  }
  await new Promise(r => setTimeout(r, 500));
}

console.log('\n=== long-stream result ===');
console.log('  success: ' + ok + '/' + N + '  (' + (ok / N * 100).toFixed(0) + '%)');
console.log('  midStream断开=' + midStream + '  连接失败=' + connectErr + '  超时=' + timeout);
if (dur.length) {
  dur.sort((a, b) => a - b);
  console.log('  完成耗时 p50 ' + dur[Math.floor(dur.length / 2)] + 'ms  p90 ' + dur[Math.floor(dur.length * 0.9)] + 'ms');
}

await rf(BASE + '/admin/api/keys/delete', { method: 'POST', headers: AH, body: JSON.stringify({ key }) });