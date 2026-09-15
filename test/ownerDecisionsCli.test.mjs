import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `agentbridge ask` IS THE ENFORCEMENT POINT.
 *
 * The pure resolver in ownerDecisions.test.mjs proves the rules are right. This
 * file proves they are actually CONSULTED -- that a worker running the real
 * binary cannot put a question in front of the builder that the ledger already
 * answers.
 *
 * That distinction is the whole reason this project keeps finding guards with
 * no call site: correct logic nothing invokes is decoration. Here the exit code
 * IS the interface, so the check is behavioural rather than structural:
 *
 *   0  allowed         proceed, do NOT ask
 *   1  denied          refuse, do NOT ask
 *   3  owner_required  escalate
 *   4  no_decision     ask ONCE, then record the answer
 *   2  could not run   NOT an outcome -- see the test at the bottom
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));
const OWNER = 'danny';

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env }, windowsHide: true, timeout: 120000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { env: { AGENTBRIDGE_HOME: path.join(root, 'home') }, root };
}

const decideArgs = (over = {}) => {
  const o = {
    id: 'd-1', owner: OWNER, statement: 'a rule', scope: 'bridge',
    effect: 'allow', capabilities: 'build', ...over,
  };
  const out = ['owner-decide'];
  for (const [k, v] of Object.entries(o)) if (v != null) out.push(`--${k}`, String(v));
  return out;
};

test('an empty ledger answers no_decision and prints the question ONCE', async (t) => {
  const { env } = await fixture(t);
  const r = await run(['ask', '--action', 'deploy.production', '--question', 'may I deploy?'], env);
  assert.equal(r.code, 4, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /NO_DECISION/);
  assert.match(r.stdout, /ASK THE OWNER ONCE/);
  assert.match(r.stdout, /may I deploy\?/);
});

test('once recorded, the SAME question is never put to the owner again', async (t) => {
  const { env } = await fixture(t);

  const before = await run(['ask', '--action', 'commit', '--question', 'may I commit?'], env);
  assert.equal(before.code, 4);
  assert.match(before.stdout, /ASK THE OWNER ONCE/);

  const rec = await run(decideArgs({
    id: 'd-lanes', statement: 'Agents may build/test/commit inside delegated lanes.',
    capabilities: 'build,test,commit',
  }), env);
  assert.equal(rec.code, 0, `${rec.stdout}${rec.stderr}`);

  // Five workers, five runs of the real binary, zero owner questions.
  for (let i = 0; i < 5; i += 1) {
    const after = await run(['ask', '--action', 'commit', '--question', 'may I commit?'], env);
    assert.equal(after.code, 0, `worker ${i} was not allowed: ${after.stdout}${after.stderr}`);
    assert.doesNotMatch(after.stdout, /ASK THE OWNER ONCE/,
      `worker ${i} would have asked a question the builder already answered`);
    assert.match(after.stdout, /d-lanes/);
  }
});

test('deny exits 1 and require_owner exits 3 — and neither prints a question', async (t) => {
  const { env } = await fixture(t);
  await run(decideArgs({
    id: 'd-seed', statement: 'Seed data stays.', scope: 'repo', 'scope-id': 'social-sparks-app',
    effect: 'deny', capabilities: 'data.delete',
  }), env);
  await run(decideArgs({
    id: 'd-prod', statement: 'Never deploy production without Danny.',
    effect: 'require_owner', capabilities: 'deploy.production',
  }), env);

  const denied = await run(['ask', '--action', 'data.delete', '--repo', 'social-sparks-app',
    '--question', 'may I wipe seeds?'], env);
  assert.equal(denied.code, 1, denied.stdout);
  assert.match(denied.stdout, /DENIED/);
  assert.doesNotMatch(denied.stdout, /ASK THE OWNER ONCE/);

  const escalate = await run(['ask', '--action', 'deploy.production', '--question', 'deploy?'], env);
  assert.equal(escalate.code, 3, escalate.stdout);
  assert.match(escalate.stdout, /OWNER_REQUIRED/);
});

test('a task-scoped approval does not leak to another task, through the CLI', async (t) => {
  const { env } = await fixture(t);
  await run(decideArgs({
    id: 'd-staging-123', statement: 'Deploy staging for task-123.',
    scope: 'task', 'scope-id': 'task-123', effect: 'allow', capabilities: 'deploy.staging',
  }), env);

  assert.equal((await run(['ask', '--action', 'deploy.staging', '--task', 'task-123'], env)).code, 0);
  assert.equal((await run(['ask', '--action', 'deploy.staging', '--task', 'task-124'], env)).code, 4);
  assert.equal((await run(['ask', '--action', 'deploy.production', '--task', 'task-123'], env)).code, 4);
});

test('the CLI refuses to record a decision a worker authored', async (t) => {
  const { env } = await fixture(t);
  const r = await run(decideArgs({
    id: 'd-forged', by: 'code-b', effect: 'allow', capabilities: 'deploy.production',
  }), env);
  assert.equal(r.code, 2, `a forged decision was stored: ${r.stdout}`);
  assert.match(r.stderr, /cannot record a decision on the owner's behalf/);

  // Nothing was written, so the action is still unanswered.
  assert.equal((await run(['ask', '--action', 'deploy.production'], env)).code, 4);
});

test('decisions are append-only: the same id cannot be overwritten', async (t) => {
  const { env } = await fixture(t);
  await run(decideArgs({ id: 'd-x', effect: 'allow', capabilities: 'x' }), env);
  const again = await run(decideArgs({ id: 'd-x', effect: 'deny', capabilities: 'x' }), env);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /append-only/);
  // The original still governs.
  assert.equal((await run(['ask', '--action', 'x'], env)).code, 0);
});

