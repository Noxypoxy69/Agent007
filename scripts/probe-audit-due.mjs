#!/usr/bin/env node
/**
 * THE §7.1 TRIGGER, EXERCISED EXACTLY AS THE STOP GATE CALLS IT, AND TIMED.
 *
 * `scripts/claude-stop-gate.mjs` does its work at import and cannot be imported
 * by a test, so the only way to check the WIRING rather than the logic is to run
 * the same three calls in the same order against the real repository. That is
 * rule 17: the wiring is a separate claim from the logic, and only the logic has
 * tests.
 *
 * It also prints the COST. The gate has a 420s budget for the suite beneath it,
 * and the objection to per-commit subprocesses is written into auditCoverage's
 * own header -- so the number of git calls this adds is a fact worth measuring
 * rather than asserting. One rev-parse per UNAUDITED commit; an audited one
 * costs nothing, so the steady state is zero.
 *
 * READ-ONLY. It runs rev-parse and reads the ledger. It writes nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditCoverage, defaultAuditRange } from '../src/auditLedger.mjs';
import { auditJobsFor, formatAuditJobs } from '../src/auditJob.mjs';
import { runGit } from '../src/safeGit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

/*
 * `--ledger` EXISTS SO THE STAND-DOWN CAN BE WATCHED WITHOUT FAKING AN AUDIT.
 *
 * Rule 16: before trusting a gate that is red, show it can go green -- and the
 * only honest way to do that here is to hand it a DIFFERENT ledger, never to
 * write a line into the real one claiming an audit that did not happen. A ledger
 * entry is a claim by a human or an agent, and typing one to make a gate quiet
 * is precisely the forgery the ledger's own header warns a reader about.
 */
const ledgerPath = flag('--ledger') ?? path.join(root, 'docs', 'audit-ledger.jsonl');
const range = flag('--range') ?? defaultAuditRange(root);

let ledgerText = '';
try { ledgerText = readFileSync(ledgerPath, 'utf8'); } catch { /* none is not clean */ }

const started = Date.now();
const coverage = auditCoverage({ repoRoot: root, range, ledgerText });

let revParses = 0;
const treeShaFor = (candidate) => {
  revParses += 1;
  try {
    return String(runGit(['-C', root, 'rev-parse', `${candidate}^{tree}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch { return null; }
};

const result = auditJobsFor(coverage, { treeShaFor, now: new Date().toISOString() });
const rendered = formatAuditJobs(result);
const elapsed = Date.now() - started;

console.log(rendered === '' ? '(nothing queued)' : rendered);
console.log('');
console.log(`ledger                              : ${ledgerPath}`);
console.log(`range                               : ${range}`);
console.log(`commits in range touching a control : ${coverage.commits.length}`);
console.log(`of those unaudited                  : ${coverage.commits.filter((c) => !c.audited).length}`);
console.log(`rev-parse calls made                : ${revParses}`);
console.log(`elapsed ms (coverage + jobs)        : ${elapsed}`);

/*
 * EXIT 1 WHEN AUDITS ARE DUE, so this can be watched failing and watched
 * standing down. A probe that always exits 0 proves nothing about either.
 */
process.exit(result.jobs.length > 0 ? 1 : 0);
