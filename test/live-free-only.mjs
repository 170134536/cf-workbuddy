#!/usr/bin/env node
/**
 * End-to-end verification of free-only enforcement on the live Worker.
 *
 * Uses fetch directly: PowerShell's Invoke-WebRequest throws on 4xx and the
 * body has to be pulled off the exception, which is easy to get wrong and
 * produced a false "not blocked" reading earlier.
 */

const BASE = 'https://kz007.ccwu.cc';
const ADMIN = 'leahdizon';

const j = (r) => r.json();

const login = await fetch(BASE + '/admin/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: ADMIN }),
});
const { token: sid } = await j(login);
const AH = { Authorization: 'Bearer ' + sid, 'Content-Type': 'application/json' };

const created = await fetch(BASE + '/admin/api/keys', {
  method: 'POST',
  headers: AH,
  body: JSON.stringify({ name: 'verify', days: 1 }),
});
const { key } = await j(created);
const KH = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const chk = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); }
};

const chat = (model) => fetch(BASE + '/v1/chat/completions', {
  method: 'POST',
  headers: KH,
  body: JSON.stringify({
    model,
    stream: true,
    messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Reply with exactly: OK' }],
  }),
});

console.log('=== 1. model listing ===');
const models = await j(await fetch(BASE + '/v1/models', { headers: KH }));
const ids = models.data.map((m) => m.id).sort();
console.log('  exposed: ' + ids.join(', '));
chk('listing is exactly the 3 free models',
  ids.length === 3 && ['deepseek-v4.1-flash', 'hy3', 'hy4-preview-f'].every((x) => ids.includes(x)),
  JSON.stringify(ids));

console.log('\n=== 2. paid models must be refused (403) ===');
const paid = ['gpt-6-astra', 'deepseek-v4.1-flash-sg', 'hy4-preview', 'glm-5.3-flash', 'kimi-k3', 'gpt-5.5', 'default-model'];
for (const m of paid) {
  const r = await chat(m);
  let code = '';
  if (r.status === 403) {
    try { code = (await j(r)).error.code; } catch {}
  }
  chk('refused ' + m, r.status === 403 && code === 'model_not_free', 'status ' + r.status + ' code ' + code);
}

console.log('\n=== 3. free models must work (200 + SSE) ===');
for (const m of ['deepseek-v4.1-flash', 'hy4-preview-f', 'hy3']) {
  const r = await chat(m);
  const ct = r.headers.get('content-type') || '';
  let text = '';
  if (r.status === 200) text = await r.text();
  const out = [...text.matchAll(/"content":"([^"]*)"/g)].map((x) => x[1]).join('');
  chk('allowed ' + m, r.status === 200 && ct.includes('event-stream'), 'status ' + r.status + ' ct ' + ct);
  console.log('        output: ' + out.trim().slice(0, 50));
}

console.log('\n=== 4. cleanup ===');
await fetch(BASE + '/admin/api/keys/delete', { method: 'POST', headers: AH, body: JSON.stringify({ key }) });
const after = await fetch(BASE + '/v1/models', { headers: KH });
chk('revoked key no longer works', after.status === 401, 'status ' + after.status);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
