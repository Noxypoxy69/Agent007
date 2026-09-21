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
function controlModules() {
  const all = [...PROTECTED_PATHS, ...AUDIT_BEARING_EXTRAS].map(norm);
  return all.filter((p) => /\.(mjs|js)$/i.test(p) && existsSync(path.join(ROOT, p)));
}

test('THE FIXTURE IS REAL: there are control modules and the graph sees them', () => {
  /*
   * Rule 5 and rule 9 together. If `controlModules()` came back empty, or
   * the graph did not contain them, every assertion below would pass by
   * iterating nothing -- which is precisely the hollow shape this file is
   * about.
   */
  const controls = controlModules();
  assert.ok(controls.length > 5,
    `expected several control modules, found ${controls.length}`);

  const graph = buildGraph(ROOT);
  const seen = controls.filter((c) => graph.has(c));
  assert.ok(seen.length > 5,
    `the module graph does not contain the registered controls: ${JSON.stringify(controls.slice(0, 5))}`);
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
  const graph = buildGraph(ROOT);
  const controls = controlModules();

  const seenSet = new Set();
  const queue = [...controls];
  while (queue.length > 0) {
    const cur = queue.pop();
    const node = graph.get(cur);
    if (!node) continue;
    for (const dep of node.imports ?? []) {
      const rel = norm(dep);
      if (seenSet.has(rel)) continue;
      seenSet.add(rel);
      queue.push(rel);
    }
  }

  /*
   * NODE BUILTINS AND TEST FILES ARE NOT CONTROLS. Builtins are not ours;
   * test files are covered by the baseline-test machinery, which is a
   * different mechanism with a different failure mode.
   */
  const missing = [...seenSet]
    .filter((rel) => !rel.startsWith('test/'))
    .filter((rel) => existsSync(path.join(ROOT, rel)))
    .filter((rel) => !isAuditBearing(rel))
    .sort();

  assert.deepEqual(missing, [],
    'these modules are REACHED BY A CONTROL and are not audit-bearing, so a commit '
    + 'changing only one of them does not appear in the coverage report and rule 20 '
    + 'cannot be enforced for it. Register them in AUDIT_BEARING_EXTRAS, or explain '
    + 'in that list why a control may reach them without itself being one');
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
