#!/usr/bin/env node
/**
 * Which commits changed a control without a recorded audit.
 *
 * Usage:
 *   node scripts/check-audit-coverage.mjs [range]      default: origin/main..HEAD, else the last 40 commits
 *   node scripts/check-audit-coverage.mjs --json
 *
 * EXIT CODES ARE NOT A VERDICT ON THE CODE. 0 means every control-touching
 * commit in range has a ledger line; 1 means some do not; 2 means the question
 * could not be answered. A ledger line is a claim, not proof -- see the header
 * of docs/audit-ledger.jsonl. This reports an ABSENCE, which is the only thing
 * it can honestly report.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditCoverage, formatCoverage, defaultAuditRange } from '../src/auditLedger.mjs';
/*
 * STATICALLY, SO THE WIRING IS VISIBLE TO WHATEVER READS THE MODULE GRAPH.
 *
 * I first imported this with `await import(...)` down in the reporting
 * branch, and `test/noOrphanModules.test.mjs` went red: "test-only
 * src/auditWindow.mjs -- a NEW module is reachable from nothing shipped".
 * The gate was RIGHT and it is rule 17 in miniature. The module was wired,
 * but by an import no static reader can see, so every tool that answers
 * "is this reachable?" -- the orphan gate, the dead-export ratchet, a human
 * grepping for callers -- would have said no. An unscannable import is a
 * weaker claim of wiring than a scannable one, and this module exists
 * BECAUSE the same logic was previously unreachable to the suite.
 *
 * There is no cost: auditWindow is pure, imports nothing, and runs no
 * top-level code. `safeGit` below stays dynamic because it is genuinely
 * optional -- the banner degrades to UNKNOWN without it.
 */
import { windowSpan, describeWindow } from '../src/auditWindow.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const explicit = args.find((a) => !a.startsWith('--'));

const range = explicit ?? defaultAuditRange(repoRoot);

let ledgerText = '';
try {
  ledgerText = readFileSync(path.join(repoRoot, 'docs', 'audit-ledger.jsonl'), 'utf8');
} catch {
  /*
   * NO LEDGER IS NOT NO DEBT. An absent file means nothing has been recorded,
   * so every control-touching commit in range is unaudited -- which is what an
   * empty ledger produces, correctly and loudly.
   */
  ledgerText = '';
}

const result = auditCoverage({ repoRoot, range, ledgerText });

/*
 * §7.1: THE JOBS ARE MATERIALISED HERE, NOT LEFT FOR SOMEBODY TO REMEMBER.
 *
 * "This is mandatory. The worker must not remember to request it." Naming the
 * shas and stopping is what this script did, and naming a problem is not a
 * trigger -- it is the notice the escalation gate was already ignoring.
 *
 * `--jobs` prints the blind packet for every unaudited candidate: the identity,
 * the touched paths, the proofs §7.4 demands -- and NOT the commit subject,
 * which is the maker's own account of the work and the first thing §7.2 says a
 * reviewer must not see. src/auditJob.mjs refuses to build a job carrying one.
 *
 * WHAT THIS STILL IS NOT. A job printed here is a demand, not a running audit.
 * The Stop hook is the only thing that fires without anybody remembering, and
 * wiring it is one import in scripts/claude-stop-gate.mjs. Said plainly so
 * nobody reads a capability as a control -- which is the mistake this whole
 * section exists to stop.
 */
