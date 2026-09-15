import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseYamlSubset } from '../src/yamlSubset.mjs';
import {
  parseLaneRegistry, validateRegistry, lanesForAgent, lanesForSession,
  holdersOfLane, contestedLanes, capabilitiesFor, classifyPath, ownersOfPath,
  globToRegExp, OWNED, SHARED, FOREIGN, UNCLAIMED,
} from '../src/laneRegistry.mjs';

/**
 * Both directions for every rule, per the standing rule that a check is not
 * trusted until it has been seen to fire AND to stay silent.
 *
 * The load-bearing property under test is NEGATIVE and easy to lose: no lane
 * name, agent name or capability decision may live in src/. Several tests
 * below invent lanes that have never existed in this project precisely so the
 * suite fails if anyone reintroduces a hardcoded A/B/C/D.
 */

const RICH = `
lanes:
  - lane_id: messaging
    display_name: Messaging
    branch_patterns:
      - "code-c/*"
    owned_paths:
      - "src/lib/reply/**"
    shared_paths:
      - "package.json"
    capabilities: []
    status: active
  - lane_id: integration
    display_name: Release integration
    owned_paths:
      - "docs/route-inventory.md"
    capabilities:
      - merge_main
      - deploy
    status: active
agents:
  - agent_id: code-a
  - agent_id: code-c
sessions:
  - session_id: s-51
    agent_id: code-a
  - session_id: s-10
    agent_id: code-c
assignments:
  - lane_id: messaging
    agent_id: code-c
    session_id: s-10
    status: active
  - lane_id: integration
    agent_id: code-a
    session_id: s-51
    status: active
`;

const reg = () => parseLaneRegistry(RICH, { source: 'test' });

// ── the yaml subset ─────────────────────────────────────────────────────────

test('yaml: nested mappings, sequences and sequences-of-mappings', () => {
  const d = parseYamlSubset(`
a: 1
b:
  - x
  - "y"
c:
  d: true
  e:
    - f: 1
      g: two
`);
  assert.equal(d.a, 1);
  assert.deepEqual(d.b, ['x', 'y']);
  assert.equal(d.c.d, true);
  assert.deepEqual(d.c.e, [{ f: 1, g: 'two' }]);
});

test('yaml: dangerous constructs are rejected, not half-parsed', () => {
  // Each of these would silently change an ownership rule if interpreted.
  const bad = [
    ['anchors', 'a: &x 1\nb: *x\n'],
    ['merge keys', 'a:\n  <<: b\n'],
    ['flow sequence', 'a: [1, 2]\n'],
    ['flow mapping', 'a: {b: 1}\n'],
    ['block scalar', 'a: |\n  text\n'],
    ['multi-doc', '---\na: 1\n'],
    ['tab indent', 'a:\n\t- x\n'],
    ['duplicate key', 'a: 1\na: 2\n'],
    ['ambiguous bool', 'a: yes\n'],
  ];
  for (const [what, text] of bad) {
    assert.throws(() => parseYamlSubset(text), new RegExp('yaml:'), `${what} was accepted`);
  }
});

test('yaml: ordinary values are NOT rejected', () => {
  // The silent half. A parser that throws on everything passes every test above.
  const d = parseYamlSubset('a: "with # hash"\nb: false\nc: null\nd: plain text\n');
  assert.equal(d.a, 'with # hash');
  assert.equal(d.b, false);
  assert.equal(d.c, null);
  assert.equal(d.d, 'plain text');
});

// ── lanes are data, not code ────────────────────────────────────────────────

test('registry: a lane nobody has ever run works with no source change', () => {
  // Invented names. If any of these needed a code change, this fails.
  const r = parseLaneRegistry(`
lanes:
  - lane_id: payments
    owned_paths:
      - "src/lib/payments/**"
    capabilities:
      - apply_sql
    status: active
  - lane_id: pos-terminal
    owned_paths:
      - "src/lib/pos/**"
    status: active
agents:
  - agent_id: worker-17
sessions:
  - session_id: sess-abc
    agent_id: worker-17
assignments:
  - lane_id: payments
    agent_id: worker-17
    status: active
`);
  assert.equal(validateRegistry(r).ok, true);
  assert.deepEqual(lanesForAgent(r, 'worker-17'), ['payments']);
  assert.deepEqual(capabilitiesFor(r, { agentId: 'worker-17' }), ['apply_sql']);
  assert.equal(classifyPath(r, 'payments', 'src/lib/pos/x.ts'), FOREIGN);
});

