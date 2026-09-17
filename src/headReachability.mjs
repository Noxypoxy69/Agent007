/*
 * IS THE COMMIT A RETURN CLAIMS SOMETHING ANYBODY ELSE CAN SEE?
 *
 * On 2026-09-17 at 01:12 the pg_cron dispatcher assigned t-wire-gate-scripts
 * with no human in the path, and four seconds later the row was `returned` with
 * returned_head_sha d8c1e0ee and returned_notes saying "worker: committed
 * d8c1e0e". The commit is in no remote ref. The two npm scripts it claims are
 * on no branch. Nothing in the return path noticed, because nothing in the
 * return path asks.
 *
 * A COMMIT IS A LOCAL ACT. `git commit` succeeds on a laptop with no network
 * and no remote, and the sha it prints is perfectly real -- to that laptop. The
 * task row then carries a 40-hex string that looks exactly like evidence and is
 * not, because the one property that makes it evidence is that a SECOND machine
 * can fetch it. The reviewer contract says the reviewer reads machine evidence
 * rather than the agent's prose; an unreachable sha is prose wearing a hash.
 *
 * EXISTENCE IS A PROXY FOR REACHABILITY AND THIS MODULE REFUSES TO ACCEPT IT.
 * `git cat-file -t <sha>` answering "commit" means the object is in the clone
 * you are standing in -- which is trivially true on the machine that authored
 * it, and true on a reviewer's machine that happened to fetch it once from a
 * branch since deleted. The question worth asking is whether the commit is
 * reachable from a REMOTE ref, and that is a different git command with a
 * different answer. Asking the easy one is how this check would have passed on
 * the very row that motivated it.
 *
 * WHY IT IS PURE, AND WHY IT TAKES A PROBE RESULT RATHER THAN RUNNING GIT.
 * `probeReturnedHead` next door does the shelling out; everything that DECIDES
 * is here so the suite can construct cases it cannot reproduce -- a fetch that
 * fails, a commit that exists locally but rides no remote branch, a worker that
 * returned its own base. The container this was written in has no network at
 * all, so a design that could only be tested against a live remote could not
 * have been watched failing here even once.
 *
 * THE UNKNOWN CASE REFUSES. A probe that could not run is not a probe that
 * passed. This is the whole "a skip is not a pass" rule, and it matters more
 * here than usual: the most likely reason a reachability probe fails is that
 * the network is down, which is also the state in which an unpushed commit is
 * indistinguishable from a pushed one.
 */

/**
 * What a returned head can be. Every value except REACHABLE is a refusal; they
 * are separate values rather than one because the work that follows each is
 * different, and a reviewer that cannot tell "you did not push" from "you did
 * not commit" gives the worker a useless finding.
 */
export const HEAD_REACHABILITY = Object.freeze({
  /** Fetchable by somebody else. The only value a review may proceed from. */
  REACHABLE: 'reachable',
  /** Well-formed, and in no remote ref. The t-wire-gate-scripts case. */
  UNPUSHED: 'unpushed',
  /** The return names no commit at all. */
  ABSENT: 'absent',
  /** Not a 40-hex sha, so it cannot be a commit this repo will ever hold. */
  MALFORMED: 'malformed',
  /** Identical to the task's base: the attempt committed nothing. */
  UNMOVED: 'unmoved',
  /** The probe did not complete. Refuses, and says it is refusing blind. */
  UNKNOWN: 'unknown',
});

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Decide what a returned head sha is worth.
 *
 * `task` supplies returned_head_sha and base_sha. `probe` is the result of
 * asking git, shaped { ran, existsLocally, remoteRefs, error }:
 *
 *   ran           did the probe complete at all. false means UNKNOWN.
 *   existsLocally is the object in this clone. Recorded, never sufficient.
 *   remoteRefs    the remote refs the commit is reachable FROM. The answer.
 *   error         why the probe could not run, carried into the reason.
 *
 * `remoteRefs` being an empty array and being absent are deliberately not the
 * same: [] is "asked, and no remote ref contains it", undefined is "nobody
 * asked", and collapsing them would let a caller that forgot the field get a
 * clean bill of health. The second is UNKNOWN.
 */
