#!/usr/bin/env node
/**
 * THE CONSUMER. The piece that was missing, and the reason the queue starved.
 *
 *   node scripts/audit-daemon.mjs [--once] [--launch] [--by <id>]
 *
 * ═══ WHAT THIS CLOSES ═══
 *
 * The audit loop had three breaks. Two are fixed: `audit-record` was
 * unreachable dead code, and the §7.1 trigger only printed. The third is that
 * NOTHING CONSUMED THE QUEUE -- four durable demands sat in it and no process
 * owned the next transition. Same shape as the task queue: sixteen runnable
 * rows, zero leases, last dispatch three days ago.
 *
 * A git hook cannot be the consumer. Not because it cannot allocate a
 * workspace -- `src/workspaceManager.mjs` does `git worktree add --detach` and
 * a hook could call it, and I was wrong to say otherwise -- but because a
 * consumer spawned by the maker's own commit is the maker choosing and
 * launching its own reviewer. That is the exact thing §7.1 forbids. The
 * consumer has to be a process that already exists and decides for itself.
 *
 * ═══ WHAT IT DOES NOT DECIDE ═══
 *
 *   which job    the oldest PENDING one it is eligible for. Not chosen.
 *   the packet   whatever `auditJobsFor` already wrote. It does not author
 *                one, and it never reads the commit SUBJECT -- that is the
 *                maker's account of the work and §7.2 keeps it away from the
 *                reviewer.
 *   the verdict  the reviewer's. This starts it and records nothing.
 *
 * ═══ ELIGIBILITY IS REAL AND IT REFUSES ═══
 *
 * A daemon that claimed its own author's work would reproduce the defect it
 * exists to fix, so `claimJob` is asked, not second-guessed: it holds the
 * author-cannot-audit rule, the lease and the staleness window.
 *
 * ═══ --launch IS OPT-IN, DELIBERATELY ═══
 *
 * Without it this prepares the workspace and prints the exact command. With
 * it, it spawns a reviewer. The default is the safe one because this machine
 * has killed three background processes for memory today, and a daemon that
 * fires an LLM session per control commit unattended is how you find that out
 * the expensive way. Measure the volume first.
 */
import {
  existsSync, writeFileSync, mkdirSync, readFileSync, rmSync, mkdtempSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 || i + 1 >= argv.length ? d : argv[i + 1];
};

const ONCE = has('--once');
const LAUNCH = has('--launch');
const say = (s) => process.stderr.write(`${s}\n`);

const { runGit } = await import('../src/safeGit.mjs');
const { readQueue, writeQueue } = await import('../src/auditQueueStore.mjs');
const {
  claimJob, JOB, REQUIRED_PROOFS, makeAuthorResolver, AUTHOR_UNAVAILABLE,
} = await import('../src/auditJob.mjs');
const { proposeAudit, isClaimable } = await import('../src/auditDispatch.mjs');
const { allocateWorkspace, releaseWorkspace } = await import('../src/auditWorkspace.mjs');

/*
 * THE DAEMON'S IDENTITY IS ITS OWN, NOT THE SESSION'S.
 *
 * It must not inherit AGENTBRIDGE_SESSION_ID: if it did, every job it claimed
 * would be claimed by whichever agent happened to start it, and the
 * author-cannot-audit check would compare a session against itself. A distinct
 * id is the minimum honesty available while no credential exists -- and it is
 * `asserted`, which `satisfiesGate` correctly refuses to count.
 */
const BY = flag('--by', `audit-daemon@${os.hostname()}`);

/**
 * HAS THIS CANDIDATE LEFT THE MACHINE?
 *
 * An escaped commit is on other clones already, so the moment to audit it has
 * passed and every hour it stays unaudited is an hour somebody can build on
 * it. A merely-queued one is still local and recoverable. They are not equally
 * urgent and the queue did not know the difference.
 *
 * ASKED OF GIT, not inferred: is the candidate an ancestor of the remote
 * tracking branch. An unreadable ref answers `false` and SAYS so -- treating
 * "I could not tell" as "escaped" would promote everything and destroy the
 * ordering, and treating it as fact would hide it.
 */
function hasEscaped(sha, upstream) {
  if (!upstream) return false;
  try {
    runGit(['merge-base', '--is-ancestor', sha, upstream], { cwd: REPO });
    return true;
  } catch { return false; }
}

