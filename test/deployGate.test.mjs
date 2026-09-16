/*
 * THE DEPLOY GATE, AND EVERY REFUSAL IT MAKES.
 *
 * A gate that only permits is decoration and a gate that only refuses is an
 * outage, so every refusal below has a partner proving the correct deploy still
 * goes through. Three of these exist because code-b read the first draft and
 * supplied a counterexample for each; those are marked, because a test whose
 * reason is lost gets deleted by the next person who finds it inconvenient.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEPLOY_GATE_VERSION,
  artifactDigest,
  assertPromotable,
  normalise,
  recordDeployment,
  verifyLive,
} from '../src/deployGate.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);

/** A deploy that should be allowed. Each test breaks exactly one thing. */
const clean = (over = {}) => ({
  dirtyPaths: [],
  headSha: SHA,
  releaseRef: 'origin/master',
  headIsAncestorOfRelease: true,
  artifactFileCount: 3,
  artifactLoads: true,
  liveDrift: { ok: true, problems: [] },
  ...over,
});

test('a promoted, clean, loading artifact deploys', () => {
  const r = assertPromotable(clean());
  assert.equal(r.ok, true, r.refusals.map((x) => x.reason).join(', '));
});

/* ── the working tree that shipped ───────────────────────────────────── */

test('a dirty tree is refused: the deploy ships the working tree', () => {
  const r = assertPromotable(clean({ dirtyPaths: ['supabase/functions/mcp/index.ts'] }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => x.reason === 'dirty-tree'));
});

/* ── code-b: pushed is not promoted ──────────────────────────────────── */

test('PUSHED IS NOT PROMOTED: a commit not on the protected branch is refused', () => {
  /*
   * code-b's counterexample from their own work: code-b/splice-ratio is pushed,
   * exists on a remote ref, is unreviewed and not on master. The first draft
   * asked "is this sha on the remote" and passed it.
   */
  const r = assertPromotable(clean({ headIsAncestorOfRelease: false }));
  assert.equal(r.ok, false);
  const refusal = r.refusals.find((x) => x.reason === 'head-not-promoted');
  assert.ok(refusal, 'an unmerged branch must not deploy');
  assert.match(refusal.detail, /Pushed is not promoted/);
});

test('UNCHECKED IS NOT CLEAN: ancestry not asked is a refusal, not a pass', () => {
  const r = assertPromotable(clean({ headIsAncestorOfRelease: null }));
  assert.equal(r.ok, false);
  assert.match(
    r.refusals.find((x) => x.reason === 'head-not-promoted').detail,
    /was not checked/,
    'an optional check is a skipped check',
  );
});

/* ── code-b: nothing proved it LOADS ─────────────────────────────────── */

test('AN ARTIFACT THAT DOES NOT PARSE IS REFUSED, which no other step sees', () => {
  /*
   * f04426d: "I took the Bridge down with a duplicate const, and no check I had
   * could see it". A digest proves the bytes, the control plane proves they
   * arrived, and neither proves the module starts.
   */
  const r = assertPromotable(clean({ artifactLoads: false }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => x.reason === 'artifact-does-not-load'));
});

test('an artifact never parsed is refused too', () => {
  const r = assertPromotable(clean({ artifactLoads: null }));
  assert.equal(r.ok, false);
  assert.match(
    r.refusals.find((x) => x.reason === 'artifact-does-not-load').detail,
    /never parsed/,
  );
});

/* ── code-b: the read-back compares to the previous read-back ────────── */

test('A HAND-DEPLOY SINCE LAST TIME IS REFUSED before we overwrite it', () => {
  const r = assertPromotable(clean({ liveDrift: { ok: false, problems: ['live artifact differs'] } }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => x.reason === 'live-artifact-drifted'));
});

test('a first deploy with nothing recorded is NOT drift', () => {
  const r = assertPromotable(clean({ liveDrift: null }));
  assert.equal(r.ok, true, 'having no previous record is honest, not a failure');
});

/* ── an empty deploy replaces a working function with nothing ────────── */

test('an empty artifact is refused', () => {
  const r = assertPromotable(clean({ artifactFileCount: 0 }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => x.reason === 'no-artifact-files'));
});

test('every refusal is reported at once, not one at a time', () => {
  const r = assertPromotable({
    dirtyPaths: ['a.ts'],
    headSha: SHA,
    headIsAncestorOfRelease: false,
    artifactFileCount: 0,
    artifactLoads: false,
    liveDrift: { ok: false, problems: ['x'] },
  });
  assert.equal(r.refusals.length, 5, 'a caller can usually fix one and needs to know all of them');
});

