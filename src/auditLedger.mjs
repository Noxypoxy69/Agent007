/**
 * WHICH COMMITS TOUCHED A CONTROL AND WERE NEVER AUDITED.
 *
 * CLAUDE.md rule 20 says nobody certifies their own work and that finishing
 * means handing it to an auditor that did not write it. It is the most expensive
 * rule in the file and it was enforced by ONE THING: whether the author
 * remembered. On 2026-09-18 the author shipped twelve commits touching the
 * guard, the shell rail, the permission grant channel and the Stop gate without
 * a single audit, having spent the same session insisting on rule 20 to two
 * other agents. The operator noticed, not the tooling.
 *
 * That is rule 17 pointed at rule 20: a control that is never consulted is not a
 * control. And CLAUDE.md's own opening ranks the places a lesson can live --
 * "a check script beats this file, which beats a code comment, which beats a
 * commit message". Rule 20 was in the file. This moves it up one.
 *
 * WHAT THIS IS NOT. It does not decide whether an audit was any good, it cannot
 * tell a real audit from a line somebody typed, and it approves nothing. It
 * answers one question: does every commit that touched a control have a recorded
 * audit. A ledger entry is a claim by a human or an agent, exactly like
 * `granted_by` in the override channel -- the value is that its ABSENCE is
 * visible, not that its presence proves anything.
 */
import path from 'node:path';

import { runGit } from './safeGit.mjs';
import { PROTECTED_PATHS } from './guardSession.mjs';

/**
 * Paths whose change requires an audit.
 *
 * DERIVED FROM PROTECTED_PATHS, not typed again. Two lists of one thing drift
 * the moment somebody edits one -- src/policy.mjs carries a header about the
 * days this project already lost to exactly that. A file worth refusing a write
 * to is a file worth auditing a change to, so the two answers come from one
 * source.
 *
 * The extras are the modules that DECIDE, which are not all protected: the shell
 * rail judges every command, and the stop gate is the second half of every
 * verdict.
 */
export const AUDIT_BEARING_EXTRAS = Object.freeze([
  'src/shellAllowlist.mjs',
  'src/claudeGuard.mjs',
  'src/guardSession.mjs',
  'src/safeGit.mjs',
  'src/tokenFile.mjs',
  'src/policy.mjs',
  'scripts/claude-stop-gate.mjs',
  'bin/agentbridge-claude-guard.mjs',
  /*
   * ADDED 2026-09-20, AND THE REASON MATTERS MORE THAN THE ENTRY.
   *
   * `bc64310` created src/principalResolution.mjs -- the module deciding
   * whether an identity counts as AUTHENTICATED -- and the coverage tool
   * reported "commits touching a control: 0". The most authority-bearing file
   * written that day was invisible to the audit gate, because this list is
   * matched by NAME and the name did not exist when the list was written.
   *
   * Adding it here fixes today and NOT the class. That is rule 8's warning --
   * fix the matcher, not the string the prober happened to try -- and it is
   * recorded as a known debt rather than presented as a repair: any new
   * control file is still exempt until somebody remembers this list.
   */
  'src/principalresolution.mjs',
  'src/governor.mjs',
  'src/auditqueuestore.mjs',
]);

/**
 * A NEW CONTROL FILE IS EXEMPT UNTIL SOMEBODY REGISTERS IT. That is the
 * current, unfixed state, and it is stated first so nobody reads the reasoning
 * below as a description of a repair.
 *
 * THE DEFECT, MEASURED. This matches only names already written
 * into PROTECTED_PATHS or the list above, so a control was auditable ONLY IF
 * SOMEBODY HAD REMEMBERED TO REGISTER IT. Which means a brand-new control was
 * exempt by construction, and the incentive ran exactly backwards: the more
 * novel and authority-bearing the module, the less likely its name was on a
 * list written before it existed.
 *
 * Demonstrated on `bc64310`, which created `src/principalResolution.mjs` --
 * the module that decides whether an identity counts as AUTHENTICATED --
 * and classified as "commits touching a control: 0". The single most
 * authority-critical file of that day was invisible to the audit gate.
 *
 * It is the same shape as two other failures this repository has paid for: the
 * tool-name matcher that missed the PowerShell tool (rule 17, a real guard
 * deletion), and the npm flag roster that lost three separate rounds. A list
 * of known names fails in both directions and loses to anything new.
 *
 * WHAT I TRIED AND WITHDREW, because the withdrawal is the useful part: making
 * everything under `src/` audit-bearing. The suite refused it immediately --
 * `ordinary files do not require an audit -- the negative that keeps this
 * usable` asserts `src/collect.mjs` must NOT, and it is right. Most of `src/`
 * is ordinary logic, and sweeping it in is the rule 19 over-block that gets a
 * gate switched off entirely. Raising that baseline to fit my change would
 * have been removing the one assertion guarding against it.
 *
 * The real discriminator is not WHERE a file lives but WHETHER A CONTROL
 * REACHES IT -- the guard's own import closure, which
 * test/guardDependenciesProtected.test.mjs already computes. That cannot be
 * decided by this function: it is pure and receives a path and nothing else.
 * So the fix belongs in `auditCoverage`, which has git, and the honest state
 * until then is that a NEW control file is exempt until registered.
 */

