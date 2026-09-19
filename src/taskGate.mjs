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


/**
 * A trimmed non-empty string, or null.
 *
 * NULL IS A POISON VALUE HERE, NOT A VALUE. A blind audit found identity
 * checks written as `str(a) !== str(b)`, which PASSES when both sides are
 * non-strings: task_id 1 and evidence task_id 2 both str() to null, so
 * `null !== null` is false and evidence for task 2 turned task 1 green. Every
 * comparison below therefore goes through `sameId`, which refuses when either
 * side is absent rather than calling two absences equal.
 */
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** A number, or null -- never NaN, so a missing attempt cannot equal itself. */
const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * Identity comparison that FAILS CLOSED on an absent side.
 *
 * Case-folded, because `str()` trims but does not fold, and one capital
 * letter was enough to defeat the maker rule ('Sess-Worker' vs 'sess-worker').
 */
const sameId = (a, b) => {
  const x = str(a);
  const y = str(b);
  return x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
};

/** True when BOTH sides are present and differ. Absence is never "differs". */
const differ = (a, b) => {
  const x = str(a);
  const y = str(b);
  return x !== null && y !== null && x.toLowerCase() !== y.toLowerCase();
};

/**
 * Is this evidence record ABOUT the work in front of us?
 *
 * EVIDENCE FROM THE WRONG ATTEMPT IS NOT WEAK EVIDENCE, IT IS NONE. A green
 * verifier run against attempt 7 says nothing about attempt 8. This project
 * has already shipped a coordinator that judged attempt 7 and accepted
 * attempt 8 -- "state is not an identity" -- so the match is on identity.
 *
 * EVERY FIELD FAILS CLOSED. The first version compared candidate shas only
 * when BOTH sides carried one, so the rule was evaded by DELETING the field
 * rather than lying about it; and it compared ids through str(), so two
 * non-strings matched. Both found by blind audit. A task that declares a
 * candidate now requires the evidence to name the same one; a task with no
 * attempt admits nothing, rather than admitting everything through NaN.
 */
export function evidenceMatches(record, task) {
  if (!record || typeof record !== 'object' || !task || typeof task !== 'object') return false;
  if (!sameId(record.task_id, task.task_id)) return false;

  const wantAttempt = num(task.attempt);
  const gotAttempt = num(record.attempt);
  if (wantAttempt === null || gotAttempt === null || wantAttempt !== gotAttempt) return false;

  /*
   * The candidate is compared only when the TASK declares one -- an early
   * phase legitimately has no candidate yet, and demanding one there would
   * make the first item of every task unsatisfiable. But once the task HAS a
   * candidate, evidence must name it; omitting the field is not a pass.
   */
  const want = str(task.candidate_sha);
  if (want !== null && !sameId(record.candidate_sha, want)) return false;

  return true;
}

/**
 * Evidence that may satisfy a requirement of this type, for this task.
 *
 * Each exclusion is REPORTED rather than silently dropped: "no evidence" and
 * "evidence you are not allowed to count" are different situations for the
 * person reading the board, and collapsing them is how a worker concludes the
 * system is broken and works around it.
 */
