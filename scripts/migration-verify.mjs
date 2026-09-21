#!/usr/bin/env node
/**
 * PROVE THE MIGRATED STATE RESOLVES — not that the files arrived.
 *
 * ═══ WHY PRESENCE IS NOT THE TEST ═══
 *
 * Every one of these stores can be present, byte-perfect, hash-verified, and
 * still invisible to Agent007. `audits/<key>.jsonl` and `findings/<key>.jsonl`
 * are named `sha256(canonical git-common-dir)[0:16]` (`repoStorePath`,
 * src/guardSession.mjs). The key is a fact about WHERE THE REPOSITORY LIVES.
 * Clone to a different path on the new machine and the key changes, so a
 * perfectly copied ledger sits under a filename nothing ever looks for and
 * **readQueue returns an empty array rather than an error**.
 *
 * An empty queue and a missing queue are indistinguishable to every consumer.
 * So `ls` proves nothing here, a hash proves nothing here, and a migration can
 * report success with its entire authority history orphaned one filename away.
 *
 * THIS SCRIPT THEREFORE READS THROUGH THE REAL CONSUMERS. Not `readFileSync`,
 * not a re-implemented parser -- the exact functions the running system uses:
 *
 *     readQueue          src/auditQueueStore.mjs      the audit queue
 *     readDelegations    src/provenanceStore.mjs      delegations
 *     readLeadWork       src/provenanceStore.mjs      lead work
 *     readMeasurements   src/provenanceStore.mjs      token measurements
 *     readEscalations    src/provenanceStore.mjs      escalations
 *     repoStorePath      src/guardSession.mjs         the findings path
 *
 * A gate that rebuilds the rule agrees with itself (hollow gate 2). If a reader
 * is changed and this script keeps its own copy, this passes while the system
 * is broken. So it imports them.
 *
 * ═══ AND IT COMPARES AGAINST THE MANIFEST ═══
 *
 * Resolving to SOMETHING is not resolving to the RIGHT thing. A truncated
 * ledger resolves fine and is short. Every count is compared to the record
 * count the packager measured at source, so silent truncation fails loudly.
 *
 *   node scripts/migration-verify.mjs --package <dir>
 *
 * Exit 0 only when every store resolved AND every count matched.
 * READ-ONLY. It changes nothing, on either machine.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from '../src/invokedDirectly.mjs';
import { readQueue } from '../src/auditQueueStore.mjs';
import { repoStorePath } from '../src/guardSession.mjs';
import {
  readDelegations, readLeadWork, readMeasurements, readEscalations,
} from '../src/provenanceStore.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  if (i === -1) return null;
  if (i + 1 >= argv.length) {
    console.error(`migration-verify: ${n} was given with no value. Refusing to guess a path.`);
    process.exit(2);
  }
  return argv[i + 1];
};

/**
 * One check. `expected` is null when the manifest carries no count for that
 * store, and an absent expectation is reported as such rather than silently
 * passing -- "could not compare" is not "compared and matched".
 */
function check(name, actual, expected, detail) {
  if (actual === null) return { name, ok: false, why: `did not resolve: ${detail}` };
  if (expected === null || expected === undefined) {
    return { name, ok: false, why: `resolved ${actual}, but the manifest carries no count to compare against` };
  }
  if (actual !== expected) {
    return { name, ok: false, why: `resolved ${actual}, manifest says ${expected} -- SHORT BY ${expected - actual}` };
  }
  return { name, ok: true, why: `resolved ${actual}, matches manifest` };
}