if (args.includes('--jobs')) {
  const { auditJobsFor } = await import('../src/auditJob.mjs');
  const { runGit } = await import('../src/safeGit.mjs');
  const treeShaFor = (sha) => {
    try {
      return String(runGit(['-C', repoRoot, 'rev-parse', `${sha}^{tree}`], { encoding: 'utf8' })).trim();
    } catch { return null; }
  };

  const { jobs, unmeasurable, error } = auditJobsFor(result, {
    treeShaFor, now: new Date().toISOString(),
  });

  if (error) {
    console.error(`[agentbridge:audit-jobs-unknown] ${error}`);
    console.error('  Treat this as UNKNOWN, not as "no audits are due".');
    process.exit(2);
  }
  console.log(JSON.stringify({ range, jobs, unmeasurable }, null, 2));
  /*
   * Exit 1 when audits are DUE. A trigger that exits 0 with work outstanding is
   * the hollow shape audit-auto already shipped once: a run that proved nothing
   * indistinguishable from one that proved everything.
   */
  process.exit(jobs.length > 0 || unmeasurable.length > 0 ? 1 : 0);
}

if (asJson) {
  console.log(JSON.stringify({ range, ...result }, null, 2));
} else {
  const report = formatCoverage(result);
  const bearing = result.commits.length;
  const missing = result.commits.filter((c) => !c.audited).length;
  /*
   * ═══ SAY THAT THE RANGE IS A WINDOW, AND HOW MUCH IT LEAVES OUT ═══
   *
   * Measured 2026-09-21: the default is `HEAD~50..HEAD`, and I read
   * "of those, unaudited: 2" as a statement about my work for several
   * hours. My work was 94 commits. Over the real span the figure was 19.
   * The number was never wrong; it answered a narrower question than the
   * one I was asking, and nothing on screen said so.
   *
   * That is this repository's own primitive -- could-not-measure reported
   * as measured-zero -- arriving in the REPORTING layer, where it is worse
   * than in a test: a test that lies goes red eventually, and a status line
   * that lies is believed and repeated. I repeated it.
   *
   * So the banner names the window, says how many commits lie OUTSIDE it,
   * and tells the reader the one command that widens it. Deriving the
   * outside-count rather than just warning, because "this may be a subset"
   * is advice and "there are 44 commits you are not looking at" is a fact.
   */
  /*
   * ═══ AND SAY WHICH DIRECTION, BECAUSE "older" WAS A GUESS ═══
   *
   * The first version printed `all - seen` and called every one of them
   * OLDER. That holds only when the window's tip is HEAD, which is the
   * default and so was the only case I looked at. For any window ending
   * short of HEAD -- `HEAD~50..HEAD~10`, or a range naming two tags --
   * the excluded commits are the NEWEST ones on the branch, and the
   * banner told the reader they were behind them. That is the same defect
   * the banner was added to fix, one line further on: a number answering
   * a different question than the one it appears to answer.
   *
   * So each direction is counted by git separately, and neither is
   * inferred by subtracting. A count that cannot be taken prints as
   * unknown on its own rather than being folded into the other.
   */
  console.log(`range: ${range}`);
  /*
   * THE DECISION LIVES IN src/, WHERE THE SUITE CAN REACH IT. Blind audit
   * M3 (rule 10) and M2 (the bare-rev branch was wrong and unwatched).
   * This file keeps only the printing.
   */
  let span = { behind: null, ahead: null, kind: 'unknown' };
  try {
    const { runGit } = await import('../src/safeGit.mjs');
    const count = (...revs) => {
      try {
        const n = Number(String(runGit(['-C', repoRoot, 'rev-list', '--count', ...revs], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        })).trim());
        return Number.isFinite(n) ? n : null;
      } catch { return null; }
    };
    span = windowSpan(range, count);
  } catch { /* safeGit itself unavailable; both directions stay null */ }

  const sentence = describeWindow(span);
  if (sentence) {
    console.log(`       ${sentence}`);
    console.log('       Widen it with: node scripts/check-audit-coverage.mjs <base>..HEAD');
  }
  console.log(`commits touching a control: ${bearing}   (within the window above)`);
  console.log(`of those, unaudited: ${missing}`);
  if (report) console.log(`\n${report}`);
  else if (!result.error) console.log('\nevery control-touching commit in range has a ledger entry.');
}

if (result.error) process.exit(2);
process.exit(result.commits.some((c) => !c.audited) ? 1 : 0);
