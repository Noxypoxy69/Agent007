/**
 * GATHERING THE EVIDENCE src/sessionPolicy.mjs DECIDES ON.
 *
 * ═══ THE CRITIQUE THIS MODULE IS AN ANSWER TO ═══
 *
 * Raised by a peer agent on 2026-09-21, before a line of this was written, and
 * it is the correct objection:
 *
 *   "How a session becomes MANUAL_TRUSTED is the whole control. If it's a
 *    session-id list or an agent-name match, CLAUDE.md rule 19 applies -- a list
 *    of names fails in both directions. If the signal is anything a worker can
 *    set itself (an env var, a flag, a registration field), then MANUAL_TRUSTED
 *    is one variable away from disabling the hardened model."
 *
 * Every one of those was considered and rejected, and src/principalResolution.mjs
 * had already enumerated the same shortlist for a different question:
 *
 *   an env var                the session sets it. This is the hole.
 *   a CLI flag                likewise, and more obviously.
 *   an agent-id match         rule 19, and the id is self-asserted anyway --
 *                             registrations.json records every row as
 *                             "runtime-self-registration", with no lease field.
 *   a file on disk            a session writes files, including outside the
 *                             worktree. guardSession.mjs concedes this about
 *                             grants in its own comments.
 *
 * ═══ WHAT IS LOAD-BEARING INSTEAD: ORDER, NOT SECRECY ═══
 *
 * The attestation is not a credential and this module does not pretend it is.
 * What it has is a property no credential is needed for: THE DECISION IS MADE
 * BEFORE THE SESSION CAN ACT, AND IT CANNOT BE REMADE.
 *
 *   1. agent.cmd writes a PENDING attestation. This runs in Danny's terminal,
 *      before `claude` is exec'd -- so there is no session yet, and nothing for
 *      a session to have done.
 *   2. The SessionStart hook CONSUMES it: the pending file is deleted and a
 *      binding naming this exact session id is created with an EXCLUSIVE CREATE.
 *      This is the same `wx` mechanism writeSnapshot already uses, for the same
 *      reason -- "re-running this used to overwrite the baseline ... the
 *      exclusive create closed that".
 *   3. Every later tool call READS that binding. Nothing writes it again.
 *
 * So by the time a session issues its first tool call, its profile is already
 * decided and the pending file is already gone. A session cannot promote itself
 * by writing a pending attestation, because pending files are only read at
 * SessionStart and its SessionStart has been and gone. It cannot promote itself
 * by writing a binding, because one already exists for its session id and the
 * create is exclusive.
 *
 * ═══ WHAT REMAINS FORGEABLE, SAID PLAINLY ═══
 *
 * A session that can write and DELETE arbitrary files outside the repository
 * can delete its binding and write a different one. That is the same residual
 * the override grant already has -- guardSession.mjs: "a session can write
 * outside the repository ... so an agent COULD forge one of these" -- and this
 * module adds no new authority beyond it. It is strictly better than the
 * wildcard grant it replaces, because that grant was ambient, permanent until
 * expiry, and applied to every session at once. It is not containment against
 * an adversary with a filesystem, and nothing here should be designed as though
 * it were. CLAUDE.md is explicit that a control documented as stronger than it
 * is, is worse than one documented as absent.
 *
 * ═══ THE ONE SIGNAL THAT IS SAFE TO TAKE FROM THE ENVIRONMENT ═══
 *
 * `holdsTaskLease` below is read from an environment variable, which the
 * paragraphs above just finished rejecting. The difference is DIRECTION, and it
 * is the whole reason it is admissible: this variable can only ever move a
 * session TOWARDS containment. Setting it forces AUTONOMOUS_TASK. Unsetting it
 * grants nothing, because MANUAL_TRUSTED additionally requires the bind-once
 * attestation, which a session cannot mint. A signal whose only abuse is
 * self-containment needs no anchor.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { repoStorePath } from './guardSession.mjs';
import { MANUAL_TRUSTED, PROFILES } from './sessionPolicy.mjs';

const STORE_KIND = 'session-profiles';

const defaultHome = () => process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge');

/**
 * HOW LONG A PENDING ATTESTATION IS GOOD FOR.
 *
 * agent.cmd writes it and immediately exec's `claude`, so the real interval is
 * seconds. Two minutes is generous for a cold start and still closes the window
 * in which a pending file planted earlier could be picked up by an unrelated
 * session started later. An attestation with no expiry is an ambient flag on
 * disk, which is the shape this module exists to avoid.
 */