/** Does this repo-relative path carry a control? */
export function isAuditBearing(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const norm = rel.split(path.sep).join('/').replace(/^\.\//, '').toLowerCase();

  for (const extra of AUDIT_BEARING_EXTRAS) {
    if (norm === extra.toLowerCase()) return true;
  }
  for (const entry of PROTECTED_PATHS) {
    const e = String(entry).toLowerCase();
    // A trailing slash in PROTECTED_PATHS is a PREFIX, matching the matcher it
    // is taken from; without this, .claude/ would match nothing at all.
    if (e.endsWith('/') ? norm.startsWith(e) : norm === e) return true;
  }
  return false;
}

/**
 * Parse the ledger. One JSON object per line; blank lines and `#` comments skipped.
 *
 * NEVER THROWS ON A BAD LINE. A malformed ledger must not take out the caller --
 * this reports missing audits, and a reporter that crashes reports nothing,
 * which is indistinguishable from "everything is audited". Bad lines are
 * returned so the caller can say so.
 */
/** A 7-to-40 character hex sha, and nothing else. No wildcards, ever. */
const SHA_ONLY = /^[0-9a-f]{7,40}$/;

export const WAIVER_TYPE = 'owner_bootstrap_waiver';

/**
 * IS THIS ROW AN OWNER BOOTSTRAP WAIVER, and is it safe to honour?
 *
 * ═══ WHAT A WAIVER MEANS, AND THE FOUR THINGS IT DOES NOT ═══
 *
 * Danny's decision, 2026-09-20, with the escaped backlog unclearable: under
 * PRE_GENESIS no review can reach `enforced` independence, so the Stop gate
 * was demanding a clearance the trust layer structurally cannot issue. That
 * is rule 16 -- a red gate nobody can turn green is a countdown, and the
 * countdown ends with somebody switching the gate off.
 *
 * So a waiver says exactly one thing: THE STOP GATE MAY STOP BLOCKING ON
 * THESE NAMED HISTORICAL COMMITS. It does NOT say they were audited, it does
 * NOT say they passed, it does NOT set any verdict, and it does NOT exempt
 * anything committed afterwards.
 *
 * ═══ WHY IT IS A SEPARATE SHAPE AND NOT AN `auditor` STRING ═══
 *
 * The obvious implementation is a normal row reading
 * `{"commit":"...","auditor":"OWNER WAIVER -- NOT AN AUDIT"}`. That is what
 * the gate's own help text invites, and it is wrong: `audited` is
 * `Boolean(entry)`, so the moment such a row parses, the commit is AUDITED as
 * far as every consumer is concerned, and the disclaimer lives only in a
 * string nothing reads. A structural distinction cannot be lost that way --
 * `audited` stays false and these commits keep appearing in the report as
 * unaudited, which is true.
 *
 * ═══ FAIL CLOSED ON EVERY DEVIATION ═══
 *
 * A waiver that grants anything beyond suppression is refused OUTRIGHT rather
 * than partially honoured. In particular `grants_audit_pass: true` does not
 * make it stronger, it makes it MALFORMED -- a file that can be edited into a
 * blanket pass is a hole with a polite name on it. Same for a missing
 * `audit_performed: false`, a non-array `commits`, an empty list, and any
 * entry that is not a bare hex sha, which is what keeps `"*"` from ever
 * meaning anything here.
 */
function waiverShas(row) {
  if (!row || row.type !== WAIVER_TYPE) return null;
  if (row.audit_performed !== false) return null;
  if (row.grants_audit_pass !== false) return null;
  if (typeof row.reason !== 'string' || row.reason.trim() === '') return null;
  if (!Array.isArray(row.commits) || row.commits.length === 0) return null;

  const shas = [];
  for (const c of row.commits) {
    if (typeof c !== 'string') return null;
    const s = c.trim().toLowerCase();
    if (!SHA_ONLY.test(s)) return null;   // refuses '*', '', globs, refs, ranges
    shas.push(s);
  }
  return shas;
}

export function parseLedger(text) {
  const audited = new Map();
  const rows = [];
  const malformed = [];
  const waived = new Set();
  const waivers = [];
  const lines = String(text ?? '').split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed.push({ line: i + 1, text: line.slice(0, 80) });
      continue;
    }
    /*
     * CHECKED BEFORE THE AUDIT-ROW VALIDATION, because a waiver legitimately
     * carries neither `commit` nor `auditor` and would otherwise be filed as
     * malformed -- which is how this would have silently done nothing.
     *
     * A row CLAIMING to be a waiver and failing the shape is malformed, not
     * ignored: silence would let a typo read as "the owner waived nothing"
     * while looking like a waiver to a human reading the file.
     */
    if (row && row.type === WAIVER_TYPE) {
      const shas = waiverShas(row);
      if (shas === null) {
        malformed.push({ line: i + 1, text: line.slice(0, 80) });
        continue;
      }
      for (const s of shas) waived.add(s);
      waivers.push({ ...row, commits: shas });
      continue;
    }
    if (!row || typeof row.commit !== 'string' || row.commit.trim() === '') {
      malformed.push({ line: i + 1, text: line.slice(0, 80) });
      continue;
    }
    if (typeof row.auditor !== 'string' || row.auditor.trim() === '') {
      malformed.push({ line: i + 1, text: line.slice(0, 80) });
      continue;
    }
    /*
     * EVERY ROW IS KEPT, and the Map is no longer the record.
     *
     * `audited.set(key, row)` silently DISCARDS an earlier row with the same
     * spelling. Two audits of one commit written the same way -- which is
     * the house style, all 69 rows are 7-char shas -- collapsed to whichever
     * came last, so the contradiction was invisible to standingAudit and to
     * the gate that exists to find contradictions. MEASURED:
     *
     *     a then b   map size 1   standing found:8
     *     b then a   map size 1   standing found:0
     *
     * In the second ordering the OLDER audit stands over the newer one and
     * the newest-`at` rule never runs, because only one row survived to be
     * compared. The Map stays for the callers that want one row per commit;
     * `rows` is the actual record.
     */
    /*
     * AN `owner_waiver: true` ROW IS A WAIVER WEARING AN AUDIT ROW'S SHAPE.
     *
     * Eight of these were already on disk when the structural waiver above
     * was built, written by code-a on 2026-09-20 -- and written CAREFULLY:
     * every one carries `owner_waiver: true`, an `auditor` reading
     * "OWNER WAIVER (Danny) -- NOT AN AUDIT", and a note saying in full that
     * no auditor examined the commit.
     *
     * The rows were honest. THE PARSER WAS NOT LISTENING. It required
     * `commit` and `auditor`, both present, so each row landed in `audited`,
     * and `audited: Boolean(entry)` meant eight commits reported as reviewed
     * that nobody had read. The disclaimer was addressed to a human and every
     * consumer saw a clearance -- which is exactly the failure the new
     * `owner_bootstrap_waiver` type was introduced to avoid, already live in
     * the file, in a shape nobody had checked.
     *
     * So the fix is here rather than in the rows: honour the field the author
     * took the trouble to write. It is the same treatment the typed waiver
     * gets -- suppresses the block, never sets `audited` -- so both spellings
     * mean one thing and neither can be mistaken for a review.
     */
    if (row.owner_waiver === true) {
      waived.add(row.commit.trim().toLowerCase());
      waivers.push({
        type: 'owner_waiver_row',
        commits: [row.commit.trim().toLowerCase()],
        audit_performed: false,
        grants_audit_pass: false,
        reason: typeof row.note === 'string' ? row.note : 'owner waiver row',
      });
      continue;
    }

    rows.push(row);
    audited.set(row.commit.trim().toLowerCase(), row);
  }
  return {
    audited, rows, malformed, waived, waivers,
  };
}

/**
 * The commits in `range` that touched a control, with whether each is recorded.
 *
 * Returns { commits, error }. `error` is a STRING when git could not be asked,
 * and the caller must NOT read an empty `commits` as "nothing to audit" -- a
 * lookup that failed and a clean result must not look alike. That confusion is
 * written up in CLAUDE.md under check-first: "a failed lookup is not an absence
 * of prior work".
 */
