#!/usr/bin/env node
/** Verify creditOf() against the real upstream values. */

// Mirrors src/worker.js creditOf exactly.
function creditOf(c) {
  if (c === undefined || c === null) return null;
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  const s = String(c).trim();
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

// Exactly the values observed from GET /v3/config on 2026-09-21.
const real = [
  ['default-model', ''],
  ['fast-model', 'x0.34 credits'],
  ['balanced-model', 'x0.59 credits'],
  ['primary-model', 'x3.31 credits'],
  ['deep-model', 'x3.33 credits'],
  ['kimi-k2.8-preview', 'x0.77'],
  ['deepseek-v4.1-flash', 'x0.00'],
  ['deepseek-v4.1-flash-sg', 'x0.03'],
  ['glm-5.3-flash', 'x0.06'],
  ['gpt-6-astra', 'x6.67'],
  ['hy4-preview-f', 'x0.00'],
  ['hy4-preview', 'x0.29'],
  ['hy3', 'x0.00'],
  ['gpt-5.6-sol', 'x3.47'],
  ['gpt-5.6-terra', 'x1.39'],
  ['gpt-5.6-luna', 'x0.14'],
  ['gpt-5.5', 'x3.31'],
  ['gpt-5.4', 'x1.65'],
  ['gemini-3.5-flash', 'x0.99'],
  ['glm-5.3', 'x0.79'],
  ['glm-5.2', 'x0.79'],
  ['kimi-k3', 'x1.62'],
  ['kimi-k2.6', 'x0.52'],
];

let bad = 0;
const free = [];
const paid = [];
const unrated = [];

console.log('id'.padEnd(28) + 'raw'.padEnd(18) + 'parsed');
console.log('-'.repeat(60));
for (const [id, raw] of real) {
  const v = creditOf(raw);
  const tag = v === 0 ? 'FREE' : v === null ? 'unrated' : 'paid ' + v;
  if (v === 0) free.push(id);
  else if (v === null) unrated.push(id);
  else paid.push(id);
  console.log(id.padEnd(28) + JSON.stringify(raw).padEnd(18) + tag);
}

console.log('\nFREE    (' + free.length + '): ' + free.join(', '));
console.log('unrated (' + unrated.length + '): ' + unrated.join(', '));
console.log('paid    (' + paid.length + '): ' + paid.join(', '));

// The whole point: free must be exactly the three known-free models.
const expected = ['deepseek-v4.1-flash', 'hy4-preview-f', 'hy3'];
const same = free.length === expected.length && expected.every((e) => free.includes(e));
console.log('\nfree set matches expectation: ' + (same ? 'YES' : 'NO  expected ' + expected.join(', ')));
if (!same) bad++;

// Guards: the old numeric parse must fail on these, the new one must not.
if (creditOf('x0.00') !== 0) { console.log('FAIL x0.00 -> ' + creditOf('x0.00')); bad++; }
if (creditOf('x0.34 credits') !== 0.34) { console.log('FAIL x0.34 -> ' + creditOf('x0.34 credits')); bad++; }
if (creditOf('') !== null) { console.log('FAIL empty -> ' + creditOf('')); bad++; }
if (creditOf(0) !== 0) { console.log('FAIL number 0'); bad++; }
if (creditOf('0') !== 0) { console.log('FAIL "0"'); bad++; }
if (creditOf(undefined) !== null) { console.log('FAIL undefined'); bad++; }
if (creditOf('免费') !== null) { console.log('FAIL non-numeric'); bad++; }

// The old implementation, for contrast.
const oldParse = (c) => {
  if (c === undefined || c === null || c === '') return null;
  const v = Number(c);
  return Number.isNaN(v) ? null : v;
};
const oldFree = real.filter(([, c]) => oldParse(c) === 0).length;
console.log('\nold parser free count: ' + oldFree + '  (0 means filtering was silently disabled)');
console.log('new parser free count: ' + free.length);

console.log('\n' + (bad === 0 ? 'ALL CHECKS PASSED' : bad + ' CHECKS FAILED'));
process.exit(bad ? 1 : 0);
