/**
 * AUDIT SCAFFOLD v2. Runs the suite over an explicit file list, tees the full
 * output to a log, and prints only the TAP-ish summary plus the failing test
 * names -- rule 14: the named assertion, not a total (the total is printed too,
 * but it is never the evidence).
 *
 * Usage: node scripts/audit-run2.mjs <dir> <logfile> [substring-filter]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'atest';
const log = process.argv[3] ?? 'audit-suite.log';
const filter = process.argv[4] ?? '';

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return walk(p);
  return e.isFile() && p.endsWith('.test.mjs') ? [p.split(path.sep).join('/')] : [];
});

const files = walk(dir).filter((f) => f.includes(filter)).sort();
const r = spawnSync(process.execPath, ['--test', ...files], {
  encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
});
const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
fs.writeFileSync(log, out);

const lines = out.split('\n');
let file = '';
const fails = [];
for (const raw of lines) {
  const l = raw.trimEnd();
  const m = /^test at (.+):\d+:\d+$/.exec(l);
  if (m) { file = m[1]; continue; }
  if (l.startsWith('✖ ')) fails.push(`${file} :: ${l.replace(/ \(\d.*$/, '').slice(2)}`);
}
console.log(`[scaffold] files=${files.length} exit=${r.status}`);
for (const l of lines) if (/^ℹ (tests|pass|fail|suites|skipped|todo|cancelled) /.test(l.trim())) console.log(l.trim());
console.log(`--- ${fails.length} FAILING ASSERTIONS ---`);
for (const f of fails) console.log(f);