export const PENDING_MAX_AGE_MS = 120_000;

/*
 * A REPO ROOT THAT IS NOT A STRING IS NOT A REPO ROOT, AND THIS THREW.
 *
 * Measured by the suite on the first full run after wiring: `repoRootOf(cwd)`
 * answers null when git cannot describe the tree, `repoStorePath` handed that
 * null to `path.resolve`, and the TypeError travelled out through
 * gatherSessionEvidence into evaluateClaudeTool. The hook binary catches a
 * throw and turns it into a DENY -- so the failure direction was safe, and the
 * consequence was still an OUTAGE: every tool call in such a session refused,
 * which is CLAUDE.md rule 19's "an outage gets the hook switched off".
 *
 * So the store path is total. No root, no store, no attestation, and the
 * resolver's contained default stands -- which is the same answer an unattested
 * session gets, reached without an exception.
 */
const usableRoot = (repoRoot) => (typeof repoRoot === 'string' && repoRoot.trim() !== '' ? repoRoot : null);

/** The one-shot file a launcher writes BEFORE the session exists. */
export function pendingPath(repoRoot, home = defaultHome()) {
  if (!usableRoot(repoRoot)) return null;
  return repoStorePath(repoRoot, STORE_KIND, '.pending.json', home);
}

/*
 * A SESSION ID BECOMES A FILENAME, SO IT IS NOT ALLOWED TO BE A PATH.
 *
 * agent.cmd already carries a blind-audit scar about an agent id that executed
 * as script because it became a directory name, and the fix for that was
 * quoting -- which does nothing about "..". The same class arrives here: a
 * session id of `../../overrides/<key>` would point this store at the grant
 * file. So the id is reduced to characters that cannot traverse, rather than
 * checked for the spellings somebody thought of (rule 8).
 */
const safeId = (sessionId) => String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '');

/** The immutable per-session binding. */
export function bindingPath(repoRoot, sessionId, home = defaultHome()) {
  if (!usableRoot(repoRoot)) return null;
  const id = safeId(sessionId);
  if (id === '') return null;
  return repoStorePath(repoRoot, STORE_KIND, `-${id}.json`, home);
}

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

/**
 * Write the pending attestation. Called by the LAUNCHER, never by a session.
 *
 * Returns { ok, file } or { ok: false, reason }.
 */
