import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as envelope from '../src/run2Envelope.mjs';
/*
 * A NAMESPACE IMPORT, so a revision that lacks an export fails the tests that
 * use it BY NAME instead of failing the whole file to load. A named import of
 * a missing export is a SyntaxError at link time: every test in the file then
 * reads as one anonymous failure, which is a red with no assertion behind it.
 */
const {
  compileEnvelope, serializeEnvelope, TRUST, FIELD_IDS, HISTORY_MARKER, ENVELOPE_VERSION,
  TASK_FRESH_MS, JUDGED_SOURCES,
} = envelope;
const ANCHOR_KINDS = envelope.ANCHOR_KINDS ?? [];
import { STALE_AFTER_MS } from '../src/liveRegistry.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * RUN 2 ENVELOPE -- RUN2-ENVELOPE-SPEC.md section 7, the four directions.
 *
 * "A trust_state that has never been observed to change is not a
 * classification." Every test below that asserts a non-TRUSTED field first
 * asserts that the SAME observation, minus the one defect, is TRUSTED -- so a
 * compiler that prints constants fails here rather than passing everything.
 *
 * All observations are synthetic. Nothing here reads the task store, the
 * roster, the candidates directory or a real repository.
 */

const T = '2026-09-23T20:00:00.000Z';
const ago = (ms) => new Date(Date.parse(T) - ms).toISOString();
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);

/* A manifest in the real file's shape: both digest spellings, and a NOT-copied
 * section whose lines carry a digest and a path but pin nothing. */
const MANIFEST = [
  'PRESERVED CANDIDATES -- 2026-09-23T08:21:38.121Z',
  '======================================================================',
  'OK        T-001  LANDED abc1234',
  `          ${D1}  100 B`,
  '          from C:\\scratch\\T-001.patch',
  '          to   C:\\Users\\x\\.agentbridge\\preserved\\candidates\\T-001-111111111111.patch',
  '',
  '4 other .patch files found and NOT copied (unrecognised digests):',
  `    ${'9'.repeat(64)}  C:\\scratch\\stray.patch`,
  '',
  'OK        T-002  UNVERIFIED',
  `          sha256 ${D2}`,
  '          from C:/scratch/T-002.patch',
  '          to   C:/Users/x/.agentbridge/preserved/candidates/T-002-222222222222.patch',
  '',
].join('\n');

/*
 * manifest_sha256 is BOUND to manifest_text (T-179 F5): it must be the digest
 * of the text's UTF-8 bytes. Every test that rewrites the manifest goes through
 * setManifest, so a test meant to fail on the manifest's CONTENT cannot pass
 * because the digest no longer matches (a green for the wrong reason).
 */
const sha256Of = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
function setManifest(obs, text) {
  obs.protected.manifest_text = text;
  obs.protected.manifest_sha256 = typeof text === 'string' ? sha256Of(text) : null;
  return obs;
}

/** Every computable field TRUSTED. Each test breaks exactly one thing. */
function healthy() {
  return {
    generated_at: T,
    tasks: {
      ok: true, observed_at: T, source_identity: 'list_tasks @ fixture',
      rows: [
        { task_id: 't-b', state: 'runnable', updated_at: ago(60_000) },
        { task_id: 't-a', state: 'assigned', updated_at: ago(120_000), assigned_agent: 'w1',
          assigned_session: 's1', lease_expires_at: ago(-600_000), base_sha: HEAD },
        { task_id: 't-old-done', state: 'accepted', updated_at: ago(30 * 86400_000) },
      ],
    },
    baseline: {
      ok: true, observed_at: T, source_identity: 'git fixture', repo_id: 'Agent007',
      head: HEAD, tree: TREE, status: [], drift: [],
      index_flags: 'H CLAUDE.md\nH src/a.mjs\nH test/a.test.mjs\n',
    },
    protected: {
      ok: true, observed_at: T, source_identity: 'fixture',
      protected_paths: ['CLAUDE.md', '.claude/'],
      manifest_text: MANIFEST, manifest_sha256: sha256Of(MANIFEST),
      patches: [
        { file: 'T-002-222222222222.patch', sha256: D2, bytes: 200 },
        { file: 'T-001-111111111111.patch', sha256: D1, bytes: 100 },
      ],
    },
    roster: {
      ok: true, observed_at: T, source_identity: 'list_agents @ fixture',
      rows: [
        { agentId: 'w2', sessionId: 's2', capacity: 'idle', lastSeenAt: ago(30_000) },
        { agentId: 'w1', sessionId: 's1', capacity: 'busy', lastSeenAt: ago(60_000) },
        { agentId: 'gone', sessionId: 's-old', capacity: 'offline', lastSeenAt: ago(2 * 86400_000) },
      ],
    },
    runtime: {
      ok: true, observed_at: T, source_identity: 'registrations fixture',
      rows: [
        { agent_id: 'w1', session_id: 's1', capacity: 'busy', heartbeat_at: ago(50_000) },
        { agent_id: 'w2', session_id: 's2', capacity: 'idle', heartbeat_at: ago(20_000) },
      ],
    },
    // AMENDMENT 2: synthetic completeness markers, from sources that are
    // neither the task store, the roster, nor registrations.json.
    anchors: {
      assignment: { ok: true, kind: 'owner-signed-record', source: 'fixture-dispatch-ledger', source_identity: 'fixture anchor A', observed_at: T, current: ['t-a', 't-b'] },
      liveness: { ok: true, kind: 'remote-write-once-record', source: 'fixture-session-list', source_identity: 'fixture anchor L', observed_at: T, live_sessions: ['s1', 's2'] },
    },
  };
}

const f = (obs, id) => compileEnvelope(obs).fields[id];

function assertNotTrusted(fld, why) {
  assert.notEqual(fld.trust_state, TRUST.TRUSTED, `${fld.field_id} stayed TRUSTED: ${why}`);
  assert.equal(fld.value, null, `${fld.field_id} is not TRUSTED but still carries a value`);
  assert.equal(typeof fld.reason, 'string');
  assert.ok(fld.reason.length > 0, `${fld.field_id} is not TRUSTED and gives no reason`);
}

/* ── the positive control every negative below depends on ──────────────── */

test('POSITIVE CONTROL: the healthy fixture makes fields 2, 3, 4, 6 and 7 TRUSTED', () => {
  const env = compileEnvelope(healthy());
  for (const id of ['assignment_candidate', 'baseline', 'protected_frozen', 'channel_liveness', 'history_marker']) {
    assert.equal(env.fields[id].trust_state, TRUST.TRUSTED, `${id}: ${env.fields[id].reason}`);
    assert.notEqual(env.fields[id].value, null, `${id} TRUSTED with no value`);
  }
  assert.equal(env.fields.baseline.value.components.head.value, HEAD);
  assert.deepEqual(env.fields.assignment_candidate.value.open_work.map((r) => r.task_id), ['t-a', 't-b'],
    'closed work must not appear as open work');
  assert.deepEqual(env.fields.protected_frozen.value.candidates.map((c) => c.sha256), [D1, D2]);
  assert.deepEqual(env.fields.channel_liveness.value.live_worker_topology.map((r) => r.session_id), ['s1', 's2'],
    'the offline roster row must not be reported as live topology');
  assert.equal(env.fields.history_marker.value, HISTORY_MARKER);
});

test('every field carries exactly the seven attributes of section 2, and a legal trust_state', () => {
  const keys = ['field_id', 'value', 'source', 'source_identity', 'observed_at', 'trust_state', 'reason'];
  for (const obs of [healthy(), { generated_at: T }]) {
    const env = compileEnvelope(obs);
    assert.equal(env.envelope_version, ENVELOPE_VERSION);
    assert.deepEqual(Object.keys(env.fields), [...FIELD_IDS]);
    for (const id of FIELD_IDS) {
      assert.deepEqual(Object.keys(env.fields[id]), keys, `${id} attribute set`);
      assert.equal(env.fields[id].field_id, id);
      assert.ok(Object.values(TRUST).includes(env.fields[id].trust_state), `${id}: ${env.fields[id].trust_state}`);
    }
  }
});

/* ── DIRECTION 1: TRUSTED -> not TRUSTED ───────────────────────────────── */

/*
 * FIELD 3's BREAKAGE LIST, WRITTEN ONCE. Every field-3 negative below --
 * direction 1, the §7.1 guard, and "a dirty tree nulls nothing in identity" --
 * is GENERATED from this table, so a case added here extends all of them.
 * Each entry names the component it must make untrusted.
 */
const HIDDEN = [
  ['h src/a.mjs', 'assume-unchanged'],
  ['S docs/notes.md', 'skip-worktree'],
  ['s docs/notes.md', 'assume-unchanged+skip-worktree'],
];
const FIELD3_BREAKS = {
  // cleanliness: porcelain entries, untracked INCLUDED (Amendment 1 does not relax this)
  'untracked ?? Microsoft/': ['cleanliness', (o) => { o.baseline.status = ['?? Microsoft/']; }],
  'modified src/a.mjs': ['cleanliness', (o) => { o.baseline.status = [' M src/a.mjs']; }],
  'deleted test': ['cleanliness', (o) => { o.baseline.status = ['D  test/x.test.mjs']; }],
  ...Object.fromEntries(HIDDEN.map(([line]) => [`hidden ${line}`, ['cleanliness', (o) => { o.baseline.index_flags = `H CLAUDE.md\n${line}\nH test/a.test.mjs\n`; }]])),
  'status unread': ['cleanliness', (o) => { o.baseline.status = null; }],
  'index flags unread': ['cleanliness', (o) => { delete o.baseline.index_flags; }],
  // drift: the shipped query's own verdict
  'drift present': ['drift', (o) => { o.baseline.drift = [{ file: 'CLAUDE.md', now: 'assume-unchanged', kind: 'protected' }]; }],
  // null is "could not measure": unknown, never clean
  'drift unmeasured': ['drift', (o) => { o.baseline.drift = null; }],
  // identity
  'no HEAD': ['head', (o) => { o.baseline.head = null; o.baseline.tree = null; o.baseline.details = { head: 'git could not answer: unknown revision HEAD' }; }],
  'no tree': ['tree', (o) => { o.baseline.tree = null; }],
  'no repo identity': ['repo_identity', (o) => { o.baseline.repo_id = null; }],
  // HOSTILE (rule 9): git reported failure, yet the observation still carries
  // well-formed identity values. Only `ok` can stop them being trusted.
  'git failed': ['head', (o) => {
    o.baseline = { ok: false, detail: 'not a git repository', observed_at: T, repo_id: 'Agent007', head: HEAD, tree: TREE, status: [], index_flags: '', drift: [] };
  }],
  'no observation': ['head', (o) => { delete o.baseline; }],
};
const IDENTITY = ['repo_identity', 'head', 'tree'];
const comp = (fld, k) => fld.value.components[k];

test('D1 / §7.1 field 3: EVERY case in the breakage list stops the FIELD being TRUSTED (generated)', () => {
  const good = f(healthy(), 'baseline');
  assert.equal(good.trust_state, TRUST.TRUSTED, good.reason);
  assert.ok(Object.keys(FIELD3_BREAKS).length >= 15, 'the breakage list shrank');
  for (const [name, [component, breakIt]] of Object.entries(FIELD3_BREAKS)) {
    const obs = healthy();
    breakIt(obs);
    const fld = f(obs, 'baseline');
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, `${name}: field-level TRUSTED`);
    assert.equal(comp(fld, component).trust_state, TRUST.UNTRUSTWORTHY, `${name}: ${component} stayed TRUSTED`);
    assert.equal(comp(fld, component).value, null, `${name}: ${component} is untrusted but keeps a value`);
    assert.ok(comp(fld, component).reason, `${name}: ${component} gives no reason`);
    assert.match(fld.reason, new RegExp(`${component}: `), `${name}: the field reason does not name ${component}`);
  }
});

test('A1 untracked only: identity TRUSTED and populated, cleanliness names the entry, field not TRUSTED', () => {
  const obs = healthy();
  obs.baseline.status = ['?? Microsoft/'];
  const fld = f(obs, 'baseline');
  assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY);
  assert.deepEqual(IDENTITY.map((k) => [k, comp(fld, k).trust_state, comp(fld, k).value]),
    [['repo_identity', TRUST.TRUSTED, 'Agent007'], ['head', TRUST.TRUSTED, HEAD], ['tree', TRUST.TRUSTED, TREE]]);
  assert.equal(comp(fld, 'cleanliness').trust_state, TRUST.UNTRUSTWORTHY);
  assert.match(comp(fld, 'cleanliness').reason, /\?\? Microsoft\//);
  assert.equal(comp(fld, 'drift').trust_state, TRUST.TRUSTED, 'drift and cleanliness are separate components');
});

test('A1 no HEAD on a CLEAN porcelain: HEAD and tree are null and not TRUSTED, field not TRUSTED', () => {
  const obs = healthy();
  FIELD3_BREAKS['no HEAD'][1](obs);
  const fld = f(obs, 'baseline');
  assert.equal(comp(fld, 'cleanliness').trust_state, TRUST.TRUSTED, 'precondition: the porcelain is clean');
  for (const k of ['head', 'tree']) {
    assert.equal(comp(fld, k).trust_state, TRUST.UNTRUSTWORTHY, k);
    assert.equal(comp(fld, k).value, null, `${k} kept a value git never established`);
  }
  assert.match(comp(fld, 'head').reason, /unknown revision HEAD/);
  assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY);
});

test('A1 identity is null whenever git itself failed', () => {
  for (const name of ['git failed', 'no observation']) {
    const obs = healthy();
    obs.baseline.status = ['?? x'];
    FIELD3_BREAKS[name][1](obs);
    const fld = f(obs, 'baseline');
    for (const k of [...IDENTITY, 'cleanliness', 'drift']) {
      assert.equal(comp(fld, k).trust_state, TRUST.UNTRUSTWORTHY, `${name}: ${k}`);
      assert.equal(comp(fld, k).value, null, `${name}: ${k} kept a value`);
    }
  }
});

test('A1 clean and established: every component TRUSTED, and the field', () => {
  const fld = f(healthy(), 'baseline');
  assert.equal(fld.trust_state, TRUST.TRUSTED);
  for (const k of ['repo_identity', 'head', 'tree', 'cleanliness', 'drift']) {
    assert.equal(comp(fld, k).trust_state, TRUST.TRUSTED, k);
    assert.notEqual(comp(fld, k).value, null, k);
  }
});

test('A1 a dirty, hidden or drifting tree nulls NOTHING in identity (generated)', () => {
  const cases = Object.entries(FIELD3_BREAKS).filter(([, [c]]) => c === 'cleanliness' || c === 'drift');
  assert.ok(cases.length >= 9);
  for (const [name, [, breakIt]] of cases) {
    const obs = healthy();
    breakIt(obs);
    const fld = f(obs, 'baseline');
    for (const k of IDENTITY) {
      assert.equal(comp(fld, k).trust_state, TRUST.TRUSTED, `${name} dragged ${k} down`);
      assert.notEqual(comp(fld, k).value, null, `${name} nulled ${k}`);
    }
  }
});

test('F3 field 3: a file hidden by assume-unchanged or skip-worktree ANYWHERE is not clean', () => {
  // Not protected, not a test: the paths the shipped drift query never looks at.
  for (const [line, how] of HIDDEN) {
    const obs = healthy();
    obs.baseline.index_flags = `H CLAUDE.md\n${line}\nH test/a.test.mjs\n`;
    const fld = f(obs, 'baseline');
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, line);
    assert.match(fld.reason, new RegExp(`hidden from status: ${line.slice(2)} ${how.replace('+', '\\+')}`));
  }
});

test('field 3 reports EVERY problem, so drift is named even when status also sees the file', () => {
  const obs = healthy();
  obs.baseline.status = [' M CLAUDE.md'];
  obs.baseline.drift = [{ file: 'CLAUDE.md', now: 'M', kind: 'protected' }];
  const fld = f(obs, 'baseline');
  assert.match(fld.reason, /not clean/);
  assert.match(fld.reason, /baseline drift: CLAUDE\.md M protected/);
});

test('D1 field 4: a MISSING manifest stops being TRUSTED', () => {
  assert.equal(f(healthy(), 'protected_frozen').trust_state, TRUST.TRUSTED);
  const obs = healthy();
  obs.protected.manifest_text = null;
  const fld = f(obs, 'protected_frozen');
  assertNotTrusted(fld, 'manifest missing');
  assert.equal(fld.trust_state, TRUST.ABSENT);
  assert.match(fld.reason, /MANIFEST\.txt is missing/);

  // With NO candidates either, nothing disagrees -- the manifest's absence must
  // still be what stops it, not a side effect of unlisted patches.
  const empty = healthy();
  empty.protected.manifest_text = null;
  empty.protected.patches = [];
  assertNotTrusted(f(empty, 'protected_frozen'), 'manifest missing, candidates empty');

  // D03: with no candidates/ directory at all (patches:null) it is still ABSENT.
  const noDir = healthy();
  noDir.protected.manifest_text = null;
  noDir.protected.patches = null;
  assert.equal(f(noDir, 'protected_frozen').trust_state, TRUST.ABSENT);
});

test('D1 field 4: a manifest that disagrees with candidates/ stops being TRUSTED', () => {
  const cases = {
    'digest changed': (o) => { o.protected.patches[1].sha256 = 'f'.repeat(64); },
    // Same 12-hex name prefix, different body: only the full-digest comparison
    // can see it. A changed prefix would be caught by the name check instead.
    'digest changed past the name prefix': (o) => { o.protected.patches[1].sha256 = `${D1.slice(0, 63)}0`; },
    'unlisted patch': (o) => { o.protected.patches.push({ file: 'T-117-333333333333.patch', sha256: '3'.repeat(64) }); },
    'pinned patch gone': (o) => { o.protected.patches.pop(); },
    'unmeasured digest': (o) => { o.protected.patches[0].sha256 = null; },
    'name prefix lies': (o) => {
      o.protected.patches[1].file = 'T-001-999999999999.patch';
      setManifest(o, o.protected.manifest_text.replace('T-001-111111111111', 'T-001-999999999999'));
    },
    'no PROTECTED_PATHS': (o) => { o.protected.protected_paths = []; },
    'candidates unreadable': (o) => { o.protected.patches = null; },
    'sources unreadable': (o) => { o.protected = { ok: false, detail: 'EACCES', observed_at: T }; },
  };
  for (const [name, breakIt] of Object.entries(cases)) {
    const obs = healthy();
    breakIt(obs);
    assertNotTrusted(f(obs, 'protected_frozen'), name);
  }
});

test('field 4: the NOT-copied section pins nothing', () => {
  // The stray digest appears in the manifest, but with no `to` line. If it were
  // read as a pin, the fixture would report a pinned-but-absent candidate.
  const fld = f(healthy(), 'protected_frozen');
  assert.equal(fld.trust_state, TRUST.TRUSTED, fld.reason);
  assert.equal(fld.value.candidates.length, 2);
});

/* ── DIRECTION 2: UNTRUSTWORTHY -> TRUSTED ─────────────────────────────── */

/*
 * AMENDMENT 2. Fields 2 and 6 are UNTRUSTWORTHY BY CONSTRUCTION: freshness and
 * the registry cross-check can only demote; promotion is on a COMPLETENESS
 * ANCHOR, a separately named input from a source independent of the store.
 */
const noAnchors = () => { const o = healthy(); delete o.anchors; return o; };

