/*
 * AUDIT MUTATION HARNESS.
 *
 * Rule 2: the mutation is verified to have LANDED on disk (byte compare) before
 * the run is believed. Rule 14: the verdict is WHICH NAMED TEST failed, never a
 * total. A mutation that does not apply is reported as NOT-APPLIED, never as
 * "missed".
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const TESTS = fs.readdirSync(path.join(REPO, 'audit'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => path.join('audit', f));

const SEARCH_ALL = process.argv.includes('--all');

function namedFailures() {
  const r = spawnSync(process.execPath, ['--test', ...TESTS],
    { cwd: REPO, encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout ?? ''}`;
  const failed = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]);
  const counts = {};
  for (const k of ['tests', 'pass', 'fail']) {
    const m = new RegExp(`^\\u2139 ${k} (\\d+)`, 'm').exec(out);
    counts[k] = m ? Number(m[1]) : null;
  }
  const loadErr = /Cannot find|ERR_MODULE_NOT_FOUND|SyntaxError/.test(out + (r.stderr ?? ''));
  return { failed, counts, exit: r.status, loadErr };
}

const BASE = namedFailures();
console.log(`BASELINE (audit subset, ${TESTS.length} files): tests=${BASE.counts.tests} pass=${BASE.counts.pass} fail=${BASE.counts.fail} exit=${BASE.exit}`);
if (BASE.failed.length) console.log(`  baseline failures: ${BASE.failed.join(' | ')}`);

const MUTATIONS = [
  ['M1 activeDecisions: restore validity-first (the D1 regression)', 'src/ownerDecisions.mjs',
    `  const present = rows.filter((d) => isPlainObject(d) && !d.revoked_at);`,
    `  const present = rows.filter((d) => isPlainObject(d) && !d.revoked_at).filter((d) => validateDecision(d, { owners }).ok);`],
  ['M1h same, hosted copy', 'supabase/functions/mcp/_shared.js',
    `  const present = rows.filter((d) => isPlainObject(d) && !d.revoked_at);`,
    `  const present = rows.filter((d) => isPlainObject(d) && !d.revoked_at).filter((d) => validateDecision(d, { owners }).ok);`],
  ['M2 activeDecisions: nothing is ever active', 'src/ownerDecisions.mjs',
    `  return valid.filter((d) => !superseded.has(d.decision_id));`,
    `  return [];`],
  ['M3 isOwnerId: widen to want.includes(o)', 'src/ownerDecisions.mjs',
    `  return owners.some((o) => isNonEmptyString(o) && o.trim().toLowerCase() === want);`,
    `  return owners.some((o) => isNonEmptyString(o) && want.includes(o.trim().toLowerCase()));`],
  ['M4 isOwnerId: widen to o.includes(want)  [REVERSE DIRECTION]', 'src/ownerDecisions.mjs',
    `  return owners.some((o) => isNonEmptyString(o) && o.trim().toLowerCase() === want);`,
    `  return owners.some((o) => isNonEmptyString(o) && o.trim().toLowerCase().includes(want));`],
  ['M5 isOwnerId: widen to o.startsWith(want)', 'src/ownerDecisions.mjs',
    `  return owners.some((o) => isNonEmptyString(o) && o.trim().toLowerCase() === want);`,
    `  return owners.some((o) => isNonEmptyString(o) && o.trim().toLowerCase().startsWith(want));`],
  ['M6 isOwnerId: strip non-alpha before comparing', 'src/ownerDecisions.mjs',
    `  const want = value.trim().toLowerCase();`,
    `  const want = value.trim().toLowerCase().replace(/[^a-z]/g, '');`],
  ['M7 revokeDecision (src): revert to compare-against-itself', 'src/ownerDecisions.mjs',
    `  if (!isOwnerId(by, owners)) {\n    return { ok: false, errors: [\`"\${by}" is not the owner: a worker cannot revoke the owner's decision\`] };`,
    `  if (isNonEmptyString(d.owner_id) && by !== d.owner_id) {\n    return { ok: false, errors: [\`"\${by}" is not the owner: a worker cannot revoke the owner's decision\`] };`],
  ['M8 created_by: revert to strict equality with owner_id', 'src/ownerDecisions.mjs',
    `  else if (!isOwnerId(d.created_by, owners)) {`,
    `  else if (isNonEmptyString(d.owner_id) && d.created_by !== d.owner_id) {`],
  ['M9 POLL WIRING: supervisor stops carrying the cursor', 'scripts/bridge-session-poll.mjs',
    `    cursor = advanceCursor(cursor, r.stdout);`,
    `    cursor = new Date(Date.now() - STALE_WINDOW_SECONDS * 1000).toISOString();`],
  ['M10 POLL WIRING: drop the refused-credential abort', 'scripts/bridge-session-poll.mjs',
    `    if (/REFUSED this credential|no registration token/i.test(err)) {`,
    `    if (false && /REFUSED this credential|no registration token/i.test(err)) {`],
  ['M11 CLI CONTRACT: change the printed cursor line', 'bin/agentbridge.mjs',
    "        console.log(`  cursor  ${cursor}`);",
    "        console.log(`  cursor: ${cursor}`);"],
  ['M12 CLI CONTRACT: stop printing the cursor line at all', 'bin/agentbridge.mjs',
    "        console.log(`  cursor  ${cursor}`);",
    "        // cursor line removed"],
  ['M13 e38687f: dispatcher runs on import again', 'scripts/bridge-session-poll.mjs',
    `const RUN_DIRECTLY = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;`,
    `const RUN_DIRECTLY = true;`],
  ['M14 e38687f: dispatcher never runs at all', 'scripts/bridge-session-poll.mjs',
    `const RUN_DIRECTLY = !!process.argv[1] && path.resolve(process.argv[1]) === SELF;`,
    `const RUN_DIRECTLY = false;`],
];

for (const [name, rel, from, to] of MUTATIONS) {
  const f = path.join(REPO, rel);
  const before = fs.readFileSync(f, 'utf8');
  if (!before.includes(from)) { console.log(`\n${name}\n  NOT-APPLIED: anchor text absent in ${rel}`); continue; }
  const occurrences = before.split(from).length - 1;
  fs.writeFileSync(f, before.split(from).join(to));
  const after = fs.readFileSync(f, 'utf8');
  if (after === before) { console.log(`\n${name}\n  NOT-APPLIED: file unchanged on disk`); continue; }
  const diffBytes = execFileSync('git', ['diff', '--numstat', '--', rel], { cwd: REPO, encoding: 'utf8' }).trim();
  try {
    const r = namedFailures();
    const newly = r.failed.filter((x) => !BASE.failed.includes(x));
    console.log(`\n${name}`);
    console.log(`  LANDED (${occurrences}x in ${rel}; git numstat: ${diffBytes || 'EMPTY -> mutation did NOT land'})`);
    console.log(`  tests=${r.counts.tests} pass=${r.counts.pass} fail=${r.counts.fail} loadError=${r.loadErr}`);
    console.log(newly.length
      ? `  CAUGHT by: ${newly.join(' | ')}`
      : `  *** MISSED: not one named assertion in the audit subset fired ***`);
  } finally {
    fs.writeFileSync(f, before);
    if (fs.readFileSync(f, 'utf8') !== before) throw new Error(`failed to restore ${rel}`);
  }
}
console.log('\nrestored; git status should be clean for mutated files:');
console.log(execFileSync('git', ['status', '--porcelain', '--', 'src', 'bin', 'scripts', 'supabase'], { cwd: REPO, encoding: 'utf8' }) || '  (clean)');
