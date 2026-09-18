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