test('A2 (a): every row FRESH and NO anchor -- fields 2 and 6 are not TRUSTED, for want of an anchor', () => {
  // The builder-reported defect: a store with every open row recently touched
  // promoted, even while it omitted current work.
  const obs = noAnchors();
  for (const id of ['assignment_candidate', 'channel_liveness']) {
    const fld = f(obs, id);
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, id);
    assert.equal(fld.value, null, id);
    assert.equal(fld.reason, 'no completeness anchor', `${id}: the reason must be the anchor, not staleness`);
  }
});

test('A2 (b) §7 DEMO: the same fresh rows PROMOTE on the anchor, and only on the anchor', () => {
  // 1b's shape made fresh, so recency cannot be what differs between the arms.
  const rows = [
    { task_id: 't-fixer-stopgate-recovery', state: 'runnable', updated_at: ago(60_000), attempt: 3 },
    { task_id: 't-code-a-heartbeat', state: 'runnable', updated_at: ago(60_000) },
  ];
  const without = noAnchors();
  without.tasks.rows = rows;
  assert.equal(f(without, 'assignment_candidate').trust_state, TRUST.UNTRUSTWORTHY, 'freshness alone promoted');
  assert.equal(f(without, 'channel_liveness').trust_state, TRUST.UNTRUSTWORTHY, 'registry agreement alone promoted');

  const withAnchor = healthy();
  withAnchor.tasks.rows = rows;
  withAnchor.anchors.assignment.current = ['t-code-a-heartbeat', 't-fixer-stopgate-recovery'];
  const after = f(withAnchor, 'assignment_candidate');
  assert.equal(after.trust_state, TRUST.TRUSTED, after.reason);
  assert.deepEqual(after.value.open_work.map((r) => r.task_id), ['t-code-a-heartbeat', 't-fixer-stopgate-recovery']);
  const live = f(withAnchor, 'channel_liveness');
  assert.equal(live.trust_state, TRUST.TRUSTED, live.reason);
});

test('A2 (c): STALE rows with a covering anchor stay UNTRUSTWORTHY -- freshness still demotes', () => {
  // Defined: the anchor proves current work is present, not that residue is
  // absent, and §3 forbids printing stale runnable tasks as current assignment.
  // Filtering them out would be choosing a likely assignment, which §5 forbids.
  // The anchor NAMES the stale row, so the naming rule (ruling 2) cannot be
  // what demotes it: staleness has to carry this refusal alone.
  const obs = healthy();
  obs.tasks.rows.push({ task_id: 't-fixer-stopgate-recovery', state: 'runnable', updated_at: ago(2 * 86400_000), attempt: 3 });
  obs.anchors.assignment.current.push('t-fixer-stopgate-recovery');
  const fld = f(obs, 'assignment_candidate');
  assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY);
  assert.equal(fld.value, null, 'stale runnable tasks must not be printed as current assignment');
  assert.match(fld.reason, /not updated within 24h: t-fixer-stopgate-recovery/);
  assert.doesNotMatch(fld.reason, /no completeness anchor/, 'the anchor was present; staleness is what demoted');
});

test('A2 (d): an anchor that does not COVER current work or a live seat is not TRUSTED', () => {
  const cases = {
    'field 2: anchor names work the store lacks': ['assignment_candidate', (o) => { o.anchors.assignment.current.push('t-tonight'); }, /absent from the store's open rows: t-tonight/],
    'field 2: anchor names work the store calls closed': ['assignment_candidate', (o) => { o.anchors.assignment.current.push('t-old-done'); }, /absent from the store's open rows: t-old-done/],
    'field 6: anchor sees a seat nobody registered': ['channel_liveness', (o) => { o.anchors.liveness.live_sessions.push('s-unregistered'); }, /anchor sees live seat\(s\) the roster lacks: s-unregistered/],
    'field 6: roster claims a seat the anchor does not see': ['channel_liveness', (o) => { o.anchors.liveness.live_sessions = ['s1']; }, /anchor does not see: s2/],
  };
  for (const [name, [id, breakIt, why]] of Object.entries(cases)) {
    const obs = healthy();
    assert.equal(f(obs, id).trust_state, TRUST.TRUSTED, `${name}: positive control`);
    breakIt(obs);
    const fld = f(obs, id);
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, name);
    assert.match(fld.reason, why, name);
  }
});

test('A2 (e): with a valid anchor, the registrations.json cross-check STILL demotes', () => {
  // A seat live in registrations.json and missing from the roster: the anchor
  // matches the roster, so only the retained cross-check can see it.
  const obs = healthy();
  obs.runtime.rows.push({ agent_id: 'w3', session_id: 's3', capacity: 'idle', heartbeat_at: ago(10_000) });
  const fld = f(obs, 'channel_liveness');
  assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY);
  assert.match(fld.reason, /observed live but absent from roster: s3/);
  assert.doesNotMatch(fld.reason, /completeness anchor/);
});

test('A2 (f): an anchor from the store it judges -- or from registrations.json -- never promotes', () => {
  const cases = {
    'field 2 anchored by the task store itself': ['assignment_candidate', (o) => {
      o.anchors.assignment = { ok: true, kind: 'owner-signed-record', source: 'task-store', source_identity: o.tasks.source_identity, observed_at: T, current: ['t-a', 't-b'] };
    }],
    'field 2 anchor carrying the store identity under another name': ['assignment_candidate', (o) => {
      o.anchors.assignment = { ok: true, kind: 'owner-signed-record', source: 'derived', source_identity: o.tasks.source_identity, observed_at: T, current: ['t-a', 't-b'] };
    }],
    'field 6 anchored by registrations.json (Controller decision)': ['channel_liveness', (o) => {
      o.anchors.liveness = { ok: true, kind: 'owner-signed-record', source: 'registrations', source_identity: 'C:/x/.agentbridge/registrations.json sha256:0', observed_at: T, live_sessions: ['s1', 's2'] };
    }],
    'field 6 anchor carrying the runtime identity': ['channel_liveness', (o) => {
      o.anchors.liveness = { ok: true, kind: 'owner-signed-record', source: 'derived', source_identity: o.runtime.source_identity, observed_at: T, live_sessions: ['s1', 's2'] };
    }],
    'field 6 anchored by the roster itself': ['channel_liveness', (o) => {
      o.anchors.liveness = { ok: true, kind: 'owner-signed-record', source: 'list_agents', source_identity: 'elsewhere', observed_at: T, live_sessions: ['s1', 's2'] };
    }],
    'anchor not observed': ['assignment_candidate', (o) => { o.anchors.assignment = { ok: false, detail: 'unreachable' }; }],
    'anchor lists nothing': ['channel_liveness', (o) => { o.anchors.liveness.live_sessions = []; }],
  };
  for (const [name, [id, breakIt]] of Object.entries(cases)) {
    const obs = healthy();
    assert.equal(f(obs, id).trust_state, TRUST.TRUSTED, `${name}: positive control`);
    breakIt(obs);
    assert.equal(f(obs, id).trust_state, TRUST.UNTRUSTWORTHY, name);
  }
});

/*
 * T-126: THE INDEPENDENCE MATCHER, AGAINST GENERATED SPELLINGS (rule 7).
 * The adversarial anchors are GENERATED from JUDGED_SOURCES and from the judged
 * stores' own identities, so adding a JUDGED_SOURCES entry extends coverage
 * without anybody remembering to. Each spelling is tried in BOTH the source and
 * the source_identity slot, the other slot holding a neutral label that is
 * first shown to promote.
 */