export function auditCoverage({ repoRoot, range, ledgerText }) {
  const ledger = parseLedger(ledgerText);
  const { malformed } = ledger;

  /*
   * ONE git CALL, NOT ONE PER COMMIT.
   *
   * The first version ran `git show --name-only` per commit. Over a forty-commit
   * range that is forty subprocesses, which puts this out of reach of anything
   * that runs on a deadline -- and a check too expensive to run in the place
   * people already look is a check nobody consults, which is the defect it was
   * written to fix, one layer down.
   *
   * `git log --name-only` emits the same information in a single pass: a header
   * line per commit, then its file list, separated by blanks. The NUL record
   * separator keeps a commit subject containing a newline from being read as a
   * filename.
   */
  /*
   * THE SEPARATOR IS EMITTED BY git, NOT PASSED TO IT. The first attempt used a
   * NUL from String.fromCharCode(0) inside the --format argument. A NUL CANNOT
   * TRAVEL IN argv -- the OS terminates the string there -- so the format arrived
   * as bare "--format=", git printed no headers, every record parsed as nothing,
   * and the report said 0 commits touch a control on a range that has 13. A
   * clean-looking false negative, in the module written to stop those. Caught by
   * this file own tests going red.
   *
   * %x1e makes GIT write the byte, which never goes near an argv boundary.
   */
  const REC = String.fromCharCode(30);
  let raw;
  try {
    /*
     * --diff-merges=first-parent, BECAUSE A MERGE SHOWED NO FILES AT ALL.
     *
     * `git log --name-only` prints a header and NOTHING ELSE for a merge
     * commit: git declines to pick a side by default. So files=[],
     * touched=[], and the loop below hits `continue` and skips the commit
     * ENTIRELY -- it is not reported as unaudited, it is not reported at all.
     *
     * Measured on this repository:
     *
     *   git log --format=%x1e%H%x09%s --name-only -1 cbbe34c
     *     -> the header line, and no file list
     *   ...with --diff-merges=first-parent
     *     -> the header line, then test/leakRegression.test.mjs
     *
     * Nine merges in this history carried audit-bearing controls past the
     * escalation this way, the worst of them merging the guard binary, the
     * Stop gate, guardSession, safeGit and the guard's own test.
     *
     * It is not a stale-range problem that goes away when the window moves.
     * An EVIL MERGE -- one whose conflict resolution differs from both
     * parents -- exists in NO OTHER COMMIT, so the change it carries was
     * invisible permanently. first-parent is the right side to diff: it is
     * what the branch actually received.
     */
    raw = String(runGit(['-C', repoRoot, 'log', '--format=%x1e%H%x09%s', '--diff-merges=first-parent', '--name-only', range], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch (e) {
    return { commits: [], malformed, error: `could not list commits for ${range}: ${e?.message ?? 'unknown'}` };
  }

  const commits = [];
  for (const record of raw.split(REC)) {
    if (record.trim() === '') continue;
    const lines = record.split('\n');
    const [sha, subject] = (lines.shift() ?? '').split('\t');
    if (!sha || sha.trim() === '') continue;

    const files = lines.map((f) => f.trim()).filter(Boolean);
    let touched = files.filter(isAuditBearing);
    if (touched.length === 0) continue;

    /*
     * package.json IS SPLIT BY KEY HERE, BECAUSE THIS IS THE ONLY PLACE WITH
     * git. isBlockingControl is pure and cannot ask what changed inside the
     * file; see its note for why the whole-file answer is wrong in both
     * directions. A commit that changed `scripts` is reported under the
     * marker, which blocks; one that only moved dependencies keeps the plain
     * path, which is still REPORTED and still does not stop the turn.
     *
     * The extra git calls are bounded by the number of package.json commits
     * in the range -- normally zero -- so the one-pass property the comment
     * above insists on is preserved for every other commit.
     */
    if (touched.some((f) => normalisePath(f) === 'package.json')) {
      let verdict = 'unknown';
      try { verdict = scriptsChanged(repoRoot, sha.trim()); } catch { verdict = 'unknown'; }
      /*
       * THE MARKER IS APPENDED, NOT SUBSTITUTED, AND THE AUDIT WAS RIGHT ABOUT
       * WHY THAT MATTERS. The first version REPLACED the path, so
       * `check-audit-coverage --json` emitted `"touched": ["package.json#scripts"]`
       * -- a phantom to any consumer doing existsSync or `git log -- <path>`,
       * and the report no longer named the file that actually changed. Every
       * other entry in that array is a real repo-relative path.
       *
       * `unknown` adds nothing: it is not a decision and it is not a clean
       * bill. It stays a plain package.json, reported and not blocking, which
       * is what an unanswerable question deserves.
       */
      if (verdict === 'changed') touched = [...touched, SCRIPTS_MARKER];
    }

    const key = sha.trim().toLowerCase();
    const entry = standingAudit(ledger, key);
    commits.push({
      sha,
      subject: subject ?? '',
      touched,
      audited: Boolean(entry),
      auditor: entry?.auditor ?? null,
      /*
       * A SEPARATE FIELD, AND `audited` ABOVE IS DELIBERATELY UNTOUCHED.
       *
       * A waived commit is still an UNAUDITED commit and every report must go
       * on saying so. All this records is that the owner accepted the
       * historical backlog it names, so the Stop gate need not block the turn
       * on it. Collapsing the two into `audited: true` would erase the
       * difference between "somebody read this" and "the owner decided to
       * proceed without anybody reading it", which is the one distinction the
       * whole module exists to keep.
       */
      waived: isWaived(ledger, key),
    });
  }

  return { commits, malformed, error: null };
}

/**
 * The audit that STANDS for a commit, when more than one row matches it.
 *
 * TWO LIVE ROWS FOR ONE COMMIT DISAGREED, AND WHICH ONE COUNTED DEPENDED ON
 * THE ORDER OF THE FILE. d81e9643 carried a blind audit reporting found:0
 * and, later, a second independent blind audit reporting found:8 with two
 * HIGH. Both are real records of real passes and neither should be deleted.
 * But the old resolver took `audited.get(key)` and otherwise the FIRST
 * prefix match in map-insertion order, so the standing verdict for that
 * commit was decided by where somebody happened to paste a line -- and
 * moving one row past the other would silently flip the gate's answer from
 * "eight findings, two HIGH" to "no defect specific to this commit".
 *
 * So the rule is stated instead of inherited from the file layout:
 *
 *   1. a row carrying `superseded_by` never stands while another row does
 *   2. among the rest, the newest `at` wins
 *   3. with no `at` to compare, first match, which is the old behaviour
 *
 * SHORT AND LONG SPELLINGS OF THE SAME SHA ARE THE SAME COMMIT here, which
 * they were not before: "d81e964" and "d81e9643" produced two separate map
 * entries, so a reader looking for a contradiction would not even see one.
 */
export function standingAudit(ledger, key) {
  /*
   * A PARSE RESULT OR A BARE MAP. The Map form loses same-spelling
   * duplicates before this function is reached, which is the defect an
   * auditor found in the first version of this rule, so the parse result is
   * the right thing to pass and the Map is accepted only for callers that
   * still hold one.
   */
  /*
   * A BARE MAP IS REFUSED, NOT QUIETLY ACCEPTED. The first version took one
   * "for callers that still hold one" -- and there are none, so nothing
   * exercised it, while a caller writing the obvious
   * `const { audited } = parseLedger(t); standingAudit(audited, key)` would
   * have got back exactly the lossy behaviour this function exists to fix,
   * with no warning. An unexercised compatibility branch that reintroduces
   * the bug is worse than no branch.
   */
  if (ledger instanceof Map) {
    throw new TypeError('standingAudit needs the parseLedger result, not its .audited Map: '
      + 'the Map holds one row per spelling and has already discarded the duplicate '
      + 'this function exists to compare');
  }
  const all = Array.isArray(ledger?.rows) ? ledger.rows : [];

  const matches = all.filter((row) => {
    const k = String(row?.commit ?? '').trim().toLowerCase();
    return k !== '' && (k === key || (k.length >= 7 && key.startsWith(k)));
  });
  if (matches.length === 0) return null;

  const standing = matches.filter((r) => !r.superseded_by);
  const pool = standing.length > 0 ? standing : matches;

  /*
   * TIES ARE THE NORMAL CASE HERE, NOT AN EDGE CASE, and the first version
   * of this rule broke on them. An audit measured the shipped ledger: 69
   * rows, 18 distinct `at` values, and 64 of the 69 share theirs with
   * another row -- because passes are transcribed in batches under one
   * minute-rounded timestamp. The largest batch is 15 rows on one value.
   *
   * With a strict `>` a tie kept whichever row the FILE listed first, so
   * "THE STANDING AUDIT DOES NOT DEPEND ON THE ORDER OF THE FILE" was false
   * for the shape the convention actually produces -- the same mistake as
   * the duplicate-spelling one it replaced, one field along.
   *
   * The rule is NEWEST TIMESTAMP, ties broken by the LAST line -- and the
   * first version of this comment said only the second half, which an
   * auditor measured as wider than the code:
   *
   *     [FAIL@00:05Z, PASS@00:04Z]  ->  FAIL wins, not the last line
   *     [FAIL@00:05Z, PASS@""]      ->  FAIL wins, unparseable sorts lowest
   *
   * Both are right: a row appended later carrying an EARLIER timestamp is a
   * late transcription of an older pass, not a newer verdict. Only for the
   * same-minute batch tie -- the case this is actually for -- does last
   * line decide, and there it is deterministic in both orderings because it
   * depends on which came last, never on which came first.
   *
   * AND THE COMPARISON IS A TIMESTAMP, NOT A STRING. Lexicographic order is
   * wrong across offsets: "2026-02-01T09:00:00+09:00" is 00:00Z and sorts
   * ABOVE "2026-02-01T05:00:00Z", which is five hours genuinely later. Every
   * shipped row is Z with second resolution so this was latent, and latent
   * is not fixed. An unparseable or absent `at` sorts below every real one,
   * which preserves the previous behaviour for undated rows.
   */
  const when = (row) => {
    const t = Date.parse(row?.at ?? '');
    return Number.isFinite(t) ? t : -Infinity;
  };
  let best = pool[0];
  for (const row of pool) if (when(row) >= when(best)) best = row;
  return best;
}

/**
 * The range to report on when nobody named one.
 *
 * A DEFAULT THAT CANNOT SILENTLY MEAN "NOTHING". If the upstream ref is missing
 * -- a fresh clone, a worktree with a different refspec, a detached checkout --
 * falling back to an empty range would print a clean report for a repository
 * nobody has audited, which is the exact failure this module exists to remove.
 * So the fallback is WIDE: it over-reports rather than under-reports, and an
 * over-report is an annoyance where an under-report is a false clearance.
 */
export function defaultAuditRange(repoRoot, depth = 50) {
  /*
   * A HISTORY WINDOW, NOT A DIFF FROM UPSTREAM.
   *
   * The first version tried origin/main, then origin/master, then main, then
   * master, and fell back to a window only if none existed. Two things were
   * wrong and a probe found both.
   *
   * It resolved to a LOCAL branch that equals HEAD, so the range was EMPTY and
   * the gate reported a clean repository that had an unaudited change to the
   * shell rail in it. The comment above it claimed the default 'cannot silently
   * mean nothing'. It could, and did, on the first tree it was pointed at.
   *
   * And the idea was wrong even when the ref existed: a diff from upstream
   * answers 'what have I not PUSHED', and pushing audits nothing. Twelve commits
   * went to the remote unaudited the same afternoon, which would have emptied
   * the range and reported coverage by publishing.
   *
   * So the question is asked of HISTORY: of the last <depth> commits, which
   * touched a control and have no ledger line. That keeps reporting an old
   * absence until somebody records it, which is the correct behaviour for a
   * reporter whose whole job is that absences stay visible.
   */
  const n = Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 50;
  try {
    const count = Number(String(runGit(['-C', repoRoot, 'rev-list', '--count', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim());
    // A shallow or young repository has no HEAD~n to name; ask for all of it.
    if (Number.isFinite(count) && count <= n) return 'HEAD';
  } catch { /* fall through to the window, which over-reports rather than under */ }
  return `HEAD~${n}..HEAD`;
}

/** A one-screen report. Returns a string, or '' when there is nothing to say. */
export function formatCoverage({ commits, malformed, error }) {
  const lines = [];
  if (error) {
    lines.push(`[agentbridge:audit-coverage-unknown] ${error}`);
    lines.push('  Treat this as UNKNOWN, not as clean.');
    return lines.join('\n');
  }
  const missing = commits.filter((c) => !c.audited);
  if (missing.length === 0 && malformed.length === 0) return '';

  if (missing.length > 0) {
    lines.push(`[agentbridge:audit-missing] ${missing.length} commit(s) changed a control with no audit recorded:`);
    for (const c of missing.slice(0, 20)) {
      /*
       * EVERY FIELD IS COERCED, BECAUSE A THROW HERE FAILS SILENTLY OPEN.
       *
       * Found by blind audit. auditEscalation hardens its own inputs and this
       * function did not: c.touched.slice(...) threw on null, undefined and a
       * plain string, and c.sha / c.subject were assumed to be strings.
       *
       * In the Stop gate the whole block sits inside
       * a catch whose whole body is the comment "a reporter must never take
       * the gate down", so a throw
       * does not surface as an error -- it surfaces as the ENTIRE audit
       * escalation never firing. That is the failure mode the comment above
       * auditEscalation already claims to have closed, one function along,
       * and it is the one shape this module exists to remove.
       *
       * Unreachable through auditCoverage today, which always builds arrays.
       * That is exactly the argument that was true of the last three things
       * here that turned out to be reachable.
       */
      const touched = Array.isArray(c?.touched) ? c.touched.map((f) => String(f)) : [];
      lines.push(`  ${String(c?.sha ?? '(no sha)').slice(0, 8)}  ${String(c?.subject ?? '').slice(0, 60)}`);
      lines.push(`            ${touched.slice(0, 4).join(', ')}${touched.length > 4 ? ` +${touched.length - 4} more` : ''}`);
    }
    if (missing.length > 20) lines.push(`  ...and ${missing.length - 20} more`);
  }
  /*
   * A CHECK THAT SKIPS SOMETHING MUST NOT PRINT A CLEAN PASS -- CLAUDE.md says
   * so about the NUL-byte files, and it applies here.
   *
   * When a package.json commit is reported, the reader has no way to know that
   * the executable-surface test looked at six keys and NOT at dependencies --
   * which execute via postinstall with no script at all. Naming the gap where
   * the report is read is the difference between a known limit and a silent
   * one, and it stops UNWATCHED_EXECUTION_KEYS being a constant only a test
   * ever looks at.
   */
  if (commits.some((c) => (Array.isArray(c?.touched) ? c.touched : [])
    .some((f) => normalisePath(f) === 'package.json'))) {
    /*
     * BOUND OUTSIDE THE TEMPLATE, AND NOT FOR STYLE. `classifyExports` runs
     * `stripNonCode` before looking for a name, and that strips STRING BODIES
     * as well as comments -- so an export used only inside a template literal
     * is invisible to it and still reports as test-only. Measured: this exact
     * line, interpolated, left UNWATCHED_EXECUTION_KEYS unwired at 102.
     *
     * Worth knowing generally: the dead-export gate cannot see a name that
     * appears only in a string, which is a blind spot rather than a false
     * positive -- it under-reports wiring, never over-reports it.
     */
    const unwatched = UNWATCHED_EXECUTION_KEYS.join(', ');
    lines.push('  NOTE: a package.json change above was judged on its executable surface only. '
      + `${unwatched} are NOT examined, and they execute -- npm install runs postinstall with `
      + 'no script present. Neither is package-lock.json.');
  }

  for (const m of malformed) {
    lines.push(`  ledger line ${m.line} is not a usable entry: ${m.text}`);
  }
  return lines.join('\n');
}

/**
 * WHICH UNAUDITED CONTROL COMMITS SHOULD STOP A TURN, AND WHICH SHOULD ONLY
 * BE REPORTED.
 *
 * ═══ WHY THIS EXISTS: THE DETECTOR WORKED AND CHANGED NOTHING ═══
 *
 * Measured 2026-09-19. `scripts/check-audit-coverage.mjs` exits 1 and names
 * every commit that changed a control with no audit recorded. The Stop gate
 * already imports auditCoverage, already calls it on every turn, and already
 * gets the right answer -- and then appends it to `carriedNotice`, which is
 * a systemMessage. It never reaches `out()`, which is what blocks.
 *
 * So rule 20 -- nobody certifies their own work -- was enforced by whether
 * anyone happened to read a notice. On the night this was written, three
 * agents each certified their own work, each was wrong, and each was caught
 * only by a separate reader who was summoned by hand. 101 commits were pushed
 * with 13 audited and nothing objected. The Stop gate had said so, in a line
 * underneath the override-grant block that everyone had stopped reading.
 *
 * That is rule 17 one level up: not a control that is never consulted, but a
 * control that IS consulted and whose answer changes nothing.
 *
 * ═══ WHY IT BLOCKS AT THE BOUNDARY RATHER THAN EVERY TURN ═══
 *
 * Blocking on any unaudited control commit would fire on the turn that writes
 * one, which is every guard turn, before the author could possibly have got an
 * audit. A gate that makes ordinary work impossible gets switched off, and
 * switching this one off loses the drift check with it -- the override
 * incentive this repository already names as a vulnerability.
 *
 * So the line is PUSHED. Unaudited work that is still local is a note: the
 * author is mid-change and the audit is ahead of them. Unaudited work that has
 * left this machine is different in kind -- other clones can now build on it,
 * and the moment to have audited it has passed. That is the exact shape of
 * what went wrong: the push, not the commit.
 *
 * ═══ AN UNDETERMINABLE ANSWER DOES NOT BLOCK, AND SAYS SO ═══
 *
 * `unpushed` is null when nobody could ask git which commits have left (no
 * upstream, detached head, a clone with a different refspec). Blocking then
 * would take the machine down on a fresh clone, so it reports instead -- but
 * it reports UNKNOWN rather than clean, because "could not tell" and "nothing
 * to do" must never render alike.
 *
 * @param {object} coverage    the return of auditCoverage()
 * @param {string[]|null} unpushed  SHAs not yet on the upstream, or null if
 *                                  that question could not be answered
 * @returns {{block: string|null, notice: string|null}}
 */
/*
 * WHICH AUDIT-BEARING PATHS ARE PROSE, AND THEREFORE REPORTED RATHER THAN
 * BLOCKED. Everything else audit-bearing BLOCKS.
 *
 * THIS USED TO BE THE OTHER WAY ROUND AND THAT WAS A DEFECT AN AUDITOR FOUND.
 * The first version of this narrowing was `BLOCKING_CONTROLS`, eleven
 * hand-typed path names, and blocking required being ON it. Measured by a
 * blind audit: the blocking set went 23 -> 11, and six of the twelve dropped
 * were neither prose nor dependencies --
 *
 *     .claude/settings.json      .claude/settings.local.json
 *     .claude/** (hook scripts)  src/moduleGraph.mjs
 *     src/tokenFile.mjs          test/claudeGuard.test.mjs
 *
 * -- so a pushed, unaudited change to a hook script or to a module the guard
 * IMPORTS stopped blocking and went back to being a notice, which is the
 * precise state this whole module was written to end. The auditor demonstrated
 * it end to end: src/moduleGraph.mjs pushed unaudited returned decision
 * "block" at 7da95e0 and approved the turn at d6fcf6f.
 *
 * TWO LESSONS, BOTH ALREADY IN THE FILE ABOVE THIS LINE.
 *
 * Rule 19: a list of names fails in both directions, and an allowlist of
 * things that block fails CLOSED for the reader and OPEN for the system --
 * every control added after it was typed is silently exempt. The header of
 * AUDIT_BEARING_EXTRAS says so in as many words, forty lines up: "DERIVED FROM
 * PROTECTED_PATHS, not typed again. Two lists of one thing drift the moment
 * somebody edits one." I typed the second list three functions below that
 * sentence.
 *
 * So the question is asked the other way round, and about the SHAPE of the
 * path rather than its name: is this prose or a dependency manifest? A new
 * control file is neither, so it blocks the day it is added, with nobody
 * remembering to extend anything. A new document ends in .md, so it does not.
 *
 * WHAT IS DELIBERATELY EXEMPT, and why each one:
 *   *.md               Prose. CLAUDE.md, the docs/ set and THIRD_PARTY_CODE.md
 *                      are worth auditing and worth REPORTING unaudited, but
 *                      blocking a turn on a documentation edit is what took
 *                      the operator machine down and nearly got this gate
 *                      switched off entirely (rule 16).
 *   package.json       Dependency manifests. A lockfile bump is not a
 *   package-lock.json  decision, and npm rewrites them without being asked.
 *
 * Note what is NOT exempt any more: .claude/** is decision CONFIGURATION --
 * settings.json decides whether the hooks arm at all -- and
 * test/claudeGuard.test.mjs is how anybody would notice the guard changing.
 * Weakening either is the cheapest way to disable a control without touching
 * it.
 */
const PROSE_OR_DEPENDENCY = /(?:\.md$)|(?:^package(?:-lock)?\.json$)/;

/*
 * ═══ AND THE PROSE EXEMPTION STOPS AT `.claude/`, WHICH THE PARAGRAPH ABOVE
 *     ALREADY SAID AND THE REGEX DID NOT DO ═══
 *
 * Read the last sentence of that comment: ".claude/** is decision CONFIGURATION
 * -- settings.json decides whether the hooks arm at all ... Weakening either is
 * the cheapest way to disable a control without touching it." Then read the
 * regex: `\.md$` matches `.claude/agents/auditor.md` and
 * `.claude/commands/deploy.md` as readily as it matches CLAUDE.md. So every
 * markdown file under the one directory the comment singles out was silently
 * back on the exempt list. Found by blind audit, 2026-09-19.
 *
 * MARKDOWN UNDER `.claude/` IS NOT PROSE. An agent definition is a system prompt
 * plus a tool roster; a slash-command file is a body of instructions that runs
 * when somebody types its name. Both change what an agent DOES, which is the
 * definition of decision configuration this module uses everywhere else. The
 * extension describes the encoding, not the role -- and this repository has
 * already been caught once assuming a file's name told it what the file was.
 *
 * ASKED AS A SHAPE, not as a list of the agent and command files that happen to
 * exist today: anything under `.claude/` blocks, so a directory added there next
 * month is covered without anybody remembering. Case-folded by normalisePath,
 * for the reason PROTECTED_PATHS is: NTFS resolves `.Claude` to the same
 * directory.
 *
 * ═══ AND `.claude/worktrees/` IS EXCLUDED HERE, EXPLICITLY, BECAUSE I ASSERTED
 *     IT WAS EXCLUDED UPSTREAM AND IT IS NOT ═══
 *
 * The first draft of this comment said the worktree carve-out was applied before
 * this function ever ran. It is not: `isAuditBearing` walks PROTECTED_PATHS
 * directly rather than going through `isProtectedRelPath`, so
 * PROTECTION_EXEMPT_PREFIXES never reaches it and
 * `.claude/worktrees/<id>/notes.md` is audit-bearing. Without this clause the
 * change above would have started BLOCKING every markdown file in every agent
 * worktree -- an over-block introduced by a fix, which is the shape two audits
 * caught on this surface on 2026-09-18, and rule 19's stated reason a gate ends
 * up switched off.
 *
 * What stays protected is the thing the carve-out was always narrow about: a
 * `.claude/` directory nested INSIDE a worktree is the directory that decides
 * whether that agent's guard runs, and pre-planting it is the whole attack. So
 * the exclusion stops at the next `.claude/` down, exactly as the prefix rule in
 * guardSession does.
 */
const CONFIG_DIR = /(?:^|\/)\.claude\//;
/*
 * THE LOOKAHEAD IS ANCHORED TO THE REMAINDER, NOT TO THE WHOLE STRING, AND MY
 * FIRST SPELLING OF IT WAS WRONG IN THE DANGEROUS DIRECTION.
 *
 * It read `(?!.*(?:^|\/)\.claude\/)`. Inside a lookahead `^` still means index 0
 * of the whole string, so the alternation collapsed to "a slash then .claude/" --
 * and a `.claude/` sitting IMMEDIATELY after the worktree directory has no slash
 * before it. `.claude/worktrees/audit-1/.claude/agents/x.md` therefore read as
 * ordinary worktree content and stopped blocking: the exact pre-plant target the
 * clause exists to protect, waved through by the clause protecting it.
 *
 * Caught by the test written in the same commit, which is the only reason it is
 * a footnote rather than a finding. `(?:.*\/)?` says "any number of leading path
 * segments, including none", which is what was meant.
 */
const WORKTREE_CONTENT = /(?:^|\/)\.claude\/worktrees\/[^/]+\/(?!(?:.*\/)?\.claude\/)/;

/**
 * The marker auditCoverage emits for a package.json commit that changed the
 * `scripts` key. Not a real path -- see isBlockingControl.
 */
export const SCRIPTS_MARKER = 'package.json#scripts';

/*
 * ═══ THE ONE THIS STILL DOES NOT COVER, NAMED RATHER THAN QUIETLY LEFT ═══
 *
 * `dependencies` and `devDependencies` are an execution channel and are not
 * watched. CLAUDE.md, in the same paragraph this feature's rationale quotes:
 * "`npm install <pkg>` needs no pre-existing script at all -- it fetches and
 * runs `postinstall`." A blind audit measured the gap and also found
 * package-lock.json alone, with `resolved` repointed at an attacker's tarball,
 * passes with no block at all.
 *
 * WATCHING THEM IS NOT OBVIOUSLY RIGHT, WHICH IS WHY IT IS NOT DONE HERE.
 * A dependency bump is frequent, npm rewrites the lockfile unprompted, and
 * blocking every one of them on a pushed-unaudited rule re-creates precisely
 * the outage the whole-file exemption was added to end -- 43672dc, an npm
 * change, stopped every turn on the operator machine. The keys above were
 * chosen because they execute AND essentially never churn, so closing them
 * costs nothing; these two fail the second test.
 *
 * So it is an owner decision with a real cost either way, recorded here with
 * the measurement rather than settled by whoever touched the file last.
 */
export const UNWATCHED_EXECUTION_KEYS = Object.freeze([
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
]);

/**
 * Did this commit change package.json's `scripts` key?
 *
 * TWO git CALLS, AND ONLY FOR COMMITS THAT TOUCH package.json. The cost note
 * on auditCoverage rejects per-commit subprocesses across a whole range, and
 * rightly -- forty commits was forty spawns. This is bounded by the number of
 * package.json commits in the range, which is normally zero.
 *
 * FAILS CLOSED. If either side cannot be read or parsed -- a root commit with
 * no parent, a malformed file mid-history -- the answer is "changed", so the
 * commit blocks. Unreadable is UNKNOWN, and unknown must not render as
 * "nothing happened here".
 *
 * Keys are sorted before comparison, so a reformat or a reorder is not
 * reported as a decision. What matters is which script names exist and what
 * they run.
 */
/*
 * ═══ WHICH package.json KEYS EXECUTE, MEASURED RATHER THAN ASSUMED ═══
 *
 * The first version watched `scripts` alone. A blind audit enumerated what that
 * leaves open, every one of them a pushed unaudited change returning no block:
 * dependencies, devDependencies, packageManager, bin, overrides, workspaces,
 * main/exports, type/engines -- and package-lock.json with `resolved` repointed
 * at an attacker's tarball.
 *
 * The keys below are the ones that execute WITHOUT anybody typing a command and
 * that essentially never churn, so watching them costs nothing:
 *
 *   bin              names an executable this package installs onto PATH
 *   packageManager   corepack downloads and RUNS the tarball this string names
 *   overrides        silently substitutes what a dependency resolves to
 *   resolutions      the same, for yarn
 *   workspaces       widens which package.json files npm will install from
 *
 * `dependencies` and `devDependencies` are deliberately NOT here, and that is a
 * decision rather than an oversight -- see the note on DEPENDENCY_KEYS below.
 */
const EXECUTING_KEYS = Object.freeze(['scripts', 'bin', 'packageManager', 'overrides', 'resolutions', 'workspaces']);

/**
 * Serialise the execution-bearing keys of package.json at a revision.
 *
 * Returns a string, `''` for "the file has none of them", or `undefined` for
 * "could not be read" -- three answers, because collapsing the third into
 * either of the others is the whole of D2 and D4 below.
 *
 * NUL LENGTH FRAMING, AND THE AUDIT NAMED THE FIX IN OUR OWN DOCUMENTATION.
 * The first version joined `${k}\x1f${v}` on `\x1e` with no lengths, so
 * `{"pwn":"benign\x1etest\x1fnode --test"}` and
 * `{"pwn":"benign","test":"node --test"}` serialised IDENTICALLY -- the second
 * defining a real `test` script that did not exist before. Measured. CLAUDE.md
 * says it in as many words about deployGate and auditRange: "without the
 * framing, two different file lists can hash the same."
 */
function executableSurfaceAt(repoRoot, rev) {
  let text;
  try {
    text = runGit(['show', `${rev}:package.json`], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return undefined; }
  let parsed;
  try { parsed = JSON.parse(String(text)); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const NUL = String.fromCharCode(0);
  const frame = (s) => `${s.length}${NUL}${s}`;
  const parts = [];
  for (const key of EXECUTING_KEYS) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const k of Object.keys(v).sort()) parts.push(frame(key), frame(k), frame(JSON.stringify(v[k])));
    } else {
      parts.push(frame(key), frame(JSON.stringify(v)));
    }
  }
  return parts.join(NUL);
}

/**
 * Did this commit change package.json's executable surface?
 *
 * @returns {'changed'|'same'|'unknown'}
 *
 * ═══ THREE ANSWERS, BECAUSE FAILING CLOSED PRODUCED AN UNCLEARABLE BLOCK ═══
 *
 * The first version returned a boolean and answered `true` whenever either side
 * could not be read. A blind audit measured what that does:
 *
 *   a repository with <= 50 commits, whose ROOT commit creates package.json
 *   a `git clone --depth 1`, whose boundary commit's parent is absent
 *
 * Both block, unconditionally, on every turn. And the recovery is worse than
 * the block: the only way to clear it is a ledger line asserting that "a reader
 * who did NOT write the commit has actually looked at it" -- for a root commit
 * nobody audited. A gate whose false positives are cleared by FABRICATING an
 * audit record corrupts the one artefact the whole rule-20 mechanism rests on.
 *
 * So the two unreadable cases are separated, because they are not the same
 * question:
 *
 *   a ROOT commit genuinely has no parent. Its executable surface is whatever
 *   it introduces, compared against nothing -- so if it defines any, that IS an
 *   addition and blocking is correct; if it defines none, nothing happened.
 *   Asked with %P, which is empty only for a true root.
 *
 *   a SHALLOW boundary records a parent that is not in the object store. That
 *   is UNKNOWN: the comparison cannot be made, and neither "changed" nor "same"
 *   is honest. It is reported as unknown and does not block, which is the same
 *   judgement formatCoverage already makes with its audit-coverage-unknown
 *   channel and check-first makes with LOOKUP INCOMPLETE.
 */
export function scriptsChanged(repoRoot, sha) {
  const after = executableSurfaceAt(repoRoot, sha);
  if (after === undefined) return 'unknown';

  let parents = '';
  try {
    parents = String(runGit(['log', '-1', '--format=%P', sha], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch { return 'unknown'; }

  /* A true root commit: compare against nothing, which is honest and readable. */
  if (parents === '') return after === '' ? 'same' : 'changed';

  const before = executableSurfaceAt(repoRoot, `${sha}^`);
  if (before === undefined) return 'unknown';
  return after === before ? 'same' : 'changed';
}

/** Is this path decision configuration rather than prose, by where it lives? */
function isConfigDirPath(p) {
  if (!CONFIG_DIR.test(p)) return false;
  return !WORKTREE_CONTENT.test(p);
}

/**
 * Normalise a git-reported path: either separator, no leading ./, folded.
 *
 * The backslash is BUILT rather than written. A literal backslash in a string
 * has been silently eaten by this session shell three separate times; the file
 * already uses this idiom for the record separator.
 */
function normalisePath(rel) {
  return String(rel).split(String.fromCharCode(92)).join('/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

/** Does changing this path stop a turn, as opposed to merely being reported? */
export function isBlockingControl(rel) {
  const p = normalisePath(rel);
  /*
   * SCRIPTS ARE NOT DEPENDENCIES, AND package.json IS BOTH.
   *
   * PROSE_OR_DEPENDENCY exempts package.json whole, because "a lockfile bump
   * is not a decision and npm rewrites them without being asked". An auditor
   * pointed out what that leaves open, using this repository's own
   * documentation as the evidence: CLAUDE.md records that `npm run pwn`
   * OVERWROTE src/claudeGuard.mjs, that npm install/ci/run are all ALLOW
   * through the shipped rail, and that `npm test`'s glob is expanded by node
   * rather than judged. package.json is where the names of those scripts
   * live, so a pushed unaudited change to it is decision-bearing in a way the
   * exemption's rationale does not cover.
   *
   * Neither whole-file answer is right:
   *
   *   block the file    re-creates the outage the exemption was added for.
   *                     43672dc, an npm-script addition, was one of the two
   *                     commits stopping every turn on the operator machine.
   *   exempt the file   leaves an execution channel entirely unaudited.
   *
   * So the split is by KEY. The decision needs git, which this pure
   * predicate does not have, so auditCoverage makes it per commit and emits
   * SCRIPTS_MARKER in place of the path; here we only honour it.
   */
  if (p === SCRIPTS_MARKER) return true;
  if (!isAuditBearing(rel)) return false;
  if (isConfigDirPath(p)) return true;   // see CONFIG_DIR: markdown there is not prose
  return !PROSE_OR_DEPENDENCY.test(p);
}

/**
 * IS THIS COMMIT NAMED BY AN OWNER BOOTSTRAP WAIVER?
 *
 * PREFIX MATCHING IN BOTH DIRECTIONS, because the house style in
 * docs/audit-ledger.jsonl is 7-character shas while `git log` hands this
 * module 40. An exact-equality check would make every hand-written waiver
 * silently cover nothing -- the same defect as the parser rejecting the
 * waiver row outright, one step further along, and just as invisible.
 *
 * A waiver entry is already constrained to 7-40 hex characters by
 * `waiverShas`, so neither direction can be satisfied by a wildcard or an
 * empty string.
 */
export function isWaived(ledger, sha) {
  const key = String(sha ?? '').trim().toLowerCase();
  if (key === '') return false;
  const set = ledger?.waived;
  if (!(set instanceof Set) || set.size === 0) return false;
  for (const w of set) {
    if (w === key || key.startsWith(w) || w.startsWith(key)) return true;
  }
  return false;
}

/** Does this commit touch decision logic, as opposed to prose or dependencies? */
export function touchesBlockingControl(touched) {
  return (Array.isArray(touched) ? touched : []).some(isBlockingControl);
}

export function auditEscalation(coverage, unpushed) {
  /*
   * NORMALISE BEFORE DELEGATING, BECAUSE A THROW HERE DISABLES THE CONTROL
   * SILENTLY.
   *
   * formatCoverage iterates `malformed` and reads `commits.length`, so a
   * partial coverage object makes it throw. In the Stop gate this call sits
   * inside `catch { /* a reporter must never take the gate down *\/ }` -- so a
   * throw would not surface as an error, it would surface as the escalation
   * never firing. A gate that fails silently open is the exact shape this
   * whole module exists to remove, and it would be invisible precisely when
   * something unusual had happened.
   */
  const safe = {
    commits: Array.isArray(coverage?.commits) ? coverage.commits : [],
    malformed: Array.isArray(coverage?.malformed) ? coverage.malformed : [],
    error: coverage?.error ?? null,
  };
  const { commits, error } = safe;
  if (error) return { block: null, notice: formatCoverage(safe) };

  const missing = commits.filter((c) => !c?.audited);
  if (missing.length === 0) return { block: null, notice: formatCoverage(safe) };

  if (!Array.isArray(unpushed)) {
    return {
      block: null,
      notice: `${formatCoverage(safe)}\n`
        + '  [agentbridge:audit-escalation-unknown] Could not determine which of these have been '
        + 'pushed, so none is being blocked on. That is UNKNOWN, not clean.',
    };
  }

  const local = new Set(unpushed.map((s) => String(s).trim().toLowerCase()));
  const escaped = missing
    .filter((c) => !local.has(String(c.sha).trim().toLowerCase()))
    /*
     * THE OWNER BOOTSTRAP WAIVER, AND IT SUPPRESSES ONLY THE BLOCK.
     *
     * These commits are still in `missing`, so `formatCoverage` below still
     * reports them as unaudited -- which they are. All that changes is that
     * the turn is not stopped on a backlog that, under PRE_GENESIS, cannot
     * obtain a gate-satisfying review no matter how much is spent on it.
     *
     * Bound to explicit shas by construction: see `waiverShas`, which refuses
     * anything that is not bare hex, so no waiver can ever widen to cover a
     * commit written after it. A control commit made tomorrow blocks normally.
     */
    .filter((c) => !c?.waived)
    /*
     * Only DECISION LOGIC stops a turn. A pushed, unaudited CLAUDE.md edit is
     * still reported in the notice below; it does not block. See
     * isBlockingControl for why that distinction exists and what it cost.
     */
    .filter((c) => touchesBlockingControl(c.touched));
  if (escaped.length === 0) return { block: null, notice: formatCoverage(safe) };

  const lines = [
    `[agentbridge:audit-escaped] ${escaped.length} commit(s) changed a control, were PUSHED, and `
      + 'have no audit recorded. Rule 20: the party that wrote a fix cannot clear it.',
  ];
  for (const c of escaped.slice(0, 10)) {
    lines.push(`  ${String(c.sha).slice(0, 8)}  ${String(c.subject).slice(0, 58)}`);
    lines.push(`            ${c.touched.slice(0, 4).join(', ')}`);
  }
  if (escaped.length > 10) lines.push(`  ...and ${escaped.length - 10} more`);
  lines.push('');
  lines.push('  These have left this machine, so other clones can build on them and the moment');
  lines.push('  to audit has passed. Record the audit in docs/audit-ledger.jsonl -- one JSON');
  lines.push('  object per line with at least {"commit":"<sha>","auditor":"<who>"} -- once a');
  lines.push('  reader who did NOT write the commit has actually looked at it.');
  /*
   * BOTH CHANNELS, AND NEITHER REPEATS THE OTHER.
   *
   * This returned `notice: null`, and an auditor showed the cost: `notice` is
   * the ONLY channel naming unaudited commits that do not block, so the moment
   * one decision-logic commit escaped, every unaudited prose commit vanished
   * from the report entirely -- present in neither channel. The commit that
   * introduced the filter claimed the opposite in its message ("the REPORT
   * still covers everything isAuditBearing covers"). It did not. Reporting
   * LESS the moment something goes wrong is backwards.
   *
   * The commits already named in the block are removed rather than repeated,
   * because the original null was answering a real objection -- a notice
   * restating the block is noise, and noise is how a reader learns to skip
   * both. If nothing else is outstanding the notice stays null.
   */
  const named = new Set(escaped.map((c) => String(c.sha).trim().toLowerCase()));
  const rest = formatCoverage({
    ...safe,
    commits: safe.commits.filter((c) => !named.has(String(c.sha).trim().toLowerCase())),
  });
  return { block: lines.join('\n'), notice: rest === '' ? null : rest };
}
