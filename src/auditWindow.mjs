/**
 * HOW MUCH OF THE BRANCH IS A COVERAGE REPORT NOT LOOKING AT?
 *
 * ═══ WHY THIS IS ITS OWN MODULE ═══
 *
 * Blind audit M3. This logic shipped as 79 top-level lines inside
 * `scripts/check-audit-coverage.mjs`, which the suite cannot import, so
 * nobody had watched any of it fail -- rule 10 verbatim. The complaint is
 * sharper than usual here because the SAME RANGE contains D-3, which was
 * that exact criticism of the daemon's attribution fence, fixed one commit
 * earlier by extracting it to `src/auditAttribution.mjs`. The move was
 * available, named, and freshly demonstrated, and I did not make it.
 *
 * ═══ AND THE UNWATCHED BRANCH WAS WRONG ═══
 *
 * Blind audit M2, MEASURED. The first version read:
 *
 *     const [base, tip] = range.includes('..') ? [...] : [range, 'HEAD'];
 *
 * For a BARE revision -- which `auditCoverage` accepts and
 * `scripts/enqueue-audit-job.mjs` documents passing -- the window is
 * everything reachable from that rev. But `base` was set to the rev
 * itself, so `older = count(base)` counted the window's OWN CONTENTS and
 * reported them as excluded:
 *
 *     check-audit-coverage.mjs HEAD
 *       A WINDOW, NOT THE BRANCH: 772 behind it.
 *     git rev-list --count HEAD  ->  772
 *
 * Every one of those 772 was inside the window it had just examined. And
 * `newer` was `HEAD ^HEAD` = 0, so for `HEAD~10` the ten commits genuinely
 * excluded went unmentioned while 762 examined ones were named.
 *
 * Which is the primitive the banner exists to remove -- a number answering
 * a different question than the one it appears to answer -- reintroduced
 * inside the fix for it. Third time in this range that a repair carried
 * the defect it was repairing.
 *
 * ═══ WHAT A BARE REV MEANS, STATED ONCE ═══
 *
 * `git rev-list <rev>` is everything reachable from <rev>. So:
 *
 *   `a..b`     window is b-not-a. Behind it = everything in `a`. Ahead of
 *              it = HEAD-not-b.
 *   `<rev>`    window is all of <rev>. Behind it = NOTHING, because the
 *              window already reaches the root. Ahead = HEAD-not-<rev>.
 *
 * Nothing is inferred by subtracting one count from another; each is asked
 * of git separately, and a count that cannot be taken is `null`, which
 * prints as UNKNOWN rather than being folded into its neighbour.
 */

/** Split a range into the base it starts after and the tip it ends at. */
export function splitRange(range) {
  const s = String(range ?? '').trim();
  /*
   * THREE-DOT IS A DIFFERENT QUESTION AND IS NOT ANSWERED HERE. `a...b` is
   * the symmetric difference, so neither "behind" nor "ahead" means what
   * the two-dot answer means. Reporting a two-dot answer for it would be
   * this module's own defect one more time, so it is named as unsupported
   * and the caller prints nothing rather than something wrong.
   */
  if (s.includes('...')) return { base: null, tip: null, kind: 'symmetric' };
  const i = s.indexOf('..');
  if (i === -1) {
    /* A bare rev: the window reaches the root, so there is nothing behind it. */
    return { base: null, tip: s || 'HEAD', kind: 'bare' };
  }
  const base = s.slice(0, i).trim();
  const tip = s.slice(i + 2).trim() || 'HEAD';
  /* `..b` means the implicit HEAD base; git reads an empty side as HEAD. */
  return { base: base || 'HEAD', tip, kind: 'two-dot' };
}

/**
 * How many commits lie outside the window, in each direction.
 *
 * @param range   the range string as the user typed it
 * @param count   (...revs) => number|null -- asks git, returns null if it could not
 * @returns {{behind:number|null, ahead:number|null, kind:string}}
 */
export function windowSpan(range, count) {
  const { base, tip, kind } = splitRange(range);
  if (kind === 'symmetric') return { behind: null, ahead: null, kind };

  /*
   * A BARE REV HAS NOTHING BEHIND IT, and that is a measured zero rather
   * than an unknown: the window is everything reachable from the rev, so
   * the statement "0 commits are behind this window" is true by the
   * definition of rev-list, not by a count that failed.
   */
  const behind = base === null ? 0 : count(base);
  const ahead = count('HEAD', `^${tip}`);
  return { behind, ahead, kind };
}

/**
 * The sentence a human reads, or null when there is nothing to say.
 *
 * SEPARATE FROM THE MEASUREMENT so the wording can be tested without git
 * and the counting can be tested without parsing English.
 */
export function describeWindow(span) {
  if (!span || span.kind === 'symmetric') return null;
  const parts = [];
  if (span.behind === null) parts.push('an UNKNOWN number behind it');
  else if (span.behind > 0) parts.push(`${span.behind} behind it`);
  if (span.ahead === null) parts.push('an UNKNOWN number ahead of it');
  else if (span.ahead > 0) parts.push(`${span.ahead} AHEAD of it, i.e. newer than anything examined`);
  if (parts.length === 0) return null;
  return `A WINDOW, NOT THE BRANCH: ${parts.join(', and ')}.`;
}