const midInsert = (v, ch) => `${v.slice(0, Math.ceil(v.length / 2))}${ch}${v.slice(Math.ceil(v.length / 2))}`;
const NFD_VOWEL = { a: 'a\u0301', e: 'e\u0301', i: 'i\u0301', o: 'o\u0301', u: 'u\u0301' };
const PRECOMPOSED = { a: '\u00E1', e: '\u00E9', i: '\u00ED', o: '\u00F3', u: '\u00FA' };
const CYRILLIC = { a: '\u0430', e: '\u0435', o: '\u043E', p: '\u0440', c: '\u0441', x: '\u0445', y: '\u0443' };
/** Replace the first character that has a mapping, or null when none does. */
const swapFirst = (v, map) => {
  const i = [...v].findIndex((ch) => map[ch]);
  if (i < 0) return null;
  const chars = [...v];
  chars[i] = map[chars[i]];
  return chars.join('');
};
const SPELLINGS = (v) => [
  ['exact', v],
  ['leading space', ` ${v}`], ['trailing space', `${v} `],
  ['leading tab', `\t${v}`], ['trailing tab', `${v}\t`],
  ['trailing newline', `${v}\n`], ['trailing CR', `${v}\r`], ['trailing CRLF', `${v}\r\n`],
  ['embedded space', `${v.slice(0, 1)} ${v.slice(1)}`], ['embedded tab', `${v.slice(0, 2)}\t${v.slice(2)}`],
  ['upper case', v.toUpperCase()],
  ['mixed case', [...v].map((ch, i) => (i % 2 ? ch.toUpperCase() : ch.toLowerCase())).join('')],
  ['posix path', `C:/x/.agentbridge/${v}`], ['windows path', `C:\\x\\.agentbridge\\${v}`], ['relative path', `./${v}`],
  // the shapes real identities take: a digest suffix, a host suffix
  ['digest suffix', `${v} sha256:0f0f`], ['host suffix', `${v} @ https://h.example/x`],
  // the same last path segment under a different directory: only the
  // last-segment comparison sees these for a path-shaped identity
  ['moved directory', `Z:/elsewhere/${v.split(/[\\/]/).pop()}`],
  ['moved directory, windows', `Z:\\elsewhere\\${v.split(/[\\/]/).pop()}`],
  // T-127 UNICODE CLASSES. Format / default-ignorable characters: \s misses them.
  ['zero-width space', midInsert(v, '\u200B')], ['zero-width joiner', midInsert(v, '\u200D')],
  ['word joiner', midInsert(v, '\u2060')], ['BOM prefix', `\uFEFF${v}`], ['soft hyphen', midInsert(v, '\u00AD')],
  // Combining marks: on a letter NFKC cannot compose, on a vowel NFKC recomposes,
  // and the precomposed form.
  ['combining acute', `${v.slice(0, 1)}\u0301${v.slice(1)}`],
  ['NFD accented vowel', swapFirst(v, NFD_VOWEL)], ['precomposed accented vowel', swapFirst(v, PRECOMPOSED)],
  // Confusables: a Cyrillic letter that no fold maps to ASCII.
  ['cyrillic confusable', swapFirst(v, CYRILLIC)],
  // T-131: the "_" confusables (a compatibility form and a combining mark).
  ['double low line for _', v.includes('_') ? v.replace('_', '\u2017') : null],
  ['macron below for _', v.includes('_') ? v.replace('_', '\u0331') : null],
  // T-131: punctuation wrapping, which tokens() used not to split on.
  ['parenthesised', `(${v})`], ['backticked', `\`${v}\``], ['double-quoted', `"${v}"`], ['single-quoted', `'${v}'`],
  ['bracketed', `[${v}]`], ['exclamation suffix', `${v}!`], ['tilde suffix', `${v}~`], ['plus-copy suffix', `${v}+copy`],
  ['trailing dot', `${v}.`],
  // FLOOR-3: percent-encoded, whole and in part; dotted components.
  ['percent-encoded', [...v].map((ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`).join('')],
  ['partly percent-encoded', v.replace(/[_.\-a-z]/, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)],
  ['.json suffix', `${v}.json`], ['dotted prefix', `mirror.${v}`],
  // T-131: C0 controls and DEL, which \s does not match.
  ['NUL prefix', `\u0000${v}`], ['SOH suffix', `${v}\u0001`], ['ESC embedded', midInsert(v, '\u001B')], ['DEL suffix', `${v}\u007F`],
].filter(([, s]) => s !== null);
const NEUTRAL = { source: 'synthetic', source_identity: 'synthetic:file' };
/*
 * OPAQUE JUDGED IDENTITIES (rule 9). The fixture's own identities -- like the
 * driver's real ones -- CONTAIN a judged name ("list_tasks @ ..."), so the
 * name-token rule refuses every spelling of them before identity equality is
 * ever consulted: case folding, backslash unification and the last-segment
 * comparison could all be deleted and these cases would still pass. A second
 * set of judged stores whose identities name nothing makes identity equality
 * carry the refusal alone.
 */
const OPAQUE = { tasks: 'opaque-store-7f3a', roster: 'opaque-roster-19c2', runtime: 'C:/home/.x/opaque-regs-55 sha256:ab12' };
const withOpaque = (o) => {
  o.tasks.source_identity = OPAQUE.tasks;
  o.roster.source_identity = OPAQUE.roster;
  o.runtime.source_identity = OPAQUE.runtime;
  return o;
};
const ANCHORED = [
  { id: 'assignment_candidate', key: 'assignment', ids: (o) => [o.tasks.source_identity] },
  { id: 'channel_liveness', key: 'liveness', ids: (o) => [o.roster.source_identity, o.runtime.source_identity] },
];
function spelledAnchorCases() {
  const cases = [];
  for (const { id, key, ids } of ANCHORED) {
    const values = [
      ...JUDGED_SOURCES.map((v) => [v, false]),
      ...ids(healthy()).map((v) => [v, false]),
      ...ids(withOpaque(healthy())).map((v) => [v, true]),
    ];
    for (const [v, opaque] of values) {
      for (const [how, spelled] of SPELLINGS(v)) {
        for (const slot of ['source', 'source_identity']) {
          cases.push({ id, key, slot, opaque, value: spelled, name: `${id} ${slot} ${how} of ${JSON.stringify(v)}${opaque ? ' (opaque stores)' : ''}` });
        }
      }
    }
  }
  return cases;
}

test('T-126: an anchor naming a judged source in ANY generated spelling, in either slot, never promotes', () => {
  const cases = spelledAnchorCases();
  assert.ok(cases.length >= JUDGED_SOURCES.length * SPELLINGS('x').length * 2 * ANCHORED.length, `only ${cases.length} cases generated`);
  for (const { id, key } of ANCHORED) {
    for (const obs of [healthy(), withOpaque(healthy())]) {
      Object.assign(obs.anchors[key], NEUTRAL);
      assert.equal(f(obs, id).trust_state, TRUST.TRUSTED, `${id}: the neutral label must promote, or every refusal below is vacuous`);
    }
  }
  assert.ok(cases.some((c) => c.opaque), 'no opaque-identity cases were generated');
  for (const cls of ['zero-width space', 'combining acute', 'NFD accented vowel', 'cyrillic confusable']) {
    assert.ok(cases.some((c) => c.name.includes(` ${cls} of `)), `the generator produced no "${cls}" case`);
  }
  const leaked = [];
  for (const c of cases) {
    const obs = c.opaque ? withOpaque(healthy()) : healthy();
    Object.assign(obs.anchors[c.key], NEUTRAL, { [c.slot]: c.value });
    const fld = f(obs, c.id);
    // refused, for an anchor-label reason, quoting the slot that carried the spelling
    if (fld.trust_state === TRUST.TRUSTED
      || !/completeness anchor (is not independent|label is not plain printable ASCII)/.test(fld.reason)
      || !fld.reason.includes(`(${c.slot} `)) leaked.push(c.name);
  }
  assert.deepEqual(leaked, [], `${leaked.length} spelling(s) promoted or were refused for the wrong reason:\n${leaked.slice(0, 20).join('\n')}`);
});

const cp = (n) => String.fromCodePoint(n);

test('T-131: a default-ignorable character carries nothing -- stripped, and the label still promotes', () => {
  // The over-refusal control for the strip. Zero-width space, BOM and soft
  // hyphen are removed before the printable-ASCII test, so they are not refusals.
  for (const label of [`fixture-dis${cp(0x200B)}patch-ledger`, `${cp(0xFEFF)}fixture-dispatch-ledger`, `fixture-dispatch${cp(0xAD)}-ledger`]) {
    const obs = healthy();
    obs.anchors.assignment.source = label;
    const fld = f(obs, 'assignment_candidate');
    assert.equal(fld.trust_state, TRUST.TRUSTED, `${JSON.stringify(label)}: ${fld.reason}`);
  }
});

test('T-131: an accented or "_"-confusable label is REFUSED, never folded', () => {
  // T-131 dropped the NFKD fold: U+2017 decomposes to a space plus a mark, so
  // folding MANUFACTURED "listtasks" from "list<U+2017>tasks". Now anything not
  // printable ASCII after the strip is refused -- accented letters included,
  // which is a named, fail-closed false refusal.
  const labels = [
    `fixture-dispatch-l${cp(0xE9)}dger`, `fixture-dispatch-le${cp(0x301)}dger`,
    `fixture${cp(0x2017)}ledger`, `fixture${cp(0x331)}ledger`,
    // C0 controls and DEL in a BENIGN label: the token denylist would refuse a
    // control char inside a judged name anyway, so only this rule sees these.
    `fixture${cp(0x01)}ledger`, `fixture${cp(0x1B)}ledger`, `fixture-ledger${cp(0x7F)}`, `fixture${cp(0x09)}ledger`,
  ];
  for (const label of labels) {
    const obs = healthy();
    obs.anchors.assignment.source = label;
    const fld = f(obs, 'assignment_candidate');
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, JSON.stringify(label));
    assert.match(fld.reason, /label is not plain printable ASCII \(source /, JSON.stringify(label));
  }
});

/*
 * T-131: THE KIND ALLOWLIST. An anchor promotes only if `kind` is EXACTLY one
 * entry of ANCHOR_KINDS. Every test below keeps the labels NEUTRAL, so the
 * label denylist cannot be what refuses: the allowlist has to do it alone.
 */
const kindVariants = () => [
  undefined, null, '', 42, true, {}, ['owner-signed-record'],
  { toString: () => 'owner-signed-record' },
  'owner', 'signed-record', 'owner-signed', 'record',
  // every entry of ANCHOR_KINDS in every generated spelling except the exact one
  ...ANCHOR_KINDS.flatMap((k) => SPELLINGS(k).filter(([how]) => how !== 'exact').map(([, s]) => s)),
];

test('T-131: every ANCHOR_KINDS entry promotes, spelled exactly (positive control)', () => {
  assert.ok(ANCHOR_KINDS.length >= 2);
  for (const kind of ANCHOR_KINDS) {
    for (const [id, key] of [['assignment_candidate', 'assignment'], ['channel_liveness', 'liveness']]) {
      const obs = healthy();
      Object.assign(obs.anchors[key], NEUTRAL, { kind });
      assert.equal(f(obs, id).trust_state, TRUST.TRUSTED, `${id} ${kind}: ${f(obs, id).reason}`);
    }
  }
});

test('T-131: a missing, unknown or non-exact kind is refused by the allowlist alone', () => {
  const variants = kindVariants();
  assert.ok(variants.length > 50, `only ${variants.length} kind variants`);
  const leaked = [];
  for (const kind of variants) {
    for (const [id, key] of [['assignment_candidate', 'assignment'], ['channel_liveness', 'liveness']]) {
      const obs = healthy();
      Object.assign(obs.anchors[key], NEUTRAL, { kind });
      if (kind === undefined) delete obs.anchors[key].kind;
      const fld = f(obs, id);
      if (fld.trust_state === TRUST.TRUSTED || fld.reason !== 'completeness anchor kind not recognised') {
        leaked.push(`${id} kind=${JSON.stringify(kind)} -> ${fld.trust_state}: ${fld.reason}`);
      }
    }
  }
  assert.deepEqual(leaked, []);
});

test('T-131: a generated HOSTILE label with no kind is refused for the KIND, not by the denylist', () => {
  // The allowlist runs first. If it were bypassed, the denylist would still
  // refuse these -- with a different reason, which is what this detects.
  const cases = spelledAnchorCases();
  const wrong = [];
  for (const c of cases) {
    const obs = c.opaque ? withOpaque(healthy()) : healthy();
    Object.assign(obs.anchors[c.key], NEUTRAL, { [c.slot]: c.value });
    delete obs.anchors[c.key].kind;
    const fld = f(obs, c.id);
    if (fld.reason !== 'completeness anchor kind not recognised') wrong.push(c.name);
  }
  assert.deepEqual(wrong, [], `${wrong.length} hostile label(s) were not refused by the allowlist`);
});

/*
 * FLOOR-3: THE PARTS OF A JUDGED IDENTITY. Real identities are composites
 * ("list_tasks @ <endpoint>", "<path>/registrations.json sha256:<digest>"), and
 * the endpoint or the digest alone names the store. These fixtures carry the
 * driver's real identity SHAPE -- the plain fixture identities above have no
 * URL or digest, so they could not fail for this class (rule 9).
 */
const URL_ID = 'https://h.example.test/functions/v1/mcp';
const DIGEST = 'd91ff69fbf8ecc58709e0a855cdcedc5c25a7014396d8670a62e0923c8afc314';
const withUrls = (o) => {
  o.tasks.source_identity = `list_tasks @ ${URL_ID}`;
  o.roster.source_identity = `list_agents @ ${URL_ID}`;
  o.runtime.source_identity = `C:\\Users\\x\\.agentbridge\\registrations.json sha256:${DIGEST}`;
  return o;
};
const partSpellings = (p) => [
  ['exact', p], ['query', `${p}?v=1`], ['fragment', `${p}#x`], ['trailing dot', `${p}.`], ['ADS', `${p}::$DATA`],
  ['glued', `x${p}&y`], ['copy-of', `copy-of-${p}?v=2`], ['in prose', `mirror of ${p} taken 12:00`],
  ['upper-case glued', `X${p.toUpperCase()}?Q`],
  ['percent-encoded', [...p].map((ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')],
];

test('FLOOR-3: an endpoint URL or file digest from a judged identity, decorated or embedded, never promotes', () => {
  for (const { id, key } of ANCHORED) {
    const obs = withUrls(healthy());
    Object.assign(obs.anchors[key], NEUTRAL);
    assert.equal(f(obs, id).trust_state, TRUST.TRUSTED, `${id}: neutral labels must promote under URL-shaped identities`);
  }
  const leaked = [];
  for (const { id, key } of ANCHORED) {
    for (const part of [URL_ID, DIGEST]) {
      if (id === 'assignment_candidate' && part === DIGEST) continue; // field 2 judges no digest
      for (const [how, spelled] of partSpellings(part)) {
        for (const slot of ['source', 'source_identity']) {
          const obs = withUrls(healthy());
          Object.assign(obs.anchors[key], NEUTRAL, { [slot]: spelled });
          const fld = f(obs, id);
          if (fld.trust_state === TRUST.TRUSTED) leaked.push(`${id} ${slot} ${how} of ${part.slice(0, 24)}`);
        }
      }
    }
  }
  assert.deepEqual(leaked, []);
});

test('an identity made of SHORT parts is still refused when embedded whole', () => {
  // Every part of this identity is under 8 characters, so the part rule cannot
  // see it; only whole-identity containment can. Real identities always carry
  // a long part (a URL, a path), which is why this needs its own fixture.
  const SHORT = 'ab12 cd34 ef56';
  for (const { id, key } of ANCHORED) {
    const obs = healthy();
    if (key === 'assignment') obs.tasks.source_identity = SHORT;
    else obs.roster.source_identity = SHORT;
    Object.assign(obs.anchors[key], NEUTRAL);
    assert.equal(f(obs, id).trust_state, TRUST.TRUSTED, `${id}: neutral labels must promote`);
    for (const slot of ['source', 'source_identity']) {
      const hostile = healthy();
      if (key === 'assignment') hostile.tasks.source_identity = SHORT;
      else hostile.roster.source_identity = SHORT;
      Object.assign(hostile.anchors[key], NEUTRAL, { [slot]: 'mirror-ab12cd34ef56-copy' });
      assert.equal(f(hostile, id).trust_state, TRUST.UNTRUSTWORTHY, `${id} ${slot}`);
    }
  }
});

test('T-131: an OPEN row without a string task_id demotes field 2 -- no String() coercion', () => {
  for (const [what, row, anchorIds] of [
    ['missing task_id, anchor names "undefined"', { state: 'runnable', updated_at: ago(60_000) }, ['t-a', 't-b', 'undefined']],
    ['null task_id, anchor names "null"', { task_id: null, state: 'runnable', updated_at: ago(60_000) }, ['t-a', 't-b', 'null']],
    ['numeric task_id, anchor names "7"', { task_id: 7, state: 'runnable', updated_at: ago(60_000) }, ['t-a', 't-b', '7']],
    ['blank task_id', { task_id: '  ', state: 'runnable', updated_at: ago(60_000) }, ['t-a', 't-b']],
  ]) {
    const obs = healthy();
    obs.tasks.rows.push(row);
    obs.anchors.assignment.current = anchorIds;
    const fld = f(obs, 'assignment_candidate');
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, what);
    assert.match(fld.reason, /open row without an id: 1 row/, what);
  }
  // Anchor entries are never coerced either: a non-string entry voids the anchor.
  const obs = healthy();
  obs.anchors.assignment.current = ['t-a', 't-b', 7];
  assert.match(f(obs, 'assignment_candidate').reason, /^completeness anchor lists no current$/);
});

test('T-131: a DUPLICATE task_id or session_id demotes its field', () => {
  const f2 = healthy();
  f2.tasks.rows.push({ task_id: 't-a', state: 'accepted', updated_at: ago(60_000) });
  const a = f(f2, 'assignment_candidate');
  assert.equal(a.trust_state, TRUST.UNTRUSTWORTHY);
  assert.match(a.reason, /duplicate id: t-a/);

  for (const [where, row] of [
    ['roster', { agentId: 'w1-again', sessionId: 's1', capacity: 'offline', lastSeenAt: ago(9 * 86400_000) }],
    ['runtime', { agent_id: 'w1-again', session_id: 's1', capacity: 'idle', heartbeat_at: ago(9 * 86400_000) }],
  ]) {
    const obs = healthy();
    obs[where].rows.push(row);
    const fld = f(obs, 'channel_liveness');
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, where);
    assert.match(fld.reason, new RegExp(`duplicate id: ${where} s1`), where);
  }
});

test('T-131: generated_at must be ISO 8601 UTC, or the input is rejected', () => {
  for (const bad of [undefined, null, '', 42, 'yesterday', '2026-09-23', '2026-09-23 20:00:00Z',
    '2026-09-23T20:00:00+01:00', '2026-09-23T20:00:00', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z']) {
    const obs = healthy();
    obs.generated_at = bad;
    assert.throws(() => compileEnvelope(obs), /generated_at must be an ISO 8601 UTC timestamp/, JSON.stringify(bad));
  }
  for (const good of [T, '2026-09-23T20:00:00Z', '2026-09-23T20:00:00.5Z']) {
    const obs = healthy();
    obs.generated_at = good;
    assert.equal(compileEnvelope(obs).generated_at, good);
  }
});

test('T-129: the refusal quotes the slot that fired, not always the source', () => {
  const obs = healthy();
  Object.assign(obs.anchors.assignment, NEUTRAL, { source_identity: obs.tasks.source_identity });
  const fld = f(obs, 'assignment_candidate');
  assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY);
  assert.match(fld.reason, /\(source_identity "list_tasks @ fixture"\)/);
  assert.doesNotMatch(fld.reason, /\(source "synthetic"\)/, 'the neutral source was blamed');
});

test('T-129 ruling 2: an OPEN row the anchor does not name demotes field 2, however fresh', () => {
  const fresh = { task_id: 't-fixer-stopgate-recovery', state: 'runnable', updated_at: ago(3600_000), attempt: 3 };
  const obs = healthy();
  obs.tasks.rows.push(fresh);
  const fld = f(obs, 'assignment_candidate');
  assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY);
  assert.equal(fld.value, null, 'the unnamed row must not be listed as open work');
  assert.match(fld.reason, /open row\(s\) the completeness anchor does not name: t-fixer-stopgate-recovery/);
  // The same store with the row NAMED promotes: the naming rule, not freshness, decided.
  const named = healthy();
  named.tasks.rows.push(fresh);
  named.anchors.assignment.current.push('t-fixer-stopgate-recovery');
  assert.equal(f(named, 'assignment_candidate').trust_state, TRUST.TRUSTED);
});

test('T-129 C09: an EMPTY anchor never promotes -- field 2 alone, field 6 alone', () => {
  // Fixtures where the empty list is the ONLY thing that can refuse: no open
  // rows for field 2 to leave unnamed, no live seats for field 6 to disagree on.
  const f2 = healthy();
  f2.tasks.rows = [{ task_id: 't-old-done', state: 'accepted', updated_at: ago(60_000) }];
  f2.anchors.assignment.current = [];
  const a = f(f2, 'assignment_candidate');
  assert.equal(a.trust_state, TRUST.UNTRUSTWORTHY);
  assert.match(a.reason, /^completeness anchor lists no current$/);

  const f6 = healthy();
  f6.roster.rows = [{ agentId: 'gone', sessionId: 's-old', capacity: 'offline', lastSeenAt: ago(2 * 86400_000) }];
  f6.runtime.rows = [];
  f6.anchors.liveness.live_sessions = [];
  const b = f(f6, 'channel_liveness');
  assert.equal(b.trust_state, TRUST.UNTRUSTWORTHY);
  assert.match(b.reason, /^completeness anchor lists no live_sessions$/);
});

test('T-129 C10: an anchor that says ok:false never promotes, even with good labels and ids', () => {
  const obs = healthy();
  Object.assign(obs.anchors.assignment, { ok: false, detail: 'probe timed out' });
  Object.assign(obs.anchors.liveness, { ok: false, detail: 'probe timed out' });
  for (const [id, key] of [['assignment_candidate', 'assignment'], ['channel_liveness', 'liveness']]) {
    assert.ok(obs.anchors[key].source && obs.anchors[key].source_identity, 'precondition: the fixture carries labels');
    const fld = f(obs, id);
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, id);
    assert.match(fld.reason, /^no completeness anchor \(probe timed out\)$/, id);
  }
});

test('T-126: all nine T-122 verifier rows are among the generated cases', () => {
  const have = new Set(spelledAnchorCases().map((c) => `${c.id}|${c.slot}|${c.value}`));
  const h = healthy();
  const rows = [
    ['assignment_candidate', 'source', ' list_tasks'],
    ['assignment_candidate', 'source', 'list_tasks\n'],
    ['assignment_candidate', 'source', 'registrations.json '],
    ['assignment_candidate', 'source_identity', `${h.tasks.source_identity} `],
    ['assignment_candidate', 'source_identity', h.tasks.source_identity.toUpperCase()],
    ['channel_liveness', 'source', ' roster'],
    ['channel_liveness', 'source', 'list_agents\t'],
    // with the other slot at NEUTRAL.source_identity, "synthetic:file"
    ['channel_liveness', 'source', 'C:/x/.agentbridge/registrations.json'],
    ['channel_liveness', 'source_identity', `${h.roster.source_identity} `],
  ];
  const missing = rows.filter(([id, slot, v]) => !have.has(`${id}|${slot}|${v}`)).map((r) => JSON.stringify(r));
  assert.deepEqual(missing, []);
});

test('M01: an untrusted field withholds the candidate value it was handed', () => {
  // field 2 hands its open_work to field() on every path; only the null rule
  // withholds it. Fresh rows, no anchor: the value exists and must not show.
  const fld = f(noAnchors(), 'assignment_candidate');
  assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY);
  assert.equal(fld.value, null, 'an untrusted field printed its candidate open_work');
});

test('M22: identity observed while git reported failure is withheld by the component null rule', () => {
  // A HEAD-shaped value in an observation that ALSO says git failed: the value
  // is passed to component() as observed; only the null rule withholds it.
  const obs = healthy();
  Object.assign(obs.baseline, { ok: false, detail: 'git exited 128' });
  const fld = f(obs, 'baseline');
  for (const k of ['repo_identity', 'head', 'tree']) {
    assert.equal(comp(fld, k).trust_state, TRUST.UNTRUSTWORTHY, k);
    assert.equal(comp(fld, k).value, null, `${k} kept a value while git reported failure`);
  }
});

test('T-126: field 3 reasons do not depend on git line order (permuted inputs, byte-identical out)', () => {
  const a = healthy();
  a.baseline.status = ['?? b.txt', ' M a.mjs', '?? c/d.txt', 'D  e.md'];
  a.baseline.drift = [
    { file: 'package.json', now: 'M', kind: 'protected' },
    { file: 'CLAUDE.md', now: 'M', kind: 'protected' },
    { file: 'test/z.test.mjs', now: '??', kind: 'baseline-test' },
  ];
  const b = JSON.parse(JSON.stringify(a));
  b.baseline.status.reverse();
  b.baseline.drift = [a.baseline.drift[2], a.baseline.drift[0], a.baseline.drift[1]];
  const out = serializeEnvelope(compileEnvelope(a));
  assert.match(out, /not clean/, 'precondition: the permuted rows reach the reason');
  assert.match(out, /baseline drift/, 'precondition: the permuted drift reaches the reason');
  assert.equal(serializeEnvelope(compileEnvelope(b)), out);
});

test('field 2: the freshness boundary is the exported window, either side', () => {
  const at = (ms) => {
    const o = healthy();
    o.tasks.rows = [{ task_id: 't', state: 'runnable', updated_at: ago(ms) }];
    o.anchors.assignment.current = ['t'];
    return f(o, 'assignment_candidate').trust_state;
  };
  assert.equal(at(TASK_FRESH_MS - 60_000), TRUST.TRUSTED);
  assert.equal(at(TASK_FRESH_MS + 60_000), TRUST.UNTRUSTWORTHY);
});

test('field 2: inconsistent open rows are UNTRUSTWORTHY', () => {
  const cases = {
    'expired lease still assigned': (o) => { o.tasks.rows[1].lease_expires_at = ago(60_000); },
    'undated open row': (o) => { delete o.tasks.rows[0].updated_at; },
    'dated in the future': (o) => { o.tasks.rows[0].updated_at = ago(-3600_000); },
    'store unreadable': (o) => { o.tasks = { ok: false, detail: 'rejected: reader token rejected (401)', observed_at: T }; },
    'not a list': (o) => { o.tasks.rows = { rows: [] }; },
  };
  for (const [name, breakIt] of Object.entries(cases)) {
    const obs = healthy();
    breakIt(obs);
    const fld = f(obs, 'assignment_candidate');
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, name);
    assert.equal(fld.value, null, name);
  }
});

test('D2 field 6: a roster of ghosts that omits live seats is UNTRUSTWORTHY, and PROMOTES when consistent', () => {
  // The shape 1b observed: every row offline and old, the live seats absent.
  const ghosts = healthy();
  ghosts.roster.rows = Array.from({ length: 21 }, (_, i) => ({
    agentId: `old-${i}`, sessionId: `old-${i}`, capacity: 'offline', lastSeenAt: '2026-09-22T03:29:00.000Z',
  }));
  const before = f(ghosts, 'channel_liveness');
  assert.equal(before.trust_state, TRUST.UNTRUSTWORTHY);
  assert.equal(before.value, null, 'the 21 ghosts must not be repeated as live topology');
  assert.match(before.reason, /contradicts directly observed runtime population/);
  assert.match(before.reason, /s1, s2/);

  const consistent = healthy();
  consistent.roster.rows = [...ghosts.roster.rows, ...healthy().roster.rows];
  const after = f(consistent, 'channel_liveness');
  assert.equal(after.trust_state, TRUST.TRUSTED, after.reason);
  assert.deepEqual(after.value.live_worker_topology.map((r) => r.session_id), ['s1', 's2']);
});

test('field 6: a roster row claiming liveness nobody observes is a ghost', () => {
  const obs = healthy();
  obs.roster.rows.push({ agentId: 'phantom', sessionId: 's-phantom', capacity: 'idle', lastSeenAt: ago(10_000) });
  const fld = f(obs, 'channel_liveness');
  assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY);
  assert.match(fld.reason, /live in roster but not observed: s-phantom/);
});

test('field 6: liveness uses the shared window, either side, and never a defaulted capacity', () => {
  const at = (ms) => {
    const o = healthy();
    o.roster.rows[0].lastSeenAt = ago(ms);
    return f(o, 'channel_liveness').trust_state;
  };
  // s2 observed live; the roster copy of s2 ages across the shared window.
  assert.equal(at(STALE_AFTER_MS - 5_000), TRUST.TRUSTED);
  assert.equal(at(STALE_AFTER_MS + 5_000), TRUST.UNTRUSTWORTHY);

  const noCap = healthy();
  delete noCap.roster.rows[0].capacity;
  const fld = f(noCap, 'channel_liveness');
  assert.equal(fld.value.live_worker_topology.find((r) => r.session_id === 's2').capacity, null,
    'a missing capacity must stay null, not become "idle"');
});

test('F5 field 6: a row with no session id counts against TRUSTED, never dropped', () => {
  for (const [where, row] of [
    ['roster', { agentId: 'nameless', capacity: 'idle', lastSeenAt: ago(10_000) }],
    ['roster', { agentId: 'nameless-offline', capacity: 'offline', lastSeenAt: ago(9 * 86400_000) }],
    ['runtime', { agent_id: 'nameless', capacity: 'idle', heartbeat_at: ago(10_000) }],
  ]) {
    const obs = healthy();
    assert.equal(f(obs, 'channel_liveness').trust_state, TRUST.TRUSTED);
    obs[where].rows.push(row);
    const fld = f(obs, 'channel_liveness');
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, `${where} ${row.agentId ?? row.agent_id}`);
    assert.match(fld.reason, /no session id/);
  }
});

test('M25: a classifier that THROWS gives a non-TRUSTED field, never TRUSTED', () => {
  const boom = { get ok() { throw new Error('injected'); } };
  for (const [key, id] of [
    ['tasks', 'assignment_candidate'], ['baseline', 'baseline'], ['protected', 'protected_frozen'], ['roster', 'channel_liveness'],
  ]) {
    const obs = healthy();
    assert.equal(f(obs, id).trust_state, TRUST.TRUSTED, `${id} positive control`);
    obs[key] = boom;
    const fld = f(obs, id);
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, `${id} after an injected throw`);
    assert.equal(fld.value, null);
    assert.match(fld.reason, /could not be classified: injected/);
  }
});

test('field 6: no independent observation means it cannot be TRUSTED', () => {
  for (const breakIt of [
    (o) => { delete o.runtime; },
    (o) => { o.runtime = { ok: false, detail: 'corrupt', observed_at: T }; },
    (o) => { o.roster = { ok: false, detail: 'AGENTBRIDGE_READER_TOKEN is not set', observed_at: T }; },
  ]) {
    const obs = healthy();
    breakIt(obs);
    assert.equal(f(obs, 'channel_liveness').trust_state, TRUST.UNTRUSTWORTHY);
  }
});

