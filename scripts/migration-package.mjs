#!/usr/bin/env node
/**
 * BUILD THE PORTABLE, NON-SECRET AGENTBRIDGE MIGRATION PACKAGE.
 *
 * ═══ WHAT THIS IS FOR ═══
 *
 * Moving Agent007 to another machine. Almost all of its state is either
 * repository-backed (travels with `git clone`) or hosted on the Bridge
 * (re-read on arrival). A small set is neither, exists nowhere else, and is
 * authority history: the audit queue, the finding registry, delegations,
 * lead-work and token measurements.
 *
 * This copies exactly that set and nothing adjacent to it.
 *
 * ═══ WHAT IT REFUSES TO CARRY, AND WHY EACH ═══
 *
 *   config.json        holds `secretStore` sealed with DPAPI at scheme
 *                      `dpapi-user` -- USER AND MACHINE scoped. A copy cannot
 *                      be unsealed elsewhere, and a blob that fails to unseal
 *                      reads as corruption rather than as an expected re-init.
 *                      It also carries machineId, and a duplicated machineId
 *                      makes two machines claim one identity.
 *   registry.json      a map of where an operator's work lives on THIS disk.
 *   registrations.json hosted; `register-session` recreates it.
 *   overrides/         keyed by sha256(git-common-dir), so a new checkout path
 *                      is a different key. The grant does not travel; the owner
 *                      re-issues it.
 *   guard-sessions/    one snapshot per session, keyed to sessions that will
 *                      never recur.
 *   verify/            cache keyed by tree digest + toolchain. A different node
 *                      build misses every entry anyway.
 *   polls/             runtime watcher state.
 *   the secrets dir    credentials. They move by hand, out of band, or are
 *                      rotated. Never in an archive beside state.
 *
 * The exclusions are a FIXED LIST, not a filter over whatever is present: a
 * filter admits tomorrow's new file by default, and the default must be to
 * leave it behind.
 *
 * ═══ THE KEY DERIVATION IS THE THING MOST LIKELY TO GO WRONG ═══
 *
 * `audits/<key>.jsonl` and `findings/<key>.jsonl` are named
 * `sha256(canonical git-common-dir)[0:16]` -- see `repoStorePath` in
 * src/guardSession.mjs. The key is a fact about WHERE THE REPOSITORY LIVES.
 * Clone to a different path on the new machine and the key changes, so a
 * correctly-copied ledger sits at a filename nothing looks for and
 * **the queue reads as EMPTY rather than erroring**. That is the failure mode
 * that looks like success, so the manifest records the source key explicitly
 * and scripts/migration-verify.mjs computes the destination key and names the
 * rename.
 *
 * ═══ INTEGRITY ═══
 *
 * Every file is hashed at source, copied, hashed at destination, and the two
 * compared. Then every source is hashed AGAIN at the end and compared to its
 * first reading, which is what proves this run left the originals untouched --
 * an assertion about the operation, not a promise about it.
 *
 * READ-ONLY AT SOURCE. Nothing here opens a source file for writing.
 *
 *   node scripts/migration-package.mjs [--out <dir>]
 *
 * Default destination is `agent007-migration-package` under the home directory.
 * It REFUSES to write into a directory that already has contents, because a
 * half-overwritten package is worse than no package.
 */
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const HOME = process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge');

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  if (i === -1) return null;
  if (i + 1 >= argv.length) {
    console.error(`migration-package: ${n} was given with no value. Refusing to guess a path.`);
    process.exit(2);
  }
  return argv[i + 1];
};

const OUT = path.resolve(flag('--out') ?? path.join(homedir(), 'agent007-migration-package'));

/**
 * EXACTLY WHAT MOVES. Named one by one on purpose.
 *
 * `why` is not decoration: it is the sentence a later reader disagrees with if
 * an item should not have travelled. `authority` marks the ones whose loss is
 * unrecoverable, as opposed to the ones that are merely convenient.
 */
