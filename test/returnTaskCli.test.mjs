import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from './helpers/hermeticEnv.mjs';
import { returnConfig, HOSTED } from '../src/hostedRegistry.mjs';

/**
 * THE WORKER'S HALF OF THE LOOP.
 *
 * assign_task is the coordinator's. return-task is the WORKER'S, and the split
 * is the point: `returned` must be written by the party that did the work, or
 * the accept that follows is one actor on both sides of a review.
 *
 * The head SHA is resolved from git, never passed as a flag, for the same
 * reason register-session derives its own: a return carrying a typed commit is
 * a claim rather than evidence, and every unverifiable status update in this
 * project has had exactly that shape.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

const git = (cwd, a) => new Promise((r) =>
  execFile('git', a, { cwd, windowsHide: true, timeout: 60000 }, (e, o) => r({ ok: !e, out: String(o).trim() })));

function run(args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: hermeticEnv(env), cwd, windowsHide: true, timeout: 120000,
    }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** A stand-in Bridge that records the return and answers however a test asks. */
async function bridge(t, reply = { status: 200, body: { ok: true, task: { state: 'returned' } } }) {
  const posts = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      posts.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { posts, base: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-ret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'work');
  await git(root, ['init', '-q', 'work']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 'T']);
  await writeFile(path.join(repo, 'f.txt'), 'x\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const sha = (await git(repo, ['rev-parse', 'HEAD'])).out;
  return { root, repo, sha, home: path.join(root, 'home') };
}

// ── the URL a worker posts to ──────────────────────────────────────────────
test('the return URL is DERIVED, so a worker still needs one environment variable', () => {
  const cfg = returnConfig({
    AGENTBRIDGE_REGISTRATION_TOKEN: 'tok',
    AGENTBRIDGE_REGISTER_URL: 'https://example.invalid/functions/v1/mcp/register',
  });
  assert.equal(cfg.url, 'https://example.invalid/functions/v1/mcp/return');
  assert.equal(cfg.token, 'tok');
});

test('an odd register URL REFUSES rather than guessing where returns go', () => {
  /*
   * Posting a return to whatever path happened to be there is how a worker
   * reports success into a void. Nothing is worse than a return that looks
   * accepted and reached nobody.
   */
  assert.equal(returnConfig({
    AGENTBRIDGE_REGISTRATION_TOKEN: 'tok',
    AGENTBRIDGE_REGISTER_URL: 'https://example.invalid/somewhere-else',
  }), null);
});

test('an explicit return URL overrides the derivation', () => {
  const cfg = returnConfig({
    AGENTBRIDGE_REGISTRATION_TOKEN: 'tok',
    AGENTBRIDGE_REGISTER_URL: 'https://example.invalid/nope',
    AGENTBRIDGE_RETURN_URL: 'https://example.invalid/custom/return',
  });
  assert.equal(cfg.url, 'https://example.invalid/custom/return');
});

test('no token means no return path at all', () => {
  assert.equal(returnConfig({}), null);
  assert.equal(returnConfig({ AGENTBRIDGE_RETURN_URL: 'https://x.invalid/return' }), null);
});

// ── the command ────────────────────────────────────────────────────────────
test('a return carries the sha RESOLVED FROM GIT, never one that was typed', async (t) => {
  const { repo, sha, home } = await fixture(t);
  const { posts, base } = await bridge(t);

  const r = await run(
    ['return-task', '--task', 't-1', '--session', 'sess-a', '--lease', 'lease-abc', '--notes', 'tests green'],
    {
      AGENTBRIDGE_HOME: home,
      AGENTBRIDGE_REGISTRATION_TOKEN: 'tok',
      AGENTBRIDGE_REGISTER_URL: `${base}/register`,
    },
    repo,
  );

  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(posts.length, 1, 'nothing was sent');
  assert.equal(posts[0].url, '/return', 'posted to the wrong endpoint');
  assert.equal(posts[0].auth, 'Bearer tok');
  assert.deepEqual(posts[0].body, {
    task_id: 't-1', session_id: 'sess-a', lease_token: 'lease-abc', head_sha: sha, notes: 'tests green',
  });
  // There is no --head flag to pass, and the sha sent is the real one.
  assert.match(r.stdout, new RegExp(sha.slice(0, 12)));
  assert.match(r.stdout, /acceptance is theirs, not yours/);
});

test('THERE IS NO WAY TO TYPE A COMMIT: --head is ignored', async (t) => {
  /*
   * The property that matters, and the one a test that merely checks the happy
   * path does not prove. A return whose sha can be supplied by the caller is a
   * claim wearing the costume of evidence -- and the caller here is a model
   * that has just been asked "did you finish?".
   *
   * So this passes a plausible-looking sha on the command line and asserts the
   * Bridge receives the REAL one. Caught by mutation: adding
   * `args.head ?? gR.sha` passed every other test in this file.
   */
  const { repo, sha, home } = await fixture(t);
  const { posts, base } = await bridge(t);
  const lie = 'f'.repeat(40);
  assert.notEqual(lie, sha);

  const r = await run(
    ['return-task', '--task', 't-1', '--session', 'sess-a', '--lease', 'lease-abc', '--head', lie],
    {
      AGENTBRIDGE_HOME: home,
      AGENTBRIDGE_REGISTRATION_TOKEN: 'tok',
      AGENTBRIDGE_REGISTER_URL: `${base}/register`,
    },
    repo,
  );

  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(posts[0].body.head_sha, sha, 'a typed --head reached the Bridge');
  assert.notEqual(posts[0].body.head_sha, lie);
  assert.doesNotMatch(r.stdout, new RegExp(lie.slice(0, 12)));
});

