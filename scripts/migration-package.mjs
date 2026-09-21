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
 * rename -- EXCEPT where a kind carries more than one file, where it refuses
 * and says so, because a rename there overwrites one authority file with
 * another. The manifest note is derived from what was packaged so it cannot
 * describe the wrong one.
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
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { invokedDirectly } from '../src/invokedDirectly.mjs';

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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * ATTACH MODE — record a companion artifact in an EXISTING manifest.
 *
 *   node scripts/migration-package.mjs --attach <package-dir> [--bundle <file>]
 *
 * ═══ WHY THIS IS CODE AND NOT A HAND EDIT ═══
 *
 * The manifest's whole value is that every number in it was measured rather
 * than typed. A hand-written hash is a claim; this one is a reading. Editing
 * the file by hand would leave a document that looks machine-verified and is
 * not, which is the exact shape this repository keeps finding in its own gates.
 *
 * ═══ WHAT A COMPANION IS ═══
 *
 * An artifact that belongs to the migration but cannot live inside the package:
 *
 *   the git bundle   objects, not AgentBridge state. Produced by `git bundle`,
 *                    which the shell rail refuses by verb, so the owner runs it
 *                    and this records what arrived.
 *   the decision doc written after the package was built, and revised when a
 *                    decision changes.
 *
 * ONLY THE BASENAME IS RECORDED. The absolute path names the operator's home
 * directory, and a manifest is a document that travels.
 *
 * `state/` IS NOT TOUCHED. Attach re-reads and re-writes the manifest only, and
 * it re-verifies every state hash while it is there -- if a state file drifted
 * since the package was built, that is worth failing on rather than silently
 * re-blessing.
 */
