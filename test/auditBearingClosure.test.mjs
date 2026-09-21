/**
 * A CONTROL REACHED BY A CONTROL IS ITSELF A CONTROL.
 *
 * ═══ THE DEFECT THIS EXISTS TO STOP RECURRING ═══
 *
 * `isAuditBearing` matches NAMES -- `PROTECTED_PATHS` plus
 * `AUDIT_BEARING_EXTRAS` -- so a control was auditable only if somebody had
 * remembered to register it, and a brand-new control was exempt by
 * construction. The incentive ran backwards: the more novel and
 * authority-bearing the module, the less likely its name was on a list
 * written before it existed.
 *
 * That module's own header has said so, in those words, since `bc64310`
 * created `src/principalResolution.mjs` and the coverage tool reported
 * "commits touching a control: 0" for the file deciding whether an identity
 * is AUTHENTICATED. It called the entry "a known debt rather than a repair"
 * and predicted the next one.
 *
 * It was right three more times in one session. Blind audit H-1, MEASURED:
 *
 *     node scripts/check-audit-coverage.mjs c5549eb^..c5549eb --json
 *       { "commits": [] }
 *
 * `c5549eb` edits `src/invokedDirectly.mjs` and nothing else. That module
 * decides whether the deploy gate and the hook attestation execute their
 * bodies. The commit does not appear in the coverage report AT ALL, so
 * `auditEscalation` could never block on it and rule 20 was structurally
 * unenforceable for it.
 *
 * ═══ WHY THIS IS A CLOSURE AND NOT A LONGER LIST ═══
 *
 * A longer list fails the same way on the next file (rule 19: a list of
 * names fails in both directions). The discriminator the header itself
 * named is not WHERE a file lives but WHETHER A CONTROL REACHES IT -- so
 * this computes that, from the real import graph, and fails on any member
 * that is not registered.
 *
 * It deliberately does NOT sweep all of `src/`. `auditLedger.mjs`'s header
 * records that attempt being refused by the suite, correctly: most of `src/`
 * is ordinary logic, and sweeping it in is the rule 19 over-block that gets
 * a gate switched off. Reachability from a control is the narrow property
 * that distinguishes `src/invokedDirectly.mjs` from `src/collect.mjs`.
 *
 * This is a RATCHET, not a rewrite: it does not change what
 * `isAuditBearing` answers at run time. It fails the build when the answer
 * has become wrong, which is the part nobody was doing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isAuditBearing, AUDIT_BEARING_EXTRAS } from '../src/auditLedger.mjs';
import { PROTECTED_PATHS } from '../src/guardSession.mjs';
import { buildGraph } from '../src/moduleGraph.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const norm = (p) => p.split(path.sep).join('/').replace(/^\.\//, '');

/**
 * Every registered control that is a JavaScript module we can follow.
 *
 * `PROTECTED_PATHS` carries non-modules too -- `.mcp.json`, `docs/ORDER.md`,
 * a hook template -- which have no imports and are simply skipped. Derived
 * from the REAL lists (rule 7) so registering a new control extends this
 * check without anybody editing it.
 */
/**
 * The registered control modules, in the GRAPH's spelling.
 *
 * ═══ WHY NOT existsSync ═══
 *
 * This used to be `existsSync(path.join(ROOT, p))`, which is
 * case-INSENSITIVE on NTFS and case-SENSITIVE on ext4. `AUDIT_BEARING_EXTRAS`
 * stores entries lower-cased -- correctly, since `isAuditBearing` folds
 * case -- so on Linux `existsSync('src/auditloop.mjs')` is FALSE and four
 * controls were filtered out before the closure walk ever saw them:
 * auditLoop, daemonArgs, auditWindow, invokedDirectly. The four newest, and
 * the ones this gate exists to cover.
 *
 * CI runs ubuntu-latest, so that is the platform that matters, and it is
 * the reader whose job is to check the gate who got the broken behaviour --
 * rule 21 exactly, in the file I wrote to close a rule-21 bug.
 *
 * `graphKeyFor` already folds case and the graph's keys come from a real
 * `readdirSync`, so resolving through it answers "does this file exist"
 * and "what is it really called" in one step, identically on both
 * platforms. A registered path the graph cannot find is reported by the
 * fixture test below rather than silently skipped.
 */