export function admissibleEvidence(type, task, evidence) {
  const admitted = [];
  const rejected = [];

  /*
   * UNKNOWN PROOF TYPES CANNOT SATISFY ANYTHING. PROOF_TYPES was declared a
   * closed set and then enforced nowhere -- a blind audit found grep returned
   * only its own definition. So a template requiring `vibes_check` was
   * satisfied by a self-produced `vibes_check`, and, sharper, a requirement
   * named `blind_review` instead of `blind_review_result` slipped past
   * MAKER_MAY_NOT_PRODUCE entirely: one missing suffix turned rule 20 off.
   */
  if (!PROOF_TYPES.includes(type)) {
    return {
      admitted: [],
      rejected: [{ evidence_id: null, why: `"${type}" is not a recognised proof type, so nothing can satisfy it` }],
    };
  }

  for (const record of Array.isArray(evidence) ? evidence : []) {
    if (!record || typeof record !== 'object') continue;

    /*
     * SNAPSHOT THE FIELDS ONCE. The first version read producer_session three
     * separate times, so a getter could return an auditor for the checks and
     * the worker for the attribution -- a VERIFIED blind review whose own
     * receipt named the worker. Reading once removes the question.
     */
    const rType = str(record.type);
    const rStatus = str(record.status);
    const rProducer = str(record.producer_session);
    const rId = record.evidence_id ?? null;

    if (!sameId(rType, type)) continue;

    if (!evidenceMatches(record, task)) {
      rejected.push({ evidence_id: rId, why: 'wrong task, attempt or candidate' });
      continue;
    }
    if (rStatus === 'failed') {
      rejected.push({ evidence_id: rId, why: 'the proof itself reports failure' });
      continue;
    }
    if (rStatus !== 'passed') {
      rejected.push({ evidence_id: rId, why: `status is ${record.status ?? 'absent'}, not passed` });
      continue;
    }

    /*
     * THE MAKER RULE, FAIL-CLOSED. rule 20, mechanical.
     *
     * The first version read `MAKER_MAY_NOT_PRODUCE.includes(type) &&
     * str(record.producer_session) && ...`, so an ABSENT producer
     * short-circuited the whole check and the worker's own blind review was
     * admitted -- with `rejected: []`, so the board showed a clean green
     * review of the author's own work and no trace that anything had been
     * skipped. It failed open from the other side too, when the task carried
     * no worker_session.
     *
     * An independent review is a POSITIVE claim: we must be able to see that
     * two different parties were involved. If either side is missing we
     * cannot see that, so it does not count.
     *
     * Compared on SESSION, not role: a role is a label the producer chooses,
     * a session id is issued.
     */
    if (MAKER_MAY_NOT_PRODUCE.includes(type)) {
      const worker = str(task?.worker_session);
      if (rProducer === null || worker === null) {
        rejected.push({
          evidence_id: rId,
          why: `a ${type} must name a producer_session AND the task must name its worker, `
            + 'or independence cannot be established (rule 20)',
        });
        continue;
      }
      if (!differ(rProducer, worker)) {
        rejected.push({
          evidence_id: rId,
          why: `a ${type} produced by the worker that did the work is not independent (rule 20)`,
        });
        continue;
      }
    }

    admitted.push({ ...record, type: rType, status: rStatus, producer_session: rProducer, evidence_id: rId });
  }
  return { admitted, rejected };
}

/**
 * A waiver counts only if the OWNER granted it, the worker did not, and it
 * was granted for THIS work.
 *
 * WAIVERS ARE IDENTITY-BOUND, WHICH THEY WERE NOT. A blind audit found the
 * first version checked only item_id, a reason and a grantor -- never
 * task_id, attempt or candidate. Item ids are generic
 * (`blind-review:blind_review_result` is the same string on every task), so
 * ONE waiver replayed across the entire repository, forever, and WAIVED
 * counts as satisfied. The module made evidence rigorously identity-bound and
 * left the other route to the same green state wide open.
 *
 * The self-waiver check is case-folded and fails closed, for the same reason
 * as the maker rule: exact equality was defeated by one capital letter, and
 * by a task carrying no worker id at all.
 */
function usableWaiver(waivers, itemId, task) {
  for (const w of Array.isArray(waivers) ? waivers : []) {
    if (!w || typeof w !== 'object') continue;
    if (!sameId(w.item_id, itemId)) continue;
    if (!str(w.reason)) continue;

    const grantor = str(w.granted_by);
    if (grantor === null) continue;

    /* Bound to this task, this attempt, and this candidate when one exists. */
    if (!sameId(w.task_id, task?.task_id)) continue;
    const wantAttempt = num(task?.attempt);
    const gotAttempt = num(w.attempt);
    if (wantAttempt === null || gotAttempt === null || wantAttempt !== gotAttempt) continue;
    const candidate = str(task?.candidate_sha);
    if (candidate !== null && !sameId(w.candidate_sha, candidate)) continue;

    /* The worker may not waive its own item, under either of its names. */
    if (!differ(grantor, task?.worker_session) && str(task?.worker_session) !== null) continue;
    if (!differ(grantor, task?.worker_id) && str(task?.worker_id) !== null) continue;

    return w;
  }
  return null;
}