/* ── DIRECTION 3: ABSENT stays ABSENT under pressure ───────────────────── */

test('D3 fields 1 and 5 stay ABSENT and null when handed plausible prose', () => {
  const PROSE_SEATS = '| seat | role |\n|---|---|\n| agent007-26 | BUILDER for T-117 |\n'
    + 'Independence: agent007-26 may not verify T-117; agent007-44 is the Verifier.';
  const pressured = {
    ...healthy(),
    role_authority: { value: 'BUILDER', trust_state: 'TRUSTED', source: 'SEATS.md' },
    review_independence: { value: { eligible: true }, trust_state: 'TRUSTED' },
    seats_md: PROSE_SEATS,
    handoff: 'You are replacing 7a. You are the reviewer for T-112.',
    terminal_name: 'agent007-p0verify',
    registry_label: 'agent007-p0verify',
    controller_memory: 'we decided last night that this seat builds T-117',
    fields: { role_authority: { value: 'BUILDER' } },
  };
  const env = compileEnvelope(pressured);
  // The observation LOADED: fields that do read input are TRUSTED from it.
  assert.equal(env.fields.baseline.trust_state, TRUST.TRUSTED, 'the pressured observation did not load');
  for (const id of ['role_authority', 'review_independence']) {
    assert.equal(env.fields[id].trust_state, TRUST.ABSENT, id);
    assert.equal(env.fields[id].value, null, `${id} took a value from prose`);
    assert.equal(env.fields[id].source, null, `${id} names a source`);
    assert.equal(env.fields[id].source_identity, null, `${id} names a source identity`);
  }
  // And no prose string leaked anywhere into the serialised envelope.
  const out = serializeEnvelope(env);
  for (const needle of ['BUILDER', 'replacing 7a', 'agent007-p0verify', 'last night', 'agent007-44']) {
    assert.equal(out.includes(needle), false, `prose "${needle}" reached the envelope`);
  }
});

/* ── DIRECTION 4: determinism ──────────────────────────────────────────── */

test('D4 the same observations give a byte-identical envelope, twice', () => {
  const a = serializeEnvelope(compileEnvelope(healthy()));
  const b = serializeEnvelope(compileEnvelope(healthy()));
  assert.equal(a, b);
  assert.ok(a.length > 500, 'the envelope is suspiciously small');
});

test('D4 row ORDER in a source does not change the envelope', () => {
  const a = serializeEnvelope(compileEnvelope(healthy()));
  const shuffled = healthy();
  for (const k of ['tasks', 'roster', 'runtime']) shuffled[k].rows.reverse();
  shuffled.protected.patches.reverse();
  shuffled.protected.protected_paths.reverse();
  assert.equal(serializeEnvelope(compileEnvelope(shuffled)), a);
});

test('D4 is not a constant: a different observation gives different bytes', () => {
  // Byte-equality above would also hold for a serializer that ignores its input.
  const a = serializeEnvelope(compileEnvelope(healthy()));
  const later = healthy();
  later.generated_at = ago(-1000);
  assert.notEqual(serializeEnvelope(compileEnvelope(later)), a);
  const otherHead = healthy();
  otherHead.baseline.head = 'd'.repeat(40);
  assert.notEqual(serializeEnvelope(compileEnvelope(otherHead)), a);
});

/* ── robustness: garbage is a source failure, never a crash ────────────── */

test('garbage observations yield an envelope with nothing TRUSTED but the constant', () => {
  // generated_at is valid in each: T-131 rejects a bad one outright (tested below).
  for (const obs of [{ generated_at: T }, { generated_at: T, tasks: 7, baseline: 'x', protected: [], roster: true, runtime: 0 }]) {
    const env = compileEnvelope(obs);
    for (const id of FIELD_IDS) {
      if (id === 'history_marker') continue;
      assert.notEqual(env.fields[id].trust_state, TRUST.TRUSTED, `${id} TRUSTED from ${JSON.stringify(obs)}`);
    }
    assert.equal(env.fields.history_marker.trust_state, TRUST.TRUSTED);
  }
});

/* ── T-155: nothing the classifier reads may be INHERITED ───────────────── */

/*
 * T-131 read anchor.kind -- and every other field -- through the prototype
 * chain, so an anchor that did not CARRY an allowed kind could still promote.
 * Every fixture below asserts its own premise first (rule 6): that the kind
 * really is inherited and really is not own, or that the pollution landed.
 * Pollution is always removed in a finally, and the removal is asserted.
 */
const ANCHOR_SLOTS = [['assignment', 'assignment_candidate'], ['liveness', 'channel_liveness']];
const withoutKey = (o, k) => { const { [k]: _drop, ...rest } = o; return rest; };
function polluted(key, value, fn) {
  assert.equal(Object.hasOwn(Object.prototype, key), false, `Object.prototype.${key} already exists`);
  Object.prototype[key] = value; // eslint-disable-line no-extend-native
  try {
    assert.equal(({})[key], value, `pollution of ${key} did not land`);
    return fn();
  } finally {
    delete Object.prototype[key];
    assert.equal(Object.hasOwn(Object.prototype, key), false, `pollution of ${key} was not cleaned up`);
  }
}

test('T-155: an anchor kind INHERITED through Object.create never promotes (every kind, both anchors)', () => {
  for (const [slot, id] of ANCHOR_SLOTS) {
    for (const kind of ANCHOR_KINDS) {
      const own = healthy();
      own.anchors[slot].kind = kind;
      assert.equal(f(own, id).trust_state, TRUST.TRUSTED, `${slot}/${kind} positive control: ${f(own, id).reason}`);
      const obs = healthy();
      obs.anchors[slot] = Object.assign(Object.create({ kind }), withoutKey(obs.anchors[slot], 'kind'));
      assert.equal(Object.hasOwn(obs.anchors[slot], 'kind'), false, 'premise: kind is not own');
      assert.equal(obs.anchors[slot].kind, kind, 'premise: kind IS readable through the prototype');
      assertNotTrusted(f(obs, id), `${slot} kind ${kind} inherited`);
      assert.match(f(obs, id).reason, /kind not recognised/);
    }
  }
});

test('T-155: with Object.prototype.kind POLLUTED, an anchor with no own kind never promotes', () => {
  for (const [slot, id] of ANCHOR_SLOTS) {
    for (const kind of ANCHOR_KINDS) {
      const obs = healthy();
      obs.anchors[slot] = withoutKey(obs.anchors[slot], 'kind');
      const fld = polluted('kind', kind, () => f(obs, id));
      assertNotTrusted(fld, `${slot}: no own kind, Object.prototype.kind = ${kind}`);
      assert.match(fld.reason, /kind not recognised/);
    }
  }
});

test('T-155: JSON carrying "__proto__" never supplies a kind -- parsed, or merged with Object.assign', () => {
  for (const [slot, id] of ANCHOR_SLOTS) {
    for (const kind of ANCHOR_KINDS) {
      const text = JSON.stringify({ ...withoutKey(healthy().anchors[slot], 'kind') }).replace(/^\{/, `{"__proto__":{"kind":${JSON.stringify(kind)}},`);
      // CONTROL (refused on T-131 too): JSON.parse makes "__proto__" an OWN key, not a prototype.
      const parsed = JSON.parse(text);
      assert.equal(Object.hasOwn(parsed, '__proto__'), true, 'premise: parsed __proto__ is an own key');
      const a = healthy(); a.anchors[slot] = parsed;
      assertNotTrusted(f(a, id), `${slot}: JSON.parse with __proto__`);
      // THE REAL PATH: Object.assign [[Set]]s "__proto__", which REPLACES the prototype.
      const merged = Object.assign({}, parsed);
      assert.equal(Object.hasOwn(merged, 'kind'), false, 'premise: merged kind is not own');
      assert.equal(merged.kind, kind, 'premise: merged kind is inherited');
      const b = healthy(); b.anchors[slot] = merged;
      assertNotTrusted(f(b, id), `${slot}: Object.assign over JSON with __proto__`);
    }
  }
});

test('T-155: every anchor field INHERITED counts exactly as ABSENT (generated from the healthy anchors)', () => {
  for (const [slot, id] of ANCHOR_SLOTS) {
    for (const key of Object.keys(healthy().anchors[slot])) {
      const absent = healthy();
      absent.anchors[slot] = withoutKey(absent.anchors[slot], key);
      const inherited = healthy();
      inherited.anchors[slot] = Object.assign(Object.create({ [key]: healthy().anchors[slot][key] }), withoutKey(inherited.anchors[slot], key));
      assert.equal(Object.hasOwn(inherited.anchors[slot], key), false, `premise: ${key} not own`);
      assert.deepEqual(f(inherited, id), f(absent, id), `${slot}.${key} inherited must read as ${slot}.${key} absent`);
    }
  }
});

/*
 * THE GENERAL CLAIM, GENERATED: for every key that appears anywhere in the
 * healthy observation -- plus the aliases liveRegistry reads -- removing that
 * key everywhere and polluting Object.prototype with its healthy value must
 * leave the envelope byte-identical. A new field added to the fixture is
 * covered without anyone remembering to list it (rule 7).
 */
function allKeys(v, out = new Map()) {
  if (Array.isArray(v)) { for (const x of v) allKeys(x, out); return out; }
  if (v === null || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v)) { if (!out.has(k)) out.set(k, structuredClone(x)); allKeys(x, out); }
  return out;
}
function stripKey(v, key) {
  if (Array.isArray(v)) return v.map((x) => stripKey(x, key));
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== key).map(([k, x]) => [k, stripKey(x, key)]));
}
const outcome = (obs) => { try { return serializeEnvelope(compileEnvelope(obs)); } catch (e) { return `THREW ${e?.message}`; } };
const ALIASES = { session_id: 's1', sessionId: 's1', agent_id: 'w1', agentId: 'w1', heartbeat_at: T, lastSeenAt: T, last_seen_at: T, detail: 'x', details: { status: 'x' } };

test('T-155: polluting Object.prototype with ANY observed key never changes the envelope (generated)', async (t) => {
  const keys = allKeys(healthy());
  for (const [k, v] of Object.entries(ALIASES)) if (!keys.has(k)) keys.set(k, v);
  assert.ok(keys.size >= 40, `premise: the key set was generated (${keys.size})`);
  for (const [key, value] of keys) {
    await t.test(key, () => {
      const obs = stripKey(healthy(), key);
      const before = outcome(obs);
      const after = polluted(key, value, () => outcome(obs));
      assert.equal(after, before, `Object.prototype.${key} reached the envelope`);
    });
  }
});

test('T-155: a HOLE in a list is never filled from the prototype (rows, anchor lists, status)', () => {
  const cases = [
    ['tasks.rows', 'assignment_candidate', (o) => { o.tasks.rows = [, ...o.tasks.rows]; }, { task_id: 't-injected', state: 'runnable', updated_at: T }], // eslint-disable-line no-sparse-arrays
    ['roster.rows', 'channel_liveness', (o) => { o.roster.rows = [, ...o.roster.rows]; }, { sessionId: 's-ghost', agentId: 'x', capacity: 'idle', lastSeenAt: T }], // eslint-disable-line no-sparse-arrays
    ['baseline.status', 'baseline', (o) => { o.baseline.status = [, ...o.baseline.status]; }, '?? injected.txt'], // eslint-disable-line no-sparse-arrays
    ['anchors.assignment.current', 'assignment_candidate', (o) => { o.anchors.assignment.current = [, ...o.anchors.assignment.current]; }, 't-injected'], // eslint-disable-line no-sparse-arrays
  ];
  for (const [where, id, holed, injected] of cases) {
    const obs = healthy();
    holed(obs);
    const before = outcome(obs);
    const after = polluted('0', injected, () => outcome(obs));
    assert.equal(after, before, `${where} (${id}): a hole read Object.prototype[0]`);
  }
});

/* ── T-155 / rule 11: C34, the missing runtime is refused EXPLICITLY ─────── */

test('T-155 / C34: a missing or malformed runtime is refused by name, not by the M25 guard', () => {
  assert.equal(f(healthy(), 'channel_liveness').trust_state, TRUST.TRUSTED, 'positive control');
  for (const runtime of [undefined, { ok: false, detail: 'gone' }, { ok: true, observed_at: T }, { ok: true, observed_at: T, rows: 'x' }]) {
    const obs = healthy();
    if (runtime === undefined) delete obs.runtime; else obs.runtime = runtime;
    const fld = f(obs, 'channel_liveness');
    assertNotTrusted(fld, `runtime ${JSON.stringify(runtime)}`);
    assert.match(fld.reason, /no runtime observation to check the roster against/);
    assert.doesNotMatch(fld.reason, /could not be classified/, 'refused only because something threw');
  }
});

/* ── T-157: a value of the wrong SHAPE in a record slot is refused, never read ── */

/*
 * T-155 copied OBJECTS into null-prototype records, but passed primitives
 * through and copied arrays into ordinary Arrays -- and reading `.kind` on an
 * Array or a string walks Object.prototype all the same. The T-155 generated
 * test built only object-shaped bases, so it could not construct the case
 * (rule 9). Everything below is GENERATED from the real fixture: every place
 * healthy() holds a record, replaced by every non-record shape, under every
 * observed key polluted one at a time AND under the whole displaced record
 * polluted at once (the promotion attack). Adding a record to the fixture
 * extends the coverage without anybody listing it (rule 7).
 */
const NON_RECORDS = [[], ['x'], [{}], 'x', '', 0, 1, true, false, null];

/** Every path below the root at which `v` holds a record (a non-null, non-array object). */
function recordPaths(v, at = [], out = []) {
  if (v === null || typeof v !== 'object') return out;
  if (at.length && !Array.isArray(v)) out.push(at);
  for (const [k, x] of Object.entries(v)) recordPaths(x, [...at, Array.isArray(v) ? Number(k) : k], out);
  return out;
}
const getAt = (o, p) => p.reduce((c, k) => c[k], o);
const setAt = (o, p, x) => { getAt(o, p.slice(0, -1))[p.at(-1)] = x; return o; };

/* Two record slots healthy() never populates: `details` and a drift entry. Each
 * base makes its slot READ -- details only reach a reason when a component
 * fails, so the head is broken there, and asserted to be quoted. */
function withDetails() {
  const obs = healthy();
  obs.baseline.head = 'not-a-sha';
  obs.baseline.details = { head: 'git said no' };
  return obs;
}
function withDrift() {
  const obs = healthy();
  obs.baseline.drift = [{ file: 'CLAUDE.md', now: 'modified', kind: 'protected' }];
  return obs;
}

/** The field(s) that read a record slot, from the slot's path. */
function ownersOf(p) {
  if (p[0] === 'tasks') return ['assignment_candidate'];
  if (p[0] === 'baseline') return ['baseline'];
  if (p[0] === 'protected') return ['protected_frozen'];
  if (p[0] === 'roster' || p[0] === 'runtime') return ['channel_liveness'];
  if (p[0] === 'anchors' && p[1] === 'assignment') return ['assignment_candidate'];
  if (p[0] === 'anchors' && p[1] === 'liveness') return ['channel_liveness'];
  if (p[0] === 'anchors') return ['assignment_candidate', 'channel_liveness'];
  throw new Error(`no owner for ${p.join('.')}`);
}

const RECORD_SLOTS = [
  ...recordPaths(healthy()).map((p) => [p, healthy]),
  [['baseline', 'details'], withDetails],
  [['baseline', 'drift', 0], withDrift],
];

function pollutedAll(rec, fn) {
  const keys = Object.keys(rec);
  for (const k of keys) assert.equal(Object.hasOwn(Object.prototype, k), false, `Object.prototype.${k} already exists`);
  for (const k of keys) Object.prototype[k] = rec[k]; // eslint-disable-line no-extend-native
  try {
    for (const k of keys) assert.equal(({})[k], rec[k], `pollution of ${k} did not land`);
    return fn();
  } finally {
    for (const k of keys) delete Object.prototype[k];
    for (const k of keys) assert.equal(Object.hasOwn(Object.prototype, k), false, `pollution of ${k} was not cleaned up`);
  }
}

/** assertNotTrusted, except that field 3 keeps its per-component container by design (AMENDMENT 1). */
const refused = (fld, why) => {
  if (fld.field_id !== 'baseline') return assertNotTrusted(fld, why);
  assert.notEqual(fld.trust_state, TRUST.TRUSTED, `baseline stayed TRUSTED: ${why}`);
  assert.ok(typeof fld.reason === 'string' && fld.reason.length > 0, `baseline is not TRUSTED and gives no reason: ${why}`);
};

test('T-157 premise: the generated record slots include every one the scope names', () => {
  const names = RECORD_SLOTS.map(([p]) => p.join('.'));
  for (const want of ['tasks', 'tasks.rows.0', 'baseline', 'baseline.details', 'baseline.drift.0', 'protected',
    'protected.patches.0', 'roster', 'roster.rows.0', 'runtime', 'runtime.rows.0', 'anchors', 'anchors.assignment', 'anchors.liveness']) {
    assert.ok(names.includes(want), `record slot ${want} was not generated (have ${names.join(', ')})`);
  }
  // The two extra bases really do READ their slot (rule 5: the positive first).
  assert.match(f(withDetails(), 'baseline').reason, /head: git said no/, 'premise: details reach the reason');
  assert.match(f(withDrift(), 'baseline').reason, /baseline drift: CLAUDE\.md modified protected/, 'premise: the drift entry is read');
});

test('T-157 R6: a NON-RECORD in any record slot is refused, and no pollution changes the envelope (generated)', async (t) => {
  const keys = allKeys(healthy());
  for (const [k, v] of Object.entries(ALIASES)) if (!keys.has(k)) keys.set(k, v);
  if (!keys.has('0')) keys.set('0', healthy().tasks.rows[0]);
  assert.ok(keys.size >= 40, `premise: the key set was generated (${keys.size})`);
  assert.ok(RECORD_SLOTS.length >= 18, `premise: the record slots were generated (${RECORD_SLOTS.length})`);
  for (const [p, base] of RECORD_SLOTS) {
    const where = p.join('.');
    const displaced = getAt(base(), p);
    assert.ok(displaced !== null && typeof displaced === 'object' && !Array.isArray(displaced), `premise: ${where} holds a record`);
    await t.test(where, () => {
      for (const bad of NON_RECORDS) {
        const obs = setAt(base(), p, structuredClone(bad));
        const label = `${where} = ${JSON.stringify(bad)}`;
        const before = outcome(obs);
        assert.doesNotMatch(before, /^THREW/, `${label}: compileEnvelope threw`);
        const env = JSON.parse(before);
        for (const id of ownersOf(p)) {
          assert.notEqual(env.fields[id].trust_state, TRUST.TRUSTED, `${label}: ${id} TRUSTED`);
          assert.doesNotMatch(env.fields[id].reason, /could not be classified/, `${label}: ${id} refused only because something threw`);
        }
        // The promotion attack: every key of the displaced record, inherited at once.
        assert.equal(pollutedAll(displaced, () => outcome(obs)), before, `${label}: the displaced record, inherited, reached the envelope`);
        for (const [key, value] of keys) {
          assert.equal(polluted(key, value, () => outcome(obs)), before, `${label}: Object.prototype.${key} reached the envelope`);
        }
      }
    });
  }
});

