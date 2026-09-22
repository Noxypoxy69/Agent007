#!/usr/bin/env node
/**
 * PROVE A MIGRATION PACKAGE ARRIVED AND RESOLVES. THREE PHASES, IN ORDER.
 *
 * ═══ WHAT THE FIRST VERSION DID, AND WHY IT WAS DANGEROUS ═══
 *
 * It read `MANIFEST.json` for its counts and then queried the LIVE
 * `~/.agentbridge` of whatever machine it happened to run on. It never opened
 * the package. It never checked one of the sha256 hashes the packager took.
 *
 * A blind auditor demonstrated the consequence end to end: a directory
 * containing one hand-written `MANIFEST.json`, no `state/` directory at all,
 * and every hash set to 64 zeros produced
 *
 *     EVERY STORE RESOLVED THROUGH ITS REAL CONSUMER AND EVERY COUNT MATCHED
 *
 * and exit 0. Nothing had arrived. Nothing was verified. **This is the gate
 * whose PASS authorises wiping the source machine**, so that is not a bug in a
 * reporting tool, it is a data-loss mechanism with a green light on it.
 *
 * The header of that version promised "ls proves nothing here, a hash proves
 * nothing here" while doing neither. It was right that resolution is the real
 * test and wrong that resolution is the ONLY test.
 *
 * ═══ SO: THREE PHASES, AND EACH IS NECESSARY ═══
 *
 *   1 INTEGRITY     every file the manifest claims is IN the package, and its
 *                   bytes hash to the recorded value. Catches a truncated,
 *                   empty or fabricated package.
 *   2 INSTALLATION  every packaged file is present in the live store at the
 *                   destination it must occupy, byte-identical. Catches a
 *                   package that was verified and then never unpacked, or
 *                   unpacked under the wrong key.
 *   3 RESOLUTION    the real consumers read the live store and return the
 *                   counts the packager measured. Catches a file that landed
 *                   correctly and still cannot be reached.
 *
 * Phase 1 without 3 passes a package nobody installed. Phase 3 without 1 passes
 * a machine that already had the data. **Neither is the test on its own.**
 *
 * ═══ WHAT IT STILL CANNOT PROVE, STATED RATHER THAN IMPLIED ═══
 *
 * It cannot tell the destination machine from the source machine. There is no
 * anchor available: `machineId` is deliberately excluded from the package, and
 * a destination cloned to the same path has the same store key. So a PASS means
 * "these bytes are present here and resolve here" — on the source machine that
 * is trivially true, because the state never left.
 *
 * The operator knows which machine they are on. This tool does not, and saying
 * so is better than a check that pretends otherwise.
 *
 *   node scripts/migration-verify.mjs --package <dir>
 *
 * Exit 0 only when all three phases pass. READ-ONLY: it changes nothing.
 */
