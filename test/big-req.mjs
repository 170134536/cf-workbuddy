#!/usr/bin/env node
/**
 * Connection error likely shows up only on BIG requests: DSH sends a huge
 * prompt (long context + tool schemas), and large payloads are what actually
 * break on a cross-border hop. Small probes all pass and hide this.
 */

const TARGETS = [
  { name: 'kz007  (CF 中转, 已优化)', base: 'https://kz007.ccwu.cc/v1', key: process.env.KZ_KEY, model: 'deepseek-v4.1-flash' },
  { name: 'tingfengai (当前默认通道)', base: 'https://freeapi.tingfengai.art/v1', key: process.env.TF_KEY, model: 'deepseek-v4-pro-0813' },
];

// A realistic big prompt: long system instructions + a long document + fake
// tool schema, roughly what DSH actually sends.
const sys = ('You are an AI agent. ' + 'Follow these rules carefully and cite sources. ').repeat(300);
const doc = ('这是一段用于填充上下文的长文档内容，模拟真实会话里的历史记录与工具返回。').repeat(600);
const tools = JSON.stringify({ tools: Array.from({ length: 40 }, (_, i) => ({ type: 'function', function: { name: 'tool_' + i, description: 'x'.repeat(200), parameters: { type: 'object', properties: { a: { type: 'string' } } } } })) });
const bigPrompt = sys + doc + tools;

const body = (model) => JSON.stringify({
  model, stream: true,
  messages: [
    { role: 'system', content: bigPrompt },
    { role: 'user', content: '总结上面内容，一句话。' },
  ],
});

for (const t of TARGETS) {
  if (!t.key) { console.log('\n' + t.name + ': 无 key，跳过'); continue; }
  console.log('\n=== ' + t.name + ' ===');
  console.log('  prompt 约 ' + bigPrompt.length + ' 字符');
  let ok = 0; const fails = {};
  const times = [];
  for (let i = 1; i <= 6; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(t.base + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t.key, 'Content-Type': 'application/json' },
        body: body(t.model), signal: AbortSignal.timeout(120000),
      });
      if (r.status !== 200) {
        const txt = await r.text().catch(() => '');
        fails['http' + r.status] = (fails['http' + r.status] || 0) + 1;
        console.log(`  #${i} HTTP ${r.status} ${txt.slice(0, 120)}`);
        continue;
      }
      const reader = r.body.getReader();
      let n = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
        ok++; times.push(Date.now() - t0);
        console.log(`  #${i} ok ${n}B ${Date.now() - t0}ms`);
      } catch (e) {
        fails['mid:' + (e.cause?.code || e.name)] = (fails['mid:' + (e.cause?.code || e.name)] || 0) + 1;
        console.log(`  #${i} 流中断 @${n}B ${e.cause?.code || e.name || e.message}`);
      }
    } catch (e) {
      const c = e.cause?.code || e.name;
      fails[c] = (fails[c] || 0) + 1;
      console.log(`  #${i} ERR ${c}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  times.sort((a, b) => a - b);
  console.log('  → 成功 ' + ok + '/6  失败 ' + JSON.stringify(fails) +
    (times.length ? '  p50 ' + times[Math.floor(times.length / 2)] + 'ms' : ''));
}