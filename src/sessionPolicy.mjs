/**
 * WHICH KIND OF SESSION IS THIS, AND THEREFORE WHICH RULES APPLY.
 *
 * ═══ THE DEFECT THIS CLOSES ═══
 *
 * Every control in this repository was written for an AUTONOMOUS WORKER: a
 * process that claimed a task off the bridge, holds a lease, runs headless in a
 * disposable worktree, and must not be able to edit the thing measuring it.
 * That model is right for that worker and it was applied to EVERY session,
 * including the ones Danny drives by hand at a terminal.
 *
 * The cost is not theoretical and it is not small. Measured 2026-09-21, the
 * override grant on this machine read, in full:
 *
 *   {"paths":["*"],"actions":["*"],
 *    "reason":"full access for code-a, code-b and fixer, directed by Danny
 *              repeatedly","granted_by":"danny", ...}
 *
 * A wildcard grant, renewed by hand, because the containment did not fit the
 * work. That is the whole argument. A control that the owner must switch off
 * with `"*"` to get ordinary engineering done is not protecting anything; it is
 * training everybody to hold the door open, and CLAUDE.md rule 19 already says
 * where that ends -- an outage gets the hook switched off, which loses every
 * layer at once. The wildcard was that outage arriving in slow motion.
 *
 * ═══ WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT ═══
 *
 * It is ONE resolver and a capability table. It is NOT a pile of `if (manual)`
 * exceptions scattered through the guard: that shape is how two lists of one
 * thing drift, which this repository has now paid for with PROTECTED_PATHS,
 * with the INSTRUCTIONS splice and with the `_shared.js` copy. There is exactly
 * one place that decides a profile and exactly one table that says what a
 * profile permits, and every caller asks THIS.
 *
 * It does NOT weaken the autonomous guard. Every check that exists still exists
 * and still runs, unchanged, for AUTONOMOUS_TASK. What moves is APPLICABILITY.
 *
 * PURE. No filesystem, no clock, no environment, no git. CLAUDE.md rule 10: a
 * guard that cannot be imported is a guard nobody has watched fail, and the
 * branch that matters here is the one where the evidence is ABSENT or FORGED --
 * which a module that gathers its own evidence cannot be tested against without
 * arranging a real launcher. The impure half is `gatherSessionEvidence` in
 * src/sessionEvidence.mjs, and it is deliberately thin.
 */

/** A session Danny is driving himself, at a terminal, in its own worktree. */
export const MANUAL_TRUSTED = 'manual-trusted';

/** A worker that claimed a task off the bridge. The hardened model, unchanged. */
export const AUTONOMOUS_TASK = 'autonomous-task';

/** A reviewer. It may read, run and report; it may not touch what it reviews. */
export const REVIEW_ONLY = 'review-only';

export const PROFILES = Object.freeze([MANUAL_TRUSTED, AUTONOMOUS_TASK, REVIEW_ONLY]);

/**
 * THE PROFILE A SESSION GETS WHEN NOTHING ESTABLISHES OTHERWISE.
 *
 * Named, exported and used by the resolver rather than written as a literal in
 * four places, because the direction of this default IS the safety property.
 * A test asserts that it is AUTONOMOUS_TASK, so a future edit that "simplifies"
 * the fallback to manual fails loudly instead of silently un-containing every
 * unrecognised session.
 */
export const DEFAULT_PROFILE = AUTONOMOUS_TASK;

/*
 * ═══ THE CAPABILITY TABLE ═══
 *
 * Read this as the answer to "which of the guard's existing checks APPLY", not
 * as a list of things a session may do. Every `false` below is a check that is
 * skipped, and every one of them is a check that still runs for the autonomous
 * worker it was written for.
 *
 * THE INVARIANT ROWS ARE IN THE TABLE ON PURPOSE. `ownerActionsGated` and
 * `gateSelfConfigImmutable` are `true` for all three profiles, so listing them
 * is redundant today -- and CLAUDE.md rule 11 is precisely about that: a
 * protection that is redundant today stops being redundant the moment the
 * conditions change, and `untested because currently redundant` is how one
 * quietly stops being a protection. Writing them out means a profile added next
 * month must state its answer rather than inherit a default nobody looked at,
 * and `assertHardBoundariesHold` below refuses the table if either is ever
 * flipped.
 */
