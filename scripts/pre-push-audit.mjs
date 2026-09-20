#!/usr/bin/env node
/**
 * AUTO-INDUCE AN AUDIT AT THE MOMENT WORK ESCAPES.
 *
 * Installed as `.git/hooks/pre-push`. git supplies, on stdin, one line per ref:
 *
 *     <local ref> <local sha> <remote ref> <remote sha>
 *
 * ═══ WHY PUSH, AND NOT COMMIT ═══
 *
 * The escaped-audit gate's own words: "These have LEFT THIS MACHINE, so other
 * clones can build on them and the moment to audit has passed." That moment is
 * the push. A local commit is cheap, reversible and invisible to everyone; it
 * is also how work gets checkpointed, rotated and handed over, so gating it
 * punishes the behaviour this system wants more of.
 *
 * Gating commit also DEADLOCKS. A reviewer is an agent too, and its findings
 * and its audit record are commits. If a commit requires a passed audit, the
 * reviewer's commit requires an audit, which requires a reviewer. The only
 * escape is exempting audit records -- a carve-out on the exact path the gate
 * protects, which is how every hole in this repository arrived.
 *
 * ═══ WHY THIS IS NOT THE MAKER SELECTING ITS OWN REVIEW ═══
 *
 * The objection that produced this file: the author was reading the escaped
 * list, choosing which of its own commits to audit, and launching the
 * reviewers. §7.1 says the maker must not have to remember to request one --
 * and must not get to decide.
 *
 * THIS HOOK HAS NO DISCRETION, and that is the whole design:
 *
 *   which commits   computed from the range git is pushing. Not chosen.
 *   when            every push. Not chosen.
 *   which packet    auditJobsFor, the same blind packet as everywhere else --
 *                   the §7.4 proofs and NOT the commit subject.
 *   which reviewer  none. This creates the job and stops. Assignment belongs
 *                   to whatever consumes the queue, and the author has no
 *                   role in it.
 *
 * ═══ REPORT-ONLY BY DEFAULT, AND DELIBERATELY ═══
 *
 * It creates the demand and ALWAYS EXITS 0 unless AGENTBRIDGE_PREPUSH_ENFORCE
 * is set. A blocking gate today would refuse every push, because no eligible
 * reviewer exists to produce a PASS -- all seventeen roster rows read offline.
 * That is a lock on a door with no key, and the first thing anybody does with
 * one is take the lock off. Rule 19: an outage costs every layer at once.
 *
 * So: measure first. The log says exactly what WOULD have been refused, which
 * is the number somebody needs before turning the wall on.
 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENFORCE = process.env.AGENTBRIDGE_PREPUSH_ENFORCE === '1';
const ZERO = /^0+$/;

const say = (s) => process.stderr.write(`${s}\n`);

/** Read git's ref lines. Absent stdin (manual run) means "whatever is unpushed". */
async function refLines() {
  if (process.stdin.isTTY) return [];
  const out = [];
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const t = line.trim();
    if (t) out.push(t.split(/\s+/));
  }
  return out;
}

const lines = await refLines();

const { runGit } = await import('../src/safeGit.mjs');
const git = (args) => {
  try { return String(runGit(args, { cwd: REPO })).trim(); } catch { return null; }
};

/*
 * THE RANGE IS WHAT GIT IS ACTUALLY PUSHING, not what the author says.
 * A brand-new remote branch arrives with an all-zero remote sha, which means
 * every commit reachable from the local ref is escaping for the first time.
 */
const ranges = [];
for (const [, localSha, remoteRef, remoteSha] of lines) {
  if (!localSha || ZERO.test(localSha)) continue; // a deletion escapes nothing
  ranges.push(ZERO.test(remoteSha ?? '') ? { spec: localSha, ref: remoteRef } : { spec: `${remoteSha}..${localSha}`, ref: remoteRef });
}

if (ranges.length === 0) {
  /* Nothing to judge. Never a refusal: a push with no new commits is not an
   * escape, and treating "I could not tell" as "block" is the outage. */
  process.exit(0);
}

let created = 0;
let audited = 0;
const wouldRefuse = [];