/*
 * The root and the anchors container cannot be reached by the generated test
 * above: an ordinary `[]` there has no own keys, so reading it by own key
 * already found nothing on T-155. What the record rule adds is that an ARRAY
 * CARRYING OWN KEYS (built in code, or merged by Object.assign) is still not a
 * record. Without this test that rule is a mutation nobody can observe (rule 11).
 */
test('T-157: the observations root and the anchors container are record slots -- an Array with own keys is not read', () => {
  for (const id of ['assignment_candidate', 'channel_liveness']) {
    assert.equal(f(healthy(), id).trust_state, TRUST.TRUSTED, `${id} positive control`);
  }
  const obs = healthy();
  obs.anchors = Object.assign([], healthy().anchors);
  assert.equal(Object.hasOwn(obs.anchors, 'assignment') && Array.isArray(obs.anchors), true, 'premise: an Array carrying own anchor keys');
  for (const id of ['assignment_candidate', 'channel_liveness']) {
    const fld = f(obs, id);
    assertNotTrusted(fld, `${id}: anchors container is an Array`);
    assert.equal(fld.reason, 'no completeness anchor', `${id}: an Array container must read as NO anchor`);
  }
  const root = Object.assign([], healthy());
  assert.equal(Object.hasOwn(root, 'generated_at') && Array.isArray(root), true, 'premise: an Array carrying own observation keys');
  assert.throws(() => compileEnvelope(root), /generated_at must be an ISO 8601 UTC timestamp/, 'an Array root was read as observations');
});

test('T-157: the four T-156 plain-JSON repros give the same envelope with and without pollution', () => {
  const cases = [
    ['anchors.assignment = []', 'assignment_candidate', (o) => { o.anchors.assignment = []; }, healthy().anchors.assignment],
    ['anchors.liveness = "x"', 'channel_liveness', (o) => { o.anchors.liveness = 'x'; }, healthy().anchors.liveness],
    ['{generated_at, baseline: []}', 'baseline', () => ({ generated_at: T, baseline: [] }), withoutKey(healthy().baseline, 'observed_at')],
    ['a trailing [] roster row', 'channel_liveness', (o) => { o.roster.rows.push([]); }, { sessionId: 's-ghost' }],
  ];
  for (const [what, id, make, pollution] of cases) {
    const obs = healthy();
    const built = make(obs) ?? obs;
    const before = outcome(built);
    assert.notEqual(JSON.parse(before).fields[id].trust_state, TRUST.TRUSTED, `${what}: TRUSTED unpolluted`);
    const after = pollutedAll(pollution, () => outcome(built));
    assert.equal(JSON.parse(after).fields[id].trust_state, JSON.parse(before).fields[id].trust_state, `${what}: pollution moved ${id}`);
    assert.equal(after, before, `${what}: pollution changed the envelope`);
  }
});

test('T-157: a list ELEMENT that is not a record demotes its field BY NAME -- never read, never dropped', () => {
  const lists = [
    ['tasks.rows', 'assignment_candidate', healthy, (o) => o.tasks.rows],
    ['roster.rows', 'channel_liveness', healthy, (o) => o.roster.rows],
    ['runtime.rows', 'channel_liveness', healthy, (o) => o.runtime.rows],
    ['protected.patches', 'protected_frozen', healthy, (o) => o.protected.patches],
  ];
  for (const [where, id, base] of lists) {
    assert.equal(f(base(), id).trust_state, TRUST.TRUSTED, `${where} positive control`);
  }
  for (const [where, id, base, list] of [...lists, ['baseline.drift', 'baseline', withDrift, (o) => o.baseline.drift]]) {
    for (const bad of [...NON_RECORDS, undefined]) {
      const obs = base();
      list(obs).push(structuredClone(bad));
      const fld = f(obs, id);
      refused(fld, `${where} + ${JSON.stringify(bad)}`);
      assert.match(fld.reason, /not a record/, `${where} + ${JSON.stringify(bad)}: the malformed entry is not named`);
      assert.doesNotMatch(fld.reason, /could not be classified/, `${where} + ${JSON.stringify(bad)}: refused by the catch-all`);
    }
    // A real HOLE (not an undefined element): it must demote by name too, not vanish.
    const obs = base();
    const xs = list(obs);
    xs.length += 1;
    assert.equal(Object.hasOwn(xs, xs.length - 1), false, `premise: ${where} ends in a hole`);
    const fld = f(obs, id);
    refused(fld, `${where} + a hole`);
    assert.match(fld.reason, /not a record/, `${where} + a hole: the hole is not named`);
  }
});

test('T-157: an inherited toJSON never reaches the serialised envelope', () => {
  const envs = [compileEnvelope(healthy()), compileEnvelope({ generated_at: T }), compileEnvelope(withDrift())];
  for (const env of envs) {
    // Behaviour preserved: unpolluted, the bytes are exactly JSON.stringify's.
    assert.equal(serializeEnvelope(env), `${JSON.stringify(env, null, 2)}\n`, 'serialisation changed shape');
    const before = serializeEnvelope(env);
    const after = polluted('toJSON', function toJSON() { return 'POLLUTED'; }, () => {
      assert.equal(JSON.stringify({ a: 1 }), '"POLLUTED"', 'premise: the toJSON pollution acts on JSON.stringify');
      return serializeEnvelope(env);
    });
    assert.equal(after, before, 'Object.prototype.toJSON reached the serialised envelope');
  }
  // The copy's own hole rule, tested directly: compileEnvelope never emits a
  // hole today, so without this the rule is a mutation nobody can observe (rule 11).
  const holed = { list: [, 'b'] }; // eslint-disable-line no-sparse-arrays
  const plain = serializeEnvelope(holed);
  assert.equal(plain, `${JSON.stringify(holed, null, 2)}\n`, 'a hole serialises as null, as JSON.stringify does');
  assert.equal(polluted('0', 'POLLUTED', () => serializeEnvelope(holed)), plain, 'a hole was read through Object.prototype');
});

/*
 * THE SAME PROPERTY ONE LEVEL DOWN (observer O-2..O-4): a SCALAR of the wrong
 * shape. Date.parse and RegExp#test coerce, so `["<iso>"]` parsed as a
 * timestamp and `["<40 hex>"]` passed as a HEAD; a null-prototype object threw
 * into the catch-all. Generated from every scalar the fixture holds: a wrong
 * shape either demotes the field BY NAME, or -- where the field stays TRUSTED
 * -- reads EXACTLY as if the key were absent. It is never read as a value.
 */
function scalarPaths(v, at = [], out = []) {
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) scalarPaths(x, [...at, Array.isArray(v) ? Number(k) : k], out);
  } else if (at.length > 1) out.push(at);
  return out;
}

test('T-157: a SCALAR of the wrong shape is refused by name or reads exactly as absent (generated)', () => {
  const paths = scalarPaths(healthy());
  assert.ok(paths.length >= 60, `premise: the scalar slots were generated (${paths.length})`);
  let demoted = 0;
  for (const p of paths) {
    const orig = getAt(healthy(), p);
    const absent = healthy();
    delete getAt(absent, p.slice(0, -1))[p.at(-1)];
    const shapes = [{ x: 1 }, {}, [], ['x'], [orig], 7, true, 'x'].filter((s) => typeof s !== typeof orig);
    for (const shape of shapes) {
      for (const id of ownersOf(p)) {
        const label = `${p.join('.')} = ${JSON.stringify(shape)} (${id})`;
        const fld = f(setAt(healthy(), p, structuredClone(shape)), id);
        if (fld.trust_state === TRUST.TRUSTED) {
          assert.deepEqual(fld, f(absent, id), `${label}: TRUSTED, and not as if the key were absent`);
        } else {
          demoted += 1;
          assert.doesNotMatch(fld.reason, /could not be classified/, `${label}: refused only because something threw`);
        }
      }
    }
  }
  assert.ok(demoted > 0, 'premise: some wrong shape demoted');
});

test('T-157 / O-2: a status entry that is not a string makes the tree NOT clean -- never filtered away', () => {
  const clean = healthy();
  assert.equal(f(clean, 'baseline').value.components.cleanliness.trust_state, TRUST.TRUSTED, 'positive control');
  for (const entry of [{ s: 1 }, 7, true, null, ['M x'], []]) {
    const obs = healthy();
    obs.baseline.status = [structuredClone(entry)];
    const fld = f(obs, 'baseline');
    refused(fld, `status [${JSON.stringify(entry)}]`);
    assert.equal(fld.value.components.cleanliness.trust_state, TRUST.UNTRUSTWORTHY, `status [${JSON.stringify(entry)}]`);
    assert.match(fld.value.components.cleanliness.reason, /1 status entry that is not text/, `status [${JSON.stringify(entry)}]`);
  }
});

test('T-157 / O-5: `details` that is not a record is ABSENT -- the default reason, polluted or not', () => {
  assert.match(f(withDetails(), 'baseline').reason, /head: git said no/, 'positive control: a record details IS read');
  for (const details of [[], ['x'], 'x', 7]) {
    const obs = withDetails();
    obs.baseline.details = details;
    const before = outcome(obs);
    assert.match(JSON.parse(before).fields.baseline.reason, /head: HEAD did not resolve to a commit/, `details ${JSON.stringify(details)}`);
    const after = polluted('head', 'POLLUTED-DETAIL', () => outcome(obs));
    assert.equal(after, before, `details ${JSON.stringify(details)}: Object.prototype.head reached the reason`);
  }
});

test('T-157 / R5: a non-string task_id is refused by NAME, never by a String() that throws', () => {
  assert.equal(f(healthy(), 'assignment_candidate').trust_state, TRUST.TRUSTED, 'positive control');
  for (const id of [{ id: 'T-9' }, {}, [], ['T-9'], 7, true, null]) {
    const obs = healthy();
    obs.tasks.rows.push({ task_id: structuredClone(id), state: 'runnable', updated_at: ago(60_000) });
    const fld = f(obs, 'assignment_candidate');
    assertNotTrusted(fld, `task_id ${JSON.stringify(id)}`);
    assert.match(fld.reason, /open row without an id: 1 row/, `task_id ${JSON.stringify(id)}`);
    assert.doesNotMatch(fld.reason, /could not be classified/, `task_id ${JSON.stringify(id)}: refused by the catch-all`);
  }
  // The same trap in the other id-shaped slots: a patch's file and a drift entry's labels.
  for (const bad of [{ id: 'x' }, [], ['x'], 7, null]) {
    const p = healthy();
    p.protected.patches[0].file = structuredClone(bad);
    const pf = f(p, 'protected_frozen');
    assertNotTrusted(pf, `patch file ${JSON.stringify(bad)}`);
    assert.doesNotMatch(pf.reason, /could not be classified/, `patch file ${JSON.stringify(bad)}: refused by the catch-all`);
    for (const k of ['file', 'now', 'kind']) {
      const d = withDrift();
      d.baseline.drift[0][k] = structuredClone(bad);
      const df = f(d, 'baseline');
      refused(df, `drift ${k} ${JSON.stringify(bad)}`);
      assert.doesNotMatch(df.reason, /could not be classified/, `drift ${k} ${JSON.stringify(bad)}: refused by the catch-all`);
    }
  }
});

/* ── T-157 rework (T-161 verifier): every input property is read ONCE ─────── */

/*
 * A check and a use that read the same input property twice can see two
 * different values: an accessor answered {} to the isRecord test on
 * observations.anchors and then an Array carrying valid anchors to the read,
 * and both fields promoted. The instance was one line; the property is "no
 * input property is read more than once", so the test is GENERATED: every own
 * property at every depth of the fixture becomes a counting accessor (rule 8).
 */
function instrumented(v, counts, at = '') {
  if (v === null || typeof v !== 'object') return v;
  const out = Array.isArray(v) ? new Array(v.length) : {};
  for (const [k, x] of Object.entries(v)) {
    const path = at ? `${at}.${k}` : k;
    const child = instrumented(x, counts, path);
    counts.set(path, 0);
    Object.defineProperty(out, k, {
      enumerable: true, configurable: true, get() { counts.set(path, counts.get(path) + 1); return child; },
    });
  }
  return out;
}

test('T-157 rework: every input property, at every depth, is read EXACTLY once (generated)', () => {
  for (const [name, base] of [['healthy', healthy], ['details', withDetails], ['drift', withDrift]]) {
    const counts = new Map();
    const obs = instrumented(base(), counts);
    assert.ok(counts.size >= 60, `premise: ${name} was instrumented (${counts.size} properties)`);
    // Positive first: the instrumented input classifies exactly like the plain one.
    assert.equal(outcome(obs), outcome(base()), `${name}: an instrumented input changed the envelope`);
    const counts2 = new Map();
    compileEnvelope(instrumented(base(), counts2));
    const wrong = [...counts2].filter(([, n]) => n !== 1).map(([p, n]) => `${p} read ${n}x`);
    assert.deepEqual(wrong, [], `${name}: input properties not read exactly once`);
    // The read goes through a property DESCRIPTOR, an ordinary object: its fields
    // must be read as own, or a polluted Object.prototype.value answers for a getter.
    const accessorInput = instrumented(base(), new Map());
    assert.equal(polluted('value', 'POLLUTED', () => outcome(accessorInput)), outcome(base()),
      `${name}: Object.prototype.value reached the envelope through an accessor's descriptor`);
  }
});

/*
 * THE SAME CHECK-THEN-USE, ONE LEVEL IN: Object.hasOwn(v, k) followed by v[k]
 * is two reads, and a Proxy can answer them differently. Its descriptor says
 * "own" while its [[Get]] falls through to the target and walks the prototype.
 * The value must come from the descriptor that proved it own.
 */
function claimsOwn(target, key) {
  return new Proxy(target, {
    ownKeys: (t) => [...new Set([...Reflect.ownKeys(t), key])],
    getOwnPropertyDescriptor: (t, k) => (k === key && !Object.hasOwn(t, k)
      ? { value: undefined, writable: true, enumerable: true, configurable: true }
      : Reflect.getOwnPropertyDescriptor(t, k)),
  });
}

test('T-157 rework: a Proxy that CLAIMS a key is own never lets the read reach the prototype', () => {
  for (const [slot, id] of ANCHOR_SLOTS) {
    for (const kind of ANCHOR_KINDS) {
      const obs = healthy();
      obs.anchors[slot] = claimsOwn(withoutKey(obs.anchors[slot], 'kind'), 'kind');
      assert.equal(Object.hasOwn(obs.anchors[slot], 'kind'), true, 'premise: the proxy claims kind is own');
      const fld = polluted('kind', kind, () => {
        assert.equal(obs.anchors[slot].kind, kind, 'premise: its [[Get]] reaches Object.prototype.kind');
        return f(obs, id);
      });
      assertNotTrusted(fld, `${slot}: kind claimed own, read from Object.prototype (${kind})`);
      assert.match(fld.reason, /kind not recognised/);
    }
  }
  // A hole the proxy claims is own, in a list of records.
  const obs = healthy();
  const rows = [...obs.tasks.rows];
  rows.length += 1;
  obs.tasks.rows = claimsOwn(rows, String(rows.length - 1));
  const before = outcome(obs);
  const injected = { task_id: 't-injected', state: 'runnable', updated_at: T };
  assert.equal(polluted(String(rows.length - 1), injected, () => outcome(obs)), before, 'a claimed-own hole read Object.prototype');
});

/*
 * An Array's `length` is an input property too. On a real Array it is plain
 * data, so a re-read is invisible; through a Proxy it is a [[Get]] like any
 * other, and a list whose length moves between reads is copied inconsistently.
 * Without this test the "read length once" rule is a mutation nobody can see
 * (rule 11).
 */
test('T-157 rework: a list\'s length is read ONCE (every list the fixture holds)', () => {
  const lists = [];
  (function walk(v, at) {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) lists.push(at);
    for (const [k, x] of Object.entries(v)) walk(x, [...at, Array.isArray(v) ? Number(k) : k]);
  }(healthy(), []));
  assert.ok(lists.length >= 8, `premise: lists were generated (${lists.length})`);
  for (const p of lists) {
    const obs = healthy();
    let reads = 0;
    setAt(obs, p, new Proxy(getAt(obs, p), { get: (t, k, r) => { if (k === 'length') reads += 1; return Reflect.get(t, k, r); } }));
    assert.equal(outcome(obs), outcome(healthy()), `${p.join('.')}: a counted list changed the envelope`);
    assert.equal(reads, 1, `${p.join('.')}.length read ${reads} times`);
  }
});

test('T-161 repro: an anchors accessor answering {} then an Array of valid anchors never promotes', () => {
  const arr = () => Object.assign([], healthy().anchors);
  assert.equal(Object.hasOwn(arr(), 'assignment'), true, 'premise: the Array carries own anchor keys');
  for (const [what, make] of [
    ['flip {} then Array', () => { let n = 0; return { get: () => { n += 1; return n === 1 ? {} : arr(); }, reads: () => n }; }],
    ['the same Array every read (control)', () => { let n = 0; const a = arr(); return { get: () => { n += 1; return a; }, reads: () => n }; }],
  ]) {
    const acc = make();
    const obs = healthy();
    Object.defineProperty(obs, 'anchors', { enumerable: true, configurable: true, get: acc.get });
    const env = compileEnvelope(obs);
    for (const id of ['assignment_candidate', 'channel_liveness']) {
      assertNotTrusted(env.fields[id], `${what}: ${id}`);
    }
    assert.equal(acc.reads(), 1, `${what}: observations.anchors was read ${acc.reads()} times`);
  }
  const plain = healthy();
  plain.anchors = arr();
  assertNotTrusted(f(plain, 'assignment_candidate'), 'a plain Array container (control)');
});

test('T-157 rework: generated_at that is not a STRING is refused, however it coerces', () => {
  const obs = healthy();
  assert.equal(compileEnvelope(obs).generated_at, T, 'positive control');
  for (const [what, bad] of [
    ['[T]', [T]],
    ['new String(T)', new String(T)], // eslint-disable-line no-new-wrappers
    ['{toString}', { toString: () => T }],
  ]) {
    assert.equal(String(bad), T, `premise: ${what} coerces to the ISO string`);
    const o = healthy();
    o.generated_at = bad;
    assert.throws(() => compileEnvelope(o), /generated_at must be an ISO 8601 UTC timestamp/, what);
  }
});

test('T-161 (a): a task row whose state is outside the task vocabulary demotes field 2 -- never read as closed', () => {
  // Positive: the two CLOSED states are read as closed and field 2 still promotes.
  for (const state of ['accepted', 'cancelled']) {
    const obs = healthy();
    obs.tasks.rows.push({ task_id: `t-closed-${state}`, state, updated_at: ago(60_000) });
    assert.equal(f(obs, 'assignment_candidate').trust_state, TRUST.TRUSTED, `closed state ${state}: ${f(obs, 'assignment_candidate').reason}`);
  }
  for (const state of ['in_progress', 'Runnable', 'RUNNABLE', ' runnable', 'done', '', null, undefined]) {
    const obs = healthy();
    const row = { task_id: 't-odd', updated_at: ago(60_000) };
    if (state !== undefined) row.state = state;
    obs.tasks.rows.push(row);
    const fld = f(obs, 'assignment_candidate');
    assertNotTrusted(fld, `state ${JSON.stringify(state)}`);
    assert.match(fld.reason, /state is not in the task vocabulary: t-odd/, `state ${JSON.stringify(state)}`);
  }
});