function nextJob() {
  const { rows } = readQueue(REPO);

  let upstream = null;
  try {
    upstream = String(runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: REPO })).trim();
  } catch {
    say('[audit-daemon] no upstream ref readable: cannot tell escaped from queued, so ordering is by age alone');
  }

  /*
   * SELECTION IS proposeAudit's, AND MOVING IT THERE FIXED A REAL BUG.
   *
   * This function used to filter `rows` to state === PENDING and rank those.
   * A CLAIMED job whose holder died was therefore NEVER RE-OFFERED -- not
   * after the lease expired, not on the next tick, not after a restart. That
   * is why the eight jobs claimed by a dead seat sat stranded: restarting the
   * daemon would not have recovered a single one of them, because the only
   * thing it ever looked at was PENDING.
   *
   * proposeAudit's `isClaimable` admits PENDING *and* CLAIMED-past-the-lease,
   * so recovery happens here now without this file knowing how a lease works.
   * It also applies the author exclusion at selection, which this never did.
   *
   * ESCAPED FIRST, THEN OLDEST, still -- a RULE, not a pick, which is the
   * whole point of the daemon. The maker does not choose which of its commits
   * get reviewed and does not choose the order either; "already on other
   * machines outranks still local" is a property of the candidate rather than
   * a preference of whoever is watching. That comparator now lives in
   * proposeAudit, and `escaped` is the flag it sorts on.
   */
  /*
   * RE-RESOLVE AN UNKNOWN AUTHOR HERE, BECAUSE THIS PROCESS HAS GIT.
   *
   * Sixth-lap blind audit D-B. `auditJobsFor` records `unavailable` whenever
   * its caller passed no resolver, and two callers that WRITE THE STORE have
   * none: the Stop gate and pre-push. The dispatcher then fail-closes on
   * `unavailable` -- correctly, rule 20 cannot be enforced against an author
   * nobody named -- so every row those two originate was undispatchable.
   *
   * The comment I wrote there said such a row "is picked up on the next tick
   * once the lookup succeeds". THAT WAS FALSE: nothing re-resolved. nextJob
   * only read the queue, and `author_source` was frozen on disk.
   *
   * It is fixed here rather than by giving the Stop gate a resolver, because
   * that file is one no session may edit and because the daemon is the right
   * place anyway: it is the party that dispatches, it has a git handle, and
   * the trailer is immutable so a later read is as good as an earlier one.
   * The upgrade persists through the ordinary claim write, and the strength
   * ordering accepts it because `unavailable` (0) is weaker than `trailer`
   * (2) and than a measured `null` (1).
   */
  const resolveAuthor = makeAuthorResolver(
    (c) => String(runGit(['log', '-1', '--format=%B', c], { cwd: REPO })),
  );
  const jobs = rows.map((j) => {
    const base = { ...j, escaped: hasEscaped(j.candidate_sha, upstream) };
    if (base.author_source !== AUTHOR_UNAVAILABLE) return base;
    const answer = resolveAuthor(base.candidate_sha);
    if (answer === AUTHOR_UNAVAILABLE) return base;   // still cannot look
    return { ...base, author_session: answer, author_source: answer ? 'trailer' : null };
  });

  /*
   * ONE SEAT: this process. isLive is `true` because the daemon is the thing
   * asking -- it is demonstrably running. That is the honest answer here and
   * NOT a bypass of liveRegistry: the registry answers "is that other agent
   * alive", a question nobody needs to ask about themselves.
   */
  const seat = { session_id: BY, agent_id: BY, capacity: 'idle' };
  const plan = proposeAudit({
    jobs, sessions: [seat], now: Date.now(), isLive: () => true,
  });

  const claimable = jobs.filter((j) => isClaimable(j, { now: Date.now() }));
  const escapedCount = claimable.filter((j) => j.escaped).length;
  if (escapedCount) {
    say(`[audit-daemon] ${escapedCount} of ${claimable.length} claimable have already left the machine; taking those first`);
  }

  const picked = plan.proposals[0] ?? null;
  if (!picked) {
    /*
     * SAY WHY NOTHING WAS TAKEN. "no job" and "the only job left is one I
     * wrote myself" are different states, and the second is the one that
     * looks like an idle daemon while a control sits unreviewed.
     */
    for (const u of plan.unassigned.slice(0, 3)) say(`[audit-daemon] ${u.audit_id}: ${u.why}`);
    return { rows, job: null, pendingCount: claimable.length };
  }

  const job = jobs.find((j) => j.audit_id === picked.audit_id) ?? null;
  if (picked.recovered) {
    say(`[audit-daemon] ${picked.audit_id} RECOVERED from ${picked.previous_holder}: its lease expired`);
  }
  return { rows, job, pendingCount: claimable.length };
}

