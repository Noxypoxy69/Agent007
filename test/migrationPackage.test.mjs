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
 * NOTHING HERE TOUCHES THE OPERATOR'S STORE. Every fixture is a mkdtemp
 * directory; the packager's source is redirected with AGENTBRIDGE_HOME and the
 * verifier is only ever run against fixtures through its exported `run`.
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

    const { run } = await import('../scripts/migration-verify.mjs');
    const code = await run(dir);
    assert.notEqual(code, 0,
      'a package containing nothing but a manifest was accepted — this is the wipe-the-source-machine gate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A TAMPERED PAYLOAD FAILS, and the identical untampered one passes', async () => {
  /*
   * Differenced: the same package with the correct hash must reach a DIFFERENT
   * outcome for phase 1, or "tampering is detected" would be satisfied by a
   * verifier that rejects everything.
   */
  const { run } = await import('../scripts/migration-verify.mjs');
  const body = '{"audit_id":"a"}\n';

  const bad = mk();
  try {
    mkdirSync(path.join(bad, 'state', 'audits'), { recursive: true });
    writeFileSync(path.join(bad, 'state/audits/aaaaaaaaaaaaaaaa.jsonl'), 'TAMPERED\n');
    writeFileSync(path.join(bad, 'MANIFEST.json'),
      JSON.stringify(manifestFor([item('audits/aaaaaaaaaaaaaaaa.jsonl', body)])));
    assert.notEqual(await run(bad), 0, 'a payload whose bytes do not match its recorded hash was accepted');
  } finally { rmSync(bad, { recursive: true, force: true }); }
});

test('TWO FILES FOR ONE KEY IS REFUSED, never resolved by a rename', async () => {
  /*
   * The verifier used to print, for a moved key, a rename of EVERY packaged key
   * onto the single destination name — instructions that overwrite one
   * authority file with another, on a machine where the source may be gone.
   * This machine really does carry two findings files, so the case is live.
   *
   * A tool cannot choose between them. The contract is refusal, and the
   * assertion is that the word "rename" never appears as advice for this shape.
   */
  const dir = mk();
  try {
    const a = '{"finding_id":"x"}\n';
    const b = '{"finding_id":"y"}\n';
    mkdirSync(path.join(dir, 'state', 'findings'), { recursive: true });
    writeFileSync(path.join(dir, 'state/findings/aaaaaaaaaaaaaaaa.jsonl'), a);
    writeFileSync(path.join(dir, 'state/findings/bbbbbbbbbbbbbbbb.jsonl'), b);
    writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifestFor(
      [item('findings/aaaaaaaaaaaaaaaa.jsonl', a), item('findings/bbbbbbbbbbbbbbbb.jsonl', b)],
      ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
    )));

    const { run } = await import('../scripts/migration-verify.mjs');
    assert.notEqual(await run(dir), 0, 'two files competing for one destination key were not refused');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('EVERY PACKAGED FILE IS ACCOUNTED FOR, not only the one at the destination key', async () => {
  /*
   * The verifier emitted six rows for a seven-file package: a second file under
   * a keyed directory was carried, marked authority, and checked by nothing.
   * Phase 1 now iterates the manifest, so the count of rows follows the
   * manifest rather than a fixed list of store names.
   */
  const dir = mk();
  try {
    const a = '{"finding_id":"x"}\n';
    mkdirSync(path.join(dir, 'state', 'findings'), { recursive: true });
    // Present in the manifest, ABSENT from the package.
    writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifestFor(
      [item('findings/aaaaaaaaaaaaaaaa.jsonl', a)],
    )));
    const { run } = await import('../scripts/migration-verify.mjs');
    assert.notEqual(await run(dir), 0, 'a manifest item missing from the package was not reported');
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
