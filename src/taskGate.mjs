/**
 * TASK GATE — a checklist item turns green because EVIDENCE SAYS SO, never
 * because anybody set a boolean.
 *
 * ═══ WHY, MEASURED RATHER THAN ASSERTED ═══
 *
 * On 2026-09-18/19 three agents each declared their own work complete and all
 * three were wrong, every time caught only by a separate reader summoned by
 * hand:
 *
 *   - a launcher gate that could be satisfied by the launcher PRINTING the
 *     words instead of doing them. Fixed twice; both fixes were themselves
 *     hollow, and each was declared fixed in its own commit message.
 *   - a commit fence whose message said it closed the pathspec-less commit
 *     shape, defeated by dropping one character (`--includ`).
 *   - a gate matching its own subject's error message.
 *
 * 101 commits were pushed with 13 audited. The detector for that existed and
 * only warned. So the shape of the problem is not that people lie; it is that
 * SAYING a thing is done and the thing BEING done were the same act.
 *
 * This module separates them. `evaluateTask` derives every checklist state
 * from evidence records and nothing else. There is no input by which a caller
 * can mark an item VERIFIED.
 *
 * ═══ WHAT IT IS NOT ═══
 *
 * It is not a second task system. It holds no state, does no IO, and owns no
 * schema: task rows, leases, workspaces and verifier output already exist in
 * src/taskRecord.mjs, src/leases.mjs, src/workspaceManager.mjs and
 * src/verifier.mjs. This is the one function that says what a pile of
 * evidence MEANS, so that the UI, the CLI, the MCP tools, the Stop gate and
 * the scheduler cannot each answer it differently -- which is the failure
 * src/policy.mjs already carries a header about.
 *
 * It also cannot tell a real audit from a fabricated record. Like `granted_by`
 * in the override channel, the value is that ABSENCE is visible and
 * attribution is recorded, not that presence proves anything.
 */

/**
 * Checklist item states. Derived, never assigned.
 *
 * WAIVED is the only state a human can cause directly, it requires owner
 * authority, and an agent may not waive its own required item -- see
 * `evaluateTask`, which drops a waiver whose grantor is the worker.
 */
export const ITEM_STATES = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  WAIVED: 'WAIVED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
});

/**
 * Evidence kinds a checklist item can require.
 *
 * A CLOSED SET, because an unrecognised proof type must not silently satisfy
 * anything. Rule 19 cuts the other way too: an unknown type is not refused
 * outright at the task level, it simply cannot satisfy a requirement -- an
 * unrecognised name is inert, not an error, so adding a kind upstream cannot
 * take the board down.
 */
export const PROOF_TYPES = Object.freeze([
  'reproduction_result',
  'candidate_commit',
  'candidate_tree',
  'positive_test_result',
  'negative_test_result',
  'mutation_verifier_result',
  'blind_review_result',
  'caller_trace',
  'integration_result',
  'live_probe_result',
  'dependency_result',
  'security_gate_result',
  'owner_decision',
]);

/**
 * PROOF TYPES THAT THE MAKER MAY NOT PRODUCE.
 *
 * This is rule 20 made mechanical, and it is the entire reason this module is
 * worth writing. A blind review produced by the party that wrote the code is
 * not a blind review; it is the author agreeing with themselves, which is the
 * exact act that failed three times in one night here.
 *
 * `owner_decision` is included for a different reason: an agent recording its
 * own owner decision is the forged-grant shape the override channel already
 * refuses by convention. Here it is refused by arithmetic.
 */
export const MAKER_MAY_NOT_PRODUCE = Object.freeze(['blind_review_result', 'owner_decision']);

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * Is this evidence record ABOUT the work in front of us?
 *
 * EVIDENCE FROM THE WRONG ATTEMPT IS NOT WEAK EVIDENCE, IT IS NONE. A green
 * verifier run against attempt 7 says nothing about attempt 8, and a run
 * against a different candidate sha says nothing about this one. This project
 * has already shipped a coordinator that judged attempt 7 and accepted attempt
 * 8 -- "state is not an identity" -- so the match is on identity, not recency.
 *
 * candidate_sha is compared only when the ITEM's task declares one. Early
 * phases (reproduce) legitimately have no candidate yet, and demanding one
 * there would make the first checklist item unsatisfiable.
 */
export function evidenceMatches(record, task) {
  if (!record || !task) return false;
  if (str(record.task_id) !== str(task.task_id)) return false;
  if (Number(record.attempt) !== Number(task.attempt)) return false;

  const want = str(task.candidate_sha);
  const got = str(record.candidate_sha);
  if (want && got && want !== got) return false;
  return true;
}

/**
 * Evidence that may satisfy a requirement of this type, for this task.
 *
 * Applies, in order: identity (above), status, and the maker rule. Each
 * exclusion is reported rather than silently dropped, because "no evidence"
 * and "evidence you are not allowed to count" are different situations for
 * the person reading the board, and collapsing them is how a worker concludes
 * the system is broken and works around it.
 */
