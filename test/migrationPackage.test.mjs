/**
 * THE MIGRATION TOOLS, WHICH SHIPPED WITH NO TEST AT ALL.
 *
 * Seven commits built and repaired `scripts/migration-package.mjs` and
 * `scripts/migration-verify.mjs` — 721 lines, including a gate whose PASS
 * authorises wiping the source machine — and `npm run audit:auto` scored six of
 * the seven `SKIP no test files touched`. Every defect a blind auditor found in
 * them was found by running the tools by hand, which is what a test does.
 *
 * The one that matters most, and the reason this file leads with it: the
 * verifier NEVER OPENED THE PACKAGE. It read the manifest for its counts and
 * queried the live store. A directory holding one hand-written manifest, no
 * `state/`, and hashes of 64 zeros produced "EVERY STORE RESOLVED" and exit 0.
 *
 * So the first test here is that exact package. It is not a hypothetical: it is
 * the auditor's counterexample, kept as a fixture, and it must never pass again.
 *
 * NOTHING HERE WRITES TO THE OPERATOR'S STORE. Every fixture is a mkdtemp
 * directory; the packager's source is redirected with AGENTBRIDGE_HOME and the
 * verifier is only ever run against fixtures through its exported `run`.
 *
 * ═══ WHY THESE ASSERT ON ROWS AND NOT ON THE EXIT CODE ═══
 *
 * The first version of this file asserted `notEqual(code, 0)` four times, under
 * a title promising that "the identical untampered one passes" and a comment
 * explaining that the case was differenced. IT WAS NOT. The untampered half was
 * never built and never run, so every one of those assertions was satisfiable by
 * a verifier that rejects everything — the precise hollow gate the comment
 * claimed to be avoiding, written into the test that exists to prevent it.
 *
 * It cannot be differenced on the exit code, and that is the reason it was not:
 * phase 2 asks whether each file is installed in the LIVE store, and a fixture
 * key is in nobody's live store, so a perfect fixture package still exits 1. The
 * exit code cannot distinguish "tampered" from "not installed here".
 *
 * So the difference is taken where it actually exists — the phase-1 verdict and
 * the row text — by capturing what `run` prints. Each negative below is paired
 * with a near-identical positive that must NOT produce the same row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
  statSync, linkSync, symlinkSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AUTHORITY_ROSTER } from '../scripts/migration-verify.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const mk = () => mkdtempSync(path.join(tmpdir(), 'ab-migtest-'));

/** A manifest whose items are real, so a failure is about the code not the shape. */
/**
 * A manifest whose items are real, so a failure is about the code not the shape.
 *
 * `source_absent` IS DERIVED FROM THE SHIPPED ROSTER, not typed. The verifier
 * holds its own list of the authority stores a migration is for, so a fixture
 * carrying only `delegations.json` must SAY it has no audit queue — that is the
 * whole point of the roster (blind audit HIGH-1: a package carrying one
 * non-authority store got the full green banner). Deriving it here means adding
 * a store to the roster does not quietly turn every fixture red for a reason
 * that has nothing to do with what the fixture tests, and `THE ROSTER FIRES`
 * below is what keeps the gate honest.
 */
function manifestFor(items, keys = ['aaaaaaaaaaaaaaaa'], absent = undefined) {
  const carried = items.map((i) => i.source_relative_to_agentbridge_home);
  const covers = (entry) => (entry.endsWith('/')
    ? carried.some((r) => r.toLowerCase().startsWith(entry.toLowerCase()))
    : carried.some((r) => r.toLowerCase() === entry.toLowerCase()));
  return {
    kind: 'agent007-migration-package',
    manifest_version: 1,
    hash_algorithm: 'sha256',
    source_store_keys: keys,
    source_inventory: carried.slice().sort(),
    source_absent: absent ?? AUTHORITY_ROSTER.filter((e) => !covers(e)),
    items,
  };
}

const item = (rel, body, extra = {}) => ({
  source_relative_to_agentbridge_home: rel,
  destination_relative_to_package: `state/${rel}`,
  bytes: Buffer.byteLength(body),
  records: body.split('\n').filter((l) => l.trim()).length,
  sha256: sha256(body),
  authority: true,
  ...extra,
});

/**
 * Run the verifier and keep every line it printed.
 *
 * `run` returns only an exit code, and the exit code conflates every phase —
 * see the header. The rows are where the verdict actually lives, so a test that
 * wants to say WHICH check fired has to read them.
 *
 * Restoring the console in `finally` matters: node's test reporter is the same
 * console, so leaking the patch turns an unrelated later failure into silence.
 */