test('supersession changes what applies and keeps what was said', async (t) => {
  const { env } = await fixture(t);
  await run(decideArgs({
    id: 'd-v1', statement: 'Agents may deploy staging.', effect: 'allow', capabilities: 'deploy.staging',
  }), env);
  assert.equal((await run(['ask', '--action', 'deploy.staging'], env)).code, 0);

  const sup = await run(decideArgs({
    id: 'd-v2', statement: 'Staging deploys need me too now.',
    effect: 'require_owner', capabilities: 'deploy.staging', supersedes: 'd-v1',
  }), env);
  assert.equal(sup.code, 0, `${sup.stdout}${sup.stderr}`);
  assert.equal((await run(['ask', '--action', 'deploy.staging'], env)).code, 3);

  // `--all` must still show the original, and show it as superseded.
  const all = await run(['owner-decisions', '--all'], env);
  assert.match(all.stdout, /d-v1\s+\[superseded\]/);
  assert.match(all.stdout, /Agents may deploy staging\./);
  assert.match(all.stdout, /d-v2\s+\[active\]/);

  // Superseding something that does not exist is refused, not silently stored.
  const bad = await run(decideArgs({ id: 'd-v3', capabilities: 'x', supersedes: 'nope' }), env);
  assert.equal(bad.code, 2);
});

test('revocation stops a decision applying and stays in the ledger', async (t) => {
  const { env } = await fixture(t);
  await run(decideArgs({ id: 'd-r', statement: 'temporary', effect: 'allow', capabilities: 'y' }), env);
  assert.equal((await run(['ask', '--action', 'y'], env)).code, 0);

  const rev = await run(['owner-revoke', '--id', 'd-r', '--owner', OWNER, '--reason', 'done'], env);
  assert.equal(rev.code, 0, `${rev.stdout}${rev.stderr}`);
  assert.equal((await run(['ask', '--action', 'y'], env)).code, 4);

  const all = await run(['owner-decisions', '--all'], env);
  assert.match(all.stdout, /d-r\s+\[revoked\]/);
  assert.match(all.stdout, /temporary/);

  // A worker cannot revoke on the owner's behalf.
  await run(decideArgs({ id: 'd-r2', effect: 'allow', capabilities: 'z' }), env);
  const forged = await run(['owner-revoke', '--id', 'd-r2', '--owner', 'code-b'], env);
  assert.equal(forged.code, 2);
  assert.match(forged.stderr, /not the owner/);
});

test('an unreadable ledger exits 2, and 2 is NOT no_decision', async (t) => {
  // The distinction that matters: "I could not find out what I am allowed to
  // do" must never render as "nothing covers this, go ask". The first means
  // stop; the second sends a worker to interrupt the builder.
  const { env, root } = await fixture(t);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(env.AGENTBRIDGE_HOME, { recursive: true });
  await writeFile(path.join(env.AGENTBRIDGE_HOME, 'ownerDecisions.json'), '{"not":"an array"}', 'utf8');

  const r = await run(['ask', '--action', 'commit'], env);
  assert.equal(r.code, 2, `a corrupt ledger did not stop the worker: ${r.stdout}`);
  assert.match(r.stderr, /cannot read the owner decision ledger/);
  assert.ok(root);
});

test('an unclassified action cannot be asked about', async (t) => {
  const { env } = await fixture(t);
  await run(decideArgs({ id: 'd-star', effect: 'allow', capabilities: '*' }), env);
  const r = await run(['ask'], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--action/);
});

test('--json carries decision_id, matched_scope and reason', async (t) => {
  const { env } = await fixture(t);
  await run(decideArgs({
    id: 'd-j', statement: 'Do not spend money without owner approval.',
    effect: 'require_owner', capabilities: 'spend.*', constraints: '{"max_usd":0}',
  }), env);
  const r = await run(['ask', '--action', 'spend.cloudflare', '--json'], env);
  assert.equal(r.code, 3);
  const out = JSON.parse(r.stdout);
  assert.equal(out.outcome, 'owner_required');
  assert.equal(out.decision_id, 'd-j');
  assert.equal(out.matched_scope, 'bridge');
  assert.deepEqual(out.constraints, { max_usd: 0 });
  assert.match(out.reason, /Do not spend money/);
});

test('the ledger file itself is append-only across a supersession', async (t) => {
  // Proving the STORE keeps history, not just that resolution ignores it.
  const { env } = await fixture(t);
  await run(decideArgs({ id: 'd-a', statement: 'first words', effect: 'allow', capabilities: 'q' }), env);
  await run(decideArgs({ id: 'd-b', statement: 'second words', effect: 'deny',
    capabilities: 'q', supersedes: 'd-a' }), env);

  const rows = JSON.parse(await readFile(path.join(env.AGENTBRIDGE_HOME, 'ownerDecisions.json'), 'utf8'));
  assert.equal(rows.length, 2, 'a superseded decision was removed from the ledger');
  const first = rows.find((d) => d.decision_id === 'd-a');
  assert.equal(first.statement, 'first words', 'the original statement was edited');
  assert.equal(first.revoked_at, null);
});