/**
 * A detached worktree at the exact candidate, at a path nobody can predict.
 *
 * ═══ THE NAME WAS THE ROOT CAUSE OF THREE FINDINGS ═══
 *
 * Sixth-lap blind audit, and the auditor named the cheap fix: this was
 * `%TEMP%/audit-<sha12>`, DERIVED FROM THE CANDIDATE, so any local process
 * could compute the path before the daemon ever ran. Everything downstream
 * followed from that one choice:
 *
 *   D9  a pre-created directory was adopted, and verifying it needed three
 *       separate checks (registered worktree / at the candidate / clean) of
 *       which only one was ever written. A separate `git clone` at the right
 *       commit passed the one check and defeated the other two.
 *   D10 `mkdir %TEMP%/audit-<sha12>` of the head-of-queue candidate WEDGED
 *       THE WHOLE DAEMON: allocate refused, the job stayed PENDING, and it
 *       is re-selected first on every subsequent tick. Permanently, silently,
 *       with no fallback and no alarm.
 *   D11 teardown `--force`-removed a directory the daemon may not have
 *       created, destroying a review in progress left by the `!LAUNCH` path.
 *
 * `mkdtempSync` removes all three at once: the path is unguessable, so it is
 * never pre-created, never adopted, never someone else's. No reuse logic
 * remains to be got wrong, and the verification it needed is gone rather
 * than improved -- which is the better outcome, because two of its three
 * checks were never going to be written.
 *
 * The cost is that the `!LAUNCH` convenience no longer reuses a prepared
 * worktree across runs. That was never reliable anyway -- it depended on the
 * name colliding -- and the path is printed, so an operator can still work
 * in it.
 */
function allocate(candidateSha) {
  /*
   * DELEGATED, so the contract is testable. The first version of this fix
   * inlined `mkdtempSync` here -- which removed the predictable NAME and
   * left the identity fuzzy: nothing stopped a later caller recomputing a
   * path from the sha, and with a per-run suffix there can now be several
   * workspaces for one candidate, so a recomputed path is a guess at which
   * one it owns. Danny's correction: allocation MINTS an identity and
   * cleanup CONSUMES it.
   *
   * src/auditWorkspace.mjs also gets the run id from `randomUUID` rather
   * than `mkdtemp`'s six implementation-defined characters, because the
   * threat is a local process PREDICTING the path -- a guessability
   * property, not a uniqueness one.
   */
  const r = allocateWorkspace({ candidateSha, runGit, repoRoot: REPO });
  if (!r.ok) return { ok: false, why: r.why };
  return { ok: true, dir: r.allocation.dir, allocation: r.allocation, reused: false };
}

/**
 * The brief. THE COMMIT SUBJECT IS NOT IN IT, and that is the whole point of
 * §7.2: a reviewer who reads the maker's account starts by agreeing with it.
 */
