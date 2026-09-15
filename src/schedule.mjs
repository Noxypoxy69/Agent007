/**
 * WHICH CONTRACTS CAN RUN AT THE SAME TIME, AND WHICH MUST NOT.
 *
 * It REPORTS AND REFUSES. It does not merge, rebase, reorder or reassign
 * anything, and that restraint is the design rather than a missing feature.
 * Every automatic resolution this could perform would be a decision taken on
 * behalf of a person who has more context than it does — and the failure this
 * whole system exists to stop was not "the wrong merge happened", it was
 * several agents acting confidently on a picture only one of them could see.
 * A scheduler that silently rebased a stale base would be that failure with
 * better tooling.
 *
 * FOUR ANSWERS, plus a refusal:
 *
 *   safe-parallel                  no path in common. Run them together.
 *   declarable-shared-overlap      they overlap only on paths BOTH declare
 *                                  shared. Allowed, but somebody must reconcile
 *                                  rather than overwrite.
 *   blocking-collision             they overlap on a path at least one claims
 *                                  exclusively. One waits.
 *   stale-base-needs-re-resolution the ground under this contract's own files
 *                                  moved after its base was fixed.
 *
 *   unresolvable-base              REFUSAL, and deliberately not folded into
 *                                  "stale". They call for different acts: a
 *                                  stale base is re-resolved, a dead one cannot
 *                                  be, and telling somebody to re-resolve a
 *                                  commit that does not exist is advice that
 *                                  cannot be followed. Silently resolving it to
 *                                  HEAD would be worse still — it would invent
 *                                  a base nobody agreed to and make every
 *                                  subsequent audit meaningless.
 *
 * STALENESS IS ABOUT YOUR OWN FILES, NOT ABOUT BEING BEHIND. Marking every
 * contract stale the moment master advances would flag all of them, all the
 * time, which is a signal nobody can act on and therefore a signal nobody
 * reads. A base is stale here only when the commits since it TOUCHED A PATH
 * THIS CONTRACT CLAIMS: that is precisely when re-resolving changes what the
 * work is built on.
 *
 * NO FEDERATION. Nothing here looks at agents, sessions or lanes. Two contracts
 * collide because of the files they claim, and that is true whoever holds them
 * — making the answer depend on identity resolution would mean a scheduling
 * question could not be answered while the registry was unconfigured, which is
 * exactly when you most want to know what is safe to run.
 */
import { matchesAny, globToRegExp } from './laneRegistry.mjs';

export const SAFE_PARALLEL = 'safe-parallel';
export const SHARED_OVERLAP = 'declarable-shared-overlap';
export const BLOCKING_COLLISION = 'blocking-collision';
export const STALE_BASE = 'stale-base-needs-re-resolution';
export const UNRESOLVABLE_BASE = 'unresolvable-base';

/** Severity order, worst first. A contract is reported at its worst finding. */
const SEVERITY = [UNRESOLVABLE_BASE, BLOCKING_COLLISION, STALE_BASE, SHARED_OVERLAP, SAFE_PARALLEL];
const worst = (a, b) => (SEVERITY.indexOf(a) <= SEVERITY.indexOf(b) ? a : b);

const list = (v) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

/**
 * Do two globs describe any file in common?
 *
 * CONSERVATIVE BY CONSTRUCTION, AND THE DIRECTION MATTERS. Deciding glob
 * intersection exactly is a harder problem than this needs, so where the answer
 * is unclear this says YES. A false collision costs somebody a wait and a
 * conversation; a missed collision costs two agents editing one file, which is
 * the thing that happened and the reason this module exists.
 *
 * The cases it decides exactly: identical globs, a literal path matched by the
 * other's pattern, and two patterns sharing a literal prefix before either
 * wildcard.
 */