export function admissibleEvidence(type, task, evidence) {
  const admitted = [];
  const rejected = [];

  for (const record of Array.isArray(evidence) ? evidence : []) {
    if (str(record?.type) !== type) continue;

    if (!evidenceMatches(record, task)) {
      rejected.push({ evidence_id: record?.evidence_id ?? null, why: 'wrong task, attempt or candidate' });
      continue;
    }
    if (str(record.status) === 'failed') {
      rejected.push({ evidence_id: record.evidence_id ?? null, why: 'the proof itself reports failure' });
      continue;
    }
    if (str(record.status) !== 'passed') {
      rejected.push({ evidence_id: record.evidence_id ?? null, why: `status is ${record.status ?? 'absent'}, not passed` });
      continue;
    }
    /*
     * THE MAKER RULE. Compared on producer_session, not producer_role: a role
     * is a label the producer chooses, and the whole point is that the party
     * who did the work cannot also clear it. A session id is issued, not
     * claimed.
     */
    if (MAKER_MAY_NOT_PRODUCE.includes(type)
      && str(record.producer_session)
      && str(record.producer_session) === str(task.worker_session)) {
      rejected.push({
        evidence_id: record.evidence_id ?? null,
        why: `a ${type} produced by the worker that did the work is not independent (rule 20)`,
      });
      continue;
    }
    admitted.push(record);
  }
  return { admitted, rejected };
}

/**
 * A waiver counts only if the OWNER granted it and the worker did not.
 *
 * An agent that waives its own required item has done the same thing as an
 * agent that writes its own override grant and fills in `granted_by`.
 */
function usableWaiver(waivers, itemId, task) {
  for (const w of Array.isArray(waivers) ? waivers : []) {
    if (str(w?.item_id) !== itemId) continue;
    if (!str(w.reason)) continue;
    if (!str(w.granted_by)) continue;
    if (str(w.granted_by) === str(task?.worker_session)) continue;
    if (str(w.granted_by) === str(task?.worker_id)) continue;
    return w;
  }
  return null;
}

/**
 * WHAT A PILE OF EVIDENCE MEANS. The single checker, used by every surface.
 *
 * @param {object} args
 * @param {object} args.task      {task_id, attempt, candidate_sha, worker_id, worker_session, phase}
 * @param {object} args.template  {id, phases, requirements: {phase: [proof_type]}}
 * @param {Array}  args.evidence  evidence records
 * @param {Array}  args.waivers   owner waivers
 * @returns {{items: Array, byPhase: object, blocked: Array}}
 */
export function evaluateTask({ task, template, evidence = [], waivers = [] } = {}) {
  const items = [];
  const requirements = template?.requirements ?? {};

  for (const phase of template?.phases ?? []) {
    for (const type of requirements[phase] ?? []) {
      const itemId = `${phase}:${type}`;
      const { admitted, rejected } = admissibleEvidence(type, task, evidence);
      const waiver = usableWaiver(waivers, itemId, task);

      let state = ITEM_STATES.PENDING;
      if (admitted.length > 0) state = ITEM_STATES.VERIFIED;
      else if (waiver) state = ITEM_STATES.WAIVED;
      else if (rejected.some((r) => r.why === 'the proof itself reports failure')) state = ITEM_STATES.FAILED;
      else if (evidence.some((r) => str(r?.type) === type && str(r?.status) === 'running')) {
        state = ITEM_STATES.RUNNING;
      }

      items.push({
        item_id: itemId,
        phase,
        proof_type: type,
        required: true,
        state,
        evidence_ids: admitted.map((r) => r.evidence_id ?? null),
        rejected,
        satisfied_by: waiver ? `waiver by ${waiver.granted_by}` : (admitted[0]?.producer_session ?? null),
      });
    }
  }

  const byPhase = {};
  for (const phase of template?.phases ?? []) {
    const forPhase = items.filter((i) => i.phase === phase);
    byPhase[phase] = {
      total: forPhase.length,
      satisfied: forPhase.filter((i) => i.state === ITEM_STATES.VERIFIED || i.state === ITEM_STATES.WAIVED).length,
      complete: forPhase.length > 0 && forPhase.every(
        (i) => i.state === ITEM_STATES.VERIFIED || i.state === ITEM_STATES.WAIVED,
      ),
    };
  }

  return { items, byPhase, blocked: items.filter((i) => i.state === ITEM_STATES.FAILED) };
}

/**
 * May this task advance to `targetPhase`?
 *
 * EVERY REQUIRED ITEM OF EVERY PHASE UP TO AND INCLUDING THE TARGET. Checking
 * only the target's own items would let a task skip a phase by satisfying a
 * later one first, which is how "verified" ends up meaning "somebody ran the
 * easy check".
 *
 * Returns a REASON on refusal, always naming what is missing. A gate that
 * refuses without saying which half is open is the failure rule 15 describes,
 * and this project has already shipped advice that git itself rejects.
 */
export function canAdvance({ task, template, evidence = [], waivers = [], targetPhase } = {}) {
  const phases = template?.phases ?? [];
  const target = phases.indexOf(targetPhase);
  if (target === -1) {
    return { ok: false, why: `"${targetPhase}" is not a phase of template ${template?.id ?? '(none)'}` };
  }

  const { items } = evaluateTask({ task, template, evidence, waivers });
  const upTo = new Set(phases.slice(0, target + 1));
  const outstanding = items.filter(
    (i) => upTo.has(i.phase)
      && i.state !== ITEM_STATES.VERIFIED
      && i.state !== ITEM_STATES.WAIVED
      && i.state !== ITEM_STATES.NOT_APPLICABLE,
  );

  if (outstanding.length === 0) return { ok: true, why: `every required proof through ${targetPhase} is satisfied` };

  return {
    ok: false,
    why: `${outstanding.length} required proof(s) not satisfied: `
      + outstanding.map((i) => `${i.item_id} (${i.state})`).join(', '),
    outstanding,
  };
}