export async function run(pkgDir) {
  const manifestPath = path.join(pkgDir, 'MANIFEST.json');
  if (!existsSync(manifestPath)) {
    console.error(`migration-verify: no MANIFEST.json under ${pkgDir}`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  /**
   * THE MANIFEST SAYS WHICH COUNT TO COMPARE AGAINST, AND IT MATTERS.
   *
   * An append-only ledger holds one line per state transition; its reader folds
   * them by id and returns the latest of each. Comparing a reader's output to
   * the LINE count makes a healthy store look catastrophically short. The
   * packager records both and names the right one in
   * `compare_reader_output_against`.
   */
  const expect = (rel) => {
    const item = manifest.items.find((i) => i.source_relative_to_agentbridge_home === rel);
    if (!item) return null;
    return item.compare_reader_output_against === 'distinct_ids'
      ? item.distinct_ids ?? null
      : item.records ?? null;
  };

  /*
   * THE KEY COMPARISON FIRST, because everything about the two keyed stores
   * follows from it and because this is the step that silently does nothing.
   */
  const destKey = path.basename(repoStorePath(REPO, 'audits', '.jsonl'), '.jsonl');
  const srcKeys = manifest.source_store_keys ?? [];
  const keyMoved = !srcKeys.includes(destKey);

  const results = [];

  /*
   * ── the audit queue, through the reader the daemon uses ────────────────
   *
   * `readQueue` returns `{ rows, malformed, file }`, NOT an array -- I wrote
   * `Array.isArray(queue)` first and the control run on the source machine
   * reported the store unreadable when it was fine. `malformed` is surfaced
   * because the reader counts bad lines rather than dropping them, and a
   * ledger that arrives with lines it cannot parse is a damaged migration even
   * when the total happens to match.
   */
  let queue = null;
  let queueErr;
  try { queue = readQueue(REPO); } catch (e) { queueErr = e?.message; }
  /**
   * WHICH SOURCE FILE THIS DESTINATION KEY CORRESPONDS TO.
   *
   * When the key has NOT moved, the answer is the file with the same key --
   * not "the first source key that has a count". This mattered immediately:
   * the findings store has TWO files, and one of them is named with a
   * FIFTEEN-character key rather than sixteen. Scanning source keys in order
   * compared a correctly-resolved 3 against that stray file's 1 and reported a
   * healthy store SHORT BY 2.
   *
   * The stray key is a real anomaly in whatever wrote it and is recorded as a
   * migration finding; it must not also be allowed to corrupt the comparison.
   */
  const expectFor = (kind) => {
    const exact = expect(`${kind}/${destKey}.jsonl`);
    if (exact != null) return exact;
    return srcKeys.map((k) => expect(`${kind}/${k}.jsonl`)).find((n) => n != null) ?? null;
  };

  const expectedAudits = expectFor('audits');
  results.push(check('audit queue', Array.isArray(queue?.rows) ? queue.rows.length : null, expectedAudits,
    queueErr ?? 'readQueue returned no rows array'));
  if (queue?.malformed) {
    results.push({ name: 'audit ledger integrity', ok: false, why: `${queue.malformed} line(s) did not parse` });
  }

  // ── findings, via the same key derivation the writer uses ──────────────
  const findingsPath = repoStorePath(REPO, 'findings', '.jsonl');
  let findings = null;
  try {
    findings = readFileSync(findingsPath, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch { findings = null; }
  results.push(check('finding registry', findings, expectFor('findings'),
    `nothing readable at the destination key ${destKey}`));

  /*
   * A KEY THAT IS NOT SIXTEEN HEX CHARACTERS DID NOT COME FROM repoStorePath.
   * Reported rather than ignored: it is carried by the package so nothing is
   * lost, but something wrote it and that is worth knowing before it is
   * mistaken for a second repository's store.
   */
  for (const k of srcKeys.filter((s) => !/^[0-9a-f]{16}$/.test(s))) {
    results.push({
      name: 'store key shape', ok: false,
      why: `source key "${k}" is ${k.length} characters, not 16 -- not a repoStorePath key. Carried, but investigate what wrote it.`,
    });
  }

  // ── the flat provenance stores ─────────────────────────────────────────
  for (const [name, read, rel] of [
    ['delegations', readDelegations, 'delegations.json'],
    ['lead work', readLeadWork, 'leadWork.json'],
    ['token measurements', readMeasurements, 'tokenMeasurements.json'],
    ['escalations', readEscalations, 'escalations.json'],
  ]) {
    /*
     * AWAITED. These readers are ASYNC, and without the await every one of
     * them hands back a Promise that `Array.isArray` rejects -- so all four
     * reported "did not resolve" against stores that were perfectly readable.
     *
     * That is the same defect I fixed in src/watcherIdentity.mjs hours earlier,
     * where an un-awaited store read made every session refuse. It cost one
     * control run to find here because the control was run at all: this script
     * was pointed at the SOURCE machine first, where every store is known good,
     * so a FAIL could only be the script.
     */
    let rows = null;
    let err;
    try { rows = await read(); } catch (e) { err = e?.message; }
    results.push(check(name, Array.isArray(rows) ? rows.length : null, expect(rel),
      err ?? 'the reader did not return an array'));
  }

  console.log(`destination store key : ${destKey}`);
  console.log(`package source key(s) : ${srcKeys.join(', ') || '(none recorded)'}`);
  if (keyMoved) {
    console.log('');
    console.log('KEY MOVED. The repository is at a different path than the source machine,');
    console.log('so the two keyed stores must be RENAMED before anything can resolve:');
    for (const k of srcKeys) {
      console.log(`  audits/${k}.jsonl    ->  audits/${destKey}.jsonl`);
      console.log(`  findings/${k}.jsonl  ->  findings/${destKey}.jsonl`);
    }
    console.log('An unrenamed ledger reads as EMPTY, not as an error.');
  }
  console.log('');
  for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(20)} ${r.why}`);

  const bad = results.filter((r) => !r.ok);
  console.log('');
  if (bad.length === 0) {
    console.log('EVERY STORE RESOLVED THROUGH ITS REAL CONSUMER AND EVERY COUNT MATCHED.');
    return 0;
  }
  console.log(`${bad.length} of ${results.length} did not resolve or did not match.`);
  console.log('This is NOT a migration failure to work around by editing counts --');
  console.log('it is the state not being reachable from this checkout.');
  return 1;
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  const pkg = flag('--package');
  if (!pkg) {
    console.error('usage: node scripts/migration-verify.mjs --package <dir>');
    process.exit(2);
  }
  process.exit(await run(path.resolve(pkg)));
}
