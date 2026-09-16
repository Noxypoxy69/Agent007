/**
 * WHICH COMMITS ARE ACTUALLY THE DELEGATE'S.
 *
 * THE BUG THIS EXISTS FOR, WITH THE REAL CASE. audit-delegation diffs from the
 * CONTRACT BASE. d-orphan-modules recorded base fa9d5dc; the delegate branched
 * from master 8a4704d because the recorded base was five commits stale by the
 * time the work started. The audit therefore diffed fa9d5dc..7599d27 and
 * reported 14 changed files with three violations, including
 * bin/agentbridge.mjs as forbidden.
 *
 * Twelve of those files were the INTEGRATOR'S OWN COMMITS. The delegate's
 * commit touches two. The tool converted correct work into a recorded boundary
 * breach, and it will do that to every delegate whose branch point postdates
 * the recorded base — which is every delegate, every time a base goes stale.
 *
 * That is worse than a missed violation. A missed violation leaves a gap; this
 * manufactures evidence against somebody who did exactly what was asked, and it
 * does so in the permanent record that exists to establish who did what.
 *
 * THE RANGE IS THE BRANCH POINT, NOT THE RECORDED BASE. The delegate's work is
 * everything from where their branch left the integration line. That is the
 * merge-base of head and the integration tip, and it is a FACT about the graph
 * rather than a claim in a contract that may have gone stale while nobody
 * looked.
 *
 * AND A STALE BASE IS REPORTED, NOT ABSORBED. Computing the right range quietly
 * would fix the false violations and hide the reason they happened — the
 * recorded base no longer describes the work, which is a real defect in the
 * contract and the thing that let this go unnoticed. So the verdict carries
 * `stale_base` and REFUSES to return a clean pass while it is true.
 *
 * That is deliberately a third option rather than either of the two obvious
 * ones. Refusing outright means a delegate's correct work cannot be audited at
 * all and the ledger learns nothing; auditing silently against the wider range
 * is what slandered the work in the first place. This gives no false violations
 * AND no silent pass.
 *
 * PURE. Every git fact arrives as an argument — no spawning, no repository
 * needed — so the whole decision table is testable in a millisecond and the
 * awkward cases can be described rather than constructed.
 */

export const RANGE_OK = 'range-ok';
export const STALE_BASE = 'stale-base';
export const UNRELATED_HISTORY = 'unrelated-history';
export const NO_HEAD = 'no-head';

/**
 * Work out the range that actually belongs to the delegate.
 *
 * @param {object} input
 * @param {string} input.recordedBase   the base the contract records
 * @param {string} input.head           the delegate's returned commit
 * @param {string} input.integrationTip the branch work is integrated onto
 * @param {object} git                  injected facts, no I/O performed here
 * @param {(a:string,b:string)=>boolean} git.isAncestor
 * @param {(a:string,b:string)=>string|null} git.mergeBase
 */
export function resolveRange({ recordedBase, head, integrationTip }, git = {}) {
  const { isAncestor = () => false, mergeBase = () => null } = git;

  if (!head) {
    return { ok: false, status: NO_HEAD, reasons: ['no head commit: there is nothing to audit'] };
  }

  /*
   * A head that does not descend from the integration line cannot be audited
   * against it at all. Falling back to the recorded base here would produce a
   * confident diff across unrelated histories — every file in both trees,
   * reported as the delegate's work.
   */
  const branchPoint = mergeBase(head, integrationTip);
  if (!branchPoint) {
    return {
      ok: false,
      status: UNRELATED_HISTORY,
      reasons: [
        `head ${short(head)} shares no history with the integration tip ${short(integrationTip)} — ` +
          'it cannot be audited against it, and diffing anyway would report both trees as changes',
      ],
    };
  }

  const stale = Boolean(recordedBase) && branchPoint !== recordedBase;

  /*
   * A recorded base that is not even an ancestor of head is a different and
   * worse fault than a stale one: the contract names a commit the work does not
   * descend from, so nothing about it constrains this branch.
   */
  const baseUnrelated = Boolean(recordedBase) && !isAncestor(recordedBase, head);

  return {
    ok: !stale && !baseUnrelated,
    status: stale || baseUnrelated ? STALE_BASE : RANGE_OK,
    effectiveBase: branchPoint,
    recordedBase: recordedBase ?? null,
    stale_base: stale || baseUnrelated,
    reasons: reasonsFor({ stale, baseUnrelated, recordedBase, branchPoint, head }),
  };
}

const short = (s) => String(s ?? '').slice(0, 12);

