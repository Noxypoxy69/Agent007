/**
 * THE CREATE ROUTE MUST NOT TAKE ITS AUTHOR FROM THE CALLER.
 *
 * `record_owner_decision` shipped with `created_by: d.owner_id` — the payload
 * supplying both sides of its own authorship check — and the gate that was
 * supposed to catch it could never fire. The create route writes the same kind
 * of field, so the same mistake is available, and it is checked here before it
 * can be made rather than after.
 *
 * READ AS TEXT, because `supabase/functions/mcp/index.ts` is Deno-only and
 * cannot be imported by this suite (CLAUDE.md rule 10). `edgeSourceGuards` and
 * `ownerDecisionAuthorship` already treat it this way. The decision logic it
 * calls — `validateTask`, `createTask`, `pathsCollide` — lives in `_shared.js`
 * and is tested by behaviour in `test/taskRecordSplice.test.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = fs.readFileSync(path.join(REPO, 'supabase/functions/mcp/index.ts'), 'utf8');

/**
 * COMMENT-BLANK BEFORE MATCHING ANYTHING — rule 13, rediscovered four separate
 * times in this repository. The route's own comment explains what it must not
 * do, in the words this test searches for.
 */
const CODE = RAW
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

/** The route body: from its path test to the start of the next route. */
function routeBody() {
  const start = CODE.indexOf("path === '/task-create'");
  assert.notEqual(start, -1, 'the /task-create route is gone; this gate is measuring nothing');
  const after = CODE.slice(start);
  const next = after.indexOf("if (path === '/wait')");
  assert.notEqual(next, -1, 'could not find the end of the route');
  return after.slice(0, next);
}

const BODY = routeBody();

