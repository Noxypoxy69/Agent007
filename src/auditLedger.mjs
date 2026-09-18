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
]);

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
export function parseLedger(text) {
  const audited = new Map();
  const malformed = [];
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
    if (!row || typeof row.commit !== 'string' || row.commit.trim() === '') {
      malformed.push({ line: i + 1, text: line.slice(0, 80) });
      continue;
    }
    if (typeof row.auditor !== 'string' || row.auditor.trim() === '') {
      malformed.push({ line: i + 1, text: line.slice(0, 80) });
      continue;
    }
    audited.set(row.commit.trim().toLowerCase(), row);
  }
  return { audited, malformed };
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
  const { audited, malformed } = parseLedger(ledgerText);

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
    raw = String(runGit(['-C', repoRoot, 'log', '--format=%x1e%H%x09%s', '--name-only', range], {
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
    const touched = files.filter(isAuditBearing);
    if (touched.length === 0) continue;

    const key = sha.trim().toLowerCase();
    const entry = audited.get(key)
      ?? [...audited.keys()].find((k) => k.length >= 7 && key.startsWith(k));
    commits.push({
      sha,
      subject: subject ?? '',
      touched,
      audited: Boolean(entry),
      auditor: typeof entry === 'string' ? audited.get(entry)?.auditor : entry?.auditor ?? null,
    });
  }

  return { commits, malformed, error: null };
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
      lines.push(`  ${c.sha.slice(0, 8)}  ${c.subject.slice(0, 60)}`);
      lines.push(`            ${c.touched.slice(0, 4).join(', ')}${c.touched.length > 4 ? ` +${c.touched.length - 4} more` : ''}`);
    }
    if (missing.length > 20) lines.push(`  ...and ${missing.length - 20} more`);
  }
  for (const m of malformed) {
    lines.push(`  ledger line ${m.line} is not a usable entry: ${m.text}`);
  }
  return lines.join('\n');
}