test('T-161 (c): a patch listed TWICE demotes field 4', () => {
  assert.equal(f(healthy(), 'protected_frozen').trust_state, TRUST.TRUSTED, 'positive control');
  const obs = healthy();
  obs.protected.patches.push(structuredClone(obs.protected.patches[0]));
  const fld = f(obs, 'protected_frozen');
  assertNotTrusted(fld, 'duplicate patch entry');
  assert.match(fld.reason, /T-002-222222222222\.patch: listed more than once/);
});

test('T-161 (c) LIMIT, pinned: an EMPTY manifest with NO candidates is TRUSTED, and says there are none', () => {
  const obs = healthy();
  setManifest(obs, '');
  obs.protected.patches = [];
  const fld = f(obs, 'protected_frozen');
  assert.equal(fld.trust_state, TRUST.TRUSTED, 'LIMIT changed: an empty manifest with no candidates is no longer TRUSTED -- update the limit note');
  assert.deepEqual(fld.value.candidates, []);
});

/*
 * A LIMIT FOR RUN 2 ONLY, AND A PRECONDITION (T-173): this must be closed
 * BEFORE any anchor source is wired, because AMENDMENT 2 asks for evidence the
 * work is "known to be current". When it is closed this test goes red: replace
 * it with the freshness rule's own tests, do not delete it quietly.
 */
test('T-161 (b) LIMIT, pinned: an anchor\'s observed_at is not read, so a month-old anchor still promotes', () => {
  const obs = healthy();
  obs.anchors.assignment.observed_at = ago(30 * 86400_000);
  obs.anchors.liveness.observed_at = ago(30 * 86400_000);
  assert.equal(f(obs, 'assignment_candidate').trust_state, TRUST.TRUSTED, 'LIMIT changed (field 2): anchor observed_at is now read -- update the limit note');
  assert.equal(f(obs, 'channel_liveness').trust_state, TRUST.TRUSTED, 'LIMIT changed (field 6): anchor observed_at is now read -- update the limit note');
});

test('T-161 (d): an anchor labelled by ANY judged source\'s identity never promotes -- either field, digest alone', () => {
  const REG = `C:/Users/x/.agentbridge/registrations.json sha256:${'d'.repeat(64)}`;
  const TASKS = `tasks-export sha256:${'e'.repeat(64)}`;
  for (const [id, slot, judged, set] of [
    ['assignment_candidate', 'assignment', 'runtime', (o) => { o.runtime.source_identity = REG; }],
    ['assignment_candidate', 'assignment', 'roster', (o) => { o.roster.source_identity = REG; }],
    ['channel_liveness', 'liveness', 'tasks', (o) => { o.tasks.source_identity = TASKS; }],
  ]) {
    const digest = (judged === 'tasks' ? 'e' : 'd').repeat(64);
    // Positive: the judged identities in place, the anchor labelled by an UNRELATED digest, promotes.
    const ok = healthy(); set(ok);
    ok.anchors[slot].source_identity = 'f'.repeat(64);
    assert.equal(f(ok, id).trust_state, TRUST.TRUSTED, `${id} positive control: ${f(ok, id).reason}`);
    for (const label of [digest, `sha256:${digest}`]) {
      const obs = healthy(); set(obs);
      obs.anchors[slot].source_identity = label;
      const fld = f(obs, id);
      assertNotTrusted(fld, `${id} anchor labelled by ${judged}'s digest (${label.slice(0, 16)}...)`);
      assert.match(fld.reason, /completeness anchor is not independent of the source it judges/);
    }
  }
});

/* ── T-157 rework 2 (T-173 verifier) ───────────────────────────────────── */

/*
 * NEW-F1. M25 promises a throw costs only its own field. But the guard built
 * its reason with `${e?.message ?? e}`, and describing a hostile thrown value
 * can itself throw. Then the whole of compileEnvelope threw. Generated: every
 * property at every depth of the fixture becomes a getter that throws each
 * hostile shape. The only permitted throw is the named generated_at TypeError.
 */
const HOSTILE_THROWN = [
  ['revoked Proxy', () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; }],
  ['Symbol', () => Symbol('boom')],
  ['null-prototype object', () => Object.create(null)],
  ['{get message(){throw}}', () => ({ get message() { throw new Error('inner'); } })],
  ['{message:{[Symbol.toPrimitive]:throw}}', () => ({ message: { [Symbol.toPrimitive]() { throw new Error('inner'); } } })],
];
function propertyPaths(v, at = [], out = []) {
  if (v === null || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v)) {
    const p = [...at, Array.isArray(v) ? Number(k) : k];
    out.push(p);
    propertyPaths(x, p, out);
  }
  return out;
}
const GENERATED_AT_ERROR = /^generated_at must be an ISO 8601 UTC timestamp/;
/** 'NAMED' when fn throws the named generated_at TypeError; otherwise a description that never inspects a hostile value. */
function thrownBy(fn) {
  let e;
  try { fn(); return 'DID NOT THROW'; } catch (x) { e = x; }
  if (typeof e !== 'object' || e === null) return `threw a ${typeof e}`;
  try {
    return e instanceof TypeError && GENERATED_AT_ERROR.test(e.message) ? 'NAMED' : `threw something else: ${String(e.message).slice(0, 120)}`;
  } catch { return 'threw a value that cannot be inspected'; }
}

test('T-173 NEW-F1: a getter throwing ANY hostile value costs only its own field (generated: every path x 5 shapes)', () => {
  const paths = propertyPaths(healthy());
  assert.ok(paths.length >= 60, `premise: paths were generated (${paths.length})`);
  // Premise: each shape really does defeat a naive `${e?.message ?? e}`.
  for (const [what, make] of HOSTILE_THROWN) {
    assert.throws(() => `${make()?.message ?? make()}`, undefined, `premise: ${what} breaks a template`);
  }
  let cases = 0;
  const escaped = [];
  const unnamed = [];
  for (const p of paths) {
    for (const [what, make] of HOSTILE_THROWN) {
      const obs = healthy();
      Object.defineProperty(getAt(obs, p.slice(0, -1)), p.at(-1), { enumerable: true, configurable: true, get() { throw make(); } });
      const label = `${p.join('.')} throws ${what}`;
      cases += 1;
      if (p.length === 1 && p[0] === 'generated_at') {
        const how = thrownBy(() => compileEnvelope(obs));
        if (how !== 'NAMED') unnamed.push(`${label}: ${how}`);
        continue;
      }
      // Caught here rather than by assert.doesNotThrow, which itself inspects the
      // thrown value -- and a revoked Proxy throws again on inspection.
      let env;
      try { env = compileEnvelope(obs); } catch { escaped.push(label); continue; }
      for (const id of ownersOf(p)) {
        const fld = env.fields[id];
        // Field 3 refuses PER COMPONENT (T-179 F1): it keeps its per-component
        // container (refused() checks trust and reason, not value === null),
        // and its reason carries the component name first ("head: observation
        // could not be classified: ..."). Every other field is unchanged.
        refused(fld, label);
        assert.match(fld.reason, id === 'baseline' ? /observation could not be classified: / : /^observation could not be classified: /, label);
      }
      assert.doesNotThrow(() => serializeEnvelope(env), `${label}: serialisation`);
    }
  }
  assert.ok(cases >= 300, `premise: cases ran (${cases})`);
  assert.equal(escaped.length, 0, `the whole of compileEnvelope threw in ${escaped.length} of ${cases} cases, e.g. ${escaped.slice(0, 3).join('; ')}`);
  assert.deepEqual(unnamed, [], 'a throwing generated_at must give the named TypeError');
});

test('T-173 NEW-F1: the observations root itself, and generated_at of any value, fail ONLY with the named TypeError', () => {
  for (const [what, make] of HOSTILE_THROWN) {
    if (what !== 'revoked Proxy') continue;
    assert.equal(thrownBy(() => compileEnvelope(make())), 'NAMED', `root: ${what}`);
  }
  const cyclic = {}; cyclic.self = cyclic;
  for (const [what, value] of [
    ['revoked Proxy', HOSTILE_THROWN[0][1]()], ['Symbol', Symbol('x')], ['BigInt', 10n], ['cyclic', cyclic],
    ['throwing toJSON', { toJSON() { throw new Error('inner'); } }], ['function', () => T],
    // Type-checked BEFORE the regex: RegExp#test would call this toString.
    ['throwing toString', { toString() { throw new Error('inner'); } }],
  ]) {
    const obs = healthy();
    obs.generated_at = value;
    assert.equal(thrownBy(() => compileEnvelope(obs)), 'NAMED', `generated_at ${what}`);
  }
});

/*
 * NEW-F2. The manifest side of the duplicate-patch rule: one file name pinned
 * twice was last-wins, so the verdict depended on ORDER.
 */
test('T-173 NEW-F2: a name pinned MORE THAN ONCE in the manifest demotes field 4, in either order', () => {
  assert.equal(f(healthy(), 'protected_frozen').trust_state, TRUST.TRUSTED, 'positive control');
  const pin = (digest) => ['OK        T-001  AGAIN', `          ${digest}  100 B`, '          to   C:/y/T-001-111111111111.patch', ''].join('\n');
  const other = '7'.repeat(64);
  for (const [what, text] of [
    ['right pin first, conflicting pin last', `${MANIFEST}\n${pin(other)}`],
    ['conflicting pin first, right pin last', `${pin(other)}\n${MANIFEST}`],
    ['the same pin twice', `${MANIFEST}\n${pin(D1)}`],
  ]) {
    const obs = healthy();
    setManifest(obs, text);
    const fld = f(obs, 'protected_frozen');
    assertNotTrusted(fld, what);
    assert.match(fld.reason, /T-001-111111111111\.patch: pinned more than once in the manifest/, what);
  }
});

/* NEW-F3. A real claim always writes lease_expires_at; an assigned row without a usable one is not a claim. */
test('T-173 NEW-F3: an ASSIGNED row without a usable lease_expires_at demotes field 2 (missing, null, "x", number, [iso])', () => {
  assert.equal(f(healthy(), 'assignment_candidate').trust_state, TRUST.TRUSTED, 'positive control');
  const assigned = (o) => o.tasks.rows.find((r) => r.state === 'assigned');
  assert.ok(assigned(healthy()), 'premise: the fixture has an assigned row');
  for (const [what, set, named] of [
    ['missing', (r) => { delete r.lease_expires_at; }, true],
    ['null', (r) => { r.lease_expires_at = null; }, true],
    ['"x"', (r) => { r.lease_expires_at = 'x'; }, true],
    ['a number', (r) => { r.lease_expires_at = Date.parse(T) + 600_000; }, false],
    ['[iso]', (r) => { r.lease_expires_at = [ago(-600_000)]; }, false],
  ]) {
    const obs = healthy();
    set(assigned(obs));
    const fld = f(obs, 'assignment_candidate');
    assertNotTrusted(fld, `lease_expires_at ${what}`);
    assert.doesNotMatch(fld.reason, /could not be classified/, `lease_expires_at ${what}: catch-all`);
    if (named) assert.match(fld.reason, /assigned row\(s\) with no usable lease_expires_at: t-a/, `lease_expires_at ${what}`);
  }
});

/* NEW-F4. What a TRUSTED field publishes must be well formed, not merely text. */
test('T-173 NEW-F4: a TRUSTED field 2 publishes no malformed sha, lease or blank agent/session', () => {
  const row = (o, id) => o.tasks.rows.find((r) => r.task_id === id);
  for (const [what, set] of [
    ['base_sha "x"', (o) => { row(o, 't-a').base_sha = 'x'; }],
    ['base_sha of 39 hex', (o) => { row(o, 't-a').base_sha = 'a'.repeat(39); }],
    ['returned_head_sha "x"', (o) => { row(o, 't-a').returned_head_sha = 'x'; }],
    ['lease_expires_at "x" on a runnable row', (o) => { row(o, 't-b').lease_expires_at = 'x'; }],
    ['assigned_agent ""', (o) => { row(o, 't-a').assigned_agent = ''; }],
    ['assigned_agent " "', (o) => { row(o, 't-a').assigned_agent = ' '; }],
    ['assigned_session ""', (o) => { row(o, 't-a').assigned_session = ''; }],
    ['assigned_session " "', (o) => { row(o, 't-a').assigned_session = ' '; }],
  ]) {
    const obs = healthy();
    set(obs);
    const fld = f(obs, 'assignment_candidate');
    assertNotTrusted(fld, what);
    assert.match(fld.reason, /malformed value\(s\)/, what);
  }
  // Positive: well-formed values of the same keys still promote -- including an
  // upper-case sha, which the bridge's own head-sha check (/i) admits.
  const ok = healthy();
  row(ok, 't-a').returned_head_sha = 'C'.repeat(40);
  row(ok, 't-b').lease_expires_at = ago(-600_000);
  assert.equal(f(ok, 'assignment_candidate').trust_state, TRUST.TRUSTED, f(ok, 'assignment_candidate').reason);
});

test('T-173 NEW-F4: field 4 publishes `bytes` only as a positive integer, otherwise null (not reported)', () => {
  for (const [bytes, published] of [[100, 100], [0, null], [-1, null], [1.5, null], [2 ** 60, null]]) {
    const obs = healthy();
    obs.protected.patches[1].bytes = bytes;
    const fld = f(obs, 'protected_frozen');
    assert.equal(fld.trust_state, TRUST.TRUSTED, `bytes ${bytes}`);
    const c = fld.value.candidates.find((x) => x.file === obs.protected.patches[1].file);
    assert.equal(c.bytes, published, `bytes ${bytes}`);
  }
});

/*
 * NEW-F5. A list's length is an input: it is bounded and validated BEFORE anything iterates it.
 * Each claim is compiled in a CHILD with a kill (heavy(), below; T-187 H1). In-process, a
 * regression here spun synchronously over 2^32-1 elements: node:test's timeout needs the event
 * loop, so the WHOLE suite hung with no summary and every other red was masked (T-185, under a
 * mutant that removed the schema copy). Out of process it goes red by name. The claims
 * themselves are built in the child (LENGTH_CLAIMS in HEAVY_CHILD): NaN, a string and an object
 * with a throwing valueOf do not survive JSON.
 */
test('T-173 NEW-F5: a list claiming an absurd or non-integer length is refused at once, by name', () => {
  const claims = ['2^32-1', '2^31', '1e7', '-1', '2.5', 'NaN', 'the string "2"', 'an object whose valueOf throws'];
  for (const [i, what] of claims.entries()) {
    const r = heavy(`claimedLength${i}`);
    assert.equal(r.killed, undefined, `length ${what}: the child was killed -- the list was iterated, not refused`);
    assert.equal(r.claim, what, `premise: child claim ${i} is the one named here`);
    const fld = r.fields.assignment_candidate;
    assert.notEqual(fld.trust_state, TRUST.TRUSTED, `length ${what}: field 2 stayed TRUSTED`);
    assert.equal(fld.value_null, true, `length ${what}: not TRUSTED but still carries a value`);
    assert.match(fld.reason, /list length/, `length ${what}`);
    assert.ok(r.ms < 2000, `length ${what} took ${r.ms} ms`);
    for (const [id, other] of Object.entries(r.fields)) {
      if (id !== 'assignment_candidate') assert.equal(other.same, true, `length ${what}: ${id} changed (${other.reason})`);
    }
  }
  assert.equal(heavy('claimCount').count, claims.length, 'every claim the child can build is named here');
});

/* ── T-157 rework 3 (T-176 verifier) ───────────────────────────────────── */

/*
 * C. PURITY: THE SAME INPUT, THE SAME BYTES, IN EVERY TIME ZONE. Date.parse
 * reads a timestamp with no zone as LOCAL time, so a zone-less updated_at was
 * fresh under UTC and "dated in the future" under Los Angeles, a lease expired
 * only under Kiritimati, and heartbeats moved with it. The judge is a child
 * process per TZ, compiling the same JSON, compared byte for byte.
 */