export function globsIntersect(a, b) {
  const A = String(a);
  const B = String(b);
  if (A === B) return true;

  const wild = (s) => /[*?[\]]/.test(s);
  // A literal on one side is decided exactly by matching it against the other.
  if (!wild(A) && wild(B)) return matchesAny(A, [B]);
  if (wild(A) && !wild(B)) return matchesAny(B, [A]);
  if (!wild(A) && !wild(B)) return false;

  /*
   * Both are patterns. Compare the fixed text before the first wildcard: if one
   * prefix contains the other, the patterns can describe overlapping trees.
   * "src/lib/**" and "src/**" share "src/"; "src/a/**" and "src/b/**" do not.
   */
  const head = (s) => s.slice(0, s.search(/[*?[]/));
  const ha = head(A);
  const hb = head(B);
  if (ha.startsWith(hb) || hb.startsWith(ha)) return true;

  // Different fixed prefixes cannot meet, whatever follows.
  return false;
}

/** Every pair of globs from two lists that can describe the same file. */
function overlappingGlobs(left, right) {
  const hits = [];
  for (const a of left) for (const b of right) if (globsIntersect(a, b)) hits.push([a, b]);
  return hits;
}

/**
 * A path is SHARED between two contracts only when BOTH declare it shared.
 *
 * One-sided is not enough, and that asymmetry is the point. If A treats
 * package.json as shared and B claims it exclusively, B's expectation is that
 * nobody else is in it — honouring only A's declaration would let A edit a file
 * B believes it owns, which is the collision wearing a permission slip.
 */
function sharedOnBothSides(a, b, globA, globB) {
  return (
    (matchesAny(globA, a.shared_paths) || a.shared_paths.some((s) => globsIntersect(s, globA))) &&
    (matchesAny(globB, b.shared_paths) || b.shared_paths.some((s) => globsIntersect(s, globB)))
  );
}

const normalise = (d) => ({
  id: d?.id ?? null,
  base_sha: d?.base_sha ?? d?.base ?? null,
  allowed_paths: list(d?.allowed_paths ?? d?.allowed),
  shared_paths: list(d?.shared_paths ?? d?.shared),
});

/**
 * How two contracts relate, on paths alone.
 *
 * Returns the classification and the specific globs responsible, because "these
 * two collide" is not actionable and "both claim scripts/check-*.mjs" is.
 */
export function classifyPair(rawA, rawB) {
  const a = normalise(rawA);
  const b = normalise(rawB);

  const hits = overlappingGlobs(a.allowed_paths, b.allowed_paths);
  if (hits.length === 0) return { classification: SAFE_PARALLEL, paths: [] };

  const blocking = hits.filter(([ga, gb]) => !sharedOnBothSides(a, b, ga, gb));
  if (blocking.length) {
    return { classification: BLOCKING_COLLISION, paths: blocking.map(([ga, gb]) => ({ a: ga, b: gb })) };
  }
  return { classification: SHARED_OVERLAP, paths: hits.map(([ga, gb]) => ({ a: ga, b: gb })) };
}

/**
 * Classify a whole set of concurrently runnable contracts.
 *
 * `baseInfo` is supplied rather than looked up, so this stays pure and so a
 * test can describe a repository state that would be tedious to build for real.
 * Each entry is either:
 *
 *   { resolved: false }                        the base does not exist
 *   { resolved: true, changedPaths: [...] }    files touched since that base
 *
 * A base with NO entry at all is treated as unresolvable, not as fresh. An
 * absent fact is not a reassuring one, and defaulting to "fine" here would mean
 * a typo in a sha reads as a clean bill of health.
 */
export function scheduleSafety({ delegations = [], baseInfo = {} } = {}) {
  const ds = delegations.map(normalise);

  return ds.map((d) => {
    const reasons = [];
    let classification = SAFE_PARALLEL;
    const collidesWith = [];

    const info = d.base_sha == null ? undefined : baseInfo[d.base_sha];
    if (!info || info.resolved !== true) {
      classification = UNRESOLVABLE_BASE;
      reasons.push(
        d.base_sha == null
          ? 'names no base commit'
          : `base ${String(d.base_sha).slice(0, 12)} does not resolve — REFUSED rather than defaulted to HEAD`,
      );
    } else {
      /*
       * Staleness is judged against the paths this contract claims, including
       * the ones it shares: a shared file moving underneath you is exactly the
       * case where you need to reconcile rather than assume.
       */
      const mine = [...d.allowed_paths, ...d.shared_paths];
      const touched = (info.changedPaths ?? []).filter((p) => matchesAny(p, mine));
      if (touched.length) {
        classification = worst(classification, STALE_BASE);
        reasons.push(`base moved under ${touched.length} of its own path(s): ${touched.slice(0, 5).join(', ')}`);
      }
    }

    for (const other of ds) {
      if (other.id === d.id) continue;
      const pair = classifyPair(d, other);
      if (pair.classification === SAFE_PARALLEL) continue;
      classification = worst(classification, pair.classification);
      collidesWith.push({ id: other.id, classification: pair.classification, paths: pair.paths });
      reasons.push(
        `${pair.classification === BLOCKING_COLLISION ? 'collides with' : 'shares paths with'} ${other.id}: ${pair.paths
          .map((p) => (p.a === p.b ? p.a : `${p.a} ~ ${p.b}`))
          .slice(0, 3)
          .join(', ')}`,
      );
    }

    return {
      id: d.id,
      classification,
      runnable: classification === SAFE_PARALLEL || classification === SHARED_OVERLAP,
      reasons,
      collidesWith,
    };
  });
}

/** Render a plan for a terminal. Wording is never asserted on; classification is. */
export function formatSchedule(rows) {
  return rows
    .map((r) => {
      const head = `  ${r.classification.padEnd(30)} ${r.id}`;
      return r.reasons.length ? `${head}\n${r.reasons.map((x) => `      ${x}`).join('\n')}` : head;
    })
    .join('\n');
}

export { globToRegExp };
