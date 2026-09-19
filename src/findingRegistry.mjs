/**
 * LAYER 0, STEP E: A DEFECT THAT EXISTS ONLY IN PROSE DOES NOT EXIST.
 *
 * The Layer 0 spec is blunt about it (§9): do not rely on a commit message, on
 * chat history, on review prose, or on human memory. This repository does all
 * four. `docs/audit-ledger.jsonl` records WHICH COMMITS WERE AUDITED and folds
 * every defect into a free-text `note`, so a finding is a sentence somebody has
 * to read, remember and act on -- and the record of whether it was ever fixed is
 * another sentence, edited by hand, in the same field.
 *
 * Measured on this repository, 2026-09-19: four separate audits recorded twelve
 * findings that way. Some notes end "OPEN", some end "fixed in c9e3d68", some
 * end neither. Nothing can answer "which findings are still open" without a
 * person reading forty-odd lines of English, and nothing at all connects a
 * finding to the commit that claims to close it. That is §9 verbatim and it is
 * why the second-lap audit keeps paying: the first lap's findings were never
 * durable enough to check against.
 *
 * SO THIS IS THE REGISTRY, AND IT IS NOT A SECOND TRUTH. §30 says do not add
 * storage where an existing authoritative record can be projected, and §35 says
 * do not build parallel systems. `auditLedger` answers a different question --
 * was this commit audited at all -- and has no place to put a defect. Findings
 * are one of the four concepts §30 names as genuinely new.
 *
 * ═══ WHAT THIS REFUSES, AND WHY EACH REFUSAL IS THE POINT ═══
 *
 * A finding with no CANDIDATE IDENTITY. §9.1: a finding must be bound to the
 * exact candidate where it was observed. Without base/candidate/tree shas,
 * "still broken?" is unanswerable, because nobody knows what was being looked
 * at. This is the same binding `src/auditPin.mjs` captures, and the same reason.
 *
 * A finding with no REPRODUCTION. A defect nobody can re-run is an opinion. The
 * whole failure mode this repository is built around is a check that concluded
 * something without measuring it, and a finding is a check.
 *
 * A finding with an UNKNOWN failure class. §16 ships a versioned class list and
 * §23 makes an unknown proof type inadmissible. An unrecognised class admitted
 * "to be safe" is how a registry stops being groupable, which kills §15's
 * regression injection before it starts.
 *
 * A finding whose PRODUCER IS ABSENT. §24: the maker may not satisfy
 * blind_review_result. A finding with no reviewer session attached cannot be
 * checked for that, and unknown provenance is not independent provenance.
 *
 * ═══ AND THE ONE THAT MATTERS MOST ═══
 *
 * NOBODY CLOSES THEIR OWN FINDING. §24 says the maker may not satisfy its own
 * blind review; the same logic applies with more force to the verdict that a
 * defect is gone. `transition` refuses VERIFIED_FIXED or REJECTED from the
 * session that raised the finding OR the session that wrote the repair. Rule 20
 * in CLAUDE.md is the same sentence: the party that wrote a fix cannot clear it.
 *
 * PURE. No filesystem, no clock, no git -- the caller measures and passes
 * readings in. That is CLAUDE.md rule 10, and it is also the only way the
 * interesting cases are testable at all: no test can make a real auditor try to
 * close its own finding, but any test can hand this two session ids.
 */

import { createHash } from 'node:crypto';

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** A 40-hex object name, or null. Short shas are refused rather than padded. */
const sha = (v) => {
  const s = str(v);
  return s && /^[0-9a-f]{40}$/i.test(s) ? s.toLowerCase() : null;
};

const list = (v) => {
  if (!Array.isArray(v)) return null;
  const out = v.map(str).filter(Boolean);
  return out.length ? out : null;
};