function controlModules(graph) {
  return [...PROTECTED_PATHS, ...AUDIT_BEARING_EXTRAS]
    .map(norm)
    .filter((p) => /\.(mjs|js)$/i.test(p))
    .map((p) => graphKeyFor(graph, p))
    .filter(Boolean);
}

/**
 * Resolve a registered path to the graph's own spelling of it.
 *
 * ═══ WHY THIS IS NEEDED, AND WHY NOTHING WENT RED ═══
 *
 * Blind audit M-3. `AUDIT_BEARING_EXTRAS` stores entries LOWER-CASED --
 * `src/auditloop.mjs` -- because `isAuditBearing` folds case on both sides,
 * so registration itself is correct. `buildGraph` keys come from
 * `readdirSync`, so they carry the real spelling: `src/auditLoop.mjs`.
 * `Map.get` is exact-string.
 *
 * So `graph.get('src/auditloop.mjs')` returned undefined and the walk hit
 * `if (!edges) continue` -- dropping the module SILENTLY. On Windows
 * `existsSync` is case-insensitive so the entry survived the filter and
 * died one step later; on a case-sensitive filesystem it died one step
 * earlier. Excluded either way, on both platforms, with no notice.
 *
 * The three affected were `src/auditLoop.mjs`, `src/auditWindow.mjs` and
 * `src/invokedDirectly.mjs` -- registered only in EXTRAS and only in
 * lowercase, which is to say the three NEWEST controls, the exact ones
 * this gate was built to cover. `principalResolution` and `auditQueueStore`
 * survived only because they also appear correctly cased in
 * `PROTECTED_PATHS`.
 *
 * Impact today was zero -- all three import nothing but node builtins -- so
 * it was latent, and would have stayed silent until one of them gained a
 * local import.
 */
function graphKeyFor(graph, rel) {
  if (graph.has(rel)) return rel;
  const want = rel.toLowerCase();
  for (const key of graph.keys()) if (key.toLowerCase() === want) return key;
  return null;
}

/**
 * REACHED BY A CONTROL, AND ARGUED NOT TO BE ONE.
 *
 * ═══ WHY THIS LIST EXISTS AND WHY IT IS NOT THE OLD DEFECT AGAIN ═══
 *
 * The closure below found TWELVE modules a control reaches that are not
 * registered. Sweeping all twelve into `AUDIT_BEARING_EXTRAS` in one go
 * would multiply the audit demand across the repository overnight, and
 * rule 19 is explicit that an over-block is not the safe direction: it is
 * how a gate gets switched off entirely, which loses every layer at once.
 * `auditLedger.mjs`'s own header records the "make all of src/
 * audit-bearing" attempt being refused by this suite, correctly.
 *
 * So this freezes today's twelve and catches TOMORROW's. The difference
 * from the defect it replaces is the DIRECTION OF THE DEFAULT: before, a
 * new control was exempt until somebody remembered to register it, and
 * nothing ever went red. Now a new module reached by a control fails this
 * test until somebody either registers it or writes down, here, why it is
 * not a control. An argument somebody can disagree with beats an omission
 * nobody can see.
 *
 * Several of these are genuinely arguable and I am not pretending
 * otherwise -- `permissionRequest` and `ownerDecisions` in particular look
 * like authority surface to me. They are listed rather than registered
 * because re-classifying eleven modules is a policy change for the owner,
 * not a fix an auditor's finding licensed. Named here so the decision is
 * visible instead of buried.
 */