const SRC_URL = new URL('../src/run2Envelope.mjs', import.meta.url).href;
const TZS = ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati'];
const CHILD = `
  const { compileEnvelope, serializeEnvelope } = await import(process.env.RUN2_SRC_URL);
  let input = '';
  for await (const c of process.stdin) input += c;
  const out = JSON.parse(input).map((o) => { try { return serializeEnvelope(compileEnvelope(o)); } catch (e) { return 'THREW ' + String(e && e.message); } });
  process.stdout.write(JSON.stringify({ offset: new Date(2026, 0, 1).getTimezoneOffset(), out }));
`;
function inZone(tz, observations) {
  const env = { ...process.env, TZ: tz, RUN2_SRC_URL: SRC_URL };
  for (const k of Object.keys(env)) if (/^NODE_TEST/i.test(k)) delete env[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { env, input: JSON.stringify(observations), encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, null, `child under ${tz} was killed after 30 s`);
  assert.equal(r.status, 0, `child under ${tz} failed: ${r.stderr.slice(0, 300)}`);
  return JSON.parse(r.stdout);
}
function zoneFixtures() {
  const zoneLess = (s) => s.replace(/(\.\d+)?Z$/, '');
  const variants = [];
  const a = healthy(); for (const r of a.tasks.rows) r.updated_at = zoneLess(r.updated_at); variants.push(a);
  const b = healthy(); b.tasks.rows[1].lease_expires_at = '2026-09-23T20:10:00'; variants.push(b);
  const c = healthy(); for (const r of c.roster.rows) r.lastSeenAt = zoneLess(r.lastSeenAt); variants.push(c);
  const d = healthy(); for (const r of d.runtime.rows) r.heartbeat_at = zoneLess(r.heartbeat_at); variants.push(d);
  const e = healthy(); e.tasks.observed_at = zoneLess(T); variants.push(e);
  // Real PostgREST shapes: +00:00 and microseconds. These must PROMOTE, in every zone.
  const pg = (s) => s.replace(/\.(\d{3})Z$/, '.$1456+00:00');
  const g = healthy();
  g.tasks.observed_at = pg(T);
  for (const r of g.tasks.rows) { r.updated_at = pg(r.updated_at); if (r.lease_expires_at) r.lease_expires_at = pg(r.lease_expires_at); }
  for (const r of g.roster.rows) r.lastSeenAt = pg(r.lastSeenAt);
  g.roster.observed_at = pg(T);
  variants.push(g);
  return variants;
}

test('T-176 C: the same observations give BYTE-IDENTICAL envelopes under three time zones', () => {
  const fixtures = zoneFixtures();
  const runs = TZS.map((tz) => [tz, inZone(tz, fixtures)]);
  assert.equal(new Set(runs.map(([, r]) => r.offset)).size, 3, `premise: the three children really run in three zones (${runs.map(([tz, r]) => `${tz}=${r.offset}`).join(', ')})`);
  for (let i = 0; i < fixtures.length; i += 1) {
    const [tz0, r0] = runs[0];
    for (const [tz, r] of runs.slice(1)) {
      assert.equal(r.out[i], r0.out[i], `fixture ${i}: ${tz} differs from ${tz0}`);
    }
  }
  const pgEnv = JSON.parse(runs[0][1].out.at(-1));
  for (const id of ['assignment_candidate', 'channel_liveness']) {
    assert.equal(pgEnv.fields[id].trust_state, TRUST.TRUSTED, `PostgREST +00:00 / microsecond forms must promote ${id}: ${pgEnv.fields[id].reason}`);
  }
});

test('T-176 C: every judged timestamp must carry Z or an explicit offset -- a zone-less or free-form one is refused', () => {
  const judged = [
    ['tasks.observed_at', 'assignment_candidate', (o, v) => { o.tasks.observed_at = v; }],
    ['tasks.rows[].updated_at', 'assignment_candidate', (o, v) => { o.tasks.rows[0].updated_at = v; }],
    ['assigned lease_expires_at', 'assignment_candidate', (o, v) => { o.tasks.rows[1].lease_expires_at = v; }],
    ['roster.observed_at', 'channel_liveness', (o, v) => { o.roster.observed_at = v; }],
    ['runtime.observed_at', 'channel_liveness', (o, v) => { o.runtime.observed_at = v; }],
    ['roster lastSeenAt', 'channel_liveness', (o, v) => { o.roster.rows[0].lastSeenAt = v; }],
    ['runtime heartbeat_at', 'channel_liveness', (o, v) => { o.runtime.rows[0].heartbeat_at = v; }],
    ['last_seen_at', 'channel_liveness', (o, v) => { o.runtime.rows[0].last_seen_at = v; }],
    ['baseline.observed_at', 'baseline', (o, v) => { o.baseline.observed_at = v; }],
    ['protected.observed_at', 'protected_frozen', (o, v) => { o.protected.observed_at = v; }],
  ];
  for (const [where, id, set] of judged) {
    // Positive: the same slot in a real PostgREST form promotes (a lease must lie in the future).
    // An observed_at is the fixture's own instant T; a heartbeat or update lies just before it.
    const good = where.includes('lease') ? '2026-09-23T20:10:00.123456+00:00'
      : where.includes('observed_at') ? '2026-09-23T20:00:00.000456+00:00' : '2026-09-23T19:59:30.123456+00:00';
    const ok = healthy(); set(ok, good);
    assert.equal(f(ok, id).trust_state, TRUST.TRUSTED, `${where} PostgREST form: ${f(ok, id).reason}`);
    for (const bad of ['2026-09-23T19:59:30', '2026-09-23T19:59:30.123', '2026-09-23 19:59:30+00:00', '2099', 'Sep 30 2026', '2026-09-23T19:59:30+0000', '2026-02-30T00:00:00Z', '2026-09-23T24:00:00Z']) {
      const obs = healthy(); set(obs, bad);
      const fld = f(obs, id);
      assert.notEqual(fld.trust_state, TRUST.TRUSTED, `${where} = ${bad} stayed TRUSTED`);
      assert.doesNotMatch(fld.reason, /could not be classified/, `${where} = ${bad}: catch-all`);
    }
  }
});

/*
 * A. DESCRIBING A HUGE VALUE MUST NOT THROW EITHER. A message of 2^29-34
 * code units, or a generated_at of 1e8 control characters, made the reason
 * builder exceed V8's string limit: a RangeError escaped compileEnvelope.
 */
test('T-176 A: a huge thrown message or generated_at is described in a bounded reason, never a RangeError', () => {
  const huge = 'x'.repeat(2 ** 29 - 34);
  const obs = healthy();
  Object.defineProperty(obs.tasks, 'ok', { enumerable: true, get() { throw new Error(huge); } });
  let env;
  assert.doesNotThrow(() => { env = compileEnvelope(obs); }, 'a huge own message escaped compileEnvelope');
  assertNotTrusted(env.fields.assignment_candidate, 'huge message');
  assert.ok(env.fields.assignment_candidate.reason.length < 1000, `reason is ${env.fields.assignment_candidate.reason.length} code units`);
  const g = healthy();
  Object.defineProperty(g, 'generated_at', { enumerable: true, get() { throw new Error(huge); } });
  assert.equal(thrownBy(() => compileEnvelope(g)), 'NAMED', 'huge message on generated_at');
  const h = healthy();
  h.generated_at = '\x01'.repeat(1e8);
  let message = '';
  try { compileEnvelope(h); } catch (e) { message = e instanceof TypeError ? e.message : `not a TypeError: ${e?.name}`; }
  assert.match(message, GENERATED_AT_ERROR);
  // Bounded: at most CLIP (200) code units quoted, each escaped to at most 6.
  assert.ok(message.length < 2000, `generated_at message is ${message.length} code units`);
});

/*
 * B. TOTAL WORK IS BOUNDED. listLength bounded each list, but the copy walked
 * EVERY key -- including ones nothing reads -- so 1e6 aliases of one 1e5 list
 * under an ignored key took 45 s. Only the keys the compiler reads are copied,
 * and each observation's copy has a work budget.
 */
test('T-176 B: an IGNORED key is never read, however large', () => {
  const obs = healthy();
  let reads = 0;
  Object.defineProperty(obs.tasks, 'ignored_extra', { enumerable: true, get() { reads += 1; return []; } });
  Object.defineProperty(obs.tasks.rows[0], 'ignored_too', { enumerable: true, get() { reads += 1; return []; } });
  assert.equal(outcome(obs), outcome(healthy()), 'an ignored key changed the envelope');
  assert.equal(reads, 0, `ignored keys were read ${reads} times`);
});

/*
 * The heavy inputs run in a CHILD with a kill timeout: a synchronous copy that
 * never ends cannot be interrupted in-process (node:test's timeout needs the
 * event loop), so on a regression this test must go RED, not hang the suite.
 * The child builds each input itself -- serialising 1e6 aliases of a 1e5 list
 * would BE the 1e11-element blow-up.
 */
const HEAVY_CHILD = `
  const { compileEnvelope, serializeEnvelope } = await import(process.env.RUN2_SRC_URL);
  let input = '';
  for await (const c of process.stdin) input += c;
  const { base, which } = JSON.parse(input);
  const obs = structuredClone(base);
  const T = base.generated_at;
  const inner = new Array(1e5).fill('x');
  const record = (k) => ({ agentId: 'w' + k, sessionId: 's' + k, capacity: 'idle', lastSeenAt: T, a: 1, b: 2, c: 3, d: 4 });
  const build = {
    ignored: () => { obs.tasks.ignored_extra = new Array(1e6).fill(inner); },
    rowsOfLists: () => { obs.tasks.rows = new Array(1e6).fill(inner); },
    statusOfLists: () => { obs.baseline.status = new Array(1e6).fill(inner); },
    rowsOfOneRecord: () => { obs.tasks.rows = new Array(1e6).fill({ task_id: 't-z', state: 'runnable', updated_at: T }); },
    statusOfLongStrings: () => { obs.baseline.status = new Array(1e6).fill('?? ' + 'y'.repeat(2000)); },
    // T-179 F2: the anchor denylist was parts x label, across slots.
    manyPartsLongLabel: () => { obs.roster.source_identity = 'abcdefgh '.repeat(3e5); obs.anchors.assignment.source_identity = 'z'.repeat(1e6); },
    hugePartsHugeLabel: () => { obs.roster.source_identity = 'abcdefgh '.repeat(1e6); obs.anchors.assignment.source_identity = 'z'.repeat(1e7); },
    hugeTasksIdentity: () => { obs.tasks.source_identity = Array.from({ length: 4e6 }, (_, i) => 'p' + i.toString(36).padStart(8, '0')).join(' '); },
    proxyRows: () => {
      obs.roster.rows = new Proxy([], {
        get: (t, k, r) => (k === 'length' ? 1e6 : Reflect.get(t, k, r)),
        getOwnPropertyDescriptor: (t, k) => (/^\\d+$/.test(String(k))
          ? { value: record(k), writable: true, enumerable: true, configurable: true }
          : Reflect.getOwnPropertyDescriptor(t, k)),
      });
    },
  };
  // T-173 NEW-F5 (T-187 H1): a list that CLAIMS a length. Built here, since most do not survive JSON.
  const LENGTH_CLAIMS = [
    ['2^32-1', 2 ** 32 - 1], ['2^31', 2 ** 31], ['1e7', 1e7], ['-1', -1], ['2.5', 2.5], ['NaN', NaN],
    ['the string "2"', '2'], ['an object whose valueOf throws', { valueOf() { throw new Error('inner'); } }],
  ];
  build.claimCount = () => {};
  let claim;
  LENGTH_CLAIMS.forEach(([what, len], i) => {
    build['claimedLength' + i] = () => {
      claim = what;
      obs.tasks.rows = new Proxy(obs.tasks.rows, { get: (t, k, r) => (k === 'length' ? len : Reflect.get(t, k, r)) });
    };
  });
  build[which]();
  const plain = compileEnvelope(structuredClone(base));
  const started = Date.now();
  const env = compileEnvelope(obs);
  const ms = Date.now() - started;
  const fields = {};
  for (const [id, fld] of Object.entries(env.fields)) fields[id] = { trust_state: fld.trust_state, value_null: fld.value === null, same: serializeEnvelope(fld) === serializeEnvelope(plain.fields[id]), reason: String(fld.reason).slice(0, 200) };
  process.stdout.write(JSON.stringify({ ms, claim, count: LENGTH_CLAIMS.length, fields }));
`;
function heavy(which, killAfterMs = 20_000) {
  const env = { ...process.env, RUN2_SRC_URL: SRC_URL };
  for (const k of Object.keys(env)) if (/^NODE_TEST/i.test(k)) delete env[k];
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', HEAVY_CHILD], { env, input: JSON.stringify({ base: healthy(), which }), encoding: 'utf8', timeout: killAfterMs, maxBuffer: 1 << 24 });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { killed: true };
  assert.equal(r.status, 0, `${which}: child failed: ${String(r.stderr).slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

test('T-176 B: heavy inputs finish quickly and refuse ONLY the owning field (ignored, aliased and Proxy forms)', () => {
  // The last column names HOW the owning field must be refused: the element
  // shape rule, or the work budget (the budget is what bounds string volume).
  const cases = [
    ['ignored', 'tasks.ignored_extra = 1e6 aliases of one 1e5 list', null, null],
    ['rowsOfLists', 'tasks.rows = 1e6 aliases of one 1e5 list', 'assignment_candidate', /not a record/],
    ['statusOfLists', 'baseline.status = 1e6 aliases of one 1e5 list', 'baseline', /not text/],
    ['rowsOfOneRecord', 'tasks.rows = 1e6 aliases of one record', 'assignment_candidate', /work budget|duplicate id/],
    ['statusOfLongStrings', 'baseline.status = 1e6 aliases of one 2003-char line', 'baseline', /work budget/],
    ['proxyRows', 'roster.rows = a Proxy of 1e6 fresh records', 'channel_liveness', /work budget/],
  ];
  const slow = [];
  // ONE DEADLINE FOR THE WHOLE TEST (T-179 harness): each child is killed at
  // 15 s and no child starts after 60 s, so a regression that makes every case
  // hang (T-179's M26 hung the suite for 300 s) is RED within ~75 s, not a hang.
  const deadline = Date.now() + 60_000;
  for (const [which, what, id, how] of cases) {
    const left = deadline - Date.now();
    if (left <= 0) { slow.push(`${what}: not run -- the test's 60 s deadline was spent`); continue; }
    const r = heavy(which, Math.min(15_000, left));
    if (r.killed) { slow.push(`${what}: killed`); continue; }
    // 10 s, not the ~3 s measured alone: the bound must survive a loaded
    // machine (measured ~2x under 4 parallel runs); the regression it catches
    // was 45 s to hours, and a hang is killed at 20 s either way.
    if (r.ms > 10_000) slow.push(`${what}: ${r.ms} ms`);
    for (const [fid, fld] of Object.entries(r.fields)) {
      if (fid === id) {
        assert.notEqual(fld.trust_state, TRUST.TRUSTED, `${what}: ${fid} TRUSTED`);
        assert.match(fld.reason, how, `${what}: ${fid} refused for the wrong reason`);
      } else assert.equal(fld.same, true, `${what}: ${fid} changed (${fld.reason})`);
    }
  }
  assert.deepEqual(slow, [], 'heavy inputs must finish within 10 s');
});

test('T-176 B, rule 19: real large inputs stay within budget (10k task rows, a 1e6-line status)', () => {
  const rows = healthy();
  for (let i = 0; i < 10_000; i += 1) rows.tasks.rows.push({ task_id: `t-${i}`, state: 'accepted', updated_at: T });
  const fld = f(rows, 'assignment_candidate');
  assert.equal(fld.trust_state, TRUST.TRUSTED, `10k closed rows: ${fld.reason}`);
  const big = healthy();
  big.baseline.status = Array.from({ length: 1e6 }, (_, i) => `?? untracked/file-${String(i).padStart(7, '0')}.txt`);
  const b = f(big, 'baseline');
  assert.equal(b.value.components.cleanliness.trust_state, TRUST.UNTRUSTWORTHY);
  assert.match(b.value.components.cleanliness.reason, /working tree is not clean: 1000000 entries/, 'a 1e6-line status must be READ, not refused by the budget');
});

/*
 * D. EVERY MANY-TO-ONE STEP OF THE MANIFEST PARSER IS ORDER-FREE. Two digests
 * before one `to` kept the LAST; one digest before two `to` lines pinned the
 * FIRST. Generated: each such repeat, in every ordering of the entry's lines.
 */
function permutations(xs) {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}
test('T-176 D: a repeated digest or `to` step in a manifest entry demotes field 4, in EVERY ordering (generated)', () => {
  const header = 'OK        T-001  LANDED abc1234';
  const body = [`          ${D1}  100 B`, '          from C:\\scratch\\T-001.patch', '          to   C:\\Users\\x\\.agentbridge\\preserved\\candidates\\T-001-111111111111.patch'];
  const rest = MANIFEST.slice(MANIFEST.indexOf('\n4 other'));
  const manifest = (lines) => [MANIFEST.slice(0, MANIFEST.indexOf(header)), header, ...lines, rest].join('\n');
  assert.equal(f(healthy(), 'protected_frozen').trust_state, TRUST.TRUSTED, 'positive control');
  const ok = setManifest(healthy(), manifest(body));
  assert.equal(f(ok, 'protected_frozen').trust_state, TRUST.TRUSTED, `premise: the rebuilt manifest promotes: ${f(ok, 'protected_frozen').reason}`);
  const repeats = [
    ['a second digest', `          sha256 ${'7'.repeat(64)}`],
    ['the same digest again', `          ${D1}  100 B`],
    ['a second to', '          to   C:/y/T-009-999999999999.patch'],
    ['the same to again', '          to   C:/y/T-001-111111111111.patch'],
  ];
  let n = 0;
  for (const [what, extra] of repeats) {
    for (const order of permutations([...body, extra])) {
      const obs = healthy();
      setManifest(obs, manifest(order));
      n += 1;
      assert.notEqual(f(obs, 'protected_frozen').trust_state, TRUST.TRUSTED, `${what}, order ${JSON.stringify(order.map((l) => l.trim().slice(0, 8)))}`);
    }
  }
  assert.equal(n, 96, 'premise: 4 repeats x 24 orderings');
  // With no repeat, only an ordering that puts the digest BEFORE the `to` pins.
  for (const order of permutations(body)) {
    const obs = healthy();
    setManifest(obs, manifest(order));
    const digestFirst = order.indexOf(body[0]) < order.indexOf(body[2]);
    assert.equal(f(obs, 'protected_frozen').trust_state === TRUST.TRUSTED, digestFirst, `order ${JSON.stringify(order.map((l) => l.trim().slice(0, 8)))}`);
  }
  // A `to` line outside any entry pins nothing and is reported.
  const stray = healthy();
  setManifest(stray, `${MANIFEST}\n\n          to   C:/y/T-001-111111111111.patch\n`);
  assertNotTrusted(f(stray, 'protected_frozen'), 'a stray to line');
  assert.match(f(stray, 'protected_frozen').reason, /a "to" line outside any entry/);
});

/* E. "Carries nothing" has one definition: the module's own \\p{Cf} / default-ignorable strip. */
test('T-176 E: an id or agent/session made only of invisible characters is blank', () => {
  for (const blankish of ['\u200B', '\u200D', '\u200B \u200D', '\uFEFF', '\u00AD']) {
    for (const k of ['assigned_agent', 'assigned_session']) {
      const obs = healthy();
      obs.tasks.rows[1][k] = blankish;
      const fld = f(obs, 'assignment_candidate');
      assertNotTrusted(fld, `${k} = ${JSON.stringify(blankish)}`);
    }
    const t = healthy(); t.tasks.rows.push({ task_id: blankish, state: 'runnable', updated_at: T });
    assert.match(f(t, 'assignment_candidate').reason, /open row without an id/, `task_id ${JSON.stringify(blankish)}`);
    const s = healthy(); s.roster.rows[0].sessionId = blankish;
    assert.match(f(s, 'channel_liveness').reason, /no session id/, `sessionId ${JSON.stringify(blankish)}`);
    const p = healthy(); p.protected.protected_paths.push(blankish);
    assertNotTrusted(f(p, 'protected_frozen'), `protected_paths entry ${JSON.stringify(blankish)}`);
  }
});

/* F. One header rule for every computed field; closed rows and protected paths are not exempt. */
test('T-176 F: fields 2, 3, 4 and 6 demote alike on a missing or malformed observed_at / source_identity', () => {
  const slots = [['tasks', 'assignment_candidate'], ['baseline', 'baseline'], ['protected', 'protected_frozen'], ['roster', 'channel_liveness'], ['runtime', 'channel_liveness']];
  for (const [slot, id] of slots) {
    assert.equal(f(healthy(), id).trust_state, TRUST.TRUSTED, `${id} positive control`);
    for (const [key, bad] of [['observed_at', undefined], ['observed_at', 'x'], ['observed_at', [T]], ['source_identity', undefined], ['source_identity', ''], ['source_identity', ' '], ['source_identity', '\u200B'], ['source_identity', 7]]) {
      const obs = healthy();
      if (bad === undefined) delete obs[slot][key]; else obs[slot][key] = bad;
      const fld = f(obs, id);
      assert.notEqual(fld.trust_state, TRUST.TRUSTED, `${slot}.${key} = ${JSON.stringify(bad)}: ${id} TRUSTED`);
      assert.doesNotMatch(fld.reason, /could not be classified/, `${slot}.${key} = ${JSON.stringify(bad)}: catch-all`);
    }
  }
});

test('T-176 F: a CLOSED row without a string id, and a blank protected path, demote', () => {
  for (const id of [Symbol('x'), undefined, null, 7, {}, '', ' ']) {
    const obs = healthy();
    const row = { state: 'accepted', updated_at: T };
    if (id !== undefined) row.task_id = id;
    obs.tasks.rows.push(row);
    const fld = f(obs, 'assignment_candidate');
    assertNotTrusted(fld, `closed row task_id ${String(typeof id === 'symbol' ? 'Symbol' : JSON.stringify(id))}`);
    assert.doesNotMatch(fld.reason, /could not be classified/);
  }
  for (const p of [' ', '  ', '\t']) {
    const obs = healthy(); obs.protected.protected_paths.push(p);
    assertNotTrusted(f(obs, 'protected_frozen'), `protected path ${JSON.stringify(p)}`);
  }
});

/* G. Pins for two survivors of T-176's mutation run (rule 11). */
test('T-176 G: a task sha of 41 (or 39) hex is refused; 40 in either case is accepted', () => {
  for (const [k, v] of [['base_sha', 'a'.repeat(41)], ['returned_head_sha', 'b'.repeat(41)], ['base_sha', 'a'.repeat(39)], ['base_sha', `${'a'.repeat(40)}\n`]]) {
    const obs = healthy(); obs.tasks.rows[1][k] = v;
    assertNotTrusted(f(obs, 'assignment_candidate'), `${k} of ${v.length}`);
  }
  const ok = healthy(); ok.tasks.rows[1].base_sha = 'A'.repeat(40);
  assert.equal(f(ok, 'assignment_candidate').trust_state, TRUST.TRUSTED);
});