test('registry: src/ contains no lane or agent names', async () => {
  // The structural guarantee, asserted rather than assumed. A/B/C/D and the
  // project's lane names may appear ONLY in example data and tests.
  const files = ['laneRegistry.mjs', 'yamlSubset.mjs', 'releaseRisk.mjs'];
  const banned = /\b(code-a|code-b|code-c|code-d|messaging|onboarding|ar-hunt|fo40-funnel|website-cloner)\b/i;
  for (const f of files) {
    const text = await readFile(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hit = code.match(banned);
    assert.equal(hit, null, `${f} hardcodes "${hit?.[0]}" outside a comment`);
  }
});

// ── agent / session / lane are separate ─────────────────────────────────────

test('registry: reassigning a lane is a data edit, and the agent keeps its identity', () => {
  const before = reg();
  assert.deepEqual(lanesForAgent(before, 'code-c'), ['messaging']);

  // The exact move that happened: same agent, different lane.
  const after = parseLaneRegistry(RICH.replace(
    '  - lane_id: messaging\n    agent_id: code-c\n    session_id: s-10\n    status: active',
    '  - lane_id: integration\n    agent_id: code-c\n    session_id: s-10\n    status: active',
  ), { source: 'test' });
  assert.deepEqual(lanesForAgent(after, 'code-c'), ['integration']);
  assert.ok(after.agents.some((a) => a.agent_id === 'code-c'), 'the agent must survive reassignment');
});

test('registry: one agent can hold several lanes at once', () => {
  const r = parseLaneRegistry(RICH + `  - lane_id: integration\n    agent_id: code-c\n    status: active\n`,
    { source: 'test' });
  assert.deepEqual(lanesForAgent(r, 'code-c').sort(), ['integration', 'messaging']);
});

test('registry: one agent holding one lane does NOT acquire the others', () => {
  // Silent half: a resolver returning every lane passes the test above.
  assert.deepEqual(lanesForAgent(reg(), 'code-a'), ['integration']);
  assert.equal(lanesForAgent(reg(), 'code-a').includes('messaging'), false);
});

test('registry: an unknown agent holds nothing and can do nothing', () => {
  assert.deepEqual(lanesForAgent(reg(), 'nobody'), []);
  assert.deepEqual(capabilitiesFor(reg(), { agentId: 'nobody' }), []);
});

test('registry: sessions resolve through their agent', () => {
  assert.deepEqual(lanesForSession(reg(), 's-10'), ['messaging']);
  assert.deepEqual(lanesForSession(reg(), 's-51'), ['integration']);
});

// ── contested lanes: the three-sessions-one-lane bug ────────────────────────

test('registry: a lane held by two agents is reported as contested', () => {
  // Three sessions each believed they were Code C. The data must be able to
  // say that, rather than the belief living only in prose.
  const r = parseLaneRegistry(RICH + `  - lane_id: messaging\n    agent_id: code-a\n    status: active\n`,
    { source: 'test' });
  const c = contestedLanes(r);
  assert.equal(c.length, 1);
  assert.equal(c[0].lane_id, 'messaging');
  assert.deepEqual(c[0].agents.sort(), ['code-a', 'code-c']);
  assert.equal(holdersOfLane(r, 'messaging').length, 2);
});

test('registry: a singly-held lane is not contested', () => {
  assert.deepEqual(contestedLanes(reg()), []);
});

// ── capabilities are granted by lanes, not by names ─────────────────────────

test('registry: capability follows the assignment, not the agent name', () => {
  const r = reg();
  assert.deepEqual(capabilitiesFor(r, { agentId: 'code-a' }), ['deploy', 'merge_main']);
  assert.deepEqual(capabilitiesFor(r, { agentId: 'code-c' }), []);

  // Hand the integration lane to code-c. The privilege must move with it.
  const moved = parseLaneRegistry(
    RICH.replace('  - lane_id: integration\n    agent_id: code-a\n    session_id: s-51\n    status: active',
      '  - lane_id: integration\n    agent_id: code-c\n    status: active'),
    { source: 'test' });
  assert.deepEqual(capabilitiesFor(moved, { agentId: 'code-c' }), ['deploy', 'merge_main']);
  assert.deepEqual(capabilitiesFor(moved, { agentId: 'code-a' }), [],
    'the old holder kept a privilege after losing the lane');
});

test('registry: a paused lane grants nothing', () => {
  const r = parseLaneRegistry(RICH.replace('    capabilities:\n      - merge_main\n      - deploy\n    status: active',
    '    capabilities:\n      - merge_main\n      - deploy\n    status: paused'), { source: 'test' });
  assert.deepEqual(capabilitiesFor(r, { agentId: 'code-a' }), []);
});

// ── path classification ─────────────────────────────────────────────────────

test('registry: owned / foreign / shared / unclaimed', () => {
  const r = reg();
  assert.equal(classifyPath(r, 'messaging', 'src/lib/reply/engine.ts'), OWNED);
  assert.equal(classifyPath(r, 'messaging', 'docs/route-inventory.md'), FOREIGN);
  assert.equal(classifyPath(r, 'messaging', 'package.json'), SHARED);
  assert.equal(classifyPath(r, 'messaging', 'README.md'), UNCLAIMED);
});

test('registry: shared outranks owned', () => {
  // Whoever also claims package.json does not thereby get it unreviewed.
  const r = parseLaneRegistry(`
lanes:
  - lane_id: a
    owned_paths:
      - "package.json"
    status: active
  - lane_id: b
    shared_paths:
      - "package.json"
    status: active
`);
  assert.equal(classifyPath(r, 'a', 'package.json'), SHARED);
});

test('registry: unclaimed is not foreign', () => {
  // A partial lane map must not block ordinary work, or it gets switched off.
  assert.equal(classifyPath(reg(), 'messaging', 'src/whatever/new.ts'), UNCLAIMED);
});

test('registry: ownersOfPath names the lane to talk to', () => {
  assert.deepEqual(ownersOfPath(reg(), 'docs/route-inventory.md'), ['integration']);
  assert.deepEqual(ownersOfPath(reg(), 'README.md'), []);
});

test('glob: ** spans segments, * does not', () => {
  assert.equal(globToRegExp('src/**').test('src/a/b/c.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/a.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/a/b.ts'), false, '* must not cross a separator');
  assert.equal(globToRegExp('scripts/check-*.mjs').test('scripts/check-jeff.mjs'), true);
  assert.equal(globToRegExp('scripts/check-*.mjs').test('scripts/verify.mjs'), false);
});

test('glob: a windows path matches a posix glob', () => {
  const r = reg();
  assert.equal(classifyPath(r, 'messaging', 'src\\lib\\reply\\engine.ts'), OWNED);
});

// ── validation ──────────────────────────────────────────────────────────────

test('registry: validation rejects real mistakes', () => {
  const cases = [
    ['unknown capability', `lanes:\n  - lane_id: a\n    capabilities:\n      - deploy_prod\n`, /unknown capability/],
    ['unknown status', `lanes:\n  - lane_id: a\n    status: running\n`, /unknown status/],
    ['duplicate lane', `lanes:\n  - lane_id: a\n  - lane_id: a\n`, /duplicate lane_id/],
    ['bad id', `lanes:\n  - lane_id: "Not An Id"\n`, /not a valid id/],
    ['unknown lane in assignment', `lanes:\n  - lane_id: a\nassignments:\n  - lane_id: b\n    agent_id: x\n`, /unknown lane/],
    ['assignment names nobody', `lanes:\n  - lane_id: a\nassignments:\n  - lane_id: a\n`, /neither an agent nor a session/],
    ['two lanes own one path', `lanes:\n  - lane_id: a\n    owned_paths:\n      - "x.ts"\n  - lane_id: b\n    owned_paths:\n      - "x.ts"\n`, /owned by both/],
    ['owned and shared', `lanes:\n  - lane_id: a\n    owned_paths:\n      - "x.ts"\n    shared_paths:\n      - "x.ts"\n`, /both owned and shared/],
  ];
  for (const [what, text, pattern] of cases) {
    const v = validateRegistry(parseLaneRegistry(text));
    assert.equal(v.ok, false, `${what} was accepted`);
    assert.ok(v.errors.some((e) => pattern.test(e)), `${what}: wrong error: ${v.errors.join('; ')}`);
  }
});

test('registry: validation accepts a correct file', () => {
  // Silent half. A validator that always returns errors passes everything above.
  const v = validateRegistry(reg());
  assert.equal(v.ok, true, `valid registry rejected: ${v.errors.join('; ')}`);
  assert.deepEqual(v.errors, []);
});

// ── legacy compatibility ────────────────────────────────────────────────────

test('registry: the legacy flat format still loads and is marked legacy', () => {
  const r = parseLaneRegistry('messaging:\n  - "src/lib/reply/**"\nrelease:\n  - "supabase/migrations/**"\n');
  assert.equal(validateRegistry(r).ok, true);
  assert.equal(r.lanes.length, 2);
  assert.equal(r.lanes[0].legacy, true);
  assert.equal(classifyPath(r, 'messaging', 'src/lib/reply/x.ts'), OWNED);
  assert.deepEqual(r.assignments, [], 'legacy files carry no assignments');
});

test('registry: the shipped example files parse and validate', async () => {
  for (const f of ['lanes.example.yml', 'lanes.registry.example.yml']) {
    const text = await readFile(fileURLToPath(new URL(`../${f}`, import.meta.url)), 'utf8');
    const v = validateRegistry(parseLaneRegistry(text, { source: f }));
    assert.equal(v.ok, true, `${f} does not validate: ${v.errors.join('; ')}`);
  }
});
