#!/usr/bin/env node
/** tingfengai real chat failure-rate probe. Key comes from env TF_KEY. */

const BASE = 'https://freeapi.tingfengai.art/v1';
const KEY = process.env.TF_KEY;
if (!KEY) { console.log('no TF_KEY'); process.exit(1); }

async function chat(body, timeoutMs) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body, signal: AbortSignal.timeout(timeoutMs),
  });
  return { r, t0 };
}

const short = JSON.stringify({
  model: 'deepseek-v4-pro-0813', stream: true,
  messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Reply with exactly: OK' }],
});
const long = JSON.stringify({
  model: 'deepseek-v4-pro-0813', stream: true,
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: '写一篇约 800 字的科普短文，介绍中国高铁的发展历程，分段落。' },
  ],
});

console.log('=== short chat x10 ===');
let ok = 0; const fails = {};
for (let i = 1; i <= 10; i++) {
  try {
    const { r, t0 } = await chat(short, 45000);
    if (r.status !== 200) { fails['http' + r.status] = (fails['http' + r.status] || 0) + 1; console.log(`  #${i} HTTP ${r.status}`); continue; }
    const reader = r.body.getReader();
    for (;;) { const { done } = await reader.read(); if (done) break; }
    ok++;
    console.log(`  #${i} ok ${Date.now() - t0}ms`);
  } catch (e) {
    const c = e.cause?.code || e.name;
    fails[c] = (fails[c] || 0) + 1;
    console.log(`  #${i} ERR ${c}`);
  }
  await new Promise(r => setTimeout(r, 200));
}
console.log('  short: ok ' + ok + '/10  fails ' + JSON.stringify(fails));

console.log('\n=== long chat x5 ===');
let ok2 = 0, mid = 0; const fails2 = {};
for (let i = 1; i <= 5; i++) {
  try {
    const { r, t0 } = await chat(long, 90000);
    if (r.status !== 200) { fails2['http' + r.status] = (fails2['http' + r.status] || 0) + 1; console.log(`  #${i} HTTP ${r.status}`); continue; }
    const reader = r.body.getReader();
    let n = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
      ok2++;
      console.log(`  #${i} ok ${n}B ${Date.now() - t0}ms`);
    } catch (e) {
      mid++;
      console.log(`  #${i} 流中断 @${n}B ${e.name || e.message}`);
    }
  } catch (e) {
    const c = e.cause?.code || e.name;
    fails2[c] = (fails2[c] || 0) + 1;
    console.log(`  #${i} ERR ${c}`);
  }
  await new Promise(r => setTimeout(r, 400));
}
console.log('  long: ok ' + ok2 + '/5  流中断 ' + mid + '  fails ' + JSON.stringify(fails2));