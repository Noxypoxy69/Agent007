#!/usr/bin/env node
/**
 * REVIEW ONE RETURNED TASK, ON THE LEASE THAT NOTHING HAD EVER CLAIMED.
 *
 * `claim_review`, `renew_review_lease` and `expire_dead_reviews` have been in
 * the database since 2026-09-15 with no caller anywhere outside migrations and
 * tests. This is the caller, and it is item 4 of docs/ORDER.md.
 *
 *   agentbridge-review --task ./task.json --envelope ./envelope.json \
 *                      --session <my registered session id> --root /tmp/review
 *
 * The task file is the returned row; the envelope file is the MACHINE EVIDENCE
 * the attempt produced, as written by `agentbridge-attempt`. The worker's notes
 * travel in that envelope and this never hands them to a reviewer -- the packet
 * is built by buildReviewerPacket, whose assertNoProse runs on every build.
 *
 * WHAT IT DECIDES AND WHAT IT DOES NOT. Whether this session may review this
 * task is decided by `claim_review` in Postgres, and this honours the answer
 * including its refusals. What the review CONCLUDES is decided by
 * src/reviewDecision.mjs, which the test suite imports and can watch fail.
 *
 * --no-lease TAKES NO LEASE AND RECORDS NOTHING, and it is named for what it
 * does rather than for what it is for. It builds the packet, makes the fresh
 * worktree and runs the reviewer -- so a reviewer implementation can be
 * exercised for real -- and then the submit REFUSES, because there is no lease
 * to submit under. It exits non-zero and reports `no-lease`. It is not a review
 * and nothing in its output can be mistaken for one.
 *
 * Exit 0 ONLY when a decision was RECORDED at the far end. A review that
 * recorded nothing must not read as a review that happened.
 */

import { readFile } from 'node:fs/promises';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { run } from '../src/exec.mjs';
import { createWorkspaceManager } from '../src/workspaceManager.mjs';
import { runReview, STAGE } from '../src/reviewRunner.mjs';
import { reviewConfig } from '../src/hostedRegistry.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};
const has = (name) => args.includes(name);

function die(message, code = 2) {
  process.stderr.write(`agentbridge-review: ${message}\n`);
  process.exit(code);
}

/*
 * STOPPING AFTER A REMOTE FETCH, WITHOUT process.exit().
 *
 * `die` above is safe for every branch that has not opened a socket. The
 * --discover branch has. On node 24 / Windows, process.exit() after a fetch
 * trips a libuv assertion and kills the process with a garbage code:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
 *
 * I hit this on the first live --discover run: the refusal printed correctly and
 * the process then exited -1073740791 instead of 4. For a CLI whose contract is
 * "exit 0 ONLY when a decision was RECORDED", a garbage exit code after a
 * correct answer is the worst possible failure -- it is the gate reporting
 * something that did not happen.
 *
 * bin/agentbridge.mjs already measured the fixes that DO NOT work: destroying
 * undici's dispatcher and deferring through setImmediate both still die. Only
 * `process.exitCode` plus a NATURAL exit survives. But exitCode alone does not
 * halt, and a refusal that carries on would go and review something. So the
 * sentinel throws to halt exactly where exit halted, and the handler converts it
 * into a code and lets the loop drain. `return` is unavailable: module top level.
 */
class Done extends Error {
  constructor(code) { super(`done:${code}`); this.exitCode = code; }
}
process.on('uncaughtException', (err) => {
  if (err instanceof Done) { process.exitCode = err.exitCode; return; }
  process.stderr.write(`agentbridge-review: ${err?.stack ?? err}\n`);
  process.exitCode = 1;
});

const taskPath = flag('--task');
const envelopePath = flag('--envelope');
const root = flag('--root');
const repo = flag('--repo') ?? process.cwd();
const session = flag('--session');
const reviewerPath = flag('--reviewer');
const noLease = has('--no-lease');
const discover = has('--discover');

if ((!taskPath && !discover) || !envelopePath || !root) {
  die('usage: (--task <file.json> | --discover) --envelope <file.json> --root <workspace root> '
    + '[--repo <path>] [--session <id>] [--reviewer <module>] [--no-lease]');
}
if (!noLease && !session) die('--session is required: a review is recorded against a registered session');
if (discover && !session) {
  die('--discover needs --session: choosing what to review requires knowing who is asking, '
    + 'because the one thing a reviewer may never take is its own return');
}

/*
 * DISCOVERY. The step that did not exist, and whose absence is the whole of
 * this defect: `claim_review` and `submit_review` have been callable since
 * 2026-09-15 and this CLI has been able to drive them, but somebody had to
 * already KNOW which task to name. Nobody did, so between 01:13 and 03:20 on
 * 2026-09-17 the dispatcher prepared 740 review proposals for one returned task
 * and every one superseded unread.
 *
 * THE SELECTION IS NOT MADE HERE. `selectReviewable` is pure and lives in
 * src/reviewConsumer.mjs so the suite can watch it refuse; this only fetches
 * rows and reports what the choice was. Nothing about which task is eligible --
 * self-review, a live lease, a head that names no commit -- is decided in a file
 * that needs a network before it can be tested.
 */
let task;
if (discover) {
  const { fetchReviewableWork, HOSTED, closeHttp } = await import('../src/hostedRegistry.mjs');
  const { selectReviewable } = await import('../src/reviewConsumer.mjs');

  /*
   * LEAVE WITHOUT process.exit(). See the Done sentinel above for why.
   *
   * MY FIRST DIAGNOSIS HERE WAS WRONG AND IS WORTH RECORDING. I assumed the
   * assertion was undici holding a keep-alive socket, so the fix was to call
   * closeHttp() before exiting. I did, and it still died with
   * -1073740791 -- because the trigger is process.exit() itself, not the open
   * socket. bin/agentbridge.mjs had already measured exactly that and written it
   * down; I reproduced a solved problem by not reading it first.
   *
   * closeHttp() stays because draining the dispatcher is still correct on its
   * own terms, and because a natural exit waits for the loop to empty. It simply
   * is not what fixes the exit code. Loopback and local servers do not reproduce
   * any of this, so the hermetic suite structurally cannot catch it.
   */
  const leave = async (code) => { await closeHttp(); throw new Done(code); };

  const found = await fetchReviewableWork(process.env);
  if (found.state !== HOSTED.OK) {
    /*
     * A READ THAT FAILED IS NOT AN EMPTY QUEUE. Reporting "nothing to review"
     * when the token was rejected or the service was down is the same mistake as
     * a falling supersede rate reading as success -- it is the absence of an
     * answer being presented as an answer.
     */
    process.stderr.write(`agentbridge-review: --discover could not read reviewable work: `
      + `${found.state}${found.detail ? ` (${found.detail})` : ''}. That is not an empty queue, `
      + 'and it must not be reported as one.\n');
    await leave(4);
  }
  const chosen = selectReviewable({ tasks: found.rows, reviewerSession: session });
  if (!chosen.ok) {
    /*
     * Exit 3 is "the far end said no", which is what this is: there is real work
     * and none of it is mine to take, or there is none at all. The reason names
     * which, because "nobody else is running" and "nothing has been returned"
     * call for completely different responses from whoever is watching.
     */
    process.stdout.write(`nothing to review: ${chosen.reason} `
      + `(returned ${chosen.counts.returned}, mine ${chosen.counts.self}, `
      + `under review ${chosen.counts.underReview}, unreadable ${chosen.counts.unreadable})\n`);
    await leave(3);
  }
  task = chosen.task;
  process.stdout.write(`discovered ${chosen.taskId}: ${chosen.reason}\n`);
} else {
  task = JSON.parse(await readFile(taskPath, 'utf8'));
}

const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
if (!task.task_id) die('the task file needs a task_id');
if (envelope.taskId !== task.task_id) {
  die(`the envelope is for ${envelope.taskId} and the task is ${task.task_id}; `
    + 'a review of a different attempt is not a review of this one');
}

const git = {
  async addWorktree({ path, baseSha, detach }) {
    const r = await run('git', ['worktree', 'add', ...(detach ? ['--detach'] : []), path, baseSha], {
      cwd: repo, timeoutMs: 120_000,
    });
    if (!r.ok) die(`git worktree add failed: ${r.error ?? r.stderr}`);
  },
  async removeWorktree({ path, force }) {
    await run('git', ['worktree', 'remove', ...(force ? ['--force'] : []), path], {
      cwd: repo, timeoutMs: 60_000,
    });
  },
  async isDirty(path) {
    const r = await run('git', ['status', '--porcelain'], { cwd: path, timeoutMs: 60_000 });
    return !r.ok || r.stdout.trim().length > 0;
  },
};

const fs = {
  exists: async (p) => stat(p).then(() => true).catch(() => false),
  mkdirp: (p) => mkdir(p, { recursive: true }),
  rename,
  writeFile: (p, body) => writeFile(p, body),
  rm: (p) => rm(p, { recursive: true, force: true }),
};

/*
 * THE PHOTOGRAPH THAT CATCHES A MEDDLING REVIEWER. Both halves must succeed or
 * the fingerprint is null, which mutationBetween reads as a mutation of unknown
 * kind -- "I could not look" is not "nothing moved".
 */
const workspaceGit = {
  async headSha(path) {
    const r = await run('git', ['rev-parse', 'HEAD'], { cwd: path, timeoutMs: 30_000 });
    if (!r.ok) throw new Error(r.error ?? r.stderr);
    return r.stdout.trim();
  },
  async dirtyFiles(path) {
    const r = await run('git', ['status', '--porcelain'], { cwd: path, timeoutMs: 30_000 });
    if (!r.ok) throw new Error(r.error ?? r.stderr);
    return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  },
};

/*
 * A REVIEWER IS SUPPLIED, NOT BUILT IN.
 *
 * No reviewer means the machine evidence decides alone, which is a real and
 * honest outcome -- a missing reviewer must not make a failing attempt look
 * unjudged, and decideReview carries the machine's reasons either way. What it
 * is NOT is an accept: an attempt with no reviewer and clean evidence is
 * accepted on the evidence, and one with dirty evidence is refused on it.
 */