/**
 * §16, the initial failure classes. A VERSIONED MANIFEST, as the spec asks for,
 * rather than a free-text field: a class nobody can group on cannot drive §15's
 * automatic regression injection, and a registry whose classes are typed per
 * finding degenerates into prose with extra steps.
 *
 * An unknown class is REFUSED. That is deliberately the annoying direction: the
 * alternative admits anything and the list stops meaning something, and this
 * file's whole argument is that an unenforced record is not a record.
 */
export const FAILURE_CLASSES = Object.freeze({
  F001: 'PRIVILEGE_REMAINS_MINTABLE',
  F002: 'DENY_BECOMES_ALLOW',
  F003: 'HOLLOW_MUTATION',
  F004: 'MIGRATION_RESTORES_REVOKED_ACCESS',
  F005: 'DEPTH_3_PLUS_FAILURE',
  F006: 'UNDER_BLOCK_TO_OVER_BLOCK',
  F007: 'OVER_BLOCK_TO_UNDER_BLOCK',
  F008: 'COMMENT_OVERCLAIMS_CONTROL',
  F009: 'COMMIT_MESSAGE_OVERCLAIMS_PROOF',
  F010: 'MOVING_CANDIDATE_AUDIT',
  F011: 'STALE_ATTEMPT_WRITE',
  F012: 'SHARED_WORKSPACE_OR_INDEX',
  F013: 'SEMANTIC_COLLISION_DIFFERENT_FILES',
  F014: 'SELF_REVIEW_COUNTS_AS_BLIND',
  F015: 'WAIVER_REPLAY',
  F016: 'UNKNOWN_PROOF_TYPE_SATISFIES_GATE',
  F017: 'WRONG_ATTEMPT_EVIDENCE_REUSE',
  F018: 'WRONG_CANDIDATE_EVIDENCE_REUSE',
  F019: 'BLIND_REVIEW_GUIDED_BY_MAKER',
  F020: 'REPAIR_TEST_ALREADY_GREEN_BEFORE_FIX',
});

export const FAILURE_CLASS_VERSION = '2026-09-19-v1';

/** §8.1 finding status. */
export const FINDING = Object.freeze({
  OPEN: 'OPEN',
  BOUND_TO_REPAIR: 'BOUND_TO_REPAIR',
  RETESTING: 'RETESTING',
  VERIFIED_FIXED: 'VERIFIED_FIXED',
  REJECTED: 'REJECTED',
  SUPERSEDED: 'SUPERSEDED',
});

/** §8.1 severity, ordered so a report can rank without inventing a scale. */
export const SEVERITY = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/**
 * WHICH TRANSITIONS EXIST. Everything absent from here is refused.
 *
 * VERIFIED_FIXED is reachable only through RETESTING, and that is the whole
 * shape of §11: a repair is not verified because a fixer says so or because a
 * test is green, but because the finding was re-examined against a new
 * candidate. Allowing BOUND_TO_REPAIR -> VERIFIED_FIXED would let a commit close
 * a finding, which is exactly what the prose ledger already does badly.
 */
const LEGAL = Object.freeze({
  OPEN: ['BOUND_TO_REPAIR', 'REJECTED', 'SUPERSEDED'],
  BOUND_TO_REPAIR: ['RETESTING', 'OPEN', 'SUPERSEDED'],
  RETESTING: ['VERIFIED_FIXED', 'OPEN', 'SUPERSEDED'],
  VERIFIED_FIXED: [],
  REJECTED: [],
  SUPERSEDED: [],
});

/**
 * Verdicts that decide a finding's fate, and so demand an independent party.
 *
 * SUPERSEDED WAS MISSING, AND IT WAS THE ONE THAT NEEDED NOTHING AT ALL.
 * Found by blind audit, measured end to end through the shipped CLI in two
 * commands: `finding-move --to SUPERSEDED` with NO `--by` exited 0, the finding
 * went terminal, and `openFindings` stopped counting it. The reporter and the
 * bound fixer could each do it too. So the module's central claim -- nobody
 * retires their own finding -- was false for a third of the terminal states,
 * and false in the cheapest direction: the one requiring no identity.
 *
 * DERIVED FROM `LEGAL`, NOT TYPED AGAIN. Every terminal state demands
 * independence, because "terminal" IS the property that matters -- a finding
 * that can no longer move is a finding that has been retired, whatever the name
 * on the transition. A terminal state added later is covered on the day it is
 * added, which is the whole of rule 7 and the reason this list stopped being a
 * list.
 */