/** The requirements declared for a phase, ignoring anything inherited. */
function requirementsFor(template, phase) {
  const reqs = template?.requirements;
  if (!reqs || typeof reqs !== 'object') return [];
  /*
   * OWN PROPERTIES ONLY. Without this, a phase named `constructor` or
   * `toString` picks up Object.prototype members and `?? []` does not catch a
   * function -- measured as a TypeError by blind audit. A throw inside a
   * caller's try/catch disables the control silently.
   */
  if (!Object.prototype.hasOwnProperty.call(reqs, phase)) return [];
  const value = reqs[phase];
  return Array.isArray(value) ? value.filter((t) => typeof t === 'string') : [];
}

/**
 * The declared phases, de-duplicated to their LAST position.
 *
 * KEEPING THE FIRST OCCURRENCE DOES NOT FIX THE BUG, which I discovered by
 * writing the test before the fix. canAdvance used indexOf, so for
 * ['verify','reproduce','verify'] targeting 'verify' the window collapsed to
 * the first entry and 'reproduce' fell outside it -- the task advanced with
 * an earlier proof still PENDING. De-duplicating to the FIRST position
 * reproduces exactly that.
 *
 * A repeated phase name is most safely read as "this phase completes at its
 * LAST position", which puts everything between the two occurrences inside
 * the window. That fails closed: the worst case is demanding a proof that a
 * strange template did not intend, which is visible and arguable, rather than
 * silently skipping one.
 */
/** Every declared phase name, in declared order, DUPLICATES KEPT. */
function declaredPhases(template) {
  const out = [];
  for (const p of Array.isArray(template?.phases) ? template.phases : []) {
    const name = str(p);
    if (name !== null) out.push(name);
  }
  return out;
}

/*
 * THE DISTINCT PHASES, IN DECLARED ORDER, FIRST OCCURRENCE WINS.
 *
 * THIS FUNCTION USED TO DE-DUPLICATE TO THE *LAST* POSITION AND THAT WAS A
 * REGRESSION I SHIPPED. It was written to close a real hole -- indexOf()
 * returns the FIRST index, so a template whose target phase also appeared
 * earlier collapsed the advancement window and let a task advance with later
 * proofs still PENDING. Moving duplicates to the end fixed that direction and
 * OPENED THE MIRROR IMAGE, because it REORDERS the list.
 *
 * Found by blind audit, on the commit message's own fixture:
 *
 *     phases: ['verify', 'reproduce', 'verify']
 *     canAdvance(..., targetPhase: 'reproduce')
 *       parent  -> ok:false, "verify:positive_test_result (PENDING)"
 *       mine    -> ok:true,  "every required proof through reproduce is satisfied"
 *
 * De-duplicating to last turns the list into ['reproduce', 'verify'], so
 * 'reproduce' becomes index 0 and the window excludes the 'verify' that was
 * DECLARED BEFORE IT. My commit message claimed this "fails closed: the worst
 * case is demanding a proof a strange template did not intend". It did the
 * opposite: it silently skipped one. My new test only exercised the direction
 * I had fixed, so it was green over the hole it created.
 *
 * The real mistake was making ONE function serve two different questions.
 * Ordering for the board and the boundary of an advancement window are not
 * the same thing, and squeezing both out of a single de-duplicated list means
 * every fix for one breaks the other. They are separate now:
 *
 *   phasesOf        distinct names in DECLARED order -- what the board shows.
 *                   First occurrence wins, so a duplicate cannot reorder the
 *                   display either, which the audit also flagged.
 *   canAdvance      uses declaredPhases() and lastIndexOf, so the window is
 *                   every phase at or before the LAST mention of the target.
 *                   That is strictly more demanding than either version and
 *                   is fail-closed in both directions.
 */