async function verify(dir) {
  const { run } = await import('../scripts/migration-verify.mjs');
  const lines = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => lines.push(a.map(String).join(' '));
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try {
    const code = await run(dir);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

/**
 * Run the verifier as a CHILD against a fixture store.
 *
 * PHASE 3 READS THE REAL HOME, and the store root is a module constant resolved
 * at import — so the in-process helper above cannot be used for any assertion
 * about a resolution row: it compares the fixture's manifest against the
 * OPERATOR'S live store, and the numbers are whatever that machine holds today.
 * Both of this file's first drafts of the phase-3 tests failed for exactly that,
 * which is rule 21 in miniature: the fixture had picked up a fact about the
 * machine. Anything asserting on `resolve ...` goes through here.
 */
function verifyChild(pkg, home) {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const r = spawnSync(process.execPath, ['scripts/migration-verify.mjs', '--package', pkg],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, AGENTBRIDGE_HOME: home } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Build a one-file package on disk and return its directory. */
function packageWith(dir, items, keys, write) {
  for (const [rel, body] of write) {
    mkdirSync(path.dirname(path.join(dir, 'state', rel)), { recursive: true });
    writeFileSync(path.join(dir, 'state', rel), body);
  }
  writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifestFor(items, keys)));
  return dir;
}

test('THE COUNTEREXAMPLE: a manifest with no package behind it must FAIL', async () => {
  /*
   * The auditor's exact demonstration. Manifest only, no state/ directory,
   * hashes of 64 zeros. The old verifier returned 0 on this.
   */
  const dir = mk();
  try {
    const body = '{"audit_id":"a"}\n';
    const m = manifestFor([{ ...item('audits/aaaaaaaaaaaaaaaa.jsonl', body), sha256: '0'.repeat(64) }]);
    writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(m));

    const { code, out } = await verify(dir);
    assert.notEqual(code, 0,
      'a package containing nothing but a manifest was accepted — this is the wipe-the-source-machine gate');
    assert.match(out, /integrity FAILED/,
      'the manifest-only package was rejected, but not by the integrity phase — so this proves nothing about whether the package was opened');
    assert.match(out, /ABSENT from the package/,
      'nothing said the claimed file was missing; the rejection came from somewhere else');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A MANIFEST CANNOT SEND THE VERIFIER OUT OF THE PACKAGE', async () => {
  /*
   * ═══ THE WIPE-AUTHORISING GATE READ ITS ADDRESS FROM ITS INPUT ═══
   *
   * Blind audit HIGH-1, reproduced by hand before this was written. Phase 1 did
   * `path.join(pkgDir, item.destination_relative_to_package)` with nothing
   * constraining that field. Point it at the live store with `..` and phase 1
   * hashes the live file, phase 2 hashes the same live file, phase 3 reads the
   * same live store, and all three agree — because they are one file that was
   * never copied anywhere. Measured, on a directory containing only a manifest:
   *
   *     integrity OK · installation OK · 0 failure(s), 1 advisory
   *     PACKAGE INTACT, INSTALLED, AND REACHABLE THROUGH ITS REAL READERS.
   *
   * THE COUNTEREXAMPLE TEST ABOVE DID NOT CATCH IT, and that is the lesson: its
   * fixture used `state/` paths and hashes of 64 zeros, so it pinned the five
   * strings the first probe happened to try rather than the matcher (rule 8).
   *
   * Differenced: the same package with the honest destination must NOT produce
   * this refusal, or "traversal is refused" would be satisfied by refusing
   * everything.
   */
  const body = '{"audit_id":"a"}\n';
  const evil = mk();
  const good = mk();
  try {
    // The payload really is absent from the package — that is the whole point.
    const escape = { ...item('audits/aaaaaaaaaaaaaaaa.jsonl', body), destination_relative_to_package: '../../../../../../../../.agentbridge/audits/aaaaaaaaaaaaaaaa.jsonl' };
    writeFileSync(path.join(evil, 'MANIFEST.json'), JSON.stringify(manifestFor([escape])));
    const e = await verify(evil);
    assert.notEqual(e.code, 0, 'a manifest pointing outside the package was followed');
    assert.match(e.out, /Refusing to follow the manifest to another location/,
      'the traversal was rejected by something other than the path check, so the path check is unproven');
    assert.match(e.out, /integrity FAILED/);

    packageWith(good, [item('audits/aaaaaaaaaaaaaaaa.jsonl', body)], undefined,
      [['audits/aaaaaaaaaaaaaaaa.jsonl', body]]);
    const g = await verify(good);
    assert.doesNotMatch(g.out, /Refusing to follow the manifest/,
      'an honest destination was refused as a traversal');
    assert.match(g.out, /integrity OK/);
  } finally {
    rmSync(evil, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
});

test('A COMPANION CANNOT SEND THE VERIFIER OUT OF THE PACKAGE EITHER', async () => {
  /*
   * ═══ THE FIX FOR THE TRAVERSAL COVERED items AND NOT ITS SIBLING ═══
   *
   * Blind audit D2, reproduced by hand. `payloadPathProblem` constrained the
   * manifest's items; three lines below it the companions loop still did
   * `path.join(pkgDir, c.name)` with nothing constraining `c.name`, and decided
   * whether to open it from `c.location` — another manifest field. Measured,
   * against a package directory containing no such file:
   *
   *     OK  companion ../../../../../../../../.agentbridge/audits/<key>.jsonl
   *         sha256 matches
   *
   * The reason it survived is one line: `Grep "companion" test/migrationPackage
   * .test.mjs` returned nothing. The branch had no test, so the fix had no
   * reason to look at it — which is the whole argument for testing a gate's
   * accepting path as well as its refusing one.
   *
   * Differenced against a real companion sitting honestly inside the package.
   */
  const dir = mk();
  try {
    const body = '{"finding_id":"x"}\n';
    const doc = '# decisions\n';
    packageWith(dir, [item('findings/aaaaaaaaaaaaaaaa.jsonl', body)], ['aaaaaaaaaaaaaaaa'],
      [['findings/aaaaaaaaaaaaaaaa.jsonl', body]]);
    writeFileSync(path.join(dir, 'DECISIONS.md'), doc);

    const manifestPath = path.join(dir, 'MANIFEST.json');
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));

    // The honest companion FIRST, so the refusal below is not unconditional.
    m.companions = [{
      name: 'DECISIONS.md', location: 'inside the package', bytes: Buffer.byteLength(doc), sha256: sha256(doc),
    }];
    writeFileSync(manifestPath, JSON.stringify(m));
    const good = await verify(dir);
    assert.match(good.out, /OK +companion DECISIONS\.md/,
      'a companion genuinely inside the package was refused, so the refusal below proves nothing');

    // Now the same shape, aimed out of the package at a file that really exists.
    const outside = mk();
    try {
      writeFileSync(path.join(outside, 'secret.jsonl'), body);
      const escape = path.relative(dir, path.join(outside, 'secret.jsonl')).split(path.sep).join('/');
      m.companions = [{
        name: escape, location: 'inside the package', bytes: Buffer.byteLength(body), sha256: sha256(body),
      }];
      writeFileSync(manifestPath, JSON.stringify(m));

      const bad = await verify(dir);
      assert.notEqual(bad.code, 0, 'a companion naming a path outside the package was followed');
      assert.doesNotMatch(bad.out, /OK +companion/,
        'the verifier hashed a file outside the package and called the companion intact');
      assert.match(bad.out, /may only name a location INSIDE the package/);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A LINK INSIDE THE PACKAGE IS NOT A PAYLOAD', async (t) => {
  /*
   * Blind audit D3. A string check is not enough, because the filesystem gets a
   * vote: a symlink or junction sitting at `state/<rel>` redirects the read to
   * one live file with no `..` anywhere in the manifest. The packager was
   * hardened against exactly this — "readFileSync FOLLOWS LINKS" is in its own
   * commit message — and the verifier beside it was not.
   *
   * Differenced: the same package with a real file at that path must pass.
   */
  const body = '{"finding_id":"x"}\n';
  const real = mk();
  const linked = mk();
  const target = mk();
  try {
    packageWith(real, [item('findings/aaaaaaaaaaaaaaaa.jsonl', body)], ['aaaaaaaaaaaaaaaa'],
      [['findings/aaaaaaaaaaaaaaaa.jsonl', body]]);
    assert.match((await verify(real)).out, /OK +pkg findings\//,
      'the honest package failed, so the link refusal below proves nothing');

    // Same manifest, but the payload is a link out to an identical file.
    writeFileSync(path.join(target, 'elsewhere.jsonl'), body);
    packageWith(linked, [item('findings/aaaaaaaaaaaaaaaa.jsonl', body)], ['aaaaaaaaaaaaaaaa'], []);
    mkdirSync(path.join(linked, 'state', 'findings'), { recursive: true });
    try {
      symlinkSync(path.join(target, 'elsewhere.jsonl'), path.join(linked, 'state/findings/aaaaaaaaaaaaaaaa.jsonl'));
    } catch (e) {
      t.skip(`this platform would not create a symlink: ${e?.code ?? e?.message}`);
      return;
    }

    const out = (await verify(linked)).out;
    assert.doesNotMatch(out, /OK +pkg findings\//,
      'a link pointing out of the package was read as a packaged payload, and its bytes matched');
    assert.match(out, /resolves OUTSIDE the package/);
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('THE ROSTER FIRES: an authority store may be absent, but it must be SAID', async () => {
  /*
   * ═══ A SECOND FIELD OF THE SAME UNTRUSTED DOCUMENT IS NOT A WITNESS ═══
   *
   * Blind audit HIGH-1. `source_inventory` was added so a truncated `items` list
   * would contradict something — but it contradicts a list in the SAME FILE, so
   * trimming both together is one extra edit. Measured: a directory holding a
   * manifest and one byte-exact copy of `escalations.json` — the one store the
   * packager marks `authority: false` and REDUNDANT — produced `0 failure(s)`,
   * the full green banner and exit 0, with the audit queue, both finding
   * registries, delegations, lead work and token measurements absent.
   *
   * So the roster lives in the verifier, where the manifest cannot reach it.
   *
   * THIS TEST EXISTS BECAUSE `manifestFor` DERIVES `source_absent`. That keeps
   * every other fixture honest without hand-listing stores, and it would also
   * disarm this gate everywhere if nothing checked the undeclared case. Rule 6:
   * the precondition is an assertion, not a convenience.
   */
  const body = '{"x":1}\n';
  const dir = mk();
  try {
    const items = [item('delegations.json', body)];
    // Absent AND declared: the shape every other fixture in this file uses.
    packageWith(dir, items, [], [['delegations.json', body]]);
    const declared = await verify(dir);
    assert.doesNotMatch(declared.out, /FAIL +authority roster/,
      'a package that declared its absent stores was still refused, so the refusal below proves nothing');
    assert.match(declared.out, /OK +authority roster/);

    // The same package with the declaration removed.
    const m = manifestFor(items, [], []);
    writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(m));
    const silent = await verify(dir);
    assert.notEqual(silent.code, 0, 'a package carrying none of the authority stores passed');
    assert.match(silent.out, /FAIL +authority roster/);
    for (const entry of AUTHORITY_ROSTER.filter((e) => e !== 'delegations.json')) {
      assert.match(silent.out, new RegExp(entry.replace('.', '\\.')),
        `the roster did not name ${entry}, so an operator cannot tell what is missing`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A TRUNCATED MANIFEST IS CAUGHT BY THE SOURCE INVENTORY', async () => {
  /*
   * Blind audit HIGH-2(b): deleting the audit-queue and finding-registry items
   * from a real manifest produced a full PASS and exit 0. A list cannot notice
   * its own missing entry, so the packager now records what it FOUND at source
   * as a second fact and a truncated items list contradicts it.
   *
   * Differenced against the same manifest whose inventory agrees.
   */
  const a = '{"finding_id":"x"}\n';
  const dir = mk();
  try {
    const m = manifestFor([item('findings/aaaaaaaaaaaaaaaa.jsonl', a)]);
    m.source_inventory = ['findings/aaaaaaaaaaaaaaaa.jsonl', 'delegations.json'];  // one was dropped
    mkdirSync(path.join(dir, 'state', 'findings'), { recursive: true });
    writeFileSync(path.join(dir, 'state/findings/aaaaaaaaaaaaaaaa.jsonl'), a);
    writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(m));

    const t = await verify(dir);
    assert.notEqual(t.code, 0, 'a manifest missing a file its own inventory records was accepted');
    assert.match(t.out, /manifest completeness.*delegations\.json/s,
      'the dropped file was not named');

    // And the honest inventory must not trip it.
    m.source_inventory = ['findings/aaaaaaaaaaaaaaaa.jsonl'];
    writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(m));
    const g = await verify(dir);
    assert.match(g.out, /OK +manifest completeness/,
      'a complete manifest was reported as truncated, so the refusal above proves nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A MANIFEST WITH NO USABLE COUNT FAILS RESOLUTION rather than advising', async () => {
  /*
   * Blind audit HIGH-2(a): `compare` returned an ADVISORY whenever the expected
   * count was null, and advisories set no exit code. Renaming `records` to
   * `record_count` in every item — what a manifest_version bump would do — made
   * every resolution row a NOTE and still printed EVERY STORE RESOLVED, exit 0.
   * Phase 3 ran and asserted nothing.
   *
   * Differenced against the identical manifest that keeps `records`.
   */
  const rows = JSON.stringify([{ id: 1 }, { id: 2 }]);
  const withCount = mk();
  const without = mk();
  const home = mk();
  try {
    writeFileSync(path.join(home, 'delegations.json'), rows);
    for (const [dir, mangle] of [[withCount, false], [without, true]]) {
      const it = { ...item('delegations.json', rows), records: 2 };
      if (mangle) { it.record_count = it.records; delete it.records; }
      packageWith(dir, [it], [], [['delegations.json', rows]]);
    }
    const bad = verifyChild(without, home);
    assert.match(bad.out, /FAIL +resolve delegations/,
      'a carried store with no usable count was waved through as an advisory');
    assert.match(bad.out, /NO usable count/);

    const good = verifyChild(withCount, home);
    assert.doesNotMatch(good.out, /FAIL +resolve delegations/,
      'the store WITH a count also failed, so the refusal above is unconditional');
    assert.match(good.out, /OK +resolve delegations +resolved 2, matches manifest/);
  } finally {
    rmSync(withCount, { recursive: true, force: true });
    rmSync(without, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('A TAMPERED PAYLOAD FAILS INTEGRITY, and the identical untampered one does not', async () => {
  /*
   * DIFFERENCED FOR REAL THIS TIME. The two packages are byte-identical except
   * for the payload, so a verifier that rejects everything fails the second
   * assertion.
   *
   * The difference is the PHASE-1 verdict, not the exit code: both packages exit
   * 1, because a fixture store key is installed nowhere and phase 2 says so.
   * That is the verifier being right, and asserting the exit code here is what
   * made the original version of this test hollow.
   */
  const body = '{"audit_id":"a"}\n';
  const items = [item('audits/aaaaaaaaaaaaaaaa.jsonl', body)];

  const bad = mk();
  const good = mk();
  try {
    packageWith(bad, items, undefined, [['audits/aaaaaaaaaaaaaaaa.jsonl', 'TAMPERED\n']]);
    packageWith(good, items, undefined, [['audits/aaaaaaaaaaaaaaaa.jsonl', body]]);

    const t = await verify(bad);
    assert.notEqual(t.code, 0, 'a payload whose bytes do not match its recorded hash was accepted');
    assert.match(t.out, /integrity FAILED/, 'the tampered payload did not fail the integrity phase');
    assert.match(t.out, /does not match the manifest/, 'the tampered payload was not reported as a hash mismatch');

    const g = await verify(good);
    assert.match(g.out, /integrity OK/,
      'the UNTAMPERED package also failed integrity — so "detects tampering" is satisfied here by rejecting everything, which is exactly the hollow gate this file is about');
    assert.doesNotMatch(g.out, /does not match the manifest/,
      'a correct payload was reported as a hash mismatch');
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
});

test('TWO FILES FOR ONE KEY IS REFUSED, never resolved by a rename', async () => {
  /*
   * The verifier used to print, for a moved key, a rename of EVERY packaged key
   * onto the single destination name — instructions that overwrite one
   * authority file with another, on a machine where the source may be gone.
   * This machine really does carry two findings files, so the case is live.
   *
   * A tool cannot choose between them. The contract is refusal.
   *
   * Differenced against the SAME package carrying one findings file, because
   * every fixture here fails phase 2 anyway — so the claim has to be about the
   * refusal row, not about the exit code. This is the shape that ships: the real
   * package on this machine carries two findings files and is refused by it.
   */
  const a = '{"finding_id":"x"}\n';
  const b = '{"finding_id":"y"}\n';
  const two = mk();
  const one = mk();
  try {
    packageWith(two,
      [item('findings/aaaaaaaaaaaaaaaa.jsonl', a), item('findings/bbbbbbbbbbbbbbbb.jsonl', b)],
      ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
      [['findings/aaaaaaaaaaaaaaaa.jsonl', a], ['findings/bbbbbbbbbbbbbbbb.jsonl', b]]);
    packageWith(one,
      [item('findings/aaaaaaaaaaaaaaaa.jsonl', a)],
      ['aaaaaaaaaaaaaaaa'],
      [['findings/aaaaaaaaaaaaaaaa.jsonl', a]]);

    const t = await verify(two);
    assert.notEqual(t.code, 0, 'two files competing for one destination key were not refused');
    assert.match(t.out, /only one can occupy the destination key/,
      'the two-file package was rejected, but not by the ambiguity refusal');
    assert.doesNotMatch(t.out, /renamed from/,
      'a rename was advised for a key two files are competing for — following it destroys one of them');

    const g = await verify(one);
    assert.doesNotMatch(g.out, /only one can occupy the destination key/,
      'a package with ONE findings file was also refused as ambiguous, so the refusal is unconditional and proves nothing');
  } finally {
    rmSync(two, { recursive: true, force: true });
    rmSync(one, { recursive: true, force: true });
  }
});

test('EVERY PACKAGED FILE IS ACCOUNTED FOR, not only the one at the destination key', async () => {
  /*
   * The verifier emitted six rows for a seven-file package: a second file under
   * a keyed directory was carried, marked authority, and checked by nothing.
   * Phase 1 now iterates the manifest, so the count of rows follows the
   * manifest rather than a fixed list of store names.
   */
  const a = '{"finding_id":"x"}\n';
  const b = '{"finding_id":"y"}\n';
  const dir = mk();
  try {
    /*
     * Two manifest items, only the FIRST written to disk. If coverage followed a
     * fixed list of store names rather than the manifest, the second would go
     * unmentioned — so the assertion names the missing file, not the count.
     */
    packageWith(dir,
      [item('findings/aaaaaaaaaaaaaaaa.jsonl', a), item('findings/bbbbbbbbbbbbbbbb.jsonl', b)],
      ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
      [['findings/aaaaaaaaaaaaaaaa.jsonl', a]]);

    const { code, out } = await verify(dir);
    assert.notEqual(code, 0, 'a manifest item missing from the package was not reported');
    assert.match(out, /findings\/bbbbbbbbbbbbbbbb\.jsonl.*ABSENT from the package/,
      'the second packaged file was claimed by the manifest, absent from the package, and checked by nothing');
    assert.match(out, /OK +pkg findings\/aaaaaaaaaaaaaaaa\.jsonl/,
      'the file that IS present was not reported as present, so the absence row above proves nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('THE CREDENTIAL GUARD IS ACTUALLY CALLED, with hostile inputs derived from its own list', async () => {
  /*
   * ═══ THE ONLY TEST OF THE CREDENTIAL GUARD NEVER CALLED IT ═══
   *
   * Blind audit HIGH-3, and it was a proof rather than an inference: the suite
   * had exactly one reference to `assertNothingForbidden` and it was
   * `typeof … === 'function'`, so replacing the function body with `return`
   * left all 3048 tests green. The rest of the old test asserted that
   * `path.relative(home, home + '/config.json')` ends in `config.json` — a
   * tautology about `node:path` — and wrote a fixture nothing read.
   *
   * This is the one surface here that keeps the DPAPI-sealed secretStore, the
   * machineId, the registrations and the override grants out of a portable
   * archive, and it had zero executable coverage.
   *
   * The stated reason — symlink creation needs a privilege — did not hold: the
   * file list is an ARGUMENT, so a fixture list goes straight in. The predicate
   * is now `forbiddenFindings`, pure and exported, and this calls it.
   *
   * Rule 7: the hostile inputs are GENERATED from the real `NEVER` list, so
   * adding an entry extends the coverage without anyone remembering to.
   */
  const { forbiddenFindings, NEVER } = await import('../scripts/migration-package.mjs');

  const home = mk();
  try {
    // A benign carried file, so every refusal below is differenced against it.
    mkdirSync(path.join(home, 'audits'), { recursive: true });
    const benign = path.join(home, 'audits', 'aaaaaaaaaaaaaaaa.jsonl');
    writeFileSync(benign, '{"audit_id":"a"}\n');
    const okFile = { rel: 'audits/aaaaaaaaaaaaaaaa.jsonl', src: benign };

    assert.deepEqual(forbiddenFindings([okFile], home), [],
      'an ordinary carried file was refused, so every refusal below proves nothing');

    /*
     * EVERY never-carry entry, as a file, reached through an allowed-looking
     * name. This is the symlink/hardlink shape with the link step removed: the
     * guard resolves and compares, and what it must notice is the TARGET.
     */
    for (const name of NEVER) {
      const target = path.join(home, name);
      if (!existsSync(target)) writeFileSync(target, 'SECRET');
      if (!statSync(target).isFile()) continue;
      const findings = forbiddenFindings(
        [{ rel: `audits/looks-innocent.jsonl`, src: target }], home,
      );
      assert.equal(findings.length, 1,
        `a source resolving to ${name} was NOT refused — that is a credential leaving the machine in an archive labelled authority history`);
      assert.match(findings[0], new RegExp(name.replace('.', '\\.')),
        `the refusal for ${name} does not name it, so an operator cannot tell what was caught`);
    }

    // Case: Windows opens Config.json, an exact `includes` does not match it.
    assert.equal(
      forbiddenFindings([{ rel: 'audits/x.jsonl', src: path.join(home, 'CONFIG.JSON') }], home).length,
      1,
      'a case variant of config.json walked past the guard');

    // A never-carry name as a MIDDLE component, checked by neither end before.
    mkdirSync(path.join(home, 'nested', 'overrides'), { recursive: true });
    const buried = path.join(home, 'nested', 'overrides', 'grant.json');
    writeFileSync(buried, '{}');
    assert.equal(forbiddenFindings([{ rel: 'audits/x.jsonl', src: buried }], home).length, 1,
      'a never-carry directory in the middle of the path was not noticed');

    // Outside the store entirely.
    const outside = mk();
    try {
      const leak = path.join(outside, 'anything.json');
      writeFileSync(leak, 'SECRET');
      const out = forbiddenFindings([{ rel: 'audits/x.jsonl', src: leak }], home);
      assert.equal(out.length, 1, 'a source outside the AgentBridge home was carried');
      assert.match(out[0], /OUTSIDE/);
    } finally { rmSync(outside, { recursive: true, force: true }); }

    // A directory is not a regular file.
    assert.match(
      forbiddenFindings([{ rel: 'audits/x.jsonl', src: path.join(home, 'audits') }], home)[0] ?? '',
      /regular file/);

    // A `missing` entry is skipped rather than refused — the packager records it.
    assert.deepEqual(forbiddenFindings([{ rel: 'gone.json', src: path.join(home, 'gone.json'), missing: true }], home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('A HARD LINK TO A CREDENTIAL IS REFUSED BY IDENTITY, not by its name', async (t) => {
  /*
   * The shape no name check can see. `realpathSync` — native or not — cannot
   * look through a hard link: it resolves to the LINK's own path, which is a
   * regular file, inside the home, with a perfectly allowed name. Creating one
   * needs no elevation on Windows.
   *
   * So the guard compares device+inode against the never-carry files. This test
   * makes a real hard link; if the platform refuses to create one, it skips
   * rather than passing quietly — a skip is visible, a silent pass is not.
   */
  const { forbiddenFindings } = await import('../scripts/migration-package.mjs');
  const home = mk();
  try {
    writeFileSync(path.join(home, 'config.json'), '{"secretStore":{"scheme":"dpapi-user"}}');
    mkdirSync(path.join(home, 'audits'), { recursive: true });
    const link = path.join(home, 'audits', 'bbbbbbbbbbbbbbbb.jsonl');
    try {
      linkSync(path.join(home, 'config.json'), link);
    } catch (e) {
      t.skip(`this platform would not create a hard link: ${e?.code ?? e?.message}`);
      return;
    }
    /*
     * The premise, asserted rather than assumed: realpath does NOT see through
     * the hard link — it resolves to a different path from the target's, so a
     * name check waves it through. That is the whole reason identity is checked.
     *
     * Two wrong versions of this assertion preceded the right one, both caught,
     * and both are the lesson. The first compared `realpathSync.native(link)` to
     * itself — an assertion that cannot fail, in the file whose subject is
     * hollow gates. The second compared it to the raw `link` string and failed
     * on this machine, because `mkdtemp` hands back an 8.3 short path
     * that `realpathSync.native` expands. That is rule 21 exactly:
     * the value is a property of the machine, not of the thing. So the premise
     * is stated as a RELATION between two resolved paths, which no path spelling
     * can disturb.
     */
    assert.notEqual(realpathSync.native(link), realpathSync.native(path.join(home, 'config.json')),
      'realpath saw through the hard link, so this fixture is not the case being tested');

    const out = forbiddenFindings([{ rel: 'audits/bbbbbbbbbbbbbbbb.jsonl', src: link }], home);
    assert.equal(out.length, 1, 'a hard link to config.json was packaged as authority history');
    assert.match(out[0], /SAME FILE as config\.json/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('A HARD LINK TO A GRANT INSIDE A NEVER-CARRY DIRECTORY IS REFUSED', async (t) => {
  /*
   * ═══ FOUR OF THE SEVEN NEVER-CARRY ENTRIES ARE DIRECTORIES ═══
   *
   * Blind audit HIGH-4. `overrides`, `guard-sessions`, `verify` and `polls` are
   * directories in the live store, so the identity map held four DIRECTORY
   * inodes — and the `isFile()` check rejects directories before the identity
   * comparison runs, making those four entries structurally unreachable.
   *
   * A hard link at `audits/<key>.jsonl` pointing at `overrides/<key>.json`
   * therefore passed every check: resolves to its own path, regular file, inside
   * the home, no never-carry component, inode in nobody's map. An override grant
   * in an archive whose manifest says "Contains NO ... override grants."
   *
   * The previous hard-link test used `config.json` — one of the three entries
   * where the map WAS populated — so it could not have caught this. Rule 9: a
   * fixture that cannot construct the real case cannot fail for it.
   */
  const { forbiddenFindings } = await import('../scripts/migration-package.mjs');
  const home = mk();
  try {
    mkdirSync(path.join(home, 'overrides'), { recursive: true });
    mkdirSync(path.join(home, 'audits'), { recursive: true });
    const grant = path.join(home, 'overrides', 'e09139d77b22755b.json');
    writeFileSync(grant, '{"paths":["*"],"granted_by":"danny"}');

    const link = path.join(home, 'audits', 'cccccccccccccccc.jsonl');
    try { linkSync(grant, link); } catch (e) {
      t.skip(`this platform would not create a hard link: ${e?.code ?? e?.message}`);
      return;
    }

    // Premise: the link is inside the home, named like a payload, and resolves
    // to itself — every string check passes, which is why identity is needed.
    const resolved = realpathSync.native(link);
    assert.ok(!resolved.toLowerCase().includes('overrides'),
      'realpath saw through the hard link, so this fixture is not the case being tested');

    const out = forbiddenFindings([{ rel: 'audits/cccccccccccccccc.jsonl', src: link }], home);
    assert.equal(out.length, 1, 'a hard link to a live override grant was packaged as authority history');
    assert.match(out[0], /names on disk|overrides/,
      'the refusal does not say why, so an operator cannot tell a grant leaked from an ordinary error');

    // Differenced: an ordinary single-named payload beside it must still pass.
    const honest = path.join(home, 'audits', 'dddddddddddddddd.jsonl');
    writeFileSync(honest, '{"audit_id":"a"}\n');
    assert.deepEqual(forbiddenFindings([{ rel: 'audits/dddddddddddddddd.jsonl', src: honest }], home), [],
      'an ordinary store file was refused, so the refusal above proves nothing');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ATTACH RE-VERIFIES THE PACKAGE, and cannot be sent out of it', () => {
  /*
   * `attach()` had ZERO test coverage — blind audit MEDIUM-7 — which is why its
   * manifest-address bug (HIGH-3) survived two commits that fixed the identical
   * mechanism in the verifier. A fix with no test has nothing to stop it
   * regressing, which is the argument its own commit message makes.
   *
   * Run as a child because `attach` exits the process on refusal.
   */
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const run = (dir, extra = []) => spawnSync(process.execPath,
    ['scripts/migration-package.mjs', '--attach', dir, ...extra],
    { cwd: repo, encoding: 'utf8' });

  const dir = mk();
  try {
    const body = '{"x":1}\n';
    packageWith(dir, [item('delegations.json', body)], [], [['delegations.json', body]]);
    writeFileSync(path.join(dir, 'MANIFEST.md'), '# manifest\n');

    const good = run(dir);
    assert.equal(good.status, 0, `an intact package was refused:\n${good.stdout}${good.stderr}`);
    assert.match(good.stdout, /1 file\(s\) re-verified against the manifest, all match/);

    /*
     * The HIGH-3 shape: the manifest names a file outside the package, and the
     * package itself holds nothing. This printed "all match" while hashing the
     * operator's live store.
     */
    const m = JSON.parse(readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
    m.items[0].destination_relative_to_package = '../../../../../../../../.agentbridge/delegations.json';
    writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(m));
    const escaped = run(dir);
    assert.notEqual(escaped.status, 0, 'attach followed the manifest out of the package');
    assert.match(`${escaped.stdout}${escaped.stderr}`, /no longer matches its manifest|Refusing to follow the manifest/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('THE MANIFEST DESCRIBES THE VERIFIER IT ACTUALLY SHIPS WITH', async () => {
  /*
   * The manifest promised that migration-verify "computes the destination key
   * and names the rename". For a kind carrying two files it does the opposite —
   * it refuses, on purpose, because a rename there overwrites one authority file
   * with another. The real package on this machine hits that branch, so an
   * operator reading the old sentence would have read a correct refusal as a
   * broken tool.
   *
   * Differenced: the one-file shape must still get the rename sentence, or
   * "the note warns about ambiguity" would be satisfied by warning always.
   */
  const { storeKeyNote } = await import('../scripts/migration-package.mjs');
  const one = [{ source_relative_to_agentbridge_home: 'findings/aaaaaaaaaaaaaaaa.jsonl' }];
  const two = [...one, { source_relative_to_agentbridge_home: 'findings/bbbbbbbbbbbbbbbb.jsonl' }];

  assert.match(storeKeyNote(one), /names the rename/,
    'the unambiguous shape lost the rename instruction, which is the only thing that stops a silently empty queue');
  assert.doesNotMatch(storeKeyNote(one), /REFUSE/,
    'a package with one file per kind was warned about an ambiguity it does not have');

  assert.match(storeKeyNote(two), /will REFUSE to name a rename/,
    'a package carrying two files under one kind was told the verifier would name a rename — it will not, and following that advice destroys an authority file');
  assert.match(storeKeyNote(two), /findings\/ \(2 files\)/,
    'the note does not name the kind that is ambiguous, so the operator cannot tell which decision is theirs');
});

test('THE NOTE IS CHECKED AGAINST THE VERIFIER, not against a copy of the claim', async () => {
  /*
   * ═══ THE GATE ABOVE RECONSTRUCTS THE CLAIM INSTEAD OF READING IT ═══
   *
   * Hollow gate #2, found by blind audit (MEDIUM-3) in the commit whose whole
   * subject was that the manifest had stopped describing a verifier it does not
   * ship with. The replacement sentence was ALSO false: it said "integrity and
   * resolution are reported separately and still verify normally", and for the
   * ambiguous kind resolution does not verify at all — it was advisory, for
   * exactly the same reason the installation row fails.
   *
   * The test above could never have seen that, because it is a regex over the
   * note and never runs the verifier. So this one builds the shape the note
   * describes, RUNS the verifier on it, and checks the rows agree with the
   * sentence. Derive the claim from the artefact.
   */
  const { storeKeyNote } = await import('../scripts/migration-package.mjs');
  const { repoStorePath } = await import('../src/guardSession.mjs');
  const a = '{"finding_id":"x"}\n';
  const b = '{"finding_id":"y"}\n';
  const dir = mk();
  const home = mk();
  try {
    const items = [item('findings/aaaaaaaaaaaaaaaa.jsonl', a), item('findings/bbbbbbbbbbbbbbbb.jsonl', b)];
    packageWith(dir, items, ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
      [['findings/aaaaaaaaaaaaaaaa.jsonl', a], ['findings/bbbbbbbbbbbbbbbb.jsonl', b]]);

    /*
     * THROUGH A CHILD WITH A FIXTURE HOME, not the in-process helper — this test
     * asserts on a `resolve` row, and the header of this file says those go
     * through `verifyChild` because the in-process reader opens the OPERATOR'S
     * live store. Flagged by blind audit LOW-10: it was robust here only by
     * accident of the fixture, which is exactly how the 26-row measurement got
     * into a fixture two commits ago.
     *
     * The destination key is DERIVED from the shipped resolver, so the fixture
     * store is where the verifier will actually look rather than where this
     * machine happens to put it.
     */
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const key = path.basename(repoStorePath(repo, 'findings', '.jsonl'));
    mkdirSync(path.join(home, 'findings'), { recursive: true });
    writeFileSync(path.join(home, 'findings', key), a);

    const note = storeKeyNote(items);
    const { out } = verifyChild(dir, home);

    assert.match(note, /INSTALLATION and the RESOLUTION row for that kind report FAILED/,
      'the note no longer states what the verifier does with this shape');
    assert.match(out, /FAIL +install findings\//, 'the note claims installation FAILS here and it did not');
    assert.match(out, /FAIL +resolve finding registry/,
      'the note claims the resolution row FAILS here and it did not — that is the sentence being wrong again');

    assert.match(note, /INTEGRITY still verifies normally/);
    assert.match(out, /integrity OK/, 'the note claims integrity still verifies and it did not');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('THE PASS PATH EXISTS: a well-formed, installed package reaches exit 0', () => {
  /*
   * ═══ THE EXIT-0 PATH HAD NEVER BEEN WATCHED SUCCEEDING ═══
   *
   * Blind audit LOW-1, and it is the reason HIGH-1 and HIGH-2 were both
   * reachable: this file held four `notEqual(code, 0)` and not one `equal`, and
   * no assertion on any phase-3 row at all. Every test proved the gate could say
   * no. Nothing proved it could say yes for the right reasons — so two ways of
   * getting a WRONG yes sat there unnoticed.
   *
   * Rule 5: the negative needs the positive first. This is the positive, and it
   * is what makes every refusal in this file mean something.
   *
   * It runs the verifier as a CHILD with AGENTBRIDGE_HOME pointed at a fixture,
   * because the store root is a module constant read at import. Nothing here
   * touches the operator's store — which is also why the keyed stores are left
   * out: their destination key is a fact about the real repository path, and
   * phase 3 reads them through consumers this fixture cannot redirect per-call.
   */
  const rows = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i })));
  const payloads = [
    ['delegations.json', rows(3), 3],
    ['leadWork.json', rows(2), 2],
    ['tokenMeasurements.json', rows(5), 5],
    ['escalations.json', rows(1), 1],
  ];

  const pkg = mk();
  const home = mk();
  try {
    packageWith(pkg,
      payloads.map(([rel, body, n]) => ({ ...item(rel, body), records: n })), [],
      payloads.map(([rel, body]) => [rel, body]));
    for (const [rel, body] of payloads) writeFileSync(path.join(home, rel), body);

    const good = verifyChild(pkg, home);
    assert.equal(good.code, 0,
      `a correct, installed package did not pass. The gate can refuse but cannot accept:\n${good.out}`);
    /*
     * THE BANNER NAMES WHAT IT ACTUALLY RESOLVED. It used to say, unqualified,
     * "REACHABLE THROUGH ITS REAL READERS" with five of six resolution rows
     * advisory (blind audit MEDIUM-6). This fixture carries four stores and
     * declares two absent, so the banner must say four and two — a package that
     * resolved one store cannot read like a package that resolved six.
     */
    assert.match(good.out, /PACKAGE INTACT AND INSTALLED\. 4 store\(s\) read back through their real consumers; 2 carried nothing to verify\./,
      'the banner does not report how much it actually resolved');
    assert.match(good.out, /OK +resolve delegations +resolved 3, matches manifest/,
      'phase 3 did not actually compare a count — an exit 0 with every resolution row advisory is the HIGH-2 shape');
    assert.match(good.out, /OK +manifest completeness/);

    /*
     * Differenced at the far end (rule 4): change the INSTALLED bytes, not the
     * package, so phase 1 still passes and only phase 2 moves. An exit code that
     * never changes would mean the 0 above was not earned.
     */
    writeFileSync(path.join(home, 'leadWork.json'), rows(2).replace('0', '9'));
    const drifted = verifyChild(pkg, home);
    assert.notEqual(drifted.code, 0, 'the installed copy differed from the package and it still passed');
    assert.match(drifted.out, /FAIL +install leadWork\.json/);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('THE INCLUDE LIST CARRIES NOTHING FROM THE NEVER LIST', async () => {
  /*
   * Rule 7: generated from the real lists, so adding an item to either extends
   * the coverage without anyone remembering to.
   */
  const { ITEMS, NEVER } = await import('../scripts/migration-package.mjs');
  for (const it of ITEMS) {
    const name = it.file ?? it.from;
    assert.ok(!NEVER.includes(name),
      `${name} is on both the include and the never-carry list`);
  }
  for (const secret of ['config.json', 'registry.json', 'registrations.json', 'overrides']) {
    assert.ok(NEVER.includes(secret), `${secret} fell off the never-carry list`);
  }
});
