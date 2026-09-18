/*
 * AUDIT MUTATION HARNESS.
 *
 * Rule 2: every mutation is verified to have LANDED on disk (byte compare
 * against the pristine text) before its result is believed.
 * Rule 14: the verdict is WHICH NAMED ASSERTION fired, never a failure total.
 *
 * Usage: node aprobe/mutate.mjs <spec.json>
 * spec: { restore:[paths], cases:[ {name, edits:[{file,from,to}], test} ] }
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const REV = spec.rev ?? 'e59a431';

const restore = () => {
  execFileSync('git', ['checkout', REV, '--', ...spec.restore], { stdio: 'pipe' });
};

const runTest = (file) => {
  const r = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout}\n${r.stderr}`;
  const named = [];
  for (const raw of out.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('✖ ')) named.push(l.replace(/ \(\d.*$/, '').slice(2));
  }
  const m = /AssertionError[^\n]*\n([\s\S]{0,400}?)\n\s*at /.exec(out);
  const counts = /ℹ fail (\d+)/.exec(out);
  return { named, fail: counts ? Number(counts[1]) : null, first: m ? m[1].trim().split('\n').slice(0, 4).join(' | ') : '' };
};

restore();
console.log(`# baseline (unmutated) for ${spec.cases[0].test}`);
console.log(JSON.stringify(runTest(spec.cases[0].test).named), '\n');

for (const c of spec.cases) {
  restore();
  let landed = true;
  for (const e of c.edits) {
    const before = fs.readFileSync(e.file, 'utf8');
    if (!before.includes(e.from)) { landed = false; console.log(`!! ${c.name}: anchor NOT FOUND in ${e.file}`); break; }
    const after = before.split(e.from).join(e.to);
    fs.writeFileSync(e.file, after);
    const reread = fs.readFileSync(e.file, 'utf8');
    if (reread === before || !reread.includes(e.to)) { landed = false; console.log(`!! ${c.name}: mutation DID NOT LAND in ${e.file}`); break; }
  }
  if (!landed) { restore(); continue; }
  const numstat = execFileSync('git', ['diff', '--numstat', REV, '--', ...spec.restore], { encoding: 'utf8' }).trim();
  const res = runTest(c.test);
  console.log(`## ${c.name}`);
  console.log(`   mutation landed (git diff --numstat): ${numstat.split('\n').join(' ; ') || 'NOTHING — INERT'}`);
  if (res.named.length === 0) console.log('   >>> SURVIVED: no named assertion fired');
  else for (const n of res.named) console.log(`   CAUGHT BY: ${n}`);
  if (res.first) console.log(`   message: ${res.first.slice(0, 260)}`);
  console.log('');
  restore();
}
restore();
console.log('# restored:', execFileSync('git', ['diff', '--numstat', REV, '--', ...spec.restore], { encoding: 'utf8' }).trim() || 'clean');