const TABLE = Object.freeze({
  [MANUAL_TRUSTED]: Object.freeze({
    /*
     * THE CENTRAL RELAXATION. `src/claudeGuard.mjs`, `src/policy.mjs` and the
     * rest of PROTECTED_PATHS are the guard's own source, and editing the guard
     * IS the engineering task Danny hands these sessions -- this very module
     * arrived that way. Refusing it demanded a wildcard grant, which is what
     * the header is about.
     */
    protectedPathsApply: false,
    /*
     * A baseline test is immutable to an autonomous worker so that a candidate
     * cannot rewrite the thing judging it. A session Danny is directing has no
     * candidate under judgement -- it is doing the work -- and "fix this test"
     * is an ordinary instruction that had no route at all from inside.
     */
    baselineTestsImmutable: false,
    /*
     * The rail is a fast-feedback allowlist, by its own header "NOT a security
     * boundary". For a human-directed session it is pure friction: it refuses
     * `cd`, `$HOME`, a grep pattern containing `|`, and `git clone`. What stays
     * is `shellHardBoundaryApplies` below -- the small set that is about
     * authority rather than about tidiness.
     */
    shellAllowlistApplies: false,
    mayWriteRepoFiles: true,
    /*
     * REPORTED, NOT REPAIRED. Danny's instruction, and it is the difference
     * between a finding and a loop: a manual session that hits a Stop-gate
     * finding tells him, rather than editing the gate, writing itself a grant,
     * or clearing guard state until the red goes away. `never-edit-the-gate-
     * that-refuses-you` is the ruling this encodes.
     */
    stopFindingsAutoRepair: false,
    ownerActionsGated: true,
    gateSelfConfigImmutable: true,
  }),

  [AUTONOMOUS_TASK]: Object.freeze({
    // The hardened model, untouched. Every value here is what shipped before
    // this module existed, which is the point: nothing was weakened, something
    // was scoped.
    protectedPathsApply: true,
    baselineTestsImmutable: true,
    shellAllowlistApplies: true,
    mayWriteRepoFiles: true,
    stopFindingsAutoRepair: true,
    ownerActionsGated: true,
    gateSelfConfigImmutable: true,
  }),

  [REVIEW_ONLY]: Object.freeze({
    /*
     * A reviewer that can write is not a reviewer. CLAUDE.md rule 20: the
     * auditor works in its own clone and the shared worktree is READ-ONLY to
     * it -- that sentence is a requirement nothing enforced, and this row is
     * the enforcement. The path rules stay ON as well as the write ban, so a
     * reviewer that somehow reaches a write is refused twice rather than once.
     */
    protectedPathsApply: true,
    baselineTestsImmutable: true,
    shellAllowlistApplies: true,
    mayWriteRepoFiles: false,
    stopFindingsAutoRepair: false,
    ownerActionsGated: true,
    gateSelfConfigImmutable: true,
  }),
});

/**
 * The capability keys, so a caller cannot ask for one that does not exist and
 * silently get `undefined` -- which reads as `false`, which for
 * `protectedPathsApply` means the protection is OFF. A typo must not be able to
 * disarm a control, so `permits` throws on an unknown key rather than guessing.
 */
export const CAPABILITIES = Object.freeze(Object.keys(TABLE[AUTONOMOUS_TASK]));

/**
 * HARD BOUNDARIES, WHICH NO PROFILE MAY RELAX.
 *
 * These are Danny's list from the brief, reduced to the ones this layer can
 * actually decide. They are asserted against the table at module load, so the
 * table cannot drift away from them: a future edit that sets
 * `ownerActionsGated: false` for a convenient profile fails at import, in every
 * session, rather than shipping quietly.
 *
 * WHAT IS NOT HERE, STATED SO NOBODY READS THIS AS MORE THAN IT IS. Session and
 * workspace identity, secrets, integration authority and reviewer independence
 * are enforced by other modules and are not re-implemented here; what this
 * guarantees is only that a PROFILE cannot switch off the two boundaries this
 * layer routes.
 */