const NEEDS_INDEPENDENCE = Object.freeze(
  Object.keys(LEGAL).filter((s) => LEGAL[s].length === 0),
);

/**
 * A DERIVED IDENTITY, NOT A COUNTER.
 *
 * Two properties have to hold at once and a counter gives neither. Capturing the
 * same defect twice from one audit of one candidate must be IDEMPOTENT, or a
 * re-run of an auditor doubles the backlog. And the same failure appearing on a
 * DIFFERENT candidate must be a NEW finding (§9.2: do not silently merge
 * evidence from different candidates), because the two were observed against
 * different code and only one of them may still be true.
 *
 * Hashing candidate_sha, candidate_tree_sha, failure_class and the title gives
 * exactly that, and it needs no shared sequence -- which matters, because
 * several sessions raise findings on one machine with no coordinator between
 * them. Rule 21: derive it, do not allocate it.
 */
export function findingId({ candidate_sha, candidate_tree_sha, failure_class, title }) {
  const digest = createHash('sha256')
    .update(`${candidate_sha} ${candidate_tree_sha} ${failure_class} ${title}`)
    .digest('hex');
  return `F-${digest.slice(0, 12)}`;
}

/**
 * Record a defect a blind audit observed.
 *
 * REFUSES AN INCOMPLETE FINDING rather than storing a partial one. A registry
 * that accepts whatever it was handed answers "is this still broken?" with a
 * shrug, and a shrug that looks like a record is worse than no record.
 *
 * @returns {{ok:true, finding:object} | {ok:false, errors:string[]}}
 */
export function createFinding(input = {}, { now = null } = {}) {
  const {
    task_id, audit_id, base_sha, candidate_sha, candidate_tree_sha,
    failure_class, title, reproduction, expected_behavior, observed_behavior,
    affected_paths, severity, confidence,
    created_by_reviewer_session, linked_to_prior_family,
  } = input;

  const errors = [];
  const f = {
    finding_id: null,
    task_id: str(task_id),
    audit_id: str(audit_id),
    base_sha: sha(base_sha),
    candidate_sha: sha(candidate_sha),
    candidate_tree_sha: sha(candidate_tree_sha),
    failure_class: str(failure_class),
    failure_class_version: FAILURE_CLASS_VERSION,
    title: str(title),
    reproduction: str(reproduction),
    expected_behavior: str(expected_behavior),
    observed_behavior: str(observed_behavior),
    affected_paths: list(affected_paths),
    severity: str(severity)?.toUpperCase() ?? null,
    confidence: str(confidence)?.toUpperCase() ?? null,
    created_by_reviewer_session: str(created_by_reviewer_session),
    created_at: str(now),
    status: FINDING.OPEN,
    linked_to_prior_family: str(linked_to_prior_family),
    repair: null,
    history: [],
  };

  if (!f.audit_id) errors.push('audit_id is required: a finding nobody can trace to an audit is prose');
  if (!f.candidate_sha) errors.push('candidate_sha is required and must be a full 40-hex sha');
  if (!f.candidate_tree_sha) errors.push('candidate_tree_sha is required and must be a full 40-hex sha');
  if (!f.title) errors.push('title is required');

  /*
   * THE FOUR THAT MAKE IT A FINDING RATHER THAN AN OPINION. Each is argued in
   * the header; none is decoration, and dropping any one of them turns this into
   * the free-text note it replaces.
   */
  if (!f.reproduction) {
    errors.push('reproduction is required: a defect nobody can re-run cannot be confirmed fixed, '
      + 'and an unrepeatable claim is the failure class this repository exists to police');
  }
  if (!f.observed_behavior) errors.push('observed_behavior is required: what actually happened');
  if (!f.expected_behavior) errors.push('expected_behavior is required: without it nobody can tell what "fixed" means');
  if (!f.created_by_reviewer_session) {
    errors.push('created_by_reviewer_session is required: independence cannot be checked against an unknown party');
  }

  if (!f.failure_class || !Object.prototype.hasOwnProperty.call(FAILURE_CLASSES, f.failure_class)) {
    errors.push(`failure_class must be one of the §16 classes (${Object.keys(FAILURE_CLASSES).join(', ')}); `
      + `got ${JSON.stringify(failure_class ?? null)}. An unrecognised class cannot be grouped, `
      + 'and a class nobody can group on cannot drive regression injection');
  }
  if (!f.severity || !SEVERITY.includes(f.severity)) {
    errors.push(`severity must be one of ${SEVERITY.join(', ')}`);
  }

  /*
   * base_sha is OPTIONAL and that is deliberate rather than lax: an audit of a
   * working tree or of a single file legitimately has no base. What is NOT
   * optional is the candidate, because without it the finding names nothing.
   * A supplied-but-malformed base is an error, never a silent drop.
   */
  if (base_sha !== undefined && base_sha !== null && f.base_sha === null) {
    errors.push('base_sha was supplied but is not a full 40-hex sha');
  }

  if (errors.length) return { ok: false, errors };

  f.finding_id = findingId(f);
  return { ok: true, finding: f };
}