let reviewer = null;
if (reviewerPath) {
  const mod = await import(reviewerPath.startsWith('.')
    ? new URL(reviewerPath, `file://${process.cwd()}/`).href
    : reviewerPath);
  const make = mod.createReviewer ?? mod.default;
  if (typeof make !== 'function') die(`${reviewerPath} exports no createReviewer`);
  reviewer = make();
  if (typeof reviewer?.review !== 'function') die(`${reviewerPath} produced no review()`);
}

/*
 * THE TRANSPORT. It posts to the edge function with the registration token this
 * machine already holds -- no database credential, and no fifth token class.
 *
 * A 404 IS NAMED, NOT SWALLOWED. The review routes ship in
 * supabase/functions/mcp/index.ts and are live only once that function is
 * deployed. A worker that reads "not found" as a transport failure will retry a
 * route that does not exist; one that reads it as a refusal will blame its
 * credential. It is neither, and saying which it is costs one branch.
 */
function httpBridge(cfg) {
  const post = async (url, body, what) => {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { ok: false, reason: 'unreachable', detail: String(e?.message ?? e) };
    }
    if (res.status === 404) {
      return {
        ok: false,
        reason: 'route-absent',
        detail: `${url} answered 404. The deployed edge function predates the reviewer routes; `
          + `${what} cannot be performed until it is redeployed. This is not a credential `
          + 'problem and retrying will not fix it.',
      };
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* handled below */ }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, reason: 'malformed', detail: `${res.status}: ${text.slice(0, 200)}` };
    }
    if (parsed.ok === true) return parsed;
    return { ok: false, reason: parsed.reason ?? parsed.error ?? `http-${res.status}`, detail: parsed.detail ?? null };
  };

  return {
    claimReview: (body) => post(cfg.claimUrl, body, 'claiming the review lease'),
    submitReview: (body) => post(cfg.submitUrl, body, 'recording the review decision'),
  };
}

/*
 * --no-lease's bridge, and the shape of it is the honesty.
 *
 * The claim succeeds so that the packet, the fresh worktree, the reviewer and
 * the mutation check all really run -- that is the whole point of the flag. The
 * SUBMIT then refuses, because no lease was taken and there is nothing to
 * submit under. The token it hands back is not a uuid and could not be mistaken
 * for one, so it cannot be copied into a real request; the far end would refuse
 * it anyway, and this refuses first.
 *
 * A LOCAL BRIDGE THAT SAID `ok: true` TO THE SUBMIT WOULD BE A FAKE FENCE IN
 * SHIPPED CODE. It would print a recorded decision for a review nothing
 * recorded, which is this repository's oldest failure wearing a new hat.
 */
let bridge;
if (noLease) {
  bridge = {
    claimReview: async () => ({ ok: true, review_lease_token: 'none:--no-lease' }),
    submitReview: async () => ({
      ok: false,
      reason: 'no-lease',
      detail: '--no-lease was passed: the packet was built and the reviewer ran against a fresh '
        + 'worktree, but no review lease was taken and NOTHING WAS RECORDED. Run without it to '
        + 'review live work.',
    }),
  };
} else {
  const cfg = reviewConfig(process.env);
  if (!cfg) {
    die('AGENTBRIDGE_REGISTRATION_TOKEN is not set (or AGENTBRIDGE_REGISTER_URL was overridden '
      + 'to a path this cannot derive /review from). A review is recorded through the edge '
      + 'function, never with a database key.');
  }
  bridge = httpBridge(cfg);
}

const workspaces = createWorkspaceManager({ root, git, fs });

const result = await runReview({
  task,
  reviewerSession: session ?? 'no-lease',
  reviewer,
  workspaces,
  bridge,
  envelopeFor: async () => envelope,
  contract: task.allowed_paths || task.forbidden_paths
    ? { allowed: task.allowed_paths ?? [], forbidden: task.forbidden_paths ?? [] }
    : null,
  io: { workspaceGit, now: () => Date.now() },
});

process.stdout.write(`${JSON.stringify({
  ok: result.ok,
  stage: result.stage,
  task_id: result.taskId,
  reason: result.reason ?? null,
  detail: result.detail ?? null,
  decision: result.decision ?? null,
  fix_task: result.fixTask ?? null,
  disposal: result.disposal ?? null,
}, null, 2)}\n`);

if (result.ok) process.exit(0);

/*
 * A REFUSAL IS NOT A CRASH AND THE EXIT CODE SAYS WHICH. 3 means the far end
 * answered and declined -- the lease is somebody else's, the work is not
 * returned, the token was superseded. 4 means the review itself could not be
 * completed: the reviewer crashed, or it edited the tree and its verdict is
 * void. Both are ordinary; neither is 0, because a review that recorded nothing
 * must not read as a review that happened.
 */
process.exit(result.stage === STAGE.CLAIM || result.stage === STAGE.SUBMIT ? 3 : 4);