test('THE POSITIVE FIRST: the route exists and is wired to the shared validator', () => {
  /*
   * Rule 5. Every "must not" below passes against a file with no route at all,
   * which is how a gate ends up green over a deleted feature.
   */
  assert.match(BODY, /createTask\s*\(/, 'the route does not build a record through createTask');
  assert.match(BODY, /validateTask\s*\(/, 'the route does not validate before writing');
  assert.match(BODY, /write\s*\(\s*['"]tasks['"]/, 'the route never writes a task');
  assert.match(CODE, /createTask,\s*validateTask,\s*pathsCollide/,
    'the shared helpers are not imported, so the route cannot be calling them');
});

test('created_by COMES FROM THE TOKEN LABEL, NEVER FROM THE BODY', () => {
  /*
   * THE DEFECT THIS EXISTS FOR, already made once in this file.
   * record_owner_decision wrote `created_by: d.owner_id`, so the payload
   * supplied both sides of its own authorship check and the check could never
   * fire. An author a caller can type is a claim; the authenticated label is a
   * record.
   */
  assert.match(BODY, /created_by:\s*creatorLabel\b/,
    'created_by is not bound to the authenticated token label');

  /*
   * SCOPED TO THE CONSTRUCTOR CALL, WHICH IS WHERE THE RISK IS.
   *
   * The first version matched the whole route and flagged
   * `created_by: rec.created_by` inside the write() — which is SAFE, because
   * `rec` is what createTask just returned and its author came from the label.
   * A matcher that cannot tell a derived value from a caller-supplied one
   * refuses correct code, and a gate that cries wolf gets edited until it stops
   * (rule 14). The overwrite risk is covered by the spread-order test below.
   */
  const call = /createTask\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(BODY);
  assert.ok(call, 'could not find the createTask call');
  const fromBody = /created_by:\s*(createBody|body|req|request)\b/.exec(call[1]);
  assert.equal(fromBody, null,
    `created_by is taken from caller-supplied data: ${fromBody && fromBody[0]}`);
});

test('THE SPREAD CANNOT OVERWRITE THE FIELDS THE SERVER ESTABLISHES', () => {
  /*
   * `{...createBody, created_at, created_by}` is safe; the reverse is not. A
   * spread placed AFTER those keys lets the caller supply its own author and
   * its own clock, which is the same defect wearing different syntax.
   */
  const call = /createTask\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(BODY);
  assert.ok(call, 'could not find the createTask call');
  const args = call[1];
  const spreadAt = args.indexOf('...');
  const authorAt = args.indexOf('created_by');
  assert.notEqual(spreadAt, -1, 'the call no longer spreads the body; update this gate');
  assert.ok(spreadAt < authorAt,
    'the request body is spread AFTER created_by, so a caller can overwrite its own author');
});

test('COORDINATOR SCOPE, matching assign_task', () => {
  /*
   * Creating work and handing it out are the same authority. A reader able to
   * create could fill the queue with work it cannot assign, and a registration
   * token is a worker credential rather than a coordinating one.
   */
  assert.match(BODY, /tokenLabel\s*\(\s*['"]coordinator_tokens['"]/,
    'the route does not authenticate against coordinator_tokens');
  assert.ok(!/tokenLabel\s*\(\s*['"]registration_tokens['"]/.test(BODY),
    'the route accepts a worker registration token for a coordination act');
  assert.match(BODY, /unauthorized.*401|401/s, 'the route does not refuse an unauthenticated caller');
});

test('A DUPLICATE ID IS REFUSED RATHER THAN OVERWRITTEN', () => {
  /*
   * A task is a record of what was asked for. Silently replacing one loses the
   * assignment history attached to it — the same append-only judgement the
   * decision ledger makes.
   */
  assert.match(BODY, /task_id=eq\./, 'the route does not check whether the id already exists');
  assert.match(BODY, /409/, 'the route does not refuse a duplicate');
});

test('COLLISIONS ARE CHECKED ONLY AGAINST WORK STILL IN PLAY', () => {
  /*
   * A cancelled or accepted task's paths are nobody's any more. Checking
   * against them would make the queue progressively unusable as history
   * accumulates — and this table is append-only, so it only ever grows.
   */
  assert.match(BODY, /pathsCollide\s*\(/, 'the route does not check for path collisions');
  for (const state of ['runnable', 'returned', 'assigned']) {
    assert.ok(BODY.includes(`'${state}'`), `the in-play filter does not consider ${state}`);
  }
  for (const dead of ['cancelled', 'accepted']) {
    assert.ok(!BODY.includes(`'${dead}'`),
      `the collision check considers ${dead} tasks, whose paths are nobody's any more`);
  }
});

test('THE ROUTE IS REACHABLE: a coordinator store exposes createTask', () => {
  /*
   * A ROUTE NOTHING CAN CALL IS NOT A FEATURE. An audit found /task-create had
   * no caller at all — no MCP tool, no CLI command, reachable only by a
   * hand-made HTTP POST with a coordinator bearer. The stated purpose, that the
   * tasks table "held four rows because nobody could add a fifth", was not met
   * for anyone using MCP or the CLI. Rule 17: wiring is a separate claim from
   * logic, and only the logic had tests.
   *
   * toolDefs registers create_task only when the store provides the method, so
   * the method existing on coordinatorStore IS the wiring.
   */
  assert.match(CODE, /async createTask\s*\(/,
    'coordinatorStore does not expose createTask, so the create_task tool can never be built');

  const storeBlock = CODE.slice(CODE.indexOf('function coordinatorStore'));
  const createBlock = storeBlock.slice(storeBlock.indexOf('async createTask'));
  assert.match(createBlock.slice(0, 2000), /created_by:\s*label\b/,
    'the store method does not bind created_by to the authenticated label');
  assert.match(createBlock.slice(0, 2000), /validateTask\s*\(/,
    'the store method writes without validating — the route and the tool would disagree');
});

test('THE CONTROL: comment-blanking really removed the prose', () => {
  /*
   * The route's own comment says "created_by IS THE AUTHENTICATED LABEL, NEVER
   * THE BODY" — the exact words above search for. If blanking failed, this gate
   * would be reading its own documentation and passing whatever the code did.
   */
  assert.match(RAW, /NEVER THE BODY/, 'the explanatory comment is gone; update this control');
  assert.ok(!/NEVER THE BODY/.test(CODE),
    'comment-blanking did not remove the prose — every match above may be a comment');
});