export function classifyReturnedHead({ task, probe = null } = {}) {
  if (task === null || typeof task !== 'object') {
    throw new Error('classifyReturnedHead needs the task row it is judging');
  }

  const head = typeof task.returned_head_sha === 'string' ? task.returned_head_sha.trim() : '';
  const base = typeof task.base_sha === 'string' ? task.base_sha.trim() : '';

  if (head === '') {
    return verdict(HEAD_REACHABILITY.ABSENT,
      'the return names no head sha, so there is nothing for a reviewer to fetch. '
      + 'returned_notes may describe work; a review reads commits, not notes.');
  }
  if (!FULL_SHA.test(head)) {
    return verdict(HEAD_REACHABILITY.MALFORMED,
      `returned_head_sha ${JSON.stringify(head)} is not a 40-character commit sha. `
      + 'An abbreviation is not enough: it is ambiguous by construction and the review lease '
      + 'would be spent discovering that.');
  }
  /*
   * UNMOVED IS CHECKED BEFORE THE PROBE, because it needs no probe and because
   * the base is reachable by definition -- it is what the worker was told to
   * start from. A probe would therefore answer REACHABLE and hide the fact that
   * the attempt produced nothing at all.
   */
  if (base !== '' && head === base) {
    return verdict(HEAD_REACHABILITY.UNMOVED,
      `the returned head is the base commit ${base.slice(0, 12)} itself, so the attempt `
      + 'committed nothing. This is reachable and it is still not evidence of work.');
  }

  if (probe === null || typeof probe !== 'object' || probe.ran !== true) {
    return verdict(HEAD_REACHABILITY.UNKNOWN,
      'the reachability probe did not run, so this is a refusal made blind rather than a pass. '
      + (probe?.error ? `The probe reported: ${probe.error}. ` : '')
      + 'A probe that could not run is not a probe that passed, and the usual reason it cannot '
      + 'run is exactly the state in which an unpushed commit looks like a pushed one.',
      { existsLocally: probe?.existsLocally ?? null });
  }
  if (!Array.isArray(probe.remoteRefs)) {
    return verdict(HEAD_REACHABILITY.UNKNOWN,
      'the probe returned no remoteRefs list, so nothing asked which remote refs contain this '
      + 'commit. An empty list means asked-and-none; a missing list means nobody asked, and '
      + 'those must not read the same.',
      { existsLocally: probe.existsLocally ?? null });
  }

  if (probe.remoteRefs.length === 0) {
    return verdict(HEAD_REACHABILITY.UNPUSHED,
      `commit ${head.slice(0, 12)} is reachable from no remote ref`
      + (probe.existsLocally
        ? ', though it does exist in this clone -- which proves only that this machine has it, '
          + 'not that a reviewer could get it'
        : ' and is not in this clone either')
      + '. A commit is a local act; a review needs one a second machine can fetch.',
      { existsLocally: probe.existsLocally ?? false });
  }

  return verdict(HEAD_REACHABILITY.REACHABLE,
    `commit ${head.slice(0, 12)} is reachable from ${probe.remoteRefs.length} remote ref(s): `
    + `${probe.remoteRefs.slice(0, 5).join(', ')}`,
    { existsLocally: probe.existsLocally ?? null, remoteRefs: Object.freeze([...probe.remoteRefs]) });
}

function verdict(reachability, reason, extra = {}) {
  return Object.freeze({
    reachability,
    reviewable: reachability === HEAD_REACHABILITY.REACHABLE,
    reason,
    ...extra,
  });
}

/**
 * May a review proceed on this task at all?
 *
 * Separate from `classifyReturnedHead` because the classification is worth
 * recording whatever the answer, while this is the one-bit question the runner
 * asks before it spends a lease. It deliberately returns the reason too: a
 * refusal a worker cannot act on is a refusal that gets ignored.
 */
export function canReviewReturn({ task, probe = null } = {}) {
  const found = classifyReturnedHead({ task, probe });
  return Object.freeze({
    ok: found.reviewable,
    reachability: found.reachability,
    reason: found.reason,
  });
}