/**
 * §10.1: bind a finding to the repair task that is supposed to close it.
 *
 * THE FIXER DOES NOT GET TO DECIDE THIS, which is the spec's own point and the
 * reason the binding lives here rather than in a commit message. §10.3: a fixer
 * that finds something new raises a NEW finding; it does not quietly widen this
 * one. Nothing here accepts a free-text description, so there is nowhere for a
 * widened scope to hide.
 */
export function bindRepair(finding, repair = {}, { now = null, by = null } = {}) {
  const { task_id, attempt, lease_token, fixer_session } = repair;
  const errors = [];

  const bound = {
    task_id: str(task_id),
    attempt: Number.isInteger(attempt) ? attempt : null,
    lease_token: str(lease_token),
    fixer_session: str(fixer_session),
    bound_at: str(now),
  };

  /*
   * EVERY FIXER THAT HAS EVER TOUCHED THIS FINDING, NOT JUST THE CURRENT ONE.
   *
   * THE LAUNDERING, MEASURED BY BLIND AUDIT THROUGH THE SHIPPED CLI IN FOUR
   * COMMANDS, ALL BY ONE ACTOR, ALL EXIT 0:
   *
   *   finding-move --to OPEN                                   (no --by demanded)
   *   finding-bind --fixer nobody-in-particular --by fixer-bob
   *   finding-move --to RETESTING --by fixer-bob
   *   finding-move --to VERIFIED_FIXED --by fixer-bob          -> VERIFIED_FIXED
   *
   * The direct path was refused correctly. But `transition` compared against the
   * CURRENT `repair.fixer_session`, and `bindRepair` takes that value from a flag
   * the same actor types -- so the fixer rebound the finding naming somebody
   * else, and the check then had nothing to match. A guard that reads a field
   * the guarded party writes is not a guard; that is the proxy rule, and this
   * one was a proxy for "who did the work" that the worker filled in.
   *
   * The history is APPEND-ONLY and deduplicated, and `transition` checks the
   * whole set. Re-binding can add a name; it can never remove one.
   */
  const priorFixers = Array.isArray(finding?.repair_history) ? finding.repair_history : [];
  const history = [...new Set([...priorFixers.map(str).filter(Boolean), bound.fixer_session])];

  if (!bound.task_id) errors.push('a repair binding needs the repair task_id');
  if (bound.attempt === null) errors.push('a repair binding needs the attempt: state is not an identity');
  if (!bound.lease_token) {
    errors.push('a repair binding needs the lease_token: a fixer with no current lease is not the owner, '
      + 'and binding to it records a repair nobody is authorised to be making');
  }
  /*
   * REQUIRED, AND THE VERSION WITHOUT IT WAS A HOLLOW GATE I CAUGHT IN MY OWN
   * DRAFT BEFORE THE TEST WAS WRITTEN.
   *
   * `transition` refuses VERIFIED_FIXED from `finding.repair.fixer_session` --
   * CLAUDE.md rule 20, the party that wrote a fix cannot clear it. But nothing
   * WROTE that field, so the comparison was against undefined and no fixer was
   * ever refused. That is hollow gate #3 from CLAUDE.md word for word: "a
   * reviewer-lease guard refused correctly; it read a column nothing ever
   * wrote." Optional would have reproduced it for any caller that forgot.
   */
  if (!bound.fixer_session) {
    errors.push('a repair binding needs the fixer_session: without it the rule-20 check in transition() '
      + 'compares against undefined, and the fixer can clear its own repair');
  }
  if (errors.length) return { ok: false, errors };

  const moved = transition(finding, FINDING.BOUND_TO_REPAIR, { by, now });
  if (!moved.ok) return moved;

  return { ok: true, finding: { ...moved.finding, repair: bound, repair_history: history } };
}