const REACHED_BUT_NOT_A_CONTROL = Object.freeze({
  'src/config.mjs':
    'Reads configuration and resolves paths. Carries no decision a guard consults; '
    + 'the deciding is done by the callers, which are registered.',
  'src/exec.mjs':
    'A process-spawn wrapper. It REFUSES git specifically, and that refusal is pinned '
    + 'by test/... -- the lint it enforces is its own, not a control another gate reads.',
  'src/approvalStore.mjs':
    'Storage for approvals. The authority decision lives in the callers that write and '
    + 'read it; this is the file layer under them.',
  'src/ownerDecisions.mjs':
    'ARGUABLE, and flagged for the owner rather than settled here: it reads the owner '
    + 'decision ledger, which is authority surface, but registering it changes audit '
    + 'policy across every commit that touches owner decisions.',
  'src/permissionRequest.mjs':
    'ARGUABLE for the same reason. CLAUDE.md says it enforces permission routing, which '
    + 'reads like a control; the owner should decide whether it becomes audit-bearing.',
  'src/registrationStore.mjs':
    'Storage for session registrations. Persistence under the registration path rather '
    + 'than a decision any gate consults.',
  'src/secretstore.mjs':
    'Reads credential material from disk. It moves secrets, it does not decide who may '
    + 'have them; the token classes and scopes are decided elsewhere.',
  'src/validationRunner.mjs':
    'Runs validation commands and reports results. The pass/fail meaning is assigned by '
    + 'its callers, which are registered.',
  'src/candidateTree.mjs':
    'Resolves a candidate commit to its tree sha. A measurement helper for the audit '
    + 'path; the fence that compares those shas is src/auditAttribution.mjs.',
  'src/auditAttribution.mjs':
    'ARGUABLE: it IS the attribution fence, and is the strongest candidate here for '
    + 'registration. Left out only because it landed with full branch coverage this '
    + 'session and the owner should make the policy call in one pass, not piecemeal.',
  'src/auditWorkspace.mjs':
    'Allocates and releases the reviewer worktree. Identity discipline rather than a '
    + 'verdict; nothing reads it to decide whether work is approved.',
  'src/watcherIdentity.mjs':
    'ARGUABLE: it decides the identity a watcher registers under, and a wrong answer '
    + 'makes a session invisible. Another session wrote it this hour and owns that call.',
});

test('THE FIXTURE IS REAL: there are control modules and the graph sees them', () => {
  /*
   * Rule 5 and rule 9 together. If `controlModules()` came back empty, or
   * the graph did not contain them, every assertion below would pass by
   * iterating nothing -- which is precisely the hollow shape this file is
   * about.
   */
  /* `buildGraph` returns { graph, dynamicOnly, files }, and `graph` maps a
   * repo-relative path to an ARRAY of resolved edges. Asked of the module
   * rather than assumed -- my first version treated the return value itself
   * as the Map and this precondition caught it on the first run. */
  const { graph } = buildGraph(ROOT);
  const controls = controlModules(graph);
  assert.ok(controls.length > 5,
    `expected several control modules, found ${controls.length}`);

  /*
   * EVERY REGISTERED MODULE MUST RESOLVE, and this is where a dropped one
   * is now REPORTED rather than silently skipped.
   *
   * Blind audit M-3 asserted `seen.length > 5`, which passed on the
   * correctly-cased entries while three controls were invisible. M-B then
   * found the deeper half: the `existsSync` filter dropped the lower-cased
   * entries BEFORE any of this ran, on any case-sensitive filesystem --
   * which is what CI uses. So the count was right and the population was
   * wrong, on the platform that matters.
   *
   * Resolution now goes through the graph, so this compares the registered
   * list against what was actually resolved and NAMES anything missing.
   */
  const registered = [...PROTECTED_PATHS, ...AUDIT_BEARING_EXTRAS]
    .map(norm)
    .filter((p) => /\.(mjs|js)$/i.test(p));
  const missingFromGraph = registered.filter((p) => graphKeyFor(graph, p) === null);
  assert.deepEqual(missingFromGraph, [],
    'these registered controls are not in the module graph, so the closure below walks '
    + 'NONE of their imports and silently covers less than it claims');
});

