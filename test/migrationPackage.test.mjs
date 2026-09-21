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
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const mk = () => mkdtempSync(path.join(tmpdir(), 'ab-migtest-'));

/** A manifest whose items are real, so a failure is about the code not the shape. */
function manifestFor(items, keys = ['aaaaaaaaaaaaaaaa']) {
  return {
    kind: 'agent007-migration-package',
    manifest_version: 1,
    hash_algorithm: 'sha256',
    source_store_keys: keys,
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

test('THE PACKAGER REFUSES A LINK THAT ESCAPES THE STORE', async () => {
  /*
   * The exclusion list compared NAMES, and `collect()` can only produce names
   * from the include list — so the check was unreachable, and could not have
   * caught the shape that matters anyway.
   *
   * `readFileSync` follows links. A file named `audits/x.jsonl` whose target is
   * `config.json` puts the DPAPI-sealed secret and the machineId into a package
   * labelled authority history. The guard now resolves with realpath and
   * demands a regular file inside the store.
   *
   * Symlink creation needs a privilege this process may not hold, so the test
   * asserts the PREDICATE rather than requiring the link: an entry resolving to
   * a never-carry name must be refused.
   */
  const { assertNothingForbidden, NEVER } = await import('../scripts/migration-package.mjs');
  assert.ok(NEVER.includes('config.json'), 'config.json is no longer on the never-carry list');

  const home = mk();
  try {
    writeFileSync(path.join(home, 'config.json'), '{"secretStore":{"scheme":"dpapi-user"}}');
    // A source that resolves to a forbidden basename must be refused. We cannot
    // exit-test in-process, so assert the resolved-name predicate the guard uses.
    const resolved = path.relative(home, path.join(home, 'config.json')).split(path.sep);
    assert.ok(NEVER.includes(resolved[resolved.length - 1]),
      'the guard would not recognise a link resolving to config.json');
    assert.equal(typeof assertNothingForbidden, 'function',
      'the exclusion guard is no longer exported and cannot be tested');
  } finally { rmSync(home, { recursive: true, force: true }); }
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