/**
 * Move a finding, or refuse and say why.
 *
 * TWO SEPARATE REFUSALS, and collapsing them would lose the one that matters.
 * An illegal transition is a state-machine error. A transition by the wrong
 * PARTY is an independence violation, and it is the one a well-meaning agent
 * actually commits -- the fixer that genuinely believes it is done.
 */
export function transition(finding, next, { by = null, now = null } = {}) {
  if (!finding || typeof finding !== 'object') {
    return { ok: false, errors: ['there is no finding to move'] };
  }
  const to = str(next);
  const actor = str(by);
  const from = str(finding.status);

  if (!to || !Object.prototype.hasOwnProperty.call(LEGAL, to)) {
    return { ok: false, errors: [`${JSON.stringify(next ?? null)} is not a finding status`] };
  }
  if (!from || !Object.prototype.hasOwnProperty.call(LEGAL, from)) {
    return { ok: false, errors: [`the finding carries no recognisable status (${JSON.stringify(finding.status ?? null)})`] };
  }
  if (!LEGAL[from].includes(to)) {
    return {
      ok: false,
      errors: [LEGAL[from].length === 0
        ? `${from} is terminal; a finding does not reopen, a new one is raised (§9.2)`
        : `${from} -> ${to} is not a legal move; from ${from} the finding may go to ${LEGAL[from].join(', ')}`],
    };
  }

  /*
   * ═══ NOBODY CLOSES THEIR OWN FINDING ═══
   *
   * §24 and CLAUDE.md rule 20 say the same thing twice: the party that wrote a
   * fix cannot clear it, because the confident commit message and the green run
   * come from the same reasoning that produced the bug. Two parties are barred
   * here and the second is the one that gets forgotten -- the REPORTER. An
   * auditor that can mark its own finding REJECTED can retract anything it
   * decides it was wrong about, with no second reader, which is how a finding
   * disappears without ever being answered.
   *
   * AND AN UNNAMED ACTOR IS REFUSED, not waved through. "Who did this?" going
   * unanswered is indistinguishable from the wrong party doing it, and a control
   * that fails open on a missing field is the one this repository has already
   * shipped and fixed (a null session_id adopting a shared baseline).
   */
  if (NEEDS_INDEPENDENCE.includes(to)) {
    if (!actor) {
      return { ok: false, errors: [`${to} needs a named actor: independence cannot be checked against nobody`] };
    }
    /*
     * FOLDED, BECAUSE `code-a` AND `Code-A` ARE ONE AGENT AND WERE TWO PARTIES.
     *
     * Measured by blind audit through the shipped CLI: `--by code-a` was refused
     * as the reporter and `--by Code-A` exited 0 on the same finding. `str`
     * trims and does not fold, so the whole independence rule was defeated by a
     * capital letter. CLAUDE.md hollow gate #8 word for word -- a hostile
     * property tested with three lower-case strings -- and the same
     * case-variant bypass this repository has already shipped for
     * `.Claude/settings.json`.
     *
     * Folded on BOTH sides at the point of comparison rather than at capture, so
     * the record keeps the identity as it was actually given.
     */
    const same = (a, b) => {
      const x = str(a);
      const y = str(b);
      return x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
    };

    if (same(actor, finding.created_by_reviewer_session)) {
      return {
        ok: false,
        errors: [`${actor} raised this finding and may not also declare it ${to}. `
          + 'The party that reported a defect cannot be the party that retires it (§24)'],
      };
    }
    /*
     * EVERY FIXER EVER BOUND, not merely the current one -- see bindRepair for
     * the four-command laundering this closes. The current binding is included
     * explicitly so a record written before repair_history existed is still
     * checked rather than silently exempt.
     */
    const fixers = [
      ...(Array.isArray(finding.repair_history) ? finding.repair_history : []),
      finding.repair?.fixer_session,
    ];
    if (fixers.some((f) => same(actor, f))) {
      return {
        ok: false,
        errors: [`${actor} wrote a repair for this finding and may not also declare it ${to}. `
          + 'The party that wrote a fix cannot clear it (CLAUDE.md rule 20)'],
      };
    }
  }

  return {
    ok: true,
    finding: {
      ...finding,
      status: to,
      history: [...(finding.history ?? []), { from, to, by: actor, at: str(now) }],
    },
  };
}