const ITEMS = [
  /*
   * `foldKey` IS DECLARED, NOT SNIFFED. The first version inferred it from the
   * presence of `audit_id` on a line and applied that to every .jsonl -- so the
   * findings store, whose lines happen to carry an audit_id but which folds on
   * `finding_id`, was counted under the wrong key and reported 1 where its own
   * reader sees 3. Both stores fold ("APPEND-ONLY, AND THE LAST RECORD FOR AN
   * ID WINS" -- bin/agentbridge.mjs, and readQueue does the same); they simply
   * fold on different fields, and that is a fact to look up rather than detect.
   */
  {
    from: 'audits', glob: '.jsonl', authority: true, foldKey: 'audit_id',
    why: 'the audit queue and its entire state history; no hosted equivalent exists on either MCP server',
  },
  {
    from: 'findings', glob: '.jsonl', authority: true, foldKey: 'finding_id',
    why: 'the finding registry; no hosted equivalent',
  },
  {
    file: 'delegations.json', authority: true,
    why: 'task text and path authority per delegation; list_delegations exists only on the LOCAL server',
  },
  {
    file: 'leadWork.json', authority: true,
    why: 'lead-work ledger; no hosted equivalent',
  },
  {
    file: 'tokenMeasurements.json', authority: true,
    why: 'token accounting; no hosted equivalent',
  },
  {
    file: 'escalations.json', authority: false,
    why: 'REDUNDANT: get_owner_decisions returns a larger authoritative copy. Carried as an offline mirror, not as preservation.',
  },
];

/** Never carried, whatever else changes. Checked, not assumed. */
const NEVER = Object.freeze([
  'config.json', 'registry.json', 'registrations.json',
  'overrides', 'guard-sessions', 'verify', 'polls',
]);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function collect() {
  const out = [];
  for (const item of ITEMS) {
    if (item.file) {
      const src = path.join(HOME, item.file);
      if (!existsSync(src)) { out.push({ ...item, src, missing: true }); continue; }
      out.push({ ...item, src, rel: item.file });
      continue;
    }
    const dir = path.join(HOME, item.from);
    if (!existsSync(dir)) { out.push({ ...item, src: dir, missing: true }); continue; }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(item.glob)) continue;
      out.push({ ...item, src: path.join(dir, name), rel: `${item.from}/${name}` });
    }
  }
  return out;
}

/*
 * THE EXCLUSION IS ASSERTED, NOT TRUSTED. A future edit to ITEMS that reached
 * one of these would be a silent secret leak, so the check is on the RESOLVED
 * file list rather than on the intent behind it.
 */
function assertNothingForbidden(files) {
  for (const f of files) {
    const first = f.rel?.split('/')[0];
    if (NEVER.includes(first) || NEVER.includes(f.rel)) {
      console.error(`migration-package: REFUSING -- ${f.rel} is on the never-carry list.`);
      process.exit(3);
    }
  }
}

const files = collect();
assertNothingForbidden(files);

const missing = files.filter((f) => f.missing);
const present = files.filter((f) => !f.missing);

if (existsSync(OUT) && readdirSync(OUT).length) {
  console.error(`migration-package: ${OUT} already has contents. Refusing to overwrite.`);
  console.error('  A half-overwritten package is worse than no package. Remove it or pass --out.');
  process.exit(4);
}

/* Hash every source BEFORE anything is written. */
const before = new Map();
for (const f of present) before.set(f.src, sha256(readFileSync(f.src)));

mkdirSync(OUT, { recursive: true });
mkdirSync(path.join(OUT, 'state'), { recursive: true });

const rows = [];
for (const f of present) {
  const dst = path.join(OUT, 'state', f.rel);
  mkdirSync(path.dirname(dst), { recursive: true });
  const bytes = readFileSync(f.src);
  writeFileSync(dst, bytes);

  const srcHash = before.get(f.src);
  const dstHash = sha256(readFileSync(dst));
  if (srcHash !== dstHash) {
    console.error(`migration-package: COPY MISMATCH on ${f.rel}. Aborting.`);
    process.exit(5);
  }

  const text = bytes.toString('utf8');
  const lines = f.rel.endsWith('.jsonl')
    ? text.split('\n').filter((l) => l.trim())
    : null;

  /*
   * TWO COUNTS FOR AN APPEND-ONLY LEDGER, AND THEY ARE NOT THE SAME NUMBER.
   *
   * `audits/<key>.jsonl` holds one line per STATE TRANSITION, so a single job
   * contributes many. `readQueue` folds them by `audit_id` and returns the
   * latest of each, which is what every consumer means by "the queue". Compare
   * a reader's output against the line count and a healthy store looks
   * catastrophically short.
   *
   * I made exactly that mistake reading this file earlier -- counted 850 rows
   * in an append-only log and reported it as 850 jobs -- so both numbers are
   * recorded and the verifier is told which one to use.
   */
  const distinct = lines && f.foldKey
    ? (() => {
        const ids = new Set();
        let malformed = 0;
        for (const l of lines) {
          try {
            const r = JSON.parse(l);
            if (typeof r?.[f.foldKey] === 'string') ids.add(r[f.foldKey]);
            else malformed += 1;
          } catch { malformed += 1; }
        }
        return { size: ids.size, malformed };
      })()
    : null;

  rows.push({
    source_relative_to_agentbridge_home: f.rel,
    destination_relative_to_package: `state/${f.rel}`,
    bytes: statSync(f.src).size,
    records: lines
      ? lines.length
      : (() => { try { const p = JSON.parse(text); return Array.isArray(p) ? p.length : null; } catch { return null; } })(),
    distinct_ids: distinct ? distinct.size : null,
    fold_key: f.foldKey ?? null,
    malformed_at_source: distinct ? distinct.malformed : null,
    compare_reader_output_against: distinct ? 'distinct_ids' : 'records',
    sha256: srcHash,
    authority: Boolean(f.authority),
    why: f.why,
  });
}