function brief(job, dir, nonce) {
  return [
    'You are an INDEPENDENT AUDITOR. You did not write this. Your job is to BREAK it, not confirm it.',
    '',
    `WORK ONLY IN: ${dir}`,
    'It is a detached worktree at the exact candidate. Do not touch any other checkout.',
    'Do not commit, push, merge, deploy or migrate.',
    '',
    `CANDIDATE: ${job.candidate_sha}`,
    `TREE:      ${job.candidate_tree_sha}`,
    `TOUCHED:   ${(job.touched ?? []).join(', ')}`,
    '',
    'You are deliberately NOT being told what this change claims to do. That account is the',
    'maker\'s own and reading it means starting from agreement. Derive intent from the diff.',
    '',
    'PROOF OBLIGATIONS:',
    ...(job.required_proofs ?? REQUIRED_PROOFS ?? []).map((p, i) => `  ${i + 1}. ${p}`),
    '',
    'Assert the reported TEST COUNT, never the exit code. Prove any mutation landed with git diff',
    'before trusting the result, and restore it afterwards.',
    '',
    'REPORT: defects ranked by severity, each with the command that demonstrates it; SEPARATELY the',
    'claims you checked and found TRUE; and what you could not check and why.',
    '',
    'THEN END YOUR OUTPUT WITH THE VERDICT BLOCK DESCRIBED BELOW. Print it to STDOUT. Writing a',
    'file is no longer read at all: .audit/VERDICT.json lived inside this worktree, which is',
    'checked out from the candidate you are auditing, so a candidate could ship its own PASS there',
    'and your honest silence would have been read as that PASS. Stdout carrying a secret the',
    'candidate cannot know is the only channel now.',
    '',
    /*
     * THE TEMPLATE IS SPELLED OUT, NOT SHOWN. Fifth-lap blind audit D3: the
     * brief used to render a syntactically COMPLETE block carrying the live
     * nonce, inside the worktree, and the brief is the one file the reviewer
     * is told to read. So a reviewer quoting its instructions emitted a
     * second matching block -- and the "more than one is a refusal" rule
     * then discarded a real finding (rule 16), or, if it emitted none of its
     * own, left exactly one block whose body is the literal
     * `"PASS"|"FAIL"` placeholder, which fails JSON.parse and fell through
     * to the file channel.
     *
     * Rule 13, the oldest trap in this repository: the control matched its
     * own template. The markers are described here in pieces that do not
     * form a match.
     */
    `  Print a line that is three less-than signs, then AGENT007_VERDICT, then a colon,`,
    `  then ${nonce} -- with nothing else on that line.`,
    '  On the following lines print the JSON object:',
    '    {"verdict":"PASS" or "FAIL","findings":["short line each"],',
    '     "checked_true":["short line each"],"could_not_check":["short line each"]}',
    `  Then a line that is AGENT007_VERDICT, a colon, ${nonce}, and three greater-than signs.`,
    '',
    'The markers matter: they are how a machine reads this without guessing at prose, and a guess',
    'that landed on PASS would be a forged clearance. PASS means you tried to break it and could',
    'not. FAIL means you found a defect. If you established neither, emit no block -- absence reads',
    'as "nothing was proved", which is honest and is never treated as a pass.',
    '',
    `THE TRAILING ${nonce} IS A PER-RUN NONCE AND IT IS NOT DECORATION. The marker used to be a`,
    'fixed literal, and this brief lives inside the worktree you are auditing -- so a candidate',
    'could plant a complete verdict block in any file you might print, and YOUR honest quoting of',
    'observed output would have handed back a forged PASS before your real conclusion was read.',
    'Emit the block EXACTLY ONCE. If two blocks carrying this nonce appear in your output, the',
    'run is refused and your work is discarded -- so do not echo it back while explaining it, and',
    'if you must discuss the format, describe it rather than reproducing it.',
  ].join('\n');
}