/* ── the digest, and the line endings that would have switched it off ── */

test('LINE ENDINGS DO NOT CHANGE THE DIGEST', () => {
  const lf = [{ path: 'index.ts', content: 'const a = 1;\nconst b = 2;\n' }];
  const crlf = [{ path: 'index.ts', content: 'const a = 1;\r\nconst b = 2;\r\n' }];
  assert.equal(
    artifactDigest(lf),
    artifactDigest(crlf),
    'the deployed copy is CRLF and master is LF; an 1812-line file would read as a total rewrite',
  );
});

test('but real content changes DO change the digest', () => {
  const a = [{ path: 'index.ts', content: 'const a = 1;\n' }];
  const b = [{ path: 'index.ts', content: 'const a = 2;\n' }];
  assert.notEqual(artifactDigest(a), artifactDigest(b));
});

test('renaming a file changes the digest', () => {
  const a = [{ path: 'one.ts', content: 'x' }, { path: 'two.ts', content: 'y' }];
  const b = [{ path: 'one.ts', content: 'y' }, { path: 'two.ts', content: 'x' }];
  assert.notEqual(artifactDigest(a), artifactDigest(b), 'two files must not be able to swap names');
});

test('file order does not change the digest', () => {
  const a = [{ path: 'b.ts', content: '2' }, { path: 'a.ts', content: '1' }];
  const b = [{ path: 'a.ts', content: '1' }, { path: 'b.ts', content: '2' }];
  assert.equal(artifactDigest(a), artifactDigest(b));
});

test('digesting nothing is refused rather than returning a hash of emptiness', () => {
  assert.throws(() => artifactDigest([]), /refusing to digest an empty deploy/);
});

test('normalise collapses CR and CRLF but leaves inner whitespace alone', () => {
  assert.equal(normalise('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(normalise('a  b\n'), 'a  b\n', 'whitespace inside a line is real content');
});

/* ── the record, and what it refuses to record ───────────────────────── */

test('a deployment records the source digest and the far end together', () => {
  const rec = recordDeployment({
    headSha: SHA,
    sourceDigest: DIGEST,
    liveArtifactHash: 'e82b1266',
    liveVersion: 20,
    deployedAt: '2026-09-16T09:00:00.000Z',
  });
  assert.equal(rec.schemaVersion, DEPLOY_GATE_VERSION);
  assert.equal(rec.liveVersion, 20);
});

test('A DEPLOY NOBODY READ BACK IS NOT VERIFIED and cannot be recorded', () => {
  assert.throws(
    () =>
      recordDeployment({
        headSha: SHA,
        sourceDigest: DIGEST,
        liveArtifactHash: '',
        liveVersion: 20,
        deployedAt: '2026-09-16T09:00:00.000Z',
      }),
    /a deploy nobody read back is not verified/,
    'defaulting this would record the success and lose the doubt',
  );
});

/* ── verifyLive: the comparison that IS valid ────────────────────────── */

test('live matching the record passes', () => {
  const rec = recordDeployment({
    headSha: SHA, sourceDigest: DIGEST, liveArtifactHash: 'abc', liveVersion: 20,
    deployedAt: '2026-09-16T09:00:00.000Z',
  });
  assert.equal(verifyLive({ recorded: rec, live: { artifactHash: 'abc', version: 20 } }).ok, true);
});

test('a different live artifact is drift, not a pass', () => {
  const rec = recordDeployment({
    headSha: SHA, sourceDigest: DIGEST, liveArtifactHash: 'abc', liveVersion: 20,
    deployedAt: '2026-09-16T09:00:00.000Z',
  });
  const out = verifyLive({ recorded: rec, live: { artifactHash: 'zzz', version: 20 } });
  assert.equal(out.ok, false);
  assert.match(out.problems[0], /deployed from outside this path/);
});

test('a newer live version is a deploy this ledger did not see', () => {
  const rec = recordDeployment({
    headSha: SHA, sourceDigest: DIGEST, liveArtifactHash: 'abc', liveVersion: 20,
    deployedAt: '2026-09-16T09:00:00.000Z',
  });
  const out = verifyLive({ recorded: rec, live: { artifactHash: 'abc', version: 21 } });
  assert.equal(out.ok, false);
  assert.match(out.problems[0], /did not see/);
});