test('EVERY MODULE A CONTROL IMPORTS IS ITSELF AUDIT-BEARING', () => {
  /*
   * The whole point. `src/invokedDirectly.mjs` is imported by
   * `scripts/verify-hook-integrity.mjs`, a registered control, and was not
   * audit-bearing -- so a change to it was invisible to the gate that
   * exists to catch changes to controls.
   *
   * Walks the transitive closure, because a control two hops away decides
   * just as much as one hop away.
   */
  const { graph } = buildGraph(ROOT);
  const controls = controlModules(graph);

  const seenSet = new Set();
  const queue = [...controls];
  while (queue.length > 0) {
    const cur = queue.pop();
    /* Resolved through the graph's own spelling -- see graphKeyFor. A bare
     * `graph.get` dropped three registered controls without a word. */
    const key = graphKeyFor(graph, cur);
    const edges = key === null ? null : graph.get(key);
    if (!edges) continue;
    for (const dep of edges) {
      const r = norm(dep);
      if (seenSet.has(r)) continue;
      seenSet.add(r);
      queue.push(r);
    }
  }

  /*
   * NODE BUILTINS AND TEST FILES ARE NOT CONTROLS. Builtins are not ours;
   * test files are covered by the baseline-test machinery, which is a
   * different mechanism with a different failure mode.
   */
  const reached = [...seenSet]
    .filter((rel) => !rel.startsWith('test/'))
    .filter((rel) => existsSync(path.join(ROOT, rel)))
    .filter((rel) => !isAuditBearing(rel))
    .sort();

  const unexplained = reached.filter((rel) => !(rel in REACHED_BUT_NOT_A_CONTROL));

  assert.deepEqual(unexplained, [],
    'these modules are REACHED BY A CONTROL and are not audit-bearing, so a commit '
    + 'changing only one of them does not appear in the coverage report at all and '
    + 'rule 20 cannot be enforced for it. Either register them in '
    + 'AUDIT_BEARING_EXTRAS, or add an entry to REACHED_BUT_NOT_A_CONTROL saying why '
    + 'a control may reach this without it being one');
});

test('the reached-but-not-a-control list may only SHRINK', () => {
  /*
   * The companion every allowlist in this repository has, and the reason
   * `noOrphanModules` has one: an entry for something that no longer needs
   * it is permission nobody asked for, quietly widening over time.
   *
   * ═══ WHAT IT DOES NOT DO, CORRECTED ═══
   *
   * This comment used to claim it "stops the obvious abuse of the gate
   * above -- making a red test green by adding a line -- from going
   * unnoticed, because a stale line fails here." Blind audit M-7: IT DOES
   * NOT. A line added to silence the red gate is, by construction, for a
   * module that IS currently reached and IS currently unregistered -- so
   * it is not stale, and it passes all three assertions below. The only
   * cost of the abuse is writing a reason over forty characters.
   *
   * What this actually catches is an entry that has gone stale LATER:
   * the module deleted, no longer reached, or since registered. That is
   * worth having and it is what the name means. It is not a barrier to
   * adding one, and the size of the list is not frozen anywhere.
   *
   * A test name is a claim, and this one was making a claim the code did
   * not support -- in a file whose subject is gates that cover less than
   * they say.
   */
  const { graph } = buildGraph(ROOT);
  const controls = controlModules(graph);
  const seenSet = new Set();
  const queue = [...controls];
  while (queue.length > 0) {
    const cur = queue.pop();
    const key = graphKeyFor(graph, cur);
    for (const dep of (key === null ? [] : graph.get(key)) ?? []) {
      const r = norm(dep);
      if (seenSet.has(r)) continue;
      seenSet.add(r);
      queue.push(r);
    }
  }

  for (const rel of Object.keys(REACHED_BUT_NOT_A_CONTROL)) {
    assert.ok(existsSync(path.join(ROOT, rel)),
      `${rel} is exempted but no longer exists -- remove the entry`);
    assert.ok(seenSet.has(rel),
      `${rel} is exempted but no control reaches it any more -- remove the entry`);
    assert.equal(isAuditBearing(rel), false,
      `${rel} is now audit-bearing: delete its exemption`);
  }
});

