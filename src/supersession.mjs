/**
 * A WRONG RECORD IS CORRECTED BY APPENDING, NEVER BY EDITING.
 *
 * WHAT THIS EXISTS BECAUSE OF. Four contracts covering src/laneRegistry.mjs
 * were all marked `withdrawn`, none carrying a head_sha, while the work they
 * described was integrated into master. The ledger therefore says nobody was
 * contracted to do something that shipped — and `withdrawn` is terminal in
 * TRANSITIONS, with no legal path back, so the ledger could not express its own
 * correction. The only ways out were hand-editing the store, or inventing a
 * retroactive contract for work that shipped uncovered. Both are fictions; one
 * is a fiction with a paper trail.
 *
 * SO THE FIX IS NOT A REOPEN PATH, DELIBERATELY. Letting a withdrawn contract
 * return to `assigned` would mean a cancelled contract can be resurrected, and
 * a resurrected contract is indistinguishable from one that was never
 * cancelled. That is laundering: the record would stop being evidence of what
 * happened and become evidence of what somebody last wanted it to say.
 *
 * Instead the mistake STAYS, and a correction is appended beside it pointing
 * back. Two questions then have two different answers, which is the point:
 *
 *   "what is true now?"        follow the chain to the authoritative record
 *   "what happened?"           read every record, mistakes included
 *
 * An audit that cannot see the original error is not an audit. The correction
 * is additional evidence, never a replacement for it.
 *
 * WHY IT IS PURE. Nothing here reads or writes the store. `applySupersession`
 * takes rows and returns NEW rows; the caller persists them. That keeps the
 * validation testable without a filesystem, and it means the refusals below are
 * decided before anything durable is touched — a correction that would be
 * rejected never reaches disk in a half-written state.
 */

/** A correction record is this kind; ordinary delegations are untouched. */
export const SUPERSESSION = 'supersession';

export const REQUIRED_FIELDS = [
  'supersedes',
  'reason',
  'replacement_task_id',
  'recorded_by_agent',
  'recorded_by_session',
  'recorded_at',
];

/**
 * Build a correction. Returns {ok, record} or {ok:false, errors}.
 *
 * `resolveSha` is injected and consulted ONLY when a replacement_head_sha is
 * supplied. A sha that does not resolve is refused rather than recorded: a
 * correction naming a commit nobody can find is a second wrong record, and the
 * whole purpose here is to stop the ledger misstating what shipped.
 */