function attach(pkgDir, bundlePath) {
  const manifestPath = path.join(pkgDir, 'MANIFEST.json');
  if (!existsSync(manifestPath)) {
    console.error(`migration-package: no MANIFEST.json under ${pkgDir}`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  /* Re-verify what is already claimed, before adding a claim. */
  const drift = [];
  for (const item of manifest.items) {
    const f = path.join(pkgDir, item.destination_relative_to_package);
    if (!existsSync(f)) { drift.push(`${item.destination_relative_to_package} MISSING`); continue; }
    if (sha256(readFileSync(f)) !== item.sha256) drift.push(`${item.destination_relative_to_package} HASH CHANGED`);
  }
  if (drift.length) {
    console.error('migration-package: the package no longer matches its manifest:');
    for (const d of drift) console.error(`  ${d}`);
    console.error('Refusing to attach to a package that has drifted. Rebuild it.');
    process.exit(7);
  }

  const companions = [];
  for (const name of readdirSync(pkgDir)) {
    if (!name.endsWith('.md')) continue;
    /*
     * A MANIFEST CANNOT HASH ITSELF. The first run recorded MANIFEST.md as a
     * companion and then rewrote MANIFEST.md to contain that hash, so the row
     * was stale the instant it was written -- a self-referential claim that is
     * false by construction and would fail any arrival check that believed it.
     * The manifest files are the document, not its contents.
     */
    if (name.startsWith('MANIFEST.')) continue;
    const buf = readFileSync(path.join(pkgDir, name));
    companions.push({
      name, location: 'inside the package', bytes: buf.length, sha256: sha256(buf),
    });
  }
  if (bundlePath) {
    const abs = path.resolve(bundlePath);
    if (!existsSync(abs)) {
      console.error(`migration-package: no bundle at ${abs}`);
      process.exit(8);
    }
    const buf = readFileSync(abs);

    /*
     * THE KIND IS READ, NOT ASSERTED. The first version wrote
     * `kind: "git bundle"` and a note about which commits it carried for
     * WHATEVER FILE IT WAS HANDED -- a blind auditor attached `package.json`
     * and got a manifest row claiming it was a bundle containing 3bc0722.
     *
     * That is the exact failure this attach mode was written to avoid one
     * paragraph up: "a hand-written hash is a claim; this one is a reading."
     * The hash was a reading and the three claims beside it were typed.
     *
     * A git bundle begins with a version banner. Checking it is two lines and
     * turns the kind into a reading too. It is NOT a substitute for
     * `git bundle verify`, which is the only thing that proves the objects
     * resolve -- so that stays as the recorded method rather than as a claim
     * this tool makes on its behalf.
     */
    const head = buf.subarray(0, 64).toString('latin1');
    const looksLikeBundle = head.startsWith('# v2 git bundle') || head.startsWith('# v3 git bundle');
    if (!looksLikeBundle) {
      console.error(`migration-package: ${path.basename(abs)} does not begin with a git bundle banner.`);
      console.error('  Refusing to record it as a bundle. Pass the real bundle, or attach it as a plain companion.');
      process.exit(9);
    }

    companions.push({
      name: path.basename(abs),
      location: 'BESIDE the package, not inside it',
      bytes: buf.length,
      sha256: sha256(buf),
      kind: 'git bundle',
      kind_evidence: `file begins with "${head.split('\n')[0].trim()}"`,
      verify_with: 'git bundle verify <file>',
      note: 'Git objects, not AgentBridge state. A hash proves the bytes arrived; only `git bundle verify` proves the objects resolve. Which commits it carries is NOT asserted here — list them with `git bundle list-heads`.',
    });
  }

  manifest.companions = companions;
  manifest.companions_attached_at = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const mdPath = path.join(pkgDir, 'MANIFEST.md');
  const extra = [
    '',
    '## Companions',
    '',
    'Artifacts belonging to this migration that are not AgentBridge state.',
    '',
    '| file | where | bytes | sha256 |',
    '|---|---|---|---|',
    ...companions.map((c) => `| \`${c.name}\` | ${c.location} | ${c.bytes} | \`${c.sha256}\` |`),
    '',
    'The bundle is git objects and must be checked with `git bundle verify`, not',
    'by hash alone: a hash proves the bytes arrived, not that the objects resolve.',
    '',
  ].join('\n');
  const md = readFileSync(mdPath, 'utf8').replace(/\n## Companions[\s\S]*$/, '\n');
  writeFileSync(mdPath, `${md.trimEnd()}\n${extra}`);

  console.log(`attached to : ${pkgDir}`);
  console.log(`state       : ${manifest.items.length} file(s) re-verified against the manifest, all match`);
  for (const c of companions) console.log(`companion   : ${c.name}  ${c.bytes} B  ${c.sha256.slice(0, 16)}…`);
  process.exit(0);
}

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

/*
 * NOTHING RUNS ON IMPORT. The first version did all of its work at module
 * scope, so importing it -- from a test, or by accident -- would build a
 * package. Its sibling already used `invokedDirectly`; this one did not, which
 * is precisely the asymmetry that module exists to remove.
 */
function main() {
  const attachTo = flag('--attach');
  if (attachTo) attach(path.resolve(attachTo), flag('--bundle'));
  build();
}

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

/**
 * THE EXCLUSION IS ASSERTED AGAINST THE RESOLVED TARGET, NOT THE NAME.
 *
 * The first version compared `f.rel` -- the name under AGENTBRIDGE_HOME -- to
 * the NEVER list. `collect()` can only ever produce names from the include
 * list, so that intersection is EMPTY and the branch could never execute: a
 * guard under a long comment about its importance that had never been watched
 * fail. A blind auditor found it unreachable and then found what it could not
 * have caught anyway.
 *
 * THE SHAPE THAT MATTERS IS A SYMLINK. `collect()` filters `readdirSync` by
 * `.jsonl`, and `readFileSync` FOLLOWS LINKS. A link at
 * `audits/anything.jsonl` pointing at `config.json` would put the DPAPI-sealed
 * `secretStore` and the machineId into the package, labelled authority history,
 * and a name-based check would wave it through because the NAME is `audits/...`.
 *
 * So every source is resolved with `realpathSync` and three things are demanded
 * of the target: it is a REGULAR FILE, it is inside AGENTBRIDGE_HOME, and its
 * basename is not on the never-carry list. Refuse on any of them.
 */
function assertNothingForbidden(files) {
  const homeReal = realpathSync(HOME);
  for (const f of files) {
    if (f.missing) continue;

    let real;
    try { real = realpathSync(f.src); } catch {
      console.error(`migration-package: REFUSING -- ${f.rel} cannot be resolved (broken link?).`);
      process.exit(3);
    }

    if (!statSync(real).isFile()) {
      console.error(`migration-package: REFUSING -- ${f.rel} does not resolve to a regular file.`);
      process.exit(3);
    }

    const rel = path.relative(homeReal, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.error(`migration-package: REFUSING -- ${f.rel} resolves OUTSIDE the AgentBridge home.`);
      console.error('  A link out of the store is how a secret arrives labelled as history.');
      process.exit(3);
    }

    const parts = rel.split(path.sep);
    if (NEVER.includes(parts[0]) || NEVER.includes(parts[parts.length - 1])) {
      console.error(`migration-package: REFUSING -- ${f.rel} resolves to ${parts.join('/')}, which is never carried.`);
      process.exit(3);
    }
  }
}

/**
 * The manifest's store-key paragraph, DERIVED from what was actually packaged.
 *
 * THE OLD SENTENCE WAS TYPED, AND ON THIS MACHINE IT WAS FALSE. It promised that
 * "migration-verify computes the destination key and names the rename". For a
 * kind carrying TWO files the verifier does no such thing -- it REFUSES,
 * deliberately, because naming a rename there instructs the operator to
 * overwrite one authority file with another on a machine where the source may
 * already be gone. That refusal was added precisely so this could not happen,
 * and the manifest went on promising the behaviour it replaced.
 *
 * A manifest describing a tool's old behaviour is the stale-claim failure this
 * package exists to prevent. It also mattered practically: on the real package
 * the verifier exits 1 for this reason, and an operator holding a manifest that
 * says it will name a rename reads a correct refusal as a broken tool.
 *
 * Exported so the branch can be exercised -- the packager itself only ever runs
 * against one machine's real store, which is the one shape a test must not need.
 *
 * @param rows manifest items, each with `source_relative_to_agentbridge_home`
 */
export function storeKeyNote(rows) {
  const counts = new Map();
  for (const r of rows) {
    const rel = r.source_relative_to_agentbridge_home;
    if (!rel.includes('/')) continue;
    const kind = rel.split('/')[0];
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const ambiguous = [...counts].filter(([, n]) => n > 1).map(([kind, n]) => `${kind}/ (${n} files)`);

  const head = 'The store key above is a fact about the SOURCE checkout path. If the destination checkout path '
    + 'differs, audits/<key>.jsonl and findings/<key>.jsonl must be RENAMED to the destination key or the queue '
    + 'reads as EMPTY rather than erroring. ';

  if (!ambiguous.length) {
    return `${head}scripts/migration-verify.mjs computes the destination key and names the rename.`;
  }
  return `${head}This package carries more than one file under ${ambiguous.join(' and ')}, so `
    + 'scripts/migration-verify.mjs will REFUSE to name a rename for it and will report installation as FAILED '
    + 'until a person decides which file is this repository\'s store. That refusal is the tool working: only one '
    + 'file can occupy the destination name, and renaming both destroys one. Integrity and resolution are reported '
    + 'separately and still verify normally.';
}

function build() {
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

const keyNote = storeKeyNote(rows);

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
    keyNote,
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
}

if (invokedDirectly(process.argv[1], import.meta.url)) main();

export { collect, assertNothingForbidden, ITEMS, NEVER };