const INVARIANT = Object.freeze({ ownerActionsGated: true, gateSelfConfigImmutable: true });

function assertHardBoundariesHold(table) {
  for (const profile of PROFILES) {
    const row = table[profile];
    if (!row) throw new Error(`sessionPolicy: no capability row for profile ${profile}`);
    for (const [key, required] of Object.entries(INVARIANT)) {
      if (row[key] !== required) {
        throw new Error(
          `sessionPolicy: ${profile} sets ${key}=${row[key]}, but it is a hard boundary `
          + `fixed at ${required}. No execution profile may relax it.`,
        );
      }
    }
  }
  return table;
}

assertHardBoundariesHold(TABLE);

/**
 * Does `profile` permit `capability`?
 *
 * An unknown profile answers with the DEFAULT profile's row rather than
 * throwing, because this is called from inside a PreToolUse hook where a throw
 * is a deny that costs the operator a turn -- and the default is the contained
 * one, so being wrong here fails toward containment. An unknown CAPABILITY does
 * throw: that is a programming error in the guard, not a fact about a session,
 * and answering `undefined` would silently disarm whichever check asked.
 */
export function permits(profile, capability) {
  if (!CAPABILITIES.includes(capability)) {
    throw new Error(`sessionPolicy: unknown capability ${JSON.stringify(capability)}`);
  }
  const row = TABLE[profile] ?? TABLE[DEFAULT_PROFILE];
  return row[capability];
}

/*
 * `capabilitiesOf(profile)` USED TO BE HERE AND IS DELETED RATHER THAN KEPT
 * "for a caller that needs several answers at once". There was no such caller:
 * the dead-export ratchet counted it as the one export this change added with
 * tests and nothing shipping behind it, and its advice is the right advice --
 * name the production caller or do not export it. A convenience accessor that
 * exists only so a test can read a whole row is the test reaching past the
 * interface, and `permits` over CAPABILITIES says the same thing through the
 * surface production actually uses.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * THE ONE SHELL CHECK THAT SURVIVES MANUAL_TRUSTED, AND IT IS A SPEED BUMP
 * RATHER THAN A BOUNDARY. Saying which is the whole point.
 *
 * `shellAllowlistApplies` is false for MANUAL_TRUSTED, so the rail in
 * src/shellAllowlist.mjs is not consulted at all. That is deliberate -- its own
 * header calls it "a fast-feedback rail, NOT a security boundary", and for a
 * session Danny is directing it was pure friction: it refuses `cd`, `$HOME`, a
 * grep pattern containing `|`, and `git clone`. Note that the rail itself is
 * NOT edited: Danny froze it at 90b2924 and no regex is added here.
 *
 * What stays is promotion. The brief keeps "production/deployment/promotion
 * authority" as a hard boundary regardless of profile, and CLAUDE.md says
 * merges to main, deploys and anything a customer receives are Danny's.
 *
 * WHY THIS IS HONESTLY WEAK, STATED RATHER THAN GLOSSED. It is a denylist of
 * spellings, and CLAUDE.md rule 8 is explicit that a denylist bounds nothing:
 * `git push` can be spelled through an alias, a script, a config change or a
 * variable, and a determined session walks around it in one move. It is here to
 * stop an ACCIDENT -- the reflexive push at the end of a task -- and it is NOT
 * evidence that promotion is prevented.
 *
 * The controls that actually decide promotion are elsewhere and are not
 * replaced by this: the deploy gate, the integration authority, and the owner
 * action rail in src/actionAuthority.mjs, all of which still run for all three
 * profiles. A control documented as stronger than it is, is worse than one
 * documented as absent.
 */
export function shellHardBoundary(command) {
  const c = String(command ?? '');
  if (/\bgit\s+push\b/.test(c)) {
    return 'git push promotes work beyond this machine, and that is the owner\'s call';
  }
  if (/\bnpm\s+publish\b|\bwrangler\s+(?:deploy|publish)\b|\bsupabase\s+functions\s+deploy\b/.test(c)) {
    return 'this deploys or publishes, which is production authority and stays with Danny';
  }
  return null;
}