test('A LOWER-CASED REGISTRATION STILL REACHES THE GRAPH (M-3)', () => {
  /*
   * The defect, pinned in the direction it was wrong. `AUDIT_BEARING_EXTRAS`
   * stores lower-cased paths because `isAuditBearing` folds case; the graph
   * keys carry the real spelling from `readdirSync`; `Map.get` is exact.
   * So three registered controls were dropped by `if (!edges) continue`
   * with no notice, on both platforms.
   *
   * Derived from the REAL list (rule 7), so a future lower-cased entry is
   * covered without anybody remembering, and asserted against the actual
   * on-disk spelling rather than a literal (rule 21).
   *
   * ═══ AND NOT THROUGH existsSync, WHICH IS THE BUG ITSELF ═══
   *
   * Blind audit M-B. This filtered candidates with
   * `existsSync(path.join(ROOT, p))`, which is case-INSENSITIVE on NTFS
   * and case-SENSITIVE on ext4. On Linux every lower-cased entry was
   * filtered out here, `differing` came back EMPTY, and the precondition
   * below -- `differing.length > 0` -- FAILED.
   *
   * CI runs ubuntu-latest. So the test written to pin a rule-21 defect
   * was itself encoding NTFS case-insensitivity, and it failed on the
   * only platform that gates anything, in the direction that looks like
   * the registration list is wrong.
   *
   * The graph is the existence check now: its keys come from a real
   * `readdirSync`, so it answers the same question identically on both
   * platforms.
   */
  const { graph } = buildGraph(ROOT);

  const candidates = AUDIT_BEARING_EXTRAS
    .map(norm)
    .filter((p) => /\.(mjs|js)$/i.test(p))
    .filter((p) => graphKeyFor(graph, p) !== null);

  /* PRECONDITION (rule 6): there IS at least one entry whose registered
   * spelling differs from the graph's, or this test proves nothing. */
  const differing = candidates.filter((p) => !graph.has(p));
  assert.ok(differing.length > 0,
    'no registered control is spelled differently from its graph key, so this test '
    + 'cannot exercise the case-fold. If EXTRAS stopped being lower-cased, delete it.');

  for (const p of differing) {
    assert.equal(graph.has(p), false, `${p} is an exact graph key; it is not the case`);
    const key = graphKeyFor(graph, p);
    assert.ok(key, `${p} could not be resolved to a graph key -- it is invisible to the closure`);
    assert.equal(key.toLowerCase(), p.toLowerCase());
    assert.ok(Array.isArray(graph.get(key)), `${p} resolved to a key with no edge list`);
  }
});

test('every exemption carries a reason a later reader can disagree with', () => {
  for (const [rel, why] of Object.entries(REACHED_BUT_NOT_A_CONTROL)) {
    assert.ok(typeof why === 'string' && why.length > 40,
      `${rel} is exempted without a real reason`);
  }
});

test('AND ORDINARY CODE IS STILL NOT AUDIT-BEARING -- the over-block guard', () => {
  /*
   * Rule 19's second direction, and it is the one that gets a gate switched
   * off. `auditLedger.mjs`'s header records an attempt to make all of
   * `src/` audit-bearing being refused by this suite, correctly. If this
   * closure ever grows to cover ordinary logic, the demand becomes noise
   * and somebody turns it off -- so the negative is pinned here, next to
   * the positive, rather than left to the other file's test.
   */
  assert.equal(isAuditBearing('src/collect.mjs'), false,
    'ordinary logic became audit-bearing; the closure has over-reached');
  assert.equal(isAuditBearing('README.md'), false);

  /* THE POSITIVE (rule 5): the thing this file was written about IS now
   * audit-bearing, so the assertions above are not passing because
   * everything is false. */
  assert.equal(isAuditBearing('src/invokedDirectly.mjs'), true,
    'the module whose commits were invisible is still not registered');
});