function reasonsFor({ stale, baseUnrelated, recordedBase, branchPoint, head }) {
  const out = [];
  if (baseUnrelated) {
    out.push(
      `recorded base ${short(recordedBase)} is NOT an ancestor of head ${short(head)} — ` +
        'the contract names a commit this work does not descend from',
    );
  } else if (stale) {
    out.push(
      `recorded base ${short(recordedBase)} is stale: the branch actually left the integration ` +
        `line at ${short(branchPoint)}. Auditing from the recorded base would attribute every ` +
        'commit in between to the delegate. Re-record the base, or accept this range explicitly.',
    );
  }
  return out;
}

/**
 * Audit a delegate's changed files against a contract, with the range resolved.
 *
 * `changedPathsBetween(a, b)` is injected for the same reason everything else
 * is: so the interesting cases are describable rather than requiring a repo in
 * a particular shape.
 *
 * The verdict deliberately separates three things a reader conflates otherwise:
 *
 *   violations      files outside the contract, in the CORRECT range
 *   misattributed   files the old behaviour would have blamed the delegate for
 *   stale_base      the contract's own defect, surfaced rather than absorbed
 */
export function auditWithRange(delegation, { recordedBase, head, integrationTip }, git = {}) {
  const { changedPathsBetween = () => [] } = git;
  const range = resolveRange({ recordedBase: recordedBase ?? delegation?.base_sha, head, integrationTip }, git);

  if (range.status === NO_HEAD || range.status === UNRELATED_HISTORY) {
    return { ok: false, status: range.status, reasons: range.reasons, changedPaths: [], violations: [] };
  }

  const changedPaths = changedPathsBetween(range.effectiveBase, head);
  const violations = classifyPaths(delegation, changedPaths);

  /*
   * What the old behaviour would have said, computed so the difference is
   * visible rather than asserted. This is the number that proves the fix: on
   * the real case it is twelve files the delegate never touched.
   */
  const wouldHaveBlamed =
    range.recordedBase && range.recordedBase !== range.effectiveBase
      ? changedPathsBetween(range.recordedBase, head).filter((p) => !changedPaths.includes(p))
      : [];

  return {
    ok: range.ok && violations.length === 0,
    status: range.stale_base ? STALE_BASE : violations.length ? 'violations' : RANGE_OK,
    effectiveBase: range.effectiveBase,
    recordedBase: range.recordedBase,
    stale_base: range.stale_base,
    changedPaths,
    violations,
    misattributed: wouldHaveBlamed,
    reasons: [
      ...range.reasons,
      ...(wouldHaveBlamed.length
        ? [
            `auditing from the recorded base would have blamed ${wouldHaveBlamed.length} file(s) ` +
              `the delegate never touched: ${wouldHaveBlamed.slice(0, 4).join(', ')}`,
          ]
        : []),
    ],
  };
}

/** Contract classification, unchanged in spirit: forbidden beats outside-allowed. */
function classifyPaths(d, paths) {
  const allowed = list(d?.allowed_paths ?? d?.allowed);
  const forbidden = list(d?.forbidden_paths ?? d?.forbidden);
  const shared = list(d?.shared_paths ?? d?.shared);
  const out = [];
  for (const p of paths) {
    if (matchAny(p, forbidden)) out.push({ path: p, kind: 'forbidden' });
    else if (allowed.length && !matchAny(p, allowed) && !matchAny(p, shared)) {
      out.push({ path: p, kind: 'outside-allowed' });
    }
  }
  return out;
}

const list = (v) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

/**
 * Minimal glob: `**` spans separators, `*` does not. Kept local so this stays pure.
 *
 * The sentinel is NUL, chosen because it cannot occur in a path or a glob. I
 * briefly "fixed" this into a single pass, having misread the NUL as a space in
 * terminal output and convinced myself any space-bearing glob was being
 * rewritten. It was not: the original is correct, and the replacement I wrote
 * broke three tests. Recorded because the mistake is instructive -- I read a
 * rendering rather than the bytes, and acted on it.
 */
function matchAny(p, globs) {
  return globs.some((g) => {
    const rx = new RegExp(
      '^' +
        String(g)
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, ' ')
          .replace(/\*/g, '[^/]*')
          .replace(/ /g, '.*') +
        '$',
    );
    return rx.test(p);
  });
}

/** Render for a terminal. Wording is never asserted on; status is. */
export function formatAudit(v) {
  const lines = [`audit: ${v.status}  (${v.changedPaths.length} file(s) in range)`];
  if (v.recordedBase && v.recordedBase !== v.effectiveBase) {
    lines.push(`  recorded base ${short(v.recordedBase)} -> effective ${short(v.effectiveBase)}`);
  }
  for (const r of v.reasons) lines.push(`  ${r}`);
  for (const x of v.violations) lines.push(`  VIOLATION  ${x.path}  (${x.kind})`);
  return lines.join('\n');
}
