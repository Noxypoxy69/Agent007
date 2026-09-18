/* AUDIT PROBE 4 — claim 11: does the PREAMBLE still overclaim, and does the
 * gate derive its field set or merely find the word somewhere? */
import fs from 'node:fs';
import { INSTRUCTIONS as TWIN } from '../mcp/toolDefs.mjs';
import { INSTRUCTIONS as HOSTED } from '../supabase/functions/mcp/_shared.js';

const INDEX = fs.readFileSync('supabase/functions/mcp/index.ts', 'utf8');
const blank = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));
const CODE = blank(INDEX);

const m = /rows\s*\.\s*map\s*\(\s*\(\s*r\s*\)\s*=>\s*\(\s*\{/.exec(CODE);
console.log('projection found at offset', m && m.index);
const after = CODE.slice(m.index, m.index + 4000);
const proj = new Map();
for (const hit of after.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*r\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
  if (!proj.has(hit[1])) proj.set(hit[1], hit[2]);
}
console.log('\nPROJECTION (key -> column):');
for (const [k, v] of proj) console.log(`   ${k.padEnd(16)} <- r.${v}`);

const SERVER_STAMPED = ['lastSeenAt'];
const self = [...proj.keys()].filter((k) => !SERVER_STAMPED.includes(k));
console.log(`\nSELF_REPORTED (${self.length}):`, self.join(', '));

const PRE = TWIN.slice(0, TWIN.indexOf('\n\n') + 2);
console.log('\n--- PREAMBLE as shipped ---\n' + PRE);

console.log('--- what the gate actually asserts, per field ---');
for (const f of self) {
  const words = f.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const head = words.split(' ')[0];
  const full = TWIN.toLowerCase().includes(words);
  const bare = TWIN.toLowerCase().includes(head);
  console.log(`   ${f.padEnd(16)} words="${words}" full=${full} headWord="${head}" head=${bare}  -> gate ${full || bare ? 'PASSES' : 'FAILS'}`);
}

console.log('\n--- is any of them described as OBSERVED rather than SELF-REPORTED? ---');
const observedClause = /OBSERVED from git plumbing[^.]*\./i.exec(TWIN);
const selfClause = /are\s+SELF-REPORTED[^.]*\./i.exec(TWIN);
const selfList = /Identity and placement[^—]*—([^.]*?)—\s*are\s+SELF-REPORTED/i.exec(TWIN);
console.log('  observed clause:', observedClause && observedClause[0]);
console.log('  self-reported list:', selfList && selfList[1].trim());
for (const f of self) {
  const words = f.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const head = words.split(' ')[0];
  const inObserved = observedClause ? observedClause[0].toLowerCase().includes(head) : false;
  const inSelf = selfList ? selfList[1].toLowerCase().includes(head) : false;
  console.log(`   ${f.padEnd(16)} named in OBSERVED clause: ${inObserved}   named in SELF-REPORTED list: ${inSelf}`);
}

console.log('\n--- window sensitivity: how long is the projection really? ---');
const close = after.indexOf('}));');
console.log('   projection body length to "}))" =', close, '(window is 4000)');
console.log('   TWIN === HOSTED :', TWIN === HOSTED);
console.log('\n--- does index.ts stamp git.head from the registration row? ---');
for (const line of CODE.split('\n').entries()) {
  const [i, l] = line;
  if (/head\s*:\s*r\./.test(l) || /verification_state/.test(l) || /runtime-self-registration/.test(l)) {
    console.log(`   index.ts:${i + 1}: ${l.trim().slice(0, 140)}`);
  }
}