export function createSupersession(input = {}, { resolveSha = null } = {}) {
  const errors = [];
  const rec = {
    kind: SUPERSESSION,
    id: input.id ?? null,
    supersedes: input.supersedes ?? null,
    reason: typeof input.reason === 'string' ? input.reason.trim() : '',
    replacement_task_id: input.replacement_task_id ?? null,
    replacement_head_sha: input.replacement_head_sha ?? null,
    recorded_by_agent: input.recorded_by_agent ?? null,
    recorded_by_session: input.recorded_by_session ?? null,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
  };

  if (!rec.supersedes) errors.push('supersedes is required');
  /*
   * A CORRECTION WITHOUT A REASON IS NOT A CORRECTION. It is the same
   * unexplained edit the append-only rule exists to prevent, one indirection
   * further away: a reader six weeks later can see that something changed and
   * still cannot tell whether it was a fix or a mistake.
   */
  if (!rec.reason) errors.push('reason is required — a correction with no stated reason is an unexplained edit');
  if (!rec.recorded_by_agent) errors.push('recorded_by_agent is required');
  if (!rec.recorded_by_session) errors.push('recorded_by_session is required');
  if (!rec.recorded_at) errors.push('recorded_at is required');

  // Self-supersession is a record that is its own authority: the chain walker
  // would loop, and the statement means nothing even if it did not.
  if (rec.supersedes && rec.id && rec.supersedes === rec.id) {
    errors.push(`"${rec.id}" cannot supersede itself`);
  }

  if (rec.replacement_head_sha != null) {
    if (typeof resolveSha !== 'function') {
      errors.push('replacement_head_sha was supplied but no resolver was given to verify it');
    } else {
      let resolved = false;
      try {
        resolved = resolveSha(rec.replacement_head_sha) === true;
      } catch {
        resolved = false;
      }
      if (!resolved) {
        errors.push(`replacement_head_sha "${String(rec.replacement_head_sha).slice(0, 12)}" does not resolve to a commit`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, record: rec };
}

const idOf = (r) => r?.id ?? null;
const isSupersession = (r) => r?.kind === SUPERSESSION;

/**
 * Append a correction to the ledger, or refuse.
 *
 * REFUSES rather than throws, so a caller can print every problem at once, and
 * so a rejected correction cannot half-apply.
 */
export function applySupersession(rows, input, { resolveSha = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const built = createSupersession(input, { resolveSha });
  if (!built.ok) return { ok: false, errors: built.errors, rows: list };

  const rec = built.record;
  const errors = [];

  /*
   * The target must EXIST. A correction pointing at nothing is a claim about a
   * record nobody can inspect — unfalsifiable, and worse than the error it
   * purports to fix.
   */
  const target = list.find((r) => idOf(r) === rec.supersedes);
  if (!target) errors.push(`unknown supersedes target "${rec.supersedes}"`);

  if (rec.id && list.some((r) => idOf(r) === rec.id)) {
    errors.push(`a record with id "${rec.id}" already exists`);
  }

  /*
   * A CYCLE IS REFUSED BEFORE IT IS WRITTEN, not detected afterwards. Walking a
   * cyclic chain either loops forever or stops arbitrarily, and "stops
   * arbitrarily" means the authoritative record depends on where the walk
   * happened to begin. The check is done against the ledger AS IT WOULD BE, so
   * a correction that would close a loop never lands.
   */
  if (!errors.length) {
    /*
     * Walk the ledger AS IT WOULD BE, starting at the target. The first
     * version seeded the walk with the NEW record's id, which made every
     * legitimate correction look cyclic: the chain arrives at the new record by
     * design, and a guard pre-loaded with it fires on the normal case. Every
     * happy-path test failed at once, which is the only reason it was caught
     * immediately rather than shipped as "corrections are refused sometimes".
     */
    const next = [...list, rec];
    const walk = followChain(next, rec.supersedes);
    if (!walk.ok && walk.reason === 'cycle') {
      errors.push(`superseding "${rec.supersedes}" would create a cycle: ${walk.seen.join(' -> ')}`);
    }
  }

  if (errors.length) return { ok: false, errors, rows: list };
  return { ok: true, errors: [], record: rec, rows: [...list, rec] };
}

/**
 * Walk from a record id to the record that currently speaks for it.
 *
 * Returns {ok, id, hops} or {ok:false, reason:'cycle'|'missing', seen}.
 */
export function followChain(rows, startId) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = [];
  const guard = new Set();
  let current = startId;

  for (;;) {
    if (guard.has(current)) return { ok: false, reason: 'cycle', seen: [...seen, current] };
    guard.add(current);
    seen.push(current);

    const row = list.find((r) => idOf(r) === current);
    if (!row) return { ok: false, reason: 'missing', seen };

    // Who, if anyone, supersedes THIS record?
    const successor = list.find((r) => isSupersession(r) && r.supersedes === current);
    if (!successor) return { ok: true, id: current, hops: seen.length - 1 };
    current = idOf(successor);
    if (current == null) return { ok: true, id: row.id, hops: seen.length - 1 };
  }
}

/**
 * What the ledger says is TRUE NOW about a record.
 *
 * Follows the chain. A record nobody has superseded speaks for itself; one that
 * has been corrected is answered by its correction, however many hops away.
 */
export function currentRecord(rows, id) {
  const list = Array.isArray(rows) ? rows : [];
  const walk = followChain(list, id);
  if (!walk.ok) return { ok: false, reason: walk.reason, seen: walk.seen };
  return { ok: true, record: list.find((r) => idOf(r) === walk.id), superseded: walk.id !== id };
}

/**
 * What HAPPENED to a record: the original, then every correction in order.
 *
 * This is the half an audit reads, and it deliberately still contains the
 * mistake. A history that shows only the corrected state cannot answer "was
 * this ever wrong, and for how long" — which is the only question worth asking
 * after something shipped uncovered.
 */
export function history(rows, id) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  let current = id;
  const guard = new Set();
  for (;;) {
    if (guard.has(current)) break;
    guard.add(current);
    const row = list.find((r) => idOf(r) === current);
    if (!row) break;
    out.push(row);
    const successor = list.find((r) => isSupersession(r) && r.supersedes === current);
    if (!successor) break;
    current = idOf(successor);
    if (current == null) break;
  }
  return out;
}

/** Every record that has been corrected, with what corrected it. */
export function supersededRecords(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .filter(isSupersession)
    .map((s) => ({ supersedes: s.supersedes, by: idOf(s), reason: s.reason, at: s.recorded_at }));
}

/**
 * Prove the ledger was appended to and not rewritten.
 *
 * Compares a previous snapshot against a later one: every earlier record must
 * still be present and byte-identical, and the later list may only have grown.
 * This is the assertion the whole module is for, and it is exported so a caller
 * can make it rather than trust that it holds.
 */
export function assertAppendOnly(before, after) {
  const prev = Array.isArray(before) ? before : [];
  const next = Array.isArray(after) ? after : [];
  const errors = [];

  if (next.length < prev.length) errors.push(`the ledger shrank: ${prev.length} -> ${next.length}`);

  for (let i = 0; i < prev.length; i++) {
    const a = JSON.stringify(prev[i]);
    const b = JSON.stringify(next[i]);
    if (a !== b) {
      errors.push(`record ${i} ("${idOf(prev[i])}") was EDITED IN PLACE, which this ledger forbids`);
    }
  }
  return { ok: errors.length === 0, errors };
}
