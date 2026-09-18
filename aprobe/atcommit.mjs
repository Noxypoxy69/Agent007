/*
 * AUDIT SCAFFOLD — was the test GREEN at the commit that shipped it?
 *
 * Usage: node aprobe/atcommit.mjs <sha> <test-basename> <src...>
 * Materialises the named sources at <sha>, copies <sha>:test/<basename> to
 * ctest/<basename> (depth 1, so ../src resolves), runs it, restores.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [sha, base, ...srcs] = process.argv.slice(2);
const HEADREV = 'e59a431';

execFileSync('git', ['checkout', sha, '--', ...srcs], { stdio: 'pipe' });
fs.mkdirSync('ctest', { recursive: true });
const body = execFileSync('git', ['show', `${sha}:test/${base}`], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
fs.writeFileSync(`ctest/${base}`, body);

const r = spawnSync(process.execPath, ['--test', `ctest/${base}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = `${r.stdout}\n${r.stderr}`;
const num = (k) => { const m = new RegExp(`ℹ ${k} (\\d+)`).exec(out); return m ? Number(m[1]) : null; };
const named = [];
for (const raw of out.split('\n')) { const l = raw.trim(); if (l.startsWith('✖ ')) named.push(l.replace(/ \(\d.*$/, '').slice(2)); }

console.log(`${sha}  ${base}`);
console.log(`   tests=${num('tests')} pass=${num('pass')} fail=${num('fail')} exit=${r.status}`);
if (named.length) for (const n of named) console.log(`   RED: ${n}`);
else console.log('   all green');
if (num('tests') === null) console.log(`   !! NO TEST COUNT REPORTED — the file did not run. head of output:\n${out.split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n')}`);

execFileSync('git', ['checkout', HEADREV, '--', ...srcs], { stdio: 'pipe' });
fs.rmSync(`ctest/${base}`, { force: true });
console.log('   restored:', execFileSync('git', ['diff', '--numstat', HEADREV, '--', ...srcs], { encoding: 'utf8' }).trim() || 'clean');