test('A REFUSAL EXITS 1 AND NAMES EVERY REASON', async (t) => {
  /*
   * 409 is the Bridge answering, not failing to answer. A worker told only
   * "refused" retries; a worker told "this is assigned to danny-win-10, not
   * you" stops. Every reason is printed because the worker can usually fix
   * exactly one of them and needs to know which.
   */
  const { repo, home } = await fixture(t);
  const { base } = await bridge(t, {
    status: 409,
    body: {
      error: 'return-refused',
      errors: [
        'task is assigned to session "danny-win-10", not "sess-a"',
        'task is "returned"; only assigned work can be returned',
      ],
    },
  });

  const r = await run(['return-task', '--task', 't-1', '--session', 'sess-a', '--lease', 'lease-abc'], {
    AGENTBRIDGE_HOME: home,
    AGENTBRIDGE_REGISTRATION_TOKEN: 'tok',
    AGENTBRIDGE_REGISTER_URL: `${base}/register`,
  }, repo);

  assert.equal(r.code, 1, 'a refusal is exit 1: the Bridge answered and said no');
  assert.match(r.stderr, /assigned to session "danny-win-10"/);
  assert.match(r.stderr, /only assigned work can be returned/);
  assert.doesNotMatch(r.stdout, /returned t-1/);
});

test('an UNREACHABLE bridge exits 2 and says the work was not returned', async (t) => {
  // Distinct from a refusal. Nothing was recorded, and the worker should try
  // again later rather than conclude its work is filed.
  const { repo, home } = await fixture(t);
  const r = await run(['return-task', '--task', 't-1', '--session', 'sess-a', '--lease', 'lease-abc'], {
    AGENTBRIDGE_HOME: home,
    AGENTBRIDGE_REGISTRATION_TOKEN: 'tok',
    // Nothing listens here.
    AGENTBRIDGE_REGISTER_URL: 'http://127.0.0.1:1/register',
  }, repo);

  assert.equal(r.code, 2);
  assert.match(r.stderr, /unreachable/);
  assert.match(r.stderr, /NOT returned/);
});

test('a 500 is unreachable, not a refusal', async (t) => {
  // Only the guard's 409 means "no". Everything else is the far end being
  // broken, and must not read as a decision about this worker's task.
  const { repo, home } = await fixture(t);
  const { base } = await bridge(t, { status: 500, body: { detail: 'boom' } });

  const r = await run(['return-task', '--task', 't-1', '--session', 'sess-a', '--lease', 'lease-abc'], {
    AGENTBRIDGE_HOME: home,
    AGENTBRIDGE_REGISTRATION_TOKEN: 'tok',
    AGENTBRIDGE_REGISTER_URL: `${base}/register`,
  }, repo);

  assert.equal(r.code, 2);
  assert.notEqual(r.code, 1);
});

test('both identifiers are required, and neither is guessed', async (t) => {
  const { repo, home } = await fixture(t);
  const env = { AGENTBRIDGE_HOME: home, AGENTBRIDGE_REGISTRATION_TOKEN: 'tok' };

  const noTask = await run(['return-task', '--session', 'sess-a'], env, repo);
  assert.equal(noTask.code, 2);
  assert.match(noTask.stderr, /--task <task_id> is required/);

  // Deliberately NOT defaulted from the local registry: returning under
  // whichever session happens to be registered is the confusion the session
  // check on the far end exists to catch.
  const noSession = await run(['return-task', '--task', 't-1'], env, repo);
  assert.equal(noSession.code, 2);
  assert.match(noSession.stderr, /--session <session_id> is required/);
});

test('outside a git repo it refuses rather than inventing a commit', async (t) => {
  const { root, home } = await fixture(t);
  const bare = path.join(root, 'not-a-repo');
  await rm(bare, { recursive: true, force: true }).catch(() => {});
  await writeFile(path.join(root, 'loose.txt'), 'x\n');

  const r = await run(['return-task', '--task', 't-1', '--session', 'sess-a', '--lease', 'lease-abc', '--repo', root], {
    AGENTBRIDGE_HOME: home, AGENTBRIDGE_REGISTRATION_TOKEN: 'tok',
  }, root);

  assert.equal(r.code, 2);
  assert.match(r.stderr, /derived from git, never accepted as a flag/);
});

test('no registration token is a configuration failure, not a refusal', async (t) => {
  const { repo, home } = await fixture(t);
  const r = await run(['return-task', '--task', 't-1', '--session', 'sess-a', '--lease', 'lease-abc'],
    { AGENTBRIDGE_HOME: home }, repo);

  assert.equal(r.code, 2);
  assert.match(r.stderr, /no registration token/);
  assert.match(r.stderr, /NOT a database key/);
});

test('return-task is discoverable in HELP', async (t) => {
  // A command nobody can find is a command nobody uses; this project has
  // already lost two to exactly that.
  const { repo, home } = await fixture(t);
  const r = await run(['help'], { AGENTBRIDGE_HOME: home }, repo);
  assert.match(r.stdout, /return-task --task <task_id> --session <session_id>/);
  assert.match(r.stdout, /DERIVED FROM GIT/);
});

test('REFUSED is a distinct state from UNREACHABLE', () => {
  // Collapsing them would send a worker to check its network for a decision
  // the server made deliberately.
  assert.notEqual(HOSTED.REFUSED, HOSTED.UNREACHABLE);
  assert.equal(HOSTED.REFUSED, 'refused');
});