/*
 * Pin for the O-4 decision (REFUSE, not "read as absent"). Once heartbeats
 * gained their own zone check, the scalar test could no longer tell a refused
 * agentId/capacity from an absent one -- both publish null and PRESENT -- so
 * the field-6 text check became a mutation nobody could observe (rule 11).
 */
test('T-176 G / O-4: a wrong-shaped agent id or capacity in field 6 is REFUSED by name, not read as absent', () => {
  assert.equal(f(healthy(), 'channel_liveness').trust_state, TRUST.TRUSTED, 'positive control');
  for (const [k, v] of [['agentId', { a: 1 }], ['capacity', ['offline']], ['agentId', 7], ['capacity', {}]]) {
    const obs = healthy();
    obs.roster.rows[0][k] = v;
    const fld = f(obs, 'channel_liveness');
    assertNotTrusted(fld, `roster ${k} = ${JSON.stringify(v)}`);
    assert.match(fld.reason, /value\(s\) that are not text/, `roster ${k} = ${JSON.stringify(v)}`);
  }
});

test('T-176 G: describing a thrown value calls NO getter -- own or inherited', () => {
  let calls = 0;
  const own = { get message() { calls += 1; return 'from an own getter'; } };
  const inherited = Object.create({ get message() { calls += 1; return 'from an inherited getter'; } });
  for (const [what, thrown] of [['own accessor', own], ['inherited accessor', inherited]]) {
    const obs = healthy();
    Object.defineProperty(obs.tasks, 'ok', { enumerable: true, get() { throw thrown; } });
    const fld = f(obs, 'assignment_candidate');
    assert.match(fld.reason, /observation could not be classified: a thrown object with no text message/, what);
  }
  assert.equal(calls, 0, `a message getter was called ${calls} times`);
});

/* ── T-157 rework 4 (T-179 verifier) ───────────────────────────────────── */

/*
 * F1. FIELD 3 REFUSES PER COMPONENT. The guard refused the WHOLE field when the
 * copy threw -- and the whole of `git ls-files -v`, one line per tracked file,
 * was charged to the one budget shared with HEAD and tree. A large sparse index
 * nulled HEAD, tree and identity that git had answered exactly: cleanliness
 * dragging identity down, which AMENDMENT 1 forbids. Now each component's
 * inputs are read under their own guard and budget.
 */
function componentsOf(fld) {
  assert.ok(fld.value && fld.value.components, `field 3 lost its per-component value: ${fld.reason}`);
  return fld.value.components;
}
test('T-179 F1: a throw or budget refusal in ONE component\'s inputs refuses that component only', () => {
  const healthyC = componentsOf(f(healthy(), 'baseline'));
  for (const k of [...IDENTITY, 'cleanliness', 'drift']) assert.equal(healthyC[k].trust_state, TRUST.TRUSTED, `positive control ${k}`);
  const thrower = (o, key) => Object.defineProperty(o.baseline, key, { enumerable: true, configurable: true, get() { throw new Error(`injected ${key}`); } });
  const cases = [
    ['index_flags throws', (o) => thrower(o, 'index_flags'), 'cleanliness'],
    ['status throws', (o) => thrower(o, 'status'), 'cleanliness'],
    ['status claims 1e6+1 entries', (o) => { o.baseline.status = new Proxy([], { get: (t, k, r) => (k === 'length' ? 1_000_001 : Reflect.get(t, k, r)) }); }, 'cleanliness'],
    ['index_flags exceeds the budget', (o) => { o.baseline.index_flags = 'H x\n'.repeat(25_000_000); }, 'cleanliness'],
    ['drift throws', (o) => thrower(o, 'drift'), 'drift'],
    ['head throws', (o) => thrower(o, 'head'), 'head'],
    ['tree throws', (o) => thrower(o, 'tree'), 'tree'],
    ['repo_id throws', (o) => thrower(o, 'repo_id'), 'repo_identity'],
  ];
  for (const [what, set, refused] of cases) {
    const obs = healthy();
    set(obs);
    const fld = f(obs, 'baseline');
    assert.equal(fld.trust_state, TRUST.UNTRUSTWORTHY, `${what}: field 3`);
    const c = componentsOf(fld);
    assert.equal(c[refused].trust_state, TRUST.UNTRUSTWORTHY, `${what}: ${refused}`);
    assert.equal(c[refused].value, null, `${what}: ${refused} value withheld`);
    // Refused BECAUSE its input could not be read -- not by a later rule that
    // happens to trip on the missing value (rule 11: the fallback would hide a
    // guard that stopped working).
    assert.match(c[refused].reason, /observation could not be classified/, `${what}: ${refused} refused for the wrong reason`);
    for (const k of [...IDENTITY, 'cleanliness', 'drift'].filter((x) => x !== refused)) {
      assert.deepEqual(c[k], healthyC[k], `${what}: ${k} changed (${c[k].reason})`);
    }
  }
  // The shared inputs: a header throw refuses the whole field; a details throw
  // refuses the FIELD but every component keeps its own verdict and value.
  const header = healthy(); thrower(header, 'ok');
  assert.match(f(header, 'baseline').reason, /could not be classified: injected ok/);
  const details = withDetails(); thrower(details, 'details');
  const d = f(details, 'baseline');
  assert.equal(d.trust_state, TRUST.UNTRUSTWORTHY);
  assert.match(d.reason, /details could not be read/);
  assert.equal(componentsOf(d).tree.trust_state, TRUST.TRUSTED, 'details throwing must not refuse tree');
});

/*
 * F2. THE ANCHOR DENYLIST IS NEAR-LINEAR. `parts.some((p) => c.includes(p))`
 * was parts x label, across slots: 1e5 parts x a 1e6 label took 3.5 s, and a
 * refused tasks slot still cost field 6 2.2 s. The fix is TWO BOUNDS, checked
 * before the denylist runs: an anchor label is at most MAX_LABEL (256) code
 * units and a judged identity at most MAX_IDENTITY (4096), or the anchor is
 * refused, so the parts x label work is a constant. A set-of-substrings lookup
 * and a once-per-compile memo were tried and REMOVED (see namesAJudgedSource):
 * with the bounds, no mutation of either could be observed. The bounds are
 * pinned by VERDICT in the "bound is exact" tests, not by this timing.
 */
test('T-179 F2: the anchor denylist stays fast however large the labels and judged identities are', () => {
  const cases = [
    ['manyPartsLongLabel', '3e5 judged parts x a 1e6-char label', { assignment_candidate: /longer than 256/ }],
    ['hugePartsHugeLabel', '1e6 judged parts x a 1e7-char label', { assignment_candidate: /longer than 256/ }],
    ['hugeTasksIdentity', '4e6 distinct parts in the TASK store identity (field 6 judges it too)', {
      assignment_candidate: /source_identity is longer than 4096/,
      channel_liveness: /judged source identity is longer than 4096/,
    }],
  ];
  const slow = [];
  const deadline = Date.now() + 60_000;
  for (const [which, what, expect] of cases) {
    const left = deadline - Date.now();
    if (left <= 0) { slow.push(`${what}: not run -- deadline spent`); continue; }
    const r = heavy(which, Math.min(20_000, left));
    if (r.killed) { slow.push(`${what}: killed`); continue; }
    if (r.ms > 5_000) slow.push(`${what}: ${r.ms} ms`);
    for (const [id, how] of Object.entries(expect)) {
      assert.notEqual(r.fields[id].trust_state, TRUST.TRUSTED, `${what}: ${id} TRUSTED`);
      assert.match(r.fields[id].reason ?? '', how, `${what}: ${id}`);
    }
  }
  assert.deepEqual(slow, [], 'the denylist must finish within 5 s');
});

test('T-179 F2: the identity bound is exact -- 4096 characters is an identity, 4097 is refused, and the anchor that judges it cannot promote', () => {
  const at = (n) => { const o = healthy(); o.tasks.source_identity = 'x'.repeat(n); return o; };
  assert.equal(f(at(4096), 'assignment_candidate').trust_state, TRUST.TRUSTED, f(at(4096), 'assignment_candidate').reason);
  assert.equal(f(at(4096), 'channel_liveness').trust_state, TRUST.TRUSTED);
  const over = at(4097);
  assertNotTrusted(f(over, 'assignment_candidate'), 'a 4097-character task store identity');
  assert.match(f(over, 'assignment_candidate').reason, /source_identity is longer than 4096/);
  assertNotTrusted(f(over, 'channel_liveness'), 'field 6 anchor judged against an unbounded identity');
  assert.match(f(over, 'channel_liveness').reason, /judged source identity is longer than 4096/);
});

/* F3. Field 6's vocabulary is closed, as field 2's was (T-161 (a)). */
test('T-179 F3: a capacity outside the vocabulary demotes field 6 -- never read as present', () => {
  for (const cap of ['idle', 'busy', 'blocked', 'offline']) {
    const obs = healthy(); obs.roster.rows[0].capacity = cap; obs.runtime.rows[1].capacity = cap;
    assert.equal(f(obs, 'channel_liveness').trust_state, TRUST.TRUSTED, `capacity ${cap}: ${f(obs, 'channel_liveness').reason}`);
  }
  for (const cap of ['OFFLINE', 'Offline', 'offline ', '​offline', 'retired', 'ß', '', '​']) {
    for (const where of ['roster', 'runtime']) {
      const obs = healthy();
      obs[where].rows[0].capacity = cap;
      const fld = f(obs, 'channel_liveness');
      assertNotTrusted(fld, `${where} capacity ${JSON.stringify(cap)}`);
      assert.match(fld.reason, /capacity not in the vocabulary/, `${where} capacity ${JSON.stringify(cap)}`);
    }
  }
});

test('T-179 F3: a LIVE roster row without an agent id demotes field 6; a missing capacity stays "not reported"', () => {
  for (const [what, set] of [
    ['blank agentId', (r) => { r.agentId = ''; }], ['U+200B agentId', (r) => { r.agentId = '​'; }],
    ['whitespace agentId', (r) => { r.agentId = ' '; }], ['no agent id at all', (r) => { delete r.agentId; }],
  ]) {
    const obs = healthy(); set(obs.roster.rows[0]);
    const fld = f(obs, 'channel_liveness');
    assertNotTrusted(fld, what);
    assert.match(fld.reason, /live roster row\(s\) without an agent id/, what);
  }
  const alias = healthy(); delete alias.roster.rows[0].agentId; alias.roster.rows[0].agent_id = 'w2';
  assert.equal(f(alias, 'channel_liveness').trust_state, TRUST.TRUSTED, 'agent_id spelling is an agent id');
});

test('T-179 F3: the published heartbeat is the one that was JUDGED, whichever key carried it', () => {
  const at = ago(30_000);
  for (const key of ['heartbeat_at', 'lastSeenAt', 'last_seen_at']) {
    const obs = healthy();
    delete obs.roster.rows[0].lastSeenAt;
    obs.roster.rows[0][key] = at;
    const fld = f(obs, 'channel_liveness');
    assert.equal(fld.trust_state, TRUST.TRUSTED, `${key}: ${fld.reason}`);
    const row = fld.value.live_worker_topology.find((r) => r.session_id === 's2');
    assert.equal(row.heartbeat_at, at, `${key}: judged live but published ${row.heartbeat_at}`);
  }
});

/* F4. generated_at is UTC ("Z") only -- an offset, even a zero one, is refused (pins T-179's M13). */
test('T-179 F4: generated_at with a +00:00 or -00:00 offset is refused', () => {
  for (const bad of ['2026-09-23T20:00:00+00:00', '2026-09-23T20:00:00.000-00:00', '2026-09-23T20:00:00.000+00:00']) {
    const obs = healthy(); obs.generated_at = bad;
    assert.equal(thrownBy(() => compileEnvelope(obs)), 'NAMED', bad);
  }
});

/* F5. The minor items. */
test('T-179 F5: a wrong-shaped manifest_text is UNTRUSTWORTHY; only null (no file) is ABSENT', () => {
  const nul = healthy(); nul.protected.manifest_text = null;
  assert.equal(f(nul, 'protected_frozen').trust_state, TRUST.ABSENT, 'positive control: null is ABSENT');
  for (const bad of [7, true, {}, [], undefined]) {
    const obs = healthy();
    if (bad === undefined) delete obs.protected.manifest_text; else obs.protected.manifest_text = bad;
    assert.equal(f(obs, 'protected_frozen').trust_state, TRUST.UNTRUSTWORTHY, `manifest_text ${JSON.stringify(bad)}`);
  }
});

test('T-179 F5: manifest_sha256 is BOUND to manifest_text, and published only when it is', () => {
  const ok = f(healthy(), 'protected_frozen');
  assert.equal(ok.trust_state, TRUST.TRUSTED);
  assert.equal(ok.value.manifest_sha256, sha256Of(MANIFEST));
  const wrong = healthy(); wrong.protected.manifest_sha256 = 'c'.repeat(64);
  const w = f(wrong, 'protected_frozen');
  assertNotTrusted(w, 'a digest of other bytes');
  assert.match(w.reason, /manifest_sha256 is not the digest of manifest_text/);
  const none = healthy(); delete none.protected.manifest_sha256;
  assert.equal(f(none, 'protected_frozen').trust_state, TRUST.TRUSTED, 'no digest reported');
  assert.equal(f(none, 'protected_frozen').value.manifest_sha256, null);
});

test('T-179 F5: an anchor that lists the same id twice never promotes', () => {
  for (const [slot, id, key, list] of [['assignment', 'assignment_candidate', 'current', ['t-a', 't-a', 't-b']], ['liveness', 'channel_liveness', 'live_sessions', ['s1', 's2', 's2']]]) {
    const obs = healthy(); obs.anchors[slot][key] = list;
    const fld = f(obs, id);
    assertNotTrusted(fld, `${slot} ${JSON.stringify(list)}`);
    assert.match(fld.reason, /completeness anchor lists a duplicate/);
  }
});

/*
 * T-187 (a). THE LABEL BOUND, PINNED BY VERDICT. T-181's M05b moved the
 * comparison to MAX_LABEL + 1 and left the message alone, and every test
 * stayed green: the bound was pinned only by the literal "256" in a reason
 * (rule 4, a proxy). Here the TRUST STATE moves at the bound, in all four
 * label slots, with a label no other rule refuses -- so 257 promoting is the
 * bound gone, whatever the message says. The reason is matched on the RULE,
 * never on the number.
 */
test('T-187 (a): the anchor label bound is exact by VERDICT -- 256 promotes, 257 is refused, in all four slots', () => {
  const SLOTS = [
    ['assignment', 'assignment_candidate', 'source'], ['assignment', 'assignment_candidate', 'source_identity'],
    ['liveness', 'channel_liveness', 'source'], ['liveness', 'channel_liveness', 'source_identity'],
  ];
  for (const [slot, id, key] of SLOTS) {
    const at = (n) => { const o = healthy(); o.anchors[slot][key] = 'y'.repeat(n); return f(o, id); };
    for (const n of [255, 256]) {
      assert.equal(at(n).trust_state, TRUST.TRUSTED, `${slot}.${key} of ${n} characters must promote: ${at(n).reason}`);
    }
    for (const n of [257, 258]) {
      const fld = at(n);
      assertNotTrusted(fld, `${slot}.${key} of ${n} characters`);
      assert.match(fld.reason, /completeness anchor label is longer than \d+ characters/, `${slot}.${key} of ${n}: refused by another rule`);
    }
  }
});

/*
 * T-187 (b). A NON-ASCII MANIFEST. The live MANIFEST.txt carries U+2014 in its
 * first line (3 bytes of UTF-8), and every fixture above is ASCII -- where
 * UTF-8 and latin1 are the same bytes -- so T-181's M16 (digest over latin1)
 * survived, and under it the LIVE manifest would be demoted. The fixture is
 * built as BYTES, the way the driver reads the file, decoded as the driver
 * decodes it, and the expected digest is taken over those bytes: never
 * re-encoded from the text, which would be the rule reconstructing itself.
 * U+00E9 is added because latin1 spells it in ONE byte (U+2014 it truncates).
 */
function nonAsciiManifest() {
  const dash = MANIFEST.indexOf('--');
  assert.ok(dash > 0 && MANIFEST.indexOf('--', dash + 1) === -1, 'premise: the fixture header has exactly one "--"');
  const path = MANIFEST.indexOf('\\T-001.patch') + 1;
  assert.ok(path > dash, 'premise: the T-001 "from" line follows the header');
  const ascii = (s) => { assert.ok(/^[\x00-\x7f]*$/.test(s), 'premise: an ASCII piece'); return Buffer.from(s, 'latin1'); };
  const bytes = Buffer.concat([
    ascii(MANIFEST.slice(0, dash)), Buffer.from([0xe2, 0x80, 0x94]), // U+2014 EM DASH, as the live file's line 1
    ascii(MANIFEST.slice(dash + 2, path)), ascii('caf'), Buffer.from([0xc3, 0xa9]), ascii('\\'), // U+00E9
    ascii(MANIFEST.slice(path)),
  ]);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(text.includes('—') && text.includes('café\\T-001.patch'), 'premise: the fixture carries U+2014 and U+00E9');
  assert.equal(bytes.length, MANIFEST.length - 2 + 3 + 3 + 2 + 1, 'premise: 5 non-ASCII bytes in place of "--", plus "café\\"');
  return { bytes, text, digest: createHash('sha256').update(bytes).digest('hex') };
}

test('T-187 (b): a manifest carrying non-ASCII text is TRUSTED, and its digest is of its UTF-8 bytes', () => {
  const { text, digest } = nonAsciiManifest();
  const latin1 = createHash('sha256').update(Buffer.from(text, 'latin1')).digest('hex');
  assert.notEqual(latin1, digest, 'premise: this fixture tells UTF-8 from latin1 (an ASCII one cannot)');
  const obs = healthy();
  obs.protected.manifest_text = text;
  obs.protected.manifest_sha256 = digest;
  const fld = f(obs, 'protected_frozen');
  assert.equal(fld.trust_state, TRUST.TRUSTED, `the driver's own digest of a non-ASCII manifest was refused: ${fld.reason}`);
  assert.equal(fld.value.manifest_sha256, digest);
  assert.deepEqual(fld.value.candidates.map((c) => c.sha256), [D1, D2], 'the non-ASCII manifest still pins both candidates');
  const other = healthy();
  other.protected.manifest_text = text;
  other.protected.manifest_sha256 = latin1;
  const w = f(other, 'protected_frozen');
  assertNotTrusted(w, 'a digest of the latin1 encoding');
  assert.match(w.reason, /manifest_sha256 is not the digest of manifest_text/);
});

test('T-179 F5: generated_at and every judged timestamp agree on years 0000-0099', () => {
  for (const y of ['0000', '0050', '0099']) {
    const g = healthy(); g.generated_at = `${y}-06-01T00:00:00Z`;
    assert.equal(thrownBy(() => compileEnvelope(g)), 'DID NOT THROW', `generated_at year ${y}`);
    const o = healthy(); o.tasks.observed_at = `${y}-06-01T00:00:00Z`;
    assert.doesNotMatch(f(o, 'assignment_candidate').reason, /no usable observed_at/, `observed_at year ${y}`);
  }
});
