/*
 * AUDIT MUTATION HARNESS v2 — reports the TEST COUNT as well as the named
 * assertions, because hollow gate 9 is "no assertion executed" reading as a
 * pass. test:"SUITE" runs every file under atest/.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const REV = spec.rev ?? 'e59a431';
const restore = () => execFileSync('git', ['checkout', REV, '--', ...spec.restore], { stdio: 'pipe' });

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return walk(p);
  return e.isFile() && p.endsWith('.test.mjs') ? [p.split(path.sep).join('/')] : [];
});

const runTest = (file) => {
  const args = file === 'SUITE' ? ['--test', ...walk('atest').sort()] : ['--test', file];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = `${r.stdout}\n${r.stderr}`;
  const named = [];
  let cur = '';
  for (const raw of out.split('\n')) {
    const l = raw.trim();
    const m = /^test at (.+):\d+:\d+$/.exec(l);
    if (m) { cur = m[1]; continue; }
    if (l.startsWith('✖ ')) named.push(`${cur} :: ${l.replace(/ \(\d.*$/, '').slice(2)}`);
  }
  const num = (k) => { const m = new RegExp(`ℹ ${k} (\\d+)`).exec(out); return m ? Number(m[1]) : null; };
  return { named, tests: num('tests'), pass: num('pass'), fail: num('fail'), exit: r.status };
};

restore();
for (const c of spec.cases) {
  restore();
  const baseline = runTest(c.test);
  let landed = true;
  for (const e of c.edits) {
    const before = fs.readFileSync(e.file, 'utf8');
    if (!before.includes(e.from)) { landed = false; console.log(`!! ${c.name}: ANCHOR NOT FOUND in ${e.file}`); break; }
    fs.writeFileSync(e.file, before.split(e.from).join(e.to));
    if (fs.readFileSync(e.file, 'utf8') === before) { landed = false; console.log(`!! ${c.name}: DID NOT LAND`); break; }
  }
  if (!landed) { restore(); continue; }
  const numstat = execFileSync('git', ['diff', '--numstat', REV, '--', ...spec.restore], { encoding: 'utf8' }).trim().split('\n').join(' ; ');
  const after = runTest(c.test);
  console.log(`## ${c.name}`);
  console.log(`   landed: ${numstat || 'NOTHING'}`);
  console.log(`   baseline  tests=${baseline.tests} pass=${baseline.pass} fail=${baseline.fail} exit=${baseline.exit}`);
  console.log(`   mutated   tests=${after.tests} pass=${after.pass} fail=${after.fail} exit=${after.exit}`);
  const newFails = after.named.filter((n) => !baseline.named.includes(n));
  if (after.tests !== baseline.tests) console.log('   !! TEST COUNT MOVED — the mutation changed what RAN, not only what passed');
  if (newFails.length === 0) console.log('   >>> SURVIVED: no assertion that was green went red');
  else for (const n of newFails) console.log(`   CAUGHT BY: ${n}`);
  console.log('');
  restore();
}
restore();
console.log('# restored:', execFileSync('git', ['diff', '--numstat', REV, '--', ...spec.restore], { encoding: 'utf8' }).trim() || 'clean');