export function writePendingAttestation(repoRoot, profile = MANUAL_TRUSTED, now = Date.now(), home = defaultHome()) {
  if (!PROFILES.includes(profile)) {
    return { ok: false, reason: `${profile} is not an execution profile` };
  }
  const file = pendingPath(repoRoot, home);
  if (!file) return { ok: false, reason: 'no usable repository root, so there is nowhere to record it' };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ profile, created_at: new Date(now).toISOString() })}\n`, 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/**
 * CONSUME the pending attestation and bind it to this session, once.
 *
 * Called from the SessionStart hook and from nowhere else. Every branch that
 * does not produce a MANUAL_TRUSTED binding leaves the session contained, which
 * is the direction this function is allowed to be wrong in.
 */
export function bindSessionProfile(repoRoot, sessionId, now = Date.now(), home = defaultHome()) {
  const target = bindingPath(repoRoot, sessionId, home);
  if (!target) return { ok: false, reason: 'no usable session id, so nothing can be bound' };

  /*
   * THE PENDING FILE IS CONSUMED WHETHER OR NOT IT IS HONOURED.
   *
   * A stale or malformed attestation that stayed on disk would be retried by
   * the NEXT session to start, which is precisely the ambient-flag behaviour
   * the header rejects. So it is deleted first and judged afterwards.
   */
  const pending = pendingPath(repoRoot, home);
  if (!pending) return { ok: false, reason: 'no usable repository root, so nothing can be bound' };
  const claim = existsSync(pending) ? readJson(pending) : null;
  try { if (existsSync(pending)) unlinkSync(pending); } catch { /* best effort; judged below anyway */ }

  if (!claim) return { ok: false, reason: 'no launcher attestation was waiting, so this session is contained' };
  if (!PROFILES.includes(claim.profile)) {
    return { ok: false, reason: `the attestation named ${claim.profile}, which is not an execution profile` };
  }
  const createdAt = Date.parse(claim.created_at);
  if (Number.isNaN(createdAt)) {
    return { ok: false, reason: 'the attestation carried no usable created_at' };
  }
  const age = now - createdAt;
  if (age > PENDING_MAX_AGE_MS || age < -PENDING_MAX_AGE_MS) {
    return { ok: false, reason: `the attestation is ${Math.round(age / 1000)}s old, outside the ${PENDING_MAX_AGE_MS / 1000}s window` };
  }

  const record = {
    profile: claim.profile,
    sessionId: String(sessionId),
    bound_at: new Date(now).toISOString(),
  };
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    // EXCLUSIVE. A binding that already exists is never replaced -- see the header.
    writeFileSync(target, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' });
    return { ok: true, file: target, record };
  } catch (e) {
    if (e?.code === 'EEXIST') {
      return { ok: false, reason: 'a binding already exists for this session and is never replaced' };
    }
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/** The binding for this session, or null. Never throws: unreadable is unbound. */
export function readSessionBinding(repoRoot, sessionId, home = defaultHome()) {
  const file = bindingPath(repoRoot, sessionId, home);
  if (!file || !existsSync(file)) return null;
  const record = readJson(file);
  if (!record || !PROFILES.includes(record.profile)) return null;
  /*
   * THE RECORD MUST NAME THIS SESSION. resolveSessionProfile checks this too,
   * deliberately: the filename is derived from a SANITISED id, so two distinct
   * session ids could in principle land on one file, and the id inside the
   * record is the unsanitised original. Checking the content rather than
   * trusting the path is the same move as matching a grant on every spelling
   * the protection used.
   */
  if (record.sessionId !== String(sessionId)) return null;
  return { profile: record.profile, sessionId: record.sessionId, boundAt: record.bound_at ?? null };
}

/**
 * Is this session running assigned autonomous work?
 *
 * Read from the environment, which the header explains is admissible ONLY here:
 * the signal can only force containment, never relax it.
 */
export function holdsTaskLease(env = process.env) {
  const v = env.AGENTBRIDGE_TASK_LEASE;
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Is this an audit workspace?
 *
 * `scripts/audit-workspace.mjs` makes the clone, so it marks it. The marker is
 * a FILE IN THE CLONE rather than a variable, because it must survive the
 * reviewer opening a fresh terminal inside that clone -- and because, like the
 * lease above, this signal can only ever move a session towards containment.
 */
export function isAuditWorkspace(cwd, env = process.env) {
  if (typeof env.AGENTBRIDGE_REVIEW_ONLY === 'string' && env.AGENTBRIDGE_REVIEW_ONLY.trim() !== '') return true;
  try {
    return existsSync(path.join(cwd, '.agentbridge-review'));
  } catch {
    return false;
  }
}

/**
 * Everything src/sessionPolicy.mjs needs, measured. The resolver stays pure;
 * this is the only part that touches the disk or the environment.
 */
export function gatherSessionEvidence({ repoRoot, sessionId = null, cwd = repoRoot, env = process.env, home = defaultHome() } = {}) {
  /*
   * TOTAL, BECAUSE THE CALLER IS A PreToolUse HOOK AND A THROW THERE IS A DENY
   * ON EVERY TOOL CALL.
   *
   * The guards above make each helper total on its own, and this catch is the
   * class-level repair rather than a second copy of them: the property that
   * matters is that NOTHING thrown while gathering evidence can take a session
   * out, and fixing only the instance found by the suite would leave the
   * property. bin/agentbridge-claude-guard.mjs makes exactly this argument
   * about evaluateClaudeTool one layer up.
   *
   * The fallback is the CONTAINED answer, not a permissive one: no attestation
   * means resolveSessionProfile returns AUTONOMOUS_TASK. Failing to measure is
   * never a reason to trust.
   */
  try {
    return {
      sessionId,
      attestation: sessionId ? readSessionBinding(repoRoot, sessionId, home) : null,
      holdsTaskLease: holdsTaskLease(env),
      auditWorkspace: isAuditWorkspace(cwd, env),
    };
  } catch {
    return { sessionId, attestation: null, holdsTaskLease: false, auditWorkspace: false };
  }
}