/**
 * §9.2: the same failure class seen again is a NEW finding, never a merge.
 *
 * "We already know about that" is how a defect on a second candidate gets closed
 * by evidence from the first. The two were observed against different code and
 * only one of them may still be true, so they get separate ids and an explicit
 * family link -- which keeps them groupable for §15 without making either
 * answerable by the other's proof.
 *
 * Returns the finding UNCHANGED when the prior is on the same candidate: that is
 * not a duplicate, it is the same observation, and `findingId` already makes
 * re-capture idempotent.
 */
export function linkToFamily(finding, prior) {
  if (!finding || !prior) return finding;
  if (finding.candidate_sha === prior.candidate_sha
      && finding.candidate_tree_sha === prior.candidate_tree_sha) {
    return finding;
  }
  return { ...finding, linked_to_prior_family: prior.linked_to_prior_family ?? prior.finding_id };
}

/**
 * §12: THE REPAIR RECORD. The fixer supplies code; Agent007 supplies the record.
 *
 * WHY THIS IS NOT A FORM THE FIXER FILLS IN. §10 opens by saying fixers are bad
 * at paperwork, and the conclusion it draws is the important one: the fixer does
 * not get to decide whether its commit is associated with the finding. Every
 * field below except the verdicts is MEASURED from git or carried from the
 * lease, so there is nothing for a fixer to forget and nothing for it to shade.
 *
 * PURE, like everything else here: the caller measures and passes the readings
 * in. That is rule 10, and it is also what makes the interesting case testable --
 * no test can make a real fixer misreport its own diff, but any test can hand
 * this a reading that disagrees with the finding.
 *
 * REFUSES A RECORD THAT DOES NOT MATCH ITS FINDING, rather than recording a
 * mismatch. §23 makes evidence inadmissible for the wrong task, the wrong
 * attempt or the wrong candidate, and a repair record IS evidence -- it is the
 * thing a reader consults to decide whether a defect is gone.
 *
 * @param {object} finding   a finding already bound to a repair
 * @param {object} measured  { candidate_sha, candidate_tree_sha, files_changed,
 *                             before, after }
 * @returns {{ok:true, record:object} | {ok:false, errors:string[]}}
 */