async function tick() {
  const { rows, job, pendingCount } = nextJob();
  if (!job) {
    /*
     * "EMPTY" AND "STARVED" ARE DIFFERENT, AND THIS SAID EMPTY FOR BOTH.
     * Sixth-lap blind audit D-C. A queue full of jobs none of which can be
     * placed -- no live seat, every seat busy, the author unknown -- was
     * reported as `queue empty`, which is the one sentence guaranteed to
     * stop anybody looking. Same shape as the complaint the `audits` seats
     * line was added to answer, one layer down.
     */
    const claimableNow = pendingCount;
    say(claimableNow > 0
      ? `[audit-daemon] STARVED: ${claimableNow} claimable job(s) and none could be placed. `
        + 'Reasons above. This is not an empty queue.'
      : `[audit-daemon] queue empty (${rows.length} row(s)); nothing to consume`);
    return false;
  }

  /*
   * THE AUTHOR IS PASSED IN, WHICH IT WAS NOT. Blind audit D4, HIGH.
   *
   * The header forty lines up says "a daemon that claimed its own author's
   * work would reproduce the defect it exists to fix, so claimJob is asked,
   * not second-guessed: it holds the author-cannot-audit rule". claimJob does
   * hold that rule -- and this call handed it no `authorSession`, so the rule
   * had nothing to compare and could not fire. The comment described an
   * intent the call did not implement, which is the most expensive kind of
   * comment in this repository.
   *
   * `job.author_session` is populated by auditJobsFor now. It is the trailer,
   * so it is provenance rather than authority and can never grade `enforced`
   * -- it catches the honest case, which is the one that was happening.
   */
  const claim = claimJob(job, {
    by: BY,
    bySource: 'asserted',
    authorSession: job.author_session ?? null,
    authorSource: job.author_source ?? null,
    now: Date.now(),
  });
  if (!claim.ok) {
    say(`[audit-daemon] cannot claim ${job.audit_id}: ${claim.why}`);
    return false;
  }

  const ws = allocate(job.candidate_sha);
  if (!ws.ok) {
    /* NOT CLAIMED IF NOT WORKABLE. Leaving a claim on a job nobody can start
     * strands it until the lease lapses, which is starvation wearing a claim. */
    say(`[audit-daemon] could not allocate a workspace for ${job.audit_id}: ${ws.why}. Leaving it PENDING.`);
    return false;
  }

  writeQueue(REPO, rows.map((r) => (r.audit_id === job.audit_id ? claim.job : r)));

  /*
   * MINTED PER RUN, NEVER COMMITTED. A candidate authored before this moment
   * cannot contain it, which is the whole property -- see the verdict parser
   * for the forgery it closes. `randomUUID` because guessability is the
   * entire threat model; a counter or a timestamp would be predictable from
   * the candidate's own side.
   */
  const nonce = randomUUID().replace(/-/g, '').slice(0, 16);

  /*
   * ═══ THE BRIEF LIVES OUTSIDE THE TREE IT DESCRIBES ═══
   *
   * Sixth-lap blind audit D-A, HIGH, and it falsified a security claim I had
   * written one commit earlier. Removing the VERDICT.json channel, I wrote
   * "there is ONE channel now, and it is the one carrying a secret the
   * candidate cannot know". The nonce was written into
   * `<worktree>/.audit/BRIEF.txt` -- inside the tree that
   * `git worktree add --detach <dir> <candidate_sha>` had just checked out
   * FROM THE CANDIDATE -- and the reviewer runs with `cwd: ws.dir`, so the
   * candidate's own CLAUDE.md loads as its project instructions. The
   * daemon's own comment six lines away said exactly that.
   *
   * So the nonce was readable by candidate-controlled content before the
   * reviewer started, and the two-blocks refusal only catches a REPLAY
   * beside an honest block. An injected instruction that suppresses the
   * reviewer's own block and emits one forged PASS produces a single match
   * that parses cleanly and is recorded. One of two doors was closed and the
   * message said there was only one.
   *
   * The brief path is already handed to the reviewer as an ABSOLUTE path, so
   * moving the directory out of the worktree costs nothing and closes it.
   * It also closes D-H: a candidate committing a FILE named `.audit` made
   * `mkdirSync` throw after the job was already marked CLAIMED, stranding it
   * and taking the daemon down.
   */
  const briefDir = path.join(os.tmpdir(), `audit-brief-${nonce}`);
  mkdirSync(briefDir, { recursive: true });
  const briefPath = path.join(briefDir, 'BRIEF.txt');
  writeFileSync(briefPath, `${brief(job, ws.dir, nonce)}\n`);

  say(`[audit-daemon] claimed ${job.audit_id} (${pendingCount} pending)`);
  say(`[audit-daemon] workspace ${ws.dir}${ws.reused ? ' (reused)' : ''}`);
  say(`[audit-daemon] brief     ${briefPath}`);

  if (!LAUNCH) {
    say('[audit-daemon] PREPARED ONLY. To review it, run a fresh agent in that worktree with that brief.');
    say('               --launch spawns one; it is opt-in because an unattended LLM per control commit');
    say('               is how a memory-starved machine falls over.');
    return true;
  }

  /*
   * A CLAIM THAT CANNOT BE WORKED MUST GO BACK.
   *
   * The first version let the spawn failure escape as an unhandled 'error'
   * event: the daemon crashed and the job stayed CLAIMED with no reviewer,
   * stranded until the lease lapsed. I had guarded exactly that for workspace
   * allocation five lines above and not for the spawn -- the same failure, one
   * step later. A consumer that claims work it then abandons is starvation
   * wearing a claim, which is worse than never having claimed it.
   */
  const release = (why) => {
    const back = readQueue(REPO).rows.map((r) => (r.audit_id === job.audit_id
      ? { ...r, state: JOB.PENDING, claimed_by: null, claimed_at: null }
      : r));
    writeQueue(REPO, back);
    say(`[audit-daemon] released ${job.audit_id} back to PENDING: ${why}`);
    /*
     * AND TEAR THE WORKTREE DOWN HERE, because teardown used to sit only at
     * the END of tick(). Fourth-lap blind audit M5: every early return
     * skipped it, and the three that do so -- spawn error, reviewer non-zero
     * exit, no readable verdict -- are exactly the three paths this helper
     * was written for. So the commit whose message said it had stopped the
     * worktrees accumulating left the leak open on precisely the failures
     * that leak most often.
     *
     * It matters beyond tidiness: by this repository's own notes each
     * leftover worktree adds permanent Stop-gate drift lines, so a leaking
     * consumer degrades a control on every failed review.
     *
     * Failure to remove is reported, never thrown -- the release itself has
     * already landed and must not be undone by a cleanup problem.
     */
    /*
     * THE ALLOCATION, NOT THE PATH. `releaseWorkspace` refuses anything
     * whose directory does not match the identity it claims, which is what
     * stops a future edit recomputing a name from the sha and deleting a
     * SIBLING run of the same candidate -- newly possible now that the
     * suffix is per-run.
     */
    const rel = releaseWorkspace(ws.allocation, { runGit, repoRoot: REPO });
    say(rel.ok
      ? `[audit-daemon] removed ${ws.dir}`
      : `[audit-daemon] could NOT remove ${ws.dir}: ${rel.why}`);
    /*
     * AND THE BRIEF, which now lives outside the worktree (D-A) and so is no
     * longer carried away by `worktree remove`. It holds the run's nonce, so
     * leaving it behind leaves the secret on disk.
     */
    try { rmSync(briefDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  /*
   * `shell: true` ON WINDOWS, because `claude` is a .cmd shim and a bare
   * spawn cannot resolve it -- measured: spawn claude ENOENT, errno -4058.
   * The arguments here are a path derived from a sha and a fixed sentence, so
   * there is no caller-controlled text reaching the shell.
   */
  /*
   * STDOUT IS CAPTURED AS WELL AS SHOWN, because the verdict arrives on it.
   * `stdio: 'inherit'` alone gave the operator the transcript and gave this
   * process nothing to read -- which is how the first reviewer's FAIL was
   * lost.
   */
  let transcript = '';
  /*
   * THE BRIEF PATH IS QUOTED, BECAUSE IT CONTAINS A SPACE ON THIS MACHINE.
   *
   * Fourth-lap blind audit M12. With `shell: true` Node joins the file and
   * args with spaces and applies NO quoting -- that is documented -- and
   * `os.tmpdir()` on this machine sits under a home directory whose name
   * CONTAINS A SPACE. So the reviewer
   * received the prompt split across roughly eight tokens with the path
   * broken in the middle, could not open the brief, produced no verdict
   * marker, and the job was released. The brief is what carries the
   * blindness discipline and the proof obligations, so a reviewer that
   * cannot read it is not a degraded review -- it is no review at all,
   * looping.
   *
   * Double quotes are correct for cmd.exe, which is the shell `shell: true`
   * selects on win32, and harmless in the prompt text on other platforms
   * where no shell is used at all.
   */
  const child = spawn('claude', ['-p', `Read "${briefPath}" and carry it out.`], {
    cwd: ws.dir, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
  });
  child.stdout?.on('data', (d) => { transcript += d; process.stdout.write(d); });
  child.stderr?.on('data', (d) => { transcript += d; process.stderr.write(d); });

  const code = await new Promise((resolve) => {
    child.on('error', (e) => { release(`the reviewer could not be started (${e.code ?? e.message})`); resolve(null); });
    child.on('close', resolve);
  });

  if (code === null) return false;
  if (code !== 0) {
    release(`the reviewer exited ${code} without recording a verdict`);
    return false;
  }

  /*
   * THE VERDICT IS READ FROM A FILE, NOT PARSED OUT OF PROSE.
   *
   * The obvious implementation greps the reviewer's output for PASS or FAIL.
   * Prose has infinite shapes, a regex has one, and the failure direction is
   * catastrophic: a mis-parse that lands on PASS is a forged clearance for a
   * control nobody reviewed. So the reviewer writes JSON, and anything this
   * cannot read is NOT A PASS.
   *
   * ABSENCE IS "NOTHING WAS PROVED". A reviewer that exits cleanly without
   * writing a verdict has told us nothing, which is different from telling us
   * the tree is fine -- the same distinction as a shard that could not start,
   * and as `measured: false` on the hold bar.
   */
  /*
   * ═══ A PER-RUN NONCE, AND MORE THAN ONE BLOCK IS A REFUSAL ═══
   *
   * Fourth-lap blind audit H4. The marker was a FIXED LITERAL, matched
   * first-match-wins, over a transcript holding the reviewer's stdout and
   * stderr -- while the reviewer is an LLM auditing a candidate in a worktree
   * AT that candidate, and routinely quotes file contents and command output
   * into its report.
   *
   * So a candidate commit could plant the marker block in any file the
   * reviewer would print -- a test name, a script banner, a fixture -- and an
   * HONEST reviewer quoting observed output before its own conclusion handed
   * the daemon a forged PASS. The planted block matched first; the reviewer's
   * real FAIL was never examined. The literal is published in this file and
   * written verbatim into the brief, so the candidate always knew it.
   *
   * Two changes, and the nonce alone would not be enough:
   *
   *   1. THE NONCE. Minted per run, never committed, so a candidate written
   *      before the run cannot contain it. The brief carries it to the
   *      reviewer.
   *   2. REFUSE ON MORE THAN ONE MATCH. A reviewer that legitimately echoes
   *      its own block twice, or a candidate that captures the nonce out of
   *      the brief inside the worktree and replays it, produces two. Taking
   *      either one is a guess; `release` is the honest answer, and it is the
   *      safe direction -- the job returns to PENDING.
   *
   * Rule 8: the fix is the matcher, not a longer literal.
   */
  let verdict = null;
  const marker = new RegExp(
    `<<<AGENT007_VERDICT:${nonce}([\\s\\S]*?)AGENT007_VERDICT:${nonce}>>>`,
    'g',
  );
  const blocks = [...String(transcript).matchAll(marker)];
  if (blocks.length > 1) {
    release(`the transcript carried ${blocks.length} verdict blocks for this run's nonce; `
      + 'taking either one would be a guess, so nothing was proved');
    return false;
  }
  if (blocks.length === 1) {
    try {
      const parsed = JSON.parse(blocks[0][1].trim());
      const v = typeof parsed?.verdict === 'string' ? parsed.verdict.trim().toUpperCase() : null;
      if (v === 'PASS' || v === 'FAIL') verdict = { ...parsed, verdict: v };
    } catch { verdict = null; }
  }
  /*
   * ═══ THE FILE FALLBACK IS GONE. IT WAS THE OTHER HALF OF THE FORGERY ═══
   *
   * Fifth-lap blind audit D2, HIGH. The nonce hardened the stdout channel and
   * left this one untouched, and the comment that used to sit here NAMED the
   * problem -- "it lives INSIDE the worktree, which is candidate-controlled"
   * -- and then read the file anyway. Rule 8 applied to half the matcher.
   *
   * `git worktree add --detach <dir> <candidate_sha>` checks out the
   * candidate, so `.audit/VERDICT.json` is on disk BEFORE the reviewer starts
   * if the candidate commits one. `mkdirSync(recursive:true)` does not clear
   * it and `.audit` is not ignored. A candidate carrying
   * `{"verdict":"PASS","findings":[]}` then only needs the reviewer to exit 0
   * without emitting a block -- which the brief explicitly sanctions as the
   * honest outcome when nothing was established. The honest outcome became a
   * PASS.
   *
   * "Read only when no nonce block was produced" was not a mitigation: it is
   * precisely the case an attacker arranges, and D3 shows two ways to arrange
   * it (the brief's own template block fails JSON.parse, and a candidate's
   * CLAUDE.md is loaded as the reviewer's project instructions).
   *
   * So there is ONE channel now, and it is the one carrying a secret the
   * candidate cannot know. A reviewer that genuinely cannot write to stdout
   * has no route -- and that is the correct trade: losing a verdict is
   * recoverable, accepting a forged one is not.
   */

  if (!verdict) {
    release('the reviewer recorded no readable verdict, so nothing was proved');
    return false;
  }

  say(`[audit-daemon] ${job.audit_id}: ${verdict.verdict}`);
  for (const f of (verdict.findings ?? []).slice(0, 8)) say(`    finding: ${f}`);

  /*
   * THE TERMINAL WRITE IS ATTEMPTED, AND ITS REFUSAL IS REPORTED RATHER THAN
   * WORKED AROUND. `recordAudit` holds the fences -- the writer must be the
   * claimant, the lease must be live, the candidate must not have moved, and
   * independence must be `enforced`. Under PRE_GENESIS the last one refuses,
   * correctly: evidence accumulates, promotion does not. A daemon that
   * "helpfully" relaxed that would be minting clearances.
   */
  const rec = spawnSync(process.execPath, [
    path.join(REPO, 'bin', 'agentbridge.mjs'), 'audit-record',
    '--id', job.audit_id, '--verdict', verdict.verdict,
    /*
     * THE CANDIDATE AND ITS TREE ARE NAMED, or the fence compares the row
     * against itself. Fourth-lap blind audit M7.
     *
     * `recordAudit` fences on `candidate_sha` and `candidate_tree_sha` --
     * the audit-pin lesson, demonstrated live against this repository. The
     * daemon passed NEITHER, and the CLI defaults both FROM THE ROW, so on
     * the only automated write path the check compared the row with itself
     * and could never fire.
     *
     * The values come from the job as CLAIMED, not from the worktree: what
     * is being asserted is "the thing I reviewed is the thing I was given".
     * A reviewer that edits the worktree cannot move the sha, but it can
     * move the tree, and that is exactly what the tree half of the fence is
     * for -- so passing it is what makes the fence mean anything here.
     */
    '--candidate', String(job.candidate_sha),
    '--tree', String(job.candidate_tree_sha),
    /*
     * THE WRITER MUST BE NAMED, and it is the DAEMON's identity, not the
     * session's. `recordAudit` fences on writer === claimant; the daemon is
     * what claimed the job, so anything else is refused -- correctly. The
     * first run failed here with "a terminal write needs its writer named",
     * which I had predicted would be a PRE_GENESIS refusal. It was not: it
     * was this argument missing, and I would have gone on believing the
     * containment was doing work that a missing flag was doing.
     */
    '--by', BY,
  ], { cwd: REPO, encoding: 'utf8' });

  const out = `${rec.stdout ?? ''}${rec.stderr ?? ''}`.trim();
  if (rec.status === 0) {
    say(`[audit-daemon] recorded ${job.audit_id} as ${verdict.verdict}`);
  } else {
    /*
     * REVIEWED, RECORD REFUSED. A THIRD STATE, AND IT NEEDS SAYING.
     *
     * Under PRE_GENESIS `recordAudit` refuses every write, so holding the
     * claim jams the queue after a handful of reviews -- and the job reads as
     * "somebody is working on it" when the work is finished. Releasing it
     * plainly is worse: the review is lost and the next pass pays for it
     * again.
     *
     * So it goes back to PENDING carrying what was learned. A later run, once
     * an anchor exists, can record without re-reviewing, and `audits` can show
     * the difference between never-looked-at and looked-at-but-unrecordable.
     */
    say(`[audit-daemon] verdict produced but NOT recorded: ${out.split('\n')[0] ?? `exit ${rec.status}`}`);
    say('               The finding still stands; only the terminal write was refused.');
    const withReview = readQueue(REPO).rows.map((r) => (r.audit_id === job.audit_id
      ? {
        ...r,
        state: JOB.PENDING,
        claimed_by: null,
        claimed_at: null,
        last_review: {
          verdict: verdict.verdict,
          findings: verdict.findings ?? [],
          by: BY,
          at: new Date().toISOString(),
          not_recorded_because: out.split('\n')[0] ?? `exit ${rec.status}`,
        },
      }
      : r));
    writeQueue(REPO, withReview);
  }

  /*
   * TEARDOWN. Thirteen worktrees had accumulated in TEMP before this existed,
   * because the daemon allocated and never released. The findings live in the
   * captured transcript, not in the worktree, so removing it loses nothing --
   * and `git worktree remove` is used rather than a directory delete so git's
   * administrative records go too, instead of leaving entries that only
   * `prune` can clear.
   */
  try { rmSync(briefDir, { recursive: true, force: true }); } catch { /* best effort */ }
  /* Same identity discipline as the release path; see releaseWorkspace. */
  const rel = releaseWorkspace(ws.allocation, { runGit, repoRoot: REPO });
  say(rel.ok
    ? `[audit-daemon] removed ${ws.dir}`
    : `[audit-daemon] could not remove ${ws.dir}: ${rel.why}`);
  return true;
}

const did = await tick();
if (!ONCE && did) say('[audit-daemon] --once not given, but this build consumes one job per invocation by design.');
process.exit(0);