/*
 * PROVE THE ORIGINALS ARE UNCHANGED. Re-read and re-hash every source after
 * all writing is done. "It only reads" is a claim about the code; this is a
 * measurement of the outcome.
 */
const drifted = present.filter((f) => sha256(readFileSync(f.src)) !== before.get(f.src));
if (drifted.length) {
  console.error('migration-package: SOURCE FILES CHANGED DURING THE RUN:');
  for (const f of drifted) console.error(`  ${f.rel}`);
  process.exit(6);
}

/*
 * THE STORE KEY, recorded because the destination filename depends on it.
 * Only the 16-hex key is written -- never the path it was derived from, which
 * is the operator's home directory.
 */
const keys = [...new Set(rows
  .filter((r) => r.source_relative_to_agentbridge_home.includes('/'))
  .map((r) => path.basename(r.source_relative_to_agentbridge_home, '.jsonl')))];

const manifest = {
  kind: 'agent007-migration-package',
  manifest_version: 1,
  created_at: new Date().toISOString(),
  hash_algorithm: 'sha256',
  source_store_keys: keys,
  source_store_key_derivation: 'sha256(canonical git-common-dir)[0:16] -- see repoStorePath in src/guardSession.mjs',
  totals: {
    files: rows.length,
    bytes: rows.reduce((a, r) => a + r.bytes, 0),
    authority_files: rows.filter((r) => r.authority).length,
  },
  excluded_by_policy: NEVER,
  items: rows,
  notes: [
    'Contains NO credentials, NO DPAPI material, NO machineId, NO registrations, NO override grants.',
    'Historical session ids appear inside the audit ledger as authority history. They are records of who did what, not machine identity, and removing them would falsify the ledger.',
    'The store key above is a fact about the SOURCE checkout path. If the destination checkout path differs, audits/<key>.jsonl and findings/<key>.jsonl must be RENAMED to the destination key or the queue reads as EMPTY rather than erroring. scripts/migration-verify.mjs computes the destination key and names the rename.',
  ],
};

writeFileSync(path.join(OUT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const md = [
  '# Agent007 migration package — manifest',
  '',
  `Created ${manifest.created_at}. Hash algorithm ${manifest.hash_algorithm}.`,
  '',
  `**${manifest.totals.files} files, ${manifest.totals.bytes} bytes, ${manifest.totals.authority_files} of them authority history.**`,
  '',
  '| source (under AGENTBRIDGE_HOME) | destination (in package) | bytes | records | sha256 | authority |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| \`${r.source_relative_to_agentbridge_home}\` | \`${r.destination_relative_to_package}\` | ${r.bytes} | ${r.records ?? '—'} | \`${r.sha256}\` | ${r.authority ? 'YES' : 'no'} |`),
  '',
  '## Deliberately excluded',
  '',
  ...NEVER.map((n) => `- \`${n}\``),
  '- the secrets directory, in full',
  '',
  '## Store key',
  '',
  `Source key(s): ${keys.map((k) => `\`${k}\``).join(', ')}`,
  '',
  manifest.notes[2],
  '',
].join('\n');
writeFileSync(path.join(OUT, 'MANIFEST.md'), `${md}\n`);

console.log(`package   : ${OUT}`);
console.log(`files     : ${rows.length}  (${manifest.totals.authority_files} authority)`);
console.log(`bytes     : ${manifest.totals.bytes}`);
console.log(`store key : ${keys.join(', ')}`);
console.log('originals : re-hashed after the copy and UNCHANGED');
if (missing.length) {
  console.log('');
  console.log('absent at source, and that is reported rather than silently skipped:');
  for (const m of missing) console.log(`  ${m.file ?? m.from}`);
}
console.log('');
console.log('NOT a completed migration. Run scripts/migration-verify.mjs on the');
console.log('destination machine: file presence is not resolution.');