export function repairRecord(finding, measured = {}) {
  const errors = [];
  if (!finding || typeof finding !== 'object') {
    return { ok: false, errors: ['there is no finding to build a record for'] };
  }
  if (!finding.repair) {
    errors.push('this finding is not bound to a repair; bind it first (§10.1), '
      + 'because a record with no task and no lease attributes the work to nobody');
  }

  const {
    candidate_sha, candidate_tree_sha, files_changed, before, after,
  } = measured;

  const record = {
    finding_id: str(finding.finding_id),
    failure_class: str(finding.failure_class),
    task_id: finding.repair ? str(finding.repair.task_id) : null,
    attempt: finding.repair ? finding.repair.attempt : null,
    fixer_session: finding.repair ? str(finding.repair.fixer_session) : null,
    lease_token: finding.repair ? str(finding.repair.lease_token) : null,

    base_sha: sha(finding.candidate_sha),          // what the defect was OBSERVED on
    candidate_sha: sha(candidate_sha),             // what claims to repair it
    candidate_tree_sha: sha(candidate_tree_sha),
    files_changed: list(files_changed) ?? [],

    reproduction: str(finding.reproduction),
    before_fix_result: str(before),
    after_fix_result: str(after),

    blind_audit_verdict: null,                     // filled by an audit, never here
    status: finding.status,
  };

  if (!record.candidate_sha) errors.push('candidate_sha is required and must be a full 40-hex sha');
  if (!record.candidate_tree_sha) errors.push('candidate_tree_sha is required and must be a full 40-hex sha');

  /*
   * ═══ THE ASSERTION §11.2 EXISTS FOR, AND IT IS THE WHOLE POINT ═══
   *
   * "Do not accept a test that was already green before the repair as proof of
   * repair." A fixture that passed at the base proves the repair did nothing --
   * either the defect was never reproduced, or the test does not reach it. Both
   * are the hollow gate this repository is built around, and both look exactly
   * like success in a report that only records the AFTER.
   *
   * So BEFORE is required and must be RED, and AFTER is required and must be
   * GREEN. Recording a repair with a green before is refused rather than stored
   * with a caveat nobody reads.
   */
  if (record.before_fix_result === null) {
    errors.push('before_fix_result is required: without it nobody can tell the repair did anything');
  } else if (!/^red$/i.test(record.before_fix_result)) {
    errors.push(`before_fix_result is ${JSON.stringify(record.before_fix_result)}, and a repair `
      + 'whose fixture was not RED at the base proves nothing -- either the defect was never '
      + 'reproduced or the fixture does not reach it (§11.2)');
  }
  if (record.after_fix_result === null) {
    errors.push('after_fix_result is required');
  } else if (!/^green$/i.test(record.after_fix_result)) {
    errors.push(`after_fix_result is ${JSON.stringify(record.after_fix_result)}: `
      + 'this is not a repair, and recording it as one would be the report disagreeing with the run');
  }

  /*
   * A REPAIR THAT CHANGED NOTHING IS NOT A REPAIR. An empty file list with a
   * green after is the shape a mutation harness produces when the mutation never
   * applied -- CLAUDE.md rule 2, the most common way to get a wrong green.
   */
  if (record.files_changed.length === 0) {
    errors.push('files_changed is empty: a repair that touched no file did not happen, '
      + 'and a green result against an unchanged tree is the mutation-never-applied shape');
  }

  /*
   * THE CANDIDATE MUST HAVE MOVED. If the repair's candidate equals the one the
   * finding was observed on, the record is claiming a defect was fixed by the
   * commit that has it.
   */
  if (record.candidate_sha && record.base_sha && record.candidate_sha === record.base_sha) {
    errors.push('the repair candidate is the same commit the defect was observed on');
  }

  return errors.length ? { ok: false, errors } : { ok: true, record };
}

