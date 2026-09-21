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
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from '../src/invokedDirectly.mjs';
import { readQueue } from '../src/auditQueueStore.mjs';
import { repoStorePath } from '../src/guardSession.mjs';
import {
  readDelegations, readLeadWork, readMeasurements, readEscalations,
} from '../src/provenanceStore.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

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
export function payloadPathProblem(item) {
  const rel = item?.source_relative_to_agentbridge_home;
  if (typeof rel !== 'string' || rel === '') {
    return 'the manifest item carries no source_relative_to_agentbridge_home';
  }
  if (rel.includes('\\')) return `"${rel}" contains a backslash; store paths are forward-slashed`;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    return `"${rel}" is an absolute path; a manifest may only name a location INSIDE the package`;
  }
  if (rel.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    return `"${rel}" walks outside the package; a manifest may only name a location INSIDE the package`;
  }

  const declared = item.destination_relative_to_package;
  const expected = `state/${rel}`;
  if (typeof declared === 'string' && declared !== expected) {
    return `the manifest says this file is at "${declared}", but a package built by scripts/migration-package.mjs always puts it at "${expected}". `
      + 'Refusing to follow the manifest to another location -- that is how a verifier ends up hashing the live store instead of the package.';
  }
  return null;
}

function destinationFor(rel, packagedByKind) {
  const [kind, base] = rel.includes('/') ? rel.split('/') : [null, rel];
  if (!kind) return { dest: rel };
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
    const f = path.join(pkgDir, 'state', rel);
    if (!existsSync(f)) {
      results.push(fail(`pkg ${rel}`, 'claimed by the manifest and ABSENT from the package'));
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
    const inside = c.location && c.location.startsWith('inside');
    if (!inside) { results.push(advise(`companion ${c.name}`, `${c.bytes} B, beside the package — verify separately (${c.verify_with ?? 'no method recorded'})`)); continue; }
    const f = path.join(pkgDir, c.name);
    if (!existsSync(f)) { results.push(fail(`companion ${c.name}`, 'recorded and ABSENT')); integrityOk = false; continue; }
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
    const [kind] = rel.split('/');
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
  const carried = (rel) => manifest.items.some((i) => i.source_relative_to_agentbridge_home === rel);

  const expectFor = (rel) => {
    const item = manifest.items.find((i) => i.source_relative_to_agentbridge_home === rel);
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
  console.log('');
  console.log('PACKAGE INTACT, INSTALLED, AND REACHABLE THROUGH ITS REAL READERS.');
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
