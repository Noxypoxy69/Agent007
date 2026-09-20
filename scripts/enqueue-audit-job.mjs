#!/usr/bin/env node
/**
 * ENQUEUE THE AUDIT DEMAND FOR ONE COMMIT. Called from .git/hooks/post-commit.
 *
 *   node scripts/enqueue-audit-job.mjs --commit <sha> [--tree <sha>] [--quiet]
 *
 * ═══ WHY A GIT HOOK AND NOT A HARNESS HOOK ═══
 *
 * A PostToolUse matcher on "Bash" would miss every commit made through the
 * PowerShell tool, and that is not hypothetical here: CLAUDE.md rule 17
 * records a real session deleting src/claudeGuard.mjs with no refusal from
 * anywhere, because the matcher named tools instead of matching the shape of
 * the call. Git plumbing has no such gap -- every commit runs this, whatever
 * tool issued it, whatever the model intended.
 *
 * ═══ ENQUEUE ONLY. IT MUST NOT RUN AN AUDIT ═══
 *
 * Two reasons, and the second is the one that matters:
 *
 *   COST. The suite is ~537s against a ~400s Stop budget on a box that has
 *   killed three background processes for memory today. A synchronous check
 *   per commit would make committing unusable, and committing is the
 *   behaviour this system wants MORE of -- it is what makes work
 *   recoverable, checkpointable and handover-able.
 *
 *   IT CANNOT SATISFY THE PROTOCOL ANYWAY. A §7.2 audit is an adversarial
 *   second party reading the diff, told what to attack and NOT what the
 *   commit claims. No `execSync` produces that. A hook can create the demand
 *   deterministically; it structurally cannot discharge it. Conflating the
 *   two is how a mechanical check starts being called an audit.
 *
 * ═══ THE PACKET IS BUILT BY auditJobsFor, NOT BY HAND ═══
 *
 * The obvious implementation writes `{commitSha, treeSha, status}` straight to
 * the store. That row is NOT a blind packet: it carries no `required_proofs`
 * and no `touched`, so a reviewer claiming it gets no obligations, and
 * `assertBlind` has nothing to check. Worse, it would diverge from what
 * `audits` and `audit-claim` produce, giving two shapes in one queue -- the
 * pair nobody watches when they disagree.
 *
 * So this calls the same `auditJobsFor` every other producer calls, which
 * emits the §7.4 proofs and deliberately omits the commit SUBJECT, because the
 * subject is the maker's own account of the work.
 *
 * EXITS 0 WHATEVER HAPPENS. A post-commit hook cannot un-commit, and a
 * bookkeeping failure must not turn every commit into an error the agent then
 * tries to "fix". Problems are printed; they never fail the commit.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i === -1 || i + 1 >= argv.length ? null : argv[i + 1];
};
const QUIET = argv.includes('--quiet');
const say = (s) => { if (!QUIET) process.stderr.write(`${s}\n`); };

const commit = flag('--commit');
if (!commit) { say('[audit-queue] no --commit given; nothing enqueued'); process.exit(0); }

try {
  const { runGit } = await import('../src/safeGit.mjs');
  const git = (args) => {
    try { return String(runGit(args, { cwd: REPO })).trim(); } catch { return null; }
  };

  /*
   * THE RANGE IS THIS COMMIT ALONE. A root commit has no parent, so the
   * single-commit spelling `<sha>~1..<sha>` would fail -- and failing here
   * would mean the very first commit in a repository is the one that escapes.
   */
  const hasParent = git(['rev-parse', '--verify', '--quiet', `${commit}^`]) !== null;
  const range = hasParent ? `${commit}~1..${commit}` : commit;

  const { auditCoverage } = await import('../src/auditLedger.mjs');
  const { auditJobsFor, mergeQueue } = await import('../src/auditJob.mjs');
  const { readQueue, writeQueue } = await import('../src/auditQueueStore.mjs');

  let ledgerText = '';
  try { ledgerText = readFileSync(path.join(REPO, 'docs', 'audit-ledger.jsonl'), 'utf8'); } catch { ledgerText = ''; }

  const coverage = auditCoverage({ repoRoot: REPO, range, ledgerText });
  if (!coverage || coverage.error) {
    /* COULD NOT LOOK IS NOT "NOTHING IS DUE", and it is said out loud. */
    say(`[audit-queue] could not classify ${commit.slice(0, 8)}: ${coverage?.error ?? 'unknown'}.`
      + ' No demand recorded -- that is a gap, not a pass.');
    process.exit(0);
  }

  const computed = auditJobsFor(coverage, {
    treeShaFor: (c) => flag('--tree') ?? git(['rev-parse', `${c}^{tree}`]),
    now: new Date().toISOString(),
  });
  if (computed.error) {
    say(`[audit-queue] could not build a packet for ${commit.slice(0, 8)}: ${computed.error}`);
    process.exit(0);
  }

  const jobs = computed.jobs ?? [];
  if (jobs.length === 0) process.exit(0); // touched no control: silent, by design

  const now = new Date().toISOString();
  const merged = mergeQueue(readQueue(REPO).rows, jobs, { now });
  if (merged.added.length || merged.stranded.length) writeQueue(REPO, merged.queue);

  for (const j of jobs) {
    say(`[audit-queue] ${j.audit_id}  ${String(j.candidate_sha).slice(0, 8)}  ${(j.touched ?? []).join(', ')}`);
  }
  say(`[audit-queue] ${merged.added.length} new audit demand(s) recorded. The maker did not select these.`);
} catch (e) {
  say(`[audit-queue-warning] could not enqueue for ${commit.slice(0, 8)}: ${e?.message ?? e}`);
}

process.exit(0);