import { createHash } from 'node:crypto';
import {
  readFileSync, existsSync, statSync, lstatSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from '../src/invokedDirectly.mjs';
import { payloadPathProblem, insidePackage } from '../src/migrationPaths.mjs';
import { readQueue } from '../src/auditQueueStore.mjs';
import { repoStorePath } from '../src/guardSession.mjs';
import {
  readDelegations, readLeadWork, readMeasurements, readEscalations,
} from '../src/provenanceStore.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The authority history a migration is FOR, named here rather than in the input.
 *
 * A trailing slash means a keyed store: at least one file under that directory,
 * whatever its key. Everything else is an exact store name.
 *
 * `escalations.json` is deliberately absent — the packager marks it
 * `authority: false` with a larger authoritative copy on the Bridge, and a
 * roster that demands it would refuse a legitimate package.
 */
const AUTHORITY_ROSTER = Object.freeze([
  'audits/', 'findings/', 'delegations.json', 'leadWork.json', 'tokenMeasurements.json',
]);

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
 * A row. `advisory` rows are REPORTED AND DO NOT SET THE EXIT CODE.
 *
 * The first version scored an advisory as a failure, so the real package could
 * never exit 0 -- while a package containing no data at all could. A gate whose
 * green is unreachable on true data teaches people to ignore it (rule 16), and
 * this one explicitly forbids the obvious workaround, which leaves an operator
 * with nothing to do but disbelieve it.
 */
const ok = (name, why) => ({ name, state: 'OK', why });
const fail = (name, why) => ({ name, state: 'FAIL', why });
const advise = (name, why) => ({ name, state: 'NOTE', why, advisory: true });

/**
 * Where a packaged file must land in the live store.
 *
 * KEYED STORES ARE MAPPED PER FILE, NEVER PER KEY. The first version looped
 * over the key list and printed a rename for every kind against every key,
 * which produced instructions to move two DIFFERENT findings files onto ONE
 * destination name -- overwriting one authority file with another, on a machine
 * where the source may already be gone. It also named renames for files that
 * did not exist.
 *
 * So: a kind with exactly one packaged file maps to the destination key. A kind
 * with several cannot be mapped by a tool at all, because only a person knows
 * which one is the repository's real store. That is a hard refusal, not a
 * best-effort rename.
 */
/**
 * Whether a manifest item may be opened at all, and where.
 *
 * ═══ THE GATE THAT AUTHORISES A WIPE READ ITS ADDRESS FROM ITS INPUT ═══
 *
 * Blind audit HIGH-1, reproduced before this was written. Phase 1 used to do
 *
 *     path.join(pkgDir, item.destination_relative_to_package)
 *
 * with nothing constraining that field. A manifest carrying
 * `"../../../../../../../../.agentbridge/audits/<key>.jsonl"` makes phase 1 hash
 * the LIVE store, phase 2 hash the same live file, phase 3 read the same live
 * store -- and all three agree, because they are all looking at one file that
 * was never copied anywhere. Measured, on a directory containing MANIFEST.json
 * and nothing else:
 *
 *     integrity OK · installation OK · 0 failure(s), 1 advisory
 *     PACKAGE INTACT, INSTALLED, AND REACHABLE THROUGH ITS REAL READERS.
 *     exit 0
 *
 * 1.4 MB of "packaged" authority history, present nowhere but the source
 * machine, with a green light on it.
 *
 * THE FIX IS TO STOP READING THE FIELD. The packager writes exactly one value
 * there -- `state/<source_relative_to_agentbridge_home>` -- so the location is
 * DERIVED and the field is checked for agreement rather than obeyed. A manifest
 * that disagrees is refused rather than silently ignored, because a disagreement
 * is either a format change somebody must look at or an attack.
 *
 * `source_relative_to_agentbridge_home` is then the only untrusted string left,
 * and it is confined the same way: no absolute path, no drive letter, no `..`,
 * no backslash, no leading slash.
 *
 * THE TEST THAT SHOULD HAVE CAUGHT THIS PASSED. Its fixture used `state/` paths
 * and hashes of 64 zeros -- it fixed the five strings the first probe happened
 * to try instead of the matcher (rule 8). A fixture for this shape is now first
 * in `test/migrationPackage.test.mjs` beside it.
 *
 * @returns a refusal sentence, or null when the item is well-formed
 */
 * THE IMPLEMENTATION MOVED TO `src/migrationPaths.mjs` after a blind audit found
 * a THIRD reader of the same field, in the packager's `attach()`. Two commits
 * had fixed this mechanism one site at a time; a function both scripts import is
 * the matcher, and a private helper in one file is three strings (rule 8).
 */

/**
 * Open a file the package claims to contain, or say why not.
 *
 * ═══ THE TRAVERSAL FIX COVERED `items` AND LEFT ITS SIBLING OPEN ═══
 *
 * Blind audit D2, reproduced before this was written. `payloadPathProblem`
 * constrained the manifest's ITEMS and the companions loop three lines below it
 * still did `path.join(pkgDir, c.name)` with nothing constraining `c.name` --
 * and decided whether to open it at all from `c.location`, another manifest
 * field. Measured, against a package directory containing no such file:
 *
 *     OK  companion ../../../../../../../../.agentbridge/audits/<key>.jsonl
 *         sha256 matches
 *
 * 1.37 MB hashed out of the LIVE store and reported as an intact companion.
 * That is the same mechanism the header above writes up as HIGH-1, in the very
 * commit that fixed it -- rule 8 again, one field over: the five strings the
 * probe tried got fixed, and the matcher did not.
 *
 * AND A STRING CHECK IS NOT ENOUGH, because the filesystem gets a vote. Blind
 * audit D3: nothing here resolved links, so a symlink or NTFS junction sitting
 * at `state/audits/<x>.jsonl` redirects the read to one live file with no `..`
 * anywhere in the manifest. The packager was hardened against exactly this and
 * the verifier was not -- the asymmetry was inside a single commit whose own
 * message says "readFileSync FOLLOWS LINKS".
 *
 * So both halves: the manifest string is confined, and then the RESOLVED path
 * must still be a regular file inside the package. Asking the OS with
 * `realpathSync.native` rather than `realpathSync`, for the reason every other
 * resolver in this repository states -- case folding and 8.3 short names.
 *
 * BOTH HALVES NOW LIVE IN `src/migrationPaths.mjs`, because a blind audit found
 * a THIRD site reading the same field -- the packager's `attach()` -- after two
 * separate commits had each fixed the one in front of them.
 */

function destinationFor(rel, packagedByKind) {
  const [rawKind, base] = rel.includes('/') ? rel.split('/') : [null, rel];
  if (!rawKind) return { dest: rel };
  const kind = rawKind.toLowerCase();
  const destKey = path.basename(repoStorePath(REPO, kind, '.jsonl'), '.jsonl');
  const siblings = packagedByKind.get(kind) ?? [];
  if (siblings.length > 1) {
    return {
      dest: null,
      why: `${siblings.length} files are packaged under ${kind}/ (${siblings.map((s) => path.basename(s, '.jsonl')).join(', ')}) `
        + `and only one can occupy the destination key ${destKey}. A tool cannot choose; renaming both would `
        + 'destroy one. Decide which is this repository\'s store before installing.',
    };
  }
  return { dest: `${kind}/${destKey}.jsonl`, renamedFrom: base === `${destKey}.jsonl` ? null : base };
}

export async function run(pkgDir) {
  const manifestPath = path.join(pkgDir, 'MANIFEST.json');
  if (!existsSync(manifestPath)) {
    console.error(`migration-verify: no MANIFEST.json under ${pkgDir}`);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
    console.error('migration-verify: the manifest lists no items. That is not a package.');
    return 2;
  }

  const results = [];

  /* ── PHASE 1 — the package is what it says it is ────────────────────── */
  let integrityOk = true;
  for (const item of manifest.items) {
    const rel = item.source_relative_to_agentbridge_home;
    const bad = payloadPathProblem(item);
    if (bad) {
      results.push(fail(`pkg ${rel}`, bad));
      integrityOk = false;
      continue;
    }
    const { file: f, why } = insidePackage(pkgDir, `state/${rel}`);
    if (!f) {
      results.push(fail(`pkg ${rel}`, why));
      integrityOk = false;
      continue;
    }
    const got = sha256(readFileSync(f));
    if (got !== item.sha256) {
      results.push(fail(`pkg ${item.source_relative_to_agentbridge_home}`,
        `sha256 ${got.slice(0, 16)}… does not match the manifest's ${String(item.sha256).slice(0, 16)}…`));
      integrityOk = false;
      continue;
    }
    results.push(ok(`pkg ${item.source_relative_to_agentbridge_home}`, `${item.bytes} B, sha256 matches`));
  }
  for (const c of manifest.companions ?? []) {
    /*
     * THE COMPANION USED TO DECIDE WHETHER IT WOULD BE CHECKED. Blind audit
     * MEDIUM-5: `inside` was read from `c.location`, so flipping that string to
     * "BESIDE the package" made a fabricated 900 MB bundle row print from the
     * manifest's own numbers, never be looked for, and set no exit code — while
     * the verifier knew exactly where the package was.
     *
     * Only a git bundle is legitimately outside, because it is git objects and
     * `git bundle verify` is the only thing that proves it. Everything else must
     * be in the package, and `kind` is the field the packager READS from the
     * file's banner rather than one it copies from its input.
     */
    const outside = c.kind === 'git bundle';
    if (outside) { results.push(advise(`companion ${c.name}`, `${c.bytes} B, beside the package — verify separately (${c.verify_with ?? 'no method recorded'})`)); continue; }
    const { file: f, why } = insidePackage(pkgDir, c.name);
    if (!f) { results.push(fail(`companion ${c.name}`, why)); integrityOk = false; continue; }
    const got = sha256(readFileSync(f));
    results.push(got === c.sha256
      ? ok(`companion ${c.name}`, 'sha256 matches')
      : fail(`companion ${c.name}`, 'sha256 does not match'));
    if (got !== c.sha256) integrityOk = false;
  }

  /* ── PHASE 2 — every packaged file is installed where it must be ────── */
  const byKind = new Map();
  for (const item of manifest.items) {
    const rel = item.source_relative_to_agentbridge_home;
    if (typeof rel !== 'string' || !rel.includes('/')) continue;
    /* Folded, for the same reason phase 3 folds: a case variant is not a new
     * store. An unfolded key made `Audits/` invisible to every later lookup. */
    const kind = rel.split('/')[0].toLowerCase();
    byKind.set(kind, [...(byKind.get(kind) ?? []), rel.split('/')[1]]);
  }

  let installedOk = true;
  for (const item of manifest.items) {
    const rel = item.source_relative_to_agentbridge_home;
    if (payloadPathProblem(item)) { installedOk = false; continue; }
    const { dest, why, renamedFrom } = destinationFor(rel, byKind);
    if (!dest) { results.push(fail(`install ${rel}`, why)); installedOk = false; continue; }

    const live = path.join(HOME, dest);
    if (!existsSync(live)) {
      results.push(fail(`install ${rel}`,
        `not present in the live store at ${dest}${renamedFrom ? ` (must be RENAMED from ${renamedFrom})` : ''}`));
      installedOk = false;
      continue;
    }
    /*
     * THE INSTALLED COPY MUST BE A REAL FILE, NOT A POINTER AT ONE. A symlink in
     * the live store aimed back at the package makes "installed, byte-identical"
     * true of a machine where nothing was installed -- the phase-2 equivalent of
     * D2/D3 above. `lstatSync` sees the link itself; `statSync` would follow it
     * and agree with the lie.
     */
    if (!lstatSync(live).isFile()) {
      results.push(fail(`install ${rel}`,
        `${dest} exists but is a link, not a regular file. A pointer is not an installed copy: `
        + 'it can aim back at the package, or anywhere, and still hash the same.'));
      installedOk = false;
      continue;
    }
    const got = sha256(readFileSync(live));
    if (got !== item.sha256) {
      results.push(fail(`install ${rel}`, `present at ${dest} but its bytes differ from the package`));
      installedOk = false;
      continue;
    }
    results.push(ok(`install ${rel}`, renamedFrom ? `installed at ${dest} (renamed from ${renamedFrom})` : `installed at ${dest}`));
  }

  /* ── PHASE 3 — the real consumers can reach it ──────────────────────── */

  /*
   * ═══ PHASE 3 WAS OPTIONAL, AND THE MANIFEST DECIDED WHETHER IT RAN ═══
   *
   * Blind audit HIGH-2. `compare` used to return an ADVISORY whenever the
   * expected count was null, and advisories set no exit code. Three unrelated
   * situations produced null and were indistinguishable:
   *
   *   the store is not carried at all          -> genuinely nothing to compare
   *   the store IS carried, but has no count   -> the manifest is unusable
   *   the kind carries two files               -> the count cannot be attributed
   *
   * So renaming `records` to `record_count` in every item -- what a
   * `manifest_version: 2` would do -- turned every resolution row into a NOTE
   * and still printed EVERY STORE RESOLVED and exit 0. Measured. Nothing was
   * compared, and the banner said reachability had been proven.
   *
   * The three cases are now three outcomes. Only the first is an advisory, and
   * it is the one the header always meant: a store absent at source has no
   * manifest row, so there is nothing to verify and never was.
   */
  /*
   * ═══ AND CHANGING THE CASE OF A NAME MADE PHASE 3 VANISH ═══
   *
   * Blind audit HIGH-2. Phases 1 and 2 find files through the FILESYSTEM, which
   * is case-insensitive on NTFS and APFS. Phase 3 found them by exact string
   * equality against literals like 'delegations.json'. So a real package, every
   * payload byte genuine, with `audits/` spelled `Audits/` in the manifest:
   *
   *     OK    pkg Audits/<key>.jsonl        1375550 B, sha256 matches
   *     OK    install Audits/<key>.jsonl    installed at Audits/<key>.jsonl
   *     NOTE  resolve audit queue           not carried by this package
   *     ...
   *     integrity OK · installation OK · 0 failure(s), 5 advisory
   *     PACKAGE INTACT, INSTALLED, AND REACHABLE THROUGH ITS REAL READERS.
   *
   * Every store carried, hashed and installed, and its reachability through the
   * real reader never tested while the banner said it was. That is the HIGH-2
   * outcome verbatim, one matcher over: the `records`→`record_count` spelling
   * got closed and the matcher did not (rule 8, again).
   *
   * This repository already holds the answer, in `src/guardSession.mjs`: "NTFS
   * and APFS are case-insensitive; a case variant must not be a new key."
   */
  const fold = (s) => String(s).toLowerCase();
  const carried = (rel) => manifest.items.some((i) => fold(i.source_relative_to_agentbridge_home) === fold(rel));

  const expectFor = (rel) => {
    const item = manifest.items.find((i) => fold(i.source_relative_to_agentbridge_home) === fold(rel));
    if (!item) return undefined;
    const n = item.compare_reader_output_against === 'distinct_ids' ? item.distinct_ids : item.records;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  /* The keyed stores are compared against THE FILE THAT MAPS HERE, not against
   * whichever key happened to sort first -- an accident of directory order. */
  const expectKeyed = (kind) => {
    const names = byKind.get(kind) ?? [];
    if (names.length === 0) return undefined;
    if (names.length > 1) return null;
    return expectFor(`${kind}/${names[0]}`);
  };

  const compare = (name, actual, expected, detail) => {
    if (expected === undefined) return advise(name, 'not carried by this package; nothing to verify');
    if (actual === null) return fail(name, `did not resolve: ${detail}`);
    if (expected === null) {
      return fail(name, `resolved ${actual}, but the manifest carries this store with NO usable count to check it against. `
        + 'An unverifiable carried store is not a passing one -- either the manifest is a format this verifier does not understand, '
        + 'or two files are competing for one key and no count can be attributed.');
    }
    if (actual !== expected) return fail(name, `resolved ${actual}, manifest says ${expected}`);
    return ok(name, `resolved ${actual}, matches manifest`);
  };

  let queue = null;
  let queueErr;
  try { queue = readQueue(REPO); } catch (e) { queueErr = e?.message; }
  results.push(compare('resolve audit queue', Array.isArray(queue?.rows) ? queue.rows.length : null,
    expectKeyed('audits'), queueErr ?? 'readQueue returned no rows array'));
  if (queue?.malformed) results.push(fail('audit ledger integrity', `${queue.malformed} line(s) did not parse`));

  let findings = null;
  let findingsMalformed = 0;
  try {
    const ids = new Set();
    for (const line of readFileSync(repoStorePath(REPO, 'findings', '.jsonl'), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === 'object' && typeof rec.finding_id === 'string') ids.add(rec.finding_id);
        else findingsMalformed += 1;
      } catch { findingsMalformed += 1; }
    }
    findings = ids.size;
  } catch { findings = null; }
  results.push(compare('resolve finding registry', findings, expectKeyed('findings'), 'nothing readable at the destination key'));
  if (findingsMalformed) results.push(fail('findings integrity', `${findingsMalformed} line(s) carried no string finding_id`));

  for (const [name, read, rel] of [
    ['delegations', readDelegations, 'delegations.json'],
    ['lead work', readLeadWork, 'leadWork.json'],
    ['token measurements', readMeasurements, 'tokenMeasurements.json'],
    ['escalations', readEscalations, 'escalations.json'],
  ]) {
    /*
     * A STORE ABSENT AT SOURCE IS NOT A FAILURE HERE. It has no manifest row, so
     * there is nothing to compare; the first version turned that into a FAIL
     * that could never be cleared, on a store its own manifest marks REDUNDANT.
     */
    if (!carried(rel)) {
      results.push(advise(`resolve ${name}`, 'not carried by this package; nothing to verify'));
      continue;
    }
    let rows = null;
    let err;
    try { rows = await read(); } catch (e) { err = e?.message; }
    results.push(compare(`resolve ${name}`, Array.isArray(rows) ? rows.length : null, expectFor(rel),
      err ?? 'the reader did not return an array'));
  }

  /* Advisory: a key that repoStorePath cannot have produced. */
  for (const k of manifest.source_store_keys ?? []) {
    if (!/^[0-9a-f]{16}$/.test(k)) {
      results.push(advise('store key shape', `"${k}" is ${k.length} characters, not 16 — not a repoStorePath key. Carried; investigate what wrote it.`));
    }
  }

  /*
   * THE MANIFEST'S TWO HALVES WERE NEVER COMPARED. Blind audit, INFO, found
   * while demonstrating HIGH-2: a manifest declared two keyed stores in
   * `source_store_keys` while `items` carried ZERO keyed files, and the verifier
   * printed an advisory about the shape of a key belonging to a file it was not
   * checking. `source_store_keys` is derived from `items` by the packager, so a
   * disagreement means the manifest was edited or truncated after it was built --
   * which is exactly the state a package must not arrive in.
   */
  /*
   * COMPLETENESS: A LIST CANNOT NOTICE ITS OWN MISSING ENTRY. Blind audit
   * HIGH-2(b) removed the audit-queue and finding-registry items from a real
   * manifest and got a full PASS with exit 0, because `items` was the only
   * description of what should be present. `source_inventory` is the packager's
   * independent record of what it found at source, so a truncated items list now
   * contradicts something.
   *
   * ITS ABSENCE IS A FAILURE, not an advisory. Otherwise the same edit that
   * removes an item removes the inventory and the check stands down -- rule 16's
   * opposite: a gate that closes when its premise is removed. The packager and
   * this verifier ship together, so a package built by that packager always has
   * one.
   */
  /*
   * ═══ A SECOND FIELD OF THE SAME UNTRUSTED DOCUMENT IS NOT A WITNESS ═══
   *
   * Blind audit HIGH-1. `source_inventory` was added so a truncated `items` list
   * would contradict something — but it contradicts a list in the SAME FILE, so
   * trimming both together is one extra edit. Measured: a directory holding
   * `MANIFEST.json` and one byte-exact copy of `escalations.json` — the one
   * store the packager itself marks `authority: false` and REDUNDANT —
   * produced `0 failure(s)`, the full green banner, and exit 0. The audit queue,
   * both finding registries, delegations, lead work and token measurements were
   * absent and nothing said so.
   *
   * THE ROSTER HAS TO COME FROM SOMEWHERE THE MANIFEST CANNOT REACH. It is in
   * this file, beside the readers that consume each store, so a package that
   * omits an authority store is missing something the VERIFIER knows about
   * rather than something its own document declined to mention.
   *
   * The packager records what it looked for and did not find, so a store that
   * genuinely was not on the source machine is still expressible — but it has to
   * be SAID, which is the difference between an absence and a silence.
   */
  const absentAtSource = new Set((manifest.source_absent ?? []).map(fold));
  const rosterCarried = (entry) => (entry.endsWith('/')
    ? (byKind.get(entry.slice(0, -1)) ?? []).length > 0
    : carried(entry));
  const missingAuthority = AUTHORITY_ROSTER
    .filter((rel) => !rosterCarried(rel) && !absentAtSource.has(fold(rel)));
  if (missingAuthority.length) {
    results.push(fail('authority roster',
      `${missingAuthority.length} authority store(s) are neither carried nor recorded as absent at source: ${missingAuthority.join(', ')}. `
      + 'This roster is held by the verifier, not by the manifest, so trimming the manifest cannot hide an omission. '
      + 'If a store genuinely did not exist on the source machine, the packager records it in source_absent.'));
  } else {
    results.push(ok('authority roster', `all ${AUTHORITY_ROSTER.length} authority store(s) accounted for`));
  }

  const inventory = manifest.source_inventory;
  if (!Array.isArray(inventory)) {
    results.push(fail('manifest completeness',
      'this manifest carries no source_inventory, so there is no independent record of what the source held '
      + 'and nothing can tell a complete package from a truncated one. Rebuild it with scripts/migration-package.mjs.'));
  } else {
    const have = new Set(manifest.items.map((i) => i.source_relative_to_agentbridge_home));
    const dropped = inventory.filter((rel) => !have.has(rel));
    results.push(dropped.length
      ? fail('manifest completeness',
        `the source held ${inventory.length} file(s) and ${dropped.length} of them have no item in this manifest: `
        + `${dropped.join(', ')}. The packager writes both lists from the same scan, so they disagree only if the manifest was edited after it was built.`)
      : ok('manifest completeness', `all ${inventory.length} file(s) found at source are carried`));
  }

  /*
   * DUPLICATES WERE ACCEPTED AND THE CONTRADICTION NEVER CONSULTED. Blind audit
   * LOW-8: the same item twice, the second carrying `"records": 99999`, passed —
   * `expectFor` uses `.find`, so the second count is never read, in a tool whose
   * whole premise is that every number in the manifest was measured.
   */
  const seen = new Map();
  const dupes = [];
  for (const i of manifest.items) {
    const k = fold(i.source_relative_to_agentbridge_home);
    if (seen.has(k)) dupes.push(i.source_relative_to_agentbridge_home);
    else seen.set(k, i);
  }
  if (dupes.length) {
    results.push(fail('manifest self-consistency',
      `${dupes.length} item(s) appear more than once: ${[...new Set(dupes)].join(', ')}. `
      + 'Only the first is ever read, so a second entry\'s counts and hash are claims nothing checks.'));
  }

  const packagedKeys = new Set([...byKind.values()].flat().map((n) => path.basename(n, '.jsonl')));
  const orphanKeys = (manifest.source_store_keys ?? []).filter((k) => !packagedKeys.has(k));
  if (orphanKeys.length) {
    results.push(fail('manifest self-consistency',
      `source_store_keys declares ${orphanKeys.map((k) => `"${k}"`).join(', ')} but no item in this manifest carries that key. `
      + 'The packager derives one list from the other, so they disagree only if the manifest was edited or truncated after it was built.'));
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.state.padEnd(4)}  ${r.name.padEnd(width)}  ${r.why}`);

  const bad = results.filter((r) => r.state === 'FAIL');
  const notes = results.filter((r) => r.advisory);
  console.log('');
  console.log(`integrity ${integrityOk ? 'OK' : 'FAILED'} · installation ${installedOk ? 'OK' : 'FAILED'} · ${bad.length} failure(s), ${notes.length} advisory`);
  if (bad.length) {
    console.log('');
    console.log('NOT a result to work around by editing counts: the state is not');
    console.log('verifiably present and reachable from this checkout.');
    return 1;
  }
  /*
   * THE BANNER ASSERTED MORE THAN THE ROWS SUPPORTED. Blind audit MEDIUM-6:
   * with five of six resolution rows advisory it still printed, unqualified,
   * "REACHABLE THROUGH ITS REAL READERS". Rule 15 — let a gate move rather than
   * close: it now says how many stores it actually resolved, so a package that
   * resolved one store cannot read like a package that resolved six.
   */
  const resolved = results.filter((r) => r.state === 'OK' && r.name.startsWith('resolve ')).length;
  const notResolved = results.filter((r) => r.advisory && r.name.startsWith('resolve ')).length;
  console.log('');
  console.log(`PACKAGE INTACT AND INSTALLED. ${resolved} store(s) read back through their real consumers`
    + `${notResolved ? `; ${notResolved} carried nothing to verify` : ''}.`);
  console.log('This does NOT prove you are on the destination machine — nothing here can.');
  return 0;
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  const pkg = flag('--package');
  if (!pkg) {
    console.error('usage: node scripts/migration-verify.mjs --package <dir>');
    process.exit(2);
  }
  process.exit(await run(path.resolve(pkg)));
}