function phasesOf(template) {
  const out = [];
  for (const name of declaredPhases(template)) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * WHAT A PILE OF EVIDENCE MEANS. The single checker, used by every surface.
 *
 * @returns {{items: Array, byPhase: object, blocked: Array}}
 */
export function evaluateTask({ task, template, evidence = [], waivers = [] } = {}) {
  const items = [];
  const list = Array.isArray(evidence) ? evidence : [];
  const phases = phasesOf(template);

  for (const phase of phases) {
    for (const type of requirementsFor(template, phase)) {
      const itemId = `${phase}:${type}`;
      const { admitted, rejected } = admissibleEvidence(type, task, list);
      const waiver = usableWaiver(waivers, itemId, task);
      const failed = rejected.some((r) => r.why === 'the proof itself reports failure');

      /*
       * A RECORDED FAILURE OUTRANKS A LATER PASS ON THE SAME ARTEFACT.
       *
       * The first version checked `admitted.length > 0` first, so evidence
       * [failed, passed] for the SAME task, attempt and candidate came out
       * VERIFIED with `blocked` empty -- re-run-until-green against an
       * unchanged candidate, invisible on the board. Nothing about the work
       * changed between those two runs, so the failure is still true. A new
       * candidate carries a new sha and is a different question.
       */
      let state = ITEM_STATES.PENDING;
      if (failed) state = ITEM_STATES.FAILED;
      else if (admitted.length > 0) state = ITEM_STATES.VERIFIED;
      else if (waiver) state = ITEM_STATES.WAIVED;
      else if (list.some((r) => sameId(r?.type, type) && str(r?.status) === 'running' && evidenceMatches(r, task))) {
        /* RUNNING is scoped to THIS task -- it used to scan raw evidence, so a
         * proof belonging to another task read as in-flight on this one. */
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
  for (const phase of phases) {
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
 * EVERY REQUIRED ITEM OF EVERY PHASE UP TO AND INCLUDING THE TARGET.
 *
 * TWO WAYS THIS WAS WRONG, both found by blind audit. It used
 * `phases.indexOf(target)`, which returns the FIRST index -- so a template
 * whose target phase also appeared earlier collapsed the window and a task
 * advanced with earlier proofs still PENDING. Phases are now de-duplicated,
 * so a name resolves to one position. And it answered `outstanding.length
 * === 0`, which is vacuously true for a template that requires nothing --
 * while evaluateTask deliberately guarded that exact case. Two functions in
 * one file answering the same question differently is the failure this module
 * exists to prevent.
 */
export function canAdvance({ task, template, evidence = [], waivers = [], targetPhase } = {}) {
  /*
   * THE WINDOW IS COMPUTED FROM THE DECLARED LIST, NOT THE DE-DUPLICATED ONE,
   * AND FROM THE *LAST* MENTION OF THE TARGET.
   *
   * Both halves matter and each one is a hole that has actually shipped here:
   *
   *   first mention  a template naming the target early collapses the window
   *                  and the task advances with later proofs PENDING.
   *   reordered list ...and de-duplicating to fix that moved the target
   *                  ahead of phases declared BEFORE it, so those dropped out
   *                  of the window instead. See phasesOf.
   *
   * Taking every phase at or before the LAST occurrence in the raw declared
   * order is more demanding than both, and cannot be gamed by repeating a
   * name: repeating it can only ever ENLARGE the window.
   */
  const declared = declaredPhases(template);
  const target = declared.lastIndexOf(str(targetPhase));
  if (target === -1) {
    return { ok: false, why: `"${targetPhase}" is not a phase of template ${template?.id ?? '(none)'}` };
  }

  const { items } = evaluateTask({ task, template, evidence, waivers });
  const upTo = new Set(declared.slice(0, target + 1));
  const inScope = items.filter((i) => upTo.has(i.phase));

  if (inScope.length === 0) {
    return {
      ok: false,
      why: `template ${template?.id ?? '(none)'} requires no proof through ${targetPhase}; `
        + 'nothing was verified, so nothing is established',
    };
  }

  const outstanding = inScope.filter(
    (i) => i.state !== ITEM_STATES.VERIFIED
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