try {
  const { auditCoverage } = await import('../src/auditLedger.mjs');
  const { auditJobsFor, mergeQueue } = await import('../src/auditJob.mjs');
  const { readQueue, writeQueue } = await import('../src/auditQueueStore.mjs');
  const { readFileSync } = await import('node:fs');

  /*
   * THE LEDGER IS AN ARGUMENT, and an unreadable one is an EMPTY one, not a
   * reason to skip. An empty ledger makes every control commit in range read
   * as unaudited -- which is loud and correct. Treating "I could not read the
   * ledger" as "nothing is due" is the conflation this whole mechanism exists
   * to prevent.
   */
  let ledgerText = '';
  try {
    ledgerText = readFileSync(path.join(REPO, 'docs', 'audit-ledger.jsonl'), 'utf8');
  } catch { ledgerText = ''; }

  const treeShaFor = (candidate) => git(['rev-parse', `${candidate}^{tree}`]);
  const now = new Date().toISOString();

  for (const r of ranges) {
    const coverage = auditCoverage({ repoRoot: REPO, range: r.spec, ledgerText });
    if (!coverage || coverage.error) {
      /*
       * COULD NOT LOOK IS NOT "NOTHING IS DUE". Said out loud rather than
       * treated as a clean range -- that conflation is the failure this whole
       * repository is built against.
       */
      say(`[agentbridge:prepush] could not classify ${r.spec}: ${coverage?.error ?? 'unknown'}.`
        + ' No audit demand was recorded for it, and that is a gap rather than a pass.');
      continue;
    }

    /*
     * `auditJobsFor` RETURNS A RESULT OBJECT, NOT AN ARRAY -- deliberately, so
     * an unmeasurable candidate is reported rather than silently absent. I
     * wrote that module and still called it as an array here; a single test
     * run said "jobs is not iterable" before this shipped.
     */
    const computed = auditJobsFor(coverage, { treeShaFor, now });
    if (computed.error) {
      say(`[agentbridge:prepush] could not compute audit jobs for ${r.spec}: ${computed.error}.`
        + ' That is a gap, not a pass.');
      continue;
    }
    const jobs = computed.jobs ?? [];
    for (const u of computed.unmeasurable ?? []) {
      say(`[agentbridge:prepush] unmeasurable candidate ${String(u.candidate_sha ?? u).slice(0, 8)}:`
        + ' no audit demand could be keyed to it.');
    }
    audited += Math.max(0, (coverage.commits?.length ?? 0) - jobs.length);
    if (jobs.length === 0) continue;

    const merged = mergeQueue(readQueue(REPO).rows, jobs, { now });
    if (merged.added.length || merged.stranded.length) writeQueue(REPO, merged.queue);
    created += merged.added.length;
    for (const j of jobs) wouldRefuse.push(`${String(j.candidate_sha).slice(0, 8)}  ${(j.touched ?? []).join(', ')}`);
  }
} catch (e) {
  /*
   * A BOOKKEEPING FAILURE MUST NOT BLOCK A PUSH. The demand is the point; the
   * push is not the thing being protected here, escape-without-a-record is.
   * Failing closed on an internal error would make every push hostage to this
   * file, which is how a hook gets uninstalled.
   */
  say(`[agentbridge:prepush] the audit demand could not be recorded (${e?.message ?? e}). Push not blocked.`);
  process.exit(0);
}

if (wouldRefuse.length === 0) {
  if (audited > 0) say(`[agentbridge:prepush] ${audited} control commit(s) already audited. Nothing new demanded.`);
  process.exit(0);
}

say('');
say(`[agentbridge:prepush] ${wouldRefuse.length} control commit(s) are leaving this machine with no audit.`);
say(`  ${created} new audit job(s) recorded automatically. The maker did not select these and cannot.`);
for (const w of wouldRefuse.slice(0, 10)) say(`    ${w}`);
if (wouldRefuse.length > 10) say(`    ...and ${wouldRefuse.length - 10} more`);
say('');
say('  Claim one with:  node bin/agentbridge.mjs audit-claim --id <audit-id>');

if (!ENFORCE) {
  /*
   * THE HONEST PART. Report-only is a measurement, not a control, and saying
   * so is the difference between this and a gate that quietly permits.
   */
  say('  REPORT ONLY: this push is NOT blocked. Set AGENTBRIDGE_PREPUSH_ENFORCE=1 to refuse instead,');
  say('  but not before an eligible reviewer exists -- with none, enforcing refuses every push.');
  process.exit(0);
}

say('  REFUSED: AGENTBRIDGE_PREPUSH_ENFORCE=1 and these carry no terminal audit.');
process.exit(1);
