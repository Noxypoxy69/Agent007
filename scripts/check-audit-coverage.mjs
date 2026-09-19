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
  console.log(`range: ${range}`);
  console.log(`commits touching a control: ${bearing}`);
  console.log(`of those, unaudited: ${missing}`);
  if (report) console.log(`\n${report}`);
  else if (!result.error) console.log('\nevery control-touching commit in range has a ledger entry.');
}

if (result.error) process.exit(2);
process.exit(result.commits.some((c) => !c.audited) ? 1 : 0);