/**
 * WHICH PROFILE, FROM EVIDENCE.
 *
 * `evidence` is data somebody else measured:
 *
 *   sessionId       Claude Code's session uuid for THIS session.
 *   attestation     what the launcher recorded, bound to a session id:
 *                   { profile, sessionId }. `null` when nothing was recorded.
 *   holdsTaskLease  true when this session holds a bridge task lease.
 *   auditWorkspace  true when this is an audit clone.
 *
 * ═══ THE ORDER IS THE DESIGN, AND EACH STEP OUTRANKS THE ONE BELOW ═══
 *
 * 1. AN AUDIT WORKSPACE IS REVIEW_ONLY, WHOEVER LAUNCHED IT. Reviewer
 *    independence is a hard boundary and it does not yield to a launcher
 *    attestation: Danny starting an audit clone by hand is still an audit, and
 *    a reviewer that can edit the candidate has stopped being evidence.
 *
 * 2. A LIVE TASK LEASE OUTRANKS AN ATTESTATION. This is the branch that keeps
 *    the attestation honest. `src/principalResolution.mjs` already argues that
 *    the lease is the one anchor an agent cannot mint -- the server issues it
 *    inside the claim transaction. So if a session is holding one, it is doing
 *    autonomous work and gets the autonomous rules, regardless of how it was
 *    started. Without this step, `agent code-a` followed by claiming a task
 *    would be a route from the launcher into an uncontained worker.
 *
 * 3. AN ATTESTATION COUNTS ONLY FOR THE SESSION IT NAMES. Bound once, to one
 *    session id. A record left behind by a previous launch does not promote
 *    whatever session reads it next, which is the difference between an
 *    attestation and an ambient flag on disk.
 *
 * 4. OTHERWISE, CONTAINED. Absence of evidence is not evidence of a human.
 */
export function resolveSessionProfile(evidence = {}) {
  const {
    sessionId = null,
    attestation = null,
    holdsTaskLease = false,
    auditWorkspace = false,
  } = evidence ?? {};

  if (auditWorkspace === true) {
    return {
      profile: REVIEW_ONLY,
      reason: 'this is an audit workspace, and reviewer independence does not yield to a launcher',
      source: 'audit-workspace',
    };
  }

  if (holdsTaskLease === true) {
    return {
      profile: AUTONOMOUS_TASK,
      reason: 'this session holds a bridge task lease, so it is running assigned work',
      source: 'task-lease',
    };
  }

  /*
   * THE BINDING IS CHECKED AGAINST THIS SESSION, NOT MERELY READ.
   *
   * A stale attestation is the obvious way this goes wrong: agent.cmd records
   * one, the session ends, and a later session -- started any other way --
   * finds it lying there. Requiring an exact session-id match makes the record
   * a statement about ONE session rather than about the machine.
   */
  if (attestation && nonEmpty(sessionId) && attestation.sessionId === sessionId) {
    if (attestation.profile === MANUAL_TRUSTED) {
      return {
        profile: MANUAL_TRUSTED,
        reason: 'the launcher attested this exact session as owner-directed',
        source: 'launcher-attestation',
      };
    }
    if (PROFILES.includes(attestation.profile)) {
      return {
        profile: attestation.profile,
        reason: `the launcher attested this exact session as ${attestation.profile}`,
        source: 'launcher-attestation',
      };
    }
  }

  /*
   * NAME WHY, BECAUSE "CONTAINED" AND "CONTAINED FOR A REASON I CAN FIX" ARE
   * DIFFERENT MESSAGES TO A PERSON READING A REFUSAL. An attestation that
   * exists but names another session is the case an operator will actually hit
   * -- a relaunched session, a resumed one -- and "no attestation at all" would
   * send them looking in the wrong place.
   */
  const mismatched = attestation && nonEmpty(sessionId) && attestation.sessionId !== sessionId;
  return {
    profile: DEFAULT_PROFILE,
    reason: mismatched
      ? 'the launcher attestation names a different session, so it does not apply here'
      : 'nothing established who is directing this session, and unclassified means contained',
    source: mismatched ? 'attestation-session-mismatch' : 'no-evidence',
  };
}