/**
 * §15: WHICH REGRESSIONS A CANDIDATE MUST SATISFY, BECAUSE OF WHAT BROKE HERE
 * BEFORE.
 *
 * "The fixer does not need to remember prior bugs. Agent007 remembers
 * mechanically." That sentence is the whole of Layer 0's last step, and the
 * reason it is last is that it needs everything above it: a finding bound to a
 * candidate, a reproduction that can be re-run, and a verified repair to prove
 * the family is real rather than suspected.
 *
 * ═══ ONLY VERIFIED FINDINGS INJECT ═══
 *
 * An OPEN finding is a claim; a VERIFIED_FIXED one has been through a repair and
 * an independent audit. Injecting from claims would make every unconfirmed
 * suspicion a permanent tax on everyone who touches the file, and a checklist
 * that demands work nobody can justify is one people route around -- rule 16,
 * and the reason the escalation gate blocks at the push rather than the commit.
 *
 * A REJECTED finding injects nothing, deliberately: somebody looked and said it
 * was not a defect, and re-demanding proof of it is how a gate loses its
 * credibility (rule 14).
 *
 * ═══ MATCHED ON SCOPE, NOT ON THE FILE THAT HAPPENED TO BE EDITED ═══
 *
 * A finding names affected_paths. A later candidate that touches any of them is
 * in the same scope and inherits the demand. This is a path match and it is
 * deliberately coarse: the alternative is guessing at symbols, and a regression
 * demanded too often is an annoyance where one demanded too rarely is the
 * repeat this exists to stop.
 *
 * DERIVED, NOT STORED. Nothing here writes a checklist; the caller composes one.
 * A stored "required regressions" list would be a second truth that drifts from
 * the findings it came from -- §30, and the defect src/policy.mjs has a header
 * about.
 *
 * @param {object[]} findings      every finding known
 * @param {string[]} changedPaths  what the candidate touches
 * @returns {{required: object[], families: string[]}}
 */
export function requiredRegressions(findings, changedPaths) {
  const all = Array.isArray(findings) ? findings.filter((f) => f && typeof f === 'object') : [];
  const touched = new Set(
    (Array.isArray(changedPaths) ? changedPaths : [])
      .map((p) => str(p))
      .filter(Boolean)
      /*
       * FOLDED AND SEPARATOR-NORMALISED. git reports forward slashes, a Windows
       * caller may hand back backslashes, and NTFS resolves both cases to one
       * file. A scope match that misses because of a spelling is a regression
       * nobody is asked to prove -- the silent direction.
       */
      .map((p) => p.split('\\').join('/').replace(/^\.\//, '').toLowerCase()),
  );

  const required = all
    .filter((f) => f.status === FINDING.VERIFIED_FIXED)
    .filter((f) => (Array.isArray(f.affected_paths) ? f.affected_paths : [])
      .some((p) => touched.has(String(p).split('\\').join('/').replace(/^\.\//, '').toLowerCase())))
    .map((f) => ({
      finding_id: f.finding_id,
      failure_class: f.failure_class,
      title: f.title,
      /*
       * THE REPRODUCTION IS THE DEMAND. Not a description of one -- the actual
       * steps, carried from the finding, so the checklist item is executable by
       * whoever receives it rather than a reminder to go and look something up.
       */
      reproduction: f.reproduction,
      why: `${f.failure_class} was verified fixed on ${String(f.candidate_sha).slice(0, 8)} `
        + 'and this candidate touches the same scope',
    }));

  return {
    required,
    families: [...new Set(required.map((r) => r.failure_class))].sort(),
  };
}

/**
 * What is still owed, for a reader or a gate.
 *
 * COUNTS, NOT A BOOLEAN, and open findings are returned rather than summarised,
 * because "3 open" that nobody can enumerate is the prose ledger again.
 */
export function openFindings(findings) {
  const all = Array.isArray(findings) ? findings.filter((f) => f && typeof f === 'object') : [];
  const open = all.filter((f) => f.status === FINDING.OPEN || f.status === FINDING.BOUND_TO_REPAIR
    || f.status === FINDING.RETESTING);
  const rank = (f) => SEVERITY.indexOf(f.severity);
  return {
    total: all.length,
    open: open.sort((a, b) => rank(b) - rank(a)),
    byStatus: Object.fromEntries(Object.keys(FINDING)
      .map((s) => [s, all.filter((f) => f.status === s).length])),
  };
}
