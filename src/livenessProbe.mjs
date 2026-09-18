/**
 * LIVENESS BY ANSWERED PROBE, NOT BY HEARTBEAT.
 *
 * THE PROBLEM, measured on this bridge across three separate attempts.
 *
 * Every liveness signal this project has shipped proves something ADJACENT to
 * the thing the roster claims:
 *
 *   the watcher      proved a DAEMON was running. It died with the shell that
 *                    started it, nothing supervised it, and the roster went on
 *                    describing daemons rather than agents (1d2401a).
 *   touchLiveness    proves SOMEBODY HOLDING THE SHARED WORKER TOKEN spoke for
 *                    a session. 1d2401a says so in its own commit message and
 *                    names per-agent tokens as what would close it.
 *   the session poll proves a SUPERVISOR PROCESS is re-arming. It deliberately
 *                    does not interpret what it receives — "a poll that
 *                    interpreted its own wake-up would be a dispatcher" — so a
 *                    wedged or finished agent keeps polling exactly like a
 *                    working one.
 *
 * Three layers, and not one of them can tell a working agent from a process
 * that is still breathing on its behalf. That is CLAUDE.md rule 4: a proxy
 * agrees with the truth right up until something unusual happens, which is
 * exactly when a roster is supposed to speak.
 *
 * THE MEASUREMENT THAT MATTERS is a round trip the AGENT ITSELF has to close.
 * A probe is delivered as an ordinary event; the agent answers by naming the
 * probe id back. Nothing below the agent can produce that id — not the
 * supervisor, which never reads event bodies, and not another worker, because
 * an ack that does not match the outstanding probe is not an ack.
 *
 * SO THE HONEST FIELD PAIR IS (last poll, last ack), AND THE GAP IS THE
 * SIGNAL. A session polling every ten minutes with no ack for twenty is not
 * "live" and is not "gone": it is a process that is running while nobody is
 * home, which is the state this whole file exists to make visible.
 *
 * FOUR OUTCOMES, AND `unknown` IS NOT `silent`. A session nobody has probed
 * yet has not failed anything. Collapsing "we did not ask" into "it did not
 * answer" would manufacture exactly the confident wrong answer the roster keeps
 * being blamed for — see rule 5 and the null-is-unknown contract this server
 * already hands every caller.
 *
 * PURE. No clock, no network, no store: every timestamp arrives as an argument,
 * the same way src/ownerDecisions.mjs works and for the same reason — the
 * precedence rules are where a mistake quietly widens something, and they are
 * only testable offline if nothing in here reads the world.
 */

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Milliseconds since the epoch, or null.
 *
 * MICROSECONDS SURVIVE, because Postgres emits six fractional digits and
 * `Date.parse` keeps three. src/events.mjs lost mail to exactly that truncation
 * — two events inside one millisecond collapsed and the second was never
 * delivered. Nothing here compares timestamps for equality, so the extra
 * precision is defence rather than requirement, but a parser in this repository
 * that silently drops digits is a trap the next reader does not deserve.
 */
export function parseInstant(v) {
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return null;
  const frac = /\.(\d+)/.exec(String(v ?? ''));
  const sub = frac ? Number(frac[1].slice(3, 6).padEnd(3, '0')) : 0;
  return ms + (Number.isFinite(sub) ? sub / 1000 : 0);
}

/** Defaults, in milliseconds except where named otherwise. Overridable per call. */
export const PROBE_DEFAULTS = Object.freeze({
  /** How long an ack is trusted before the agent must prove itself again. */
  ackWindowMs: 10 * 60 * 1000,
  /**
   * How long ONE outstanding probe waits before the next attempt goes out.
   *
   * SHORT, BECAUSE THE ATTEMPTS ARE A BURST. "5 attempts in a row, not all
   * day." Spacing them at the healthy-probe interval would mean five failures
   * take twenty-five minutes to conclude anything, and a roster that takes
   * twenty-five minutes to notice a dead agent is one nobody trusts for
   * dispatch. At thirty seconds the whole sequence resolves inside three
   * minutes: long enough to ride out a slow model turn or a brief fault,
   * short enough to be useful.
   */
  ackGraceMs: 30 * 1000,

  /** Spacing between probes to a session that is ANSWERING. */
  probeIntervalMs: 5 * 60 * 1000,

  /**
   * HOW MANY UNANSWERED PROBES BEFORE A SESSION IS CALLED SILENT.
   *
   * Danny's number, and it is the right shape: "before a watcher drops it needs
   * 5 attempts to ping and get I'm alive before it shuts down."
   *
   * ONE MISSED ROUND TRIP IS NOT EVIDENCE OF ANYTHING. An agent mid-tool-call,
   * a slow model turn, a momentary network fault and a genuinely dead session
   * all look identical at the first unanswered probe. Dropping on that reading
   * is how the current roster ends up telling Danny an agent is dead forty-five
   * seconds after it sent a message — the failure this whole module exists to
   * stop, reintroduced one layer up.
   *
   * Five attempts across the grace window is long enough that a session which
   * never answers really has stopped answering, and a roster that only speaks
   * when it is sure is one people still read on the tenth day.
   */
  maxAttempts: 5,

  /**
   * After a session is called silent, how long before it is probed again.
   *
   * IT IS PROBED AGAIN, and that is deliberate. "Also it's hard for them to
   * refresh" — a session that recovers must be able to rejoin without a human
   * noticing and restarting something. A terminal state nothing ever re-checks
   * is how the roster fills with rows that are wrong in the other direction.
   */
  recheckIntervalMs: 15 * 60 * 1000,
});

export const LIVENESS = Object.freeze({
  LIVE: 'live',
  AWAITING_ACK: 'awaiting-ack',
  SILENT: 'silent',
  UNKNOWN: 'unknown',
});

/**
 * Is this ack the answer to the probe we actually sent?
 *
 * THE WHOLE ANTI-PROXY ARGUMENT LIVES HERE. If any ack counted, the supervisor
 * could close the loop by replaying an old id, a second worker could ack on
 * behalf of a dead one, and the probe would join the other three signals that
 * measure something adjacent. So an ack is valid only when it names the
 * OUTSTANDING probe id and arrives at or after that probe was sent.
 *
 * Exact string match, deliberately: a probe id is opaque, and any normalising
 * — trimming, folding case — is a widening nobody asked for. `scopeGrantsWrite`
 * matches an exact scope token for the same reason.
 */
export function ackMatches(session, ack) {
  if (!isPlainObject(session) || !isPlainObject(ack)) return false;
  if (!isNonEmptyString(session.probeId) || !isNonEmptyString(ack.probeId)) return false;
  if (session.probeId !== ack.probeId) return false;

  const sentAt = parseInstant(session.probeSentAt);
  const ackedAt = parseInstant(ack.at);
  if (sentAt === null || ackedAt === null) return false;
  // An ack that predates its own probe is a replay, not an answer.
  return ackedAt >= sentAt;
}

/**
 * What is this session's liveness, and WHY.
 *
 * Returns `{ state, reason, ageMs }` where `reason` names the numbers a reader
 * would otherwise have to go and find. A roster row that says "not live" and
 * nothing else is the thing Danny has been reading all evening while agents
 * were demonstrably working.
 */
export function classifyLiveness(session, now, opts = {}) {
  const { ackWindowMs, ackGraceMs, maxAttempts } = { ...PROBE_DEFAULTS, ...opts };
  const at = typeof now === 'number' ? now : parseInstant(now);

  if (!isPlainObject(session) || at === null) {
    return { state: LIVENESS.UNKNOWN, reason: 'no session or no clock to judge it against', ageMs: null };
  }

  const acked = parseInstant(session.lastAckAt);
  const sent = parseInstant(session.probeSentAt);
  const polled = parseInstant(session.lastPollAt);

  /*
   * A FRESH ACK IS THE ONLY THING THAT MEANS LIVE. Note what is NOT consulted:
   * lastPollAt. A poll cannot make a session live here, which is the entire
   * point — it is the signal that has been lying.
   */
  if (acked !== null && at - acked <= ackWindowMs) {
    return {
      state: LIVENESS.LIVE,
      reason: `acked ${Math.round((at - acked) / 1000)}s ago`,
      ageMs: at - acked,
    };
  }

  /*
   * A PROBE IN FLIGHT IS NOT A FAILURE YET. Flapping to "silent" the instant a
   * probe is sent would make every busy agent look dead for the length of one
   * round trip, and a roster that cries wolf gets ignored — rule 14's lesson
   * about a harness that burns its own credibility.
   */
  if (sent !== null && at - sent <= ackGraceMs) {
    return {
      state: LIVENESS.AWAITING_ACK,
      reason: `probe ${session.probeId ?? '?'} sent ${Math.round((at - sent) / 1000)}s ago, within grace`,
      ageMs: at - sent,
    };
  }

  /*
   * PROBED, GRACE EXPIRED, NO ANSWER. This is the state the other three signals
   * cannot express, so the reason says the quiet part out loud: the process is
   * still polling and the agent is not answering.
   */
  if (sent !== null) {
    const attempts = Number.isInteger(session.probeAttempts) ? session.probeAttempts : 1;
    const pollNote = polled !== null
      ? `; still polling ${Math.round((at - polled) / 1000)}s ago`
      : '';
    const ackNote = acked !== null
      ? `last ack ${Math.round((at - acked) / 1000)}s ago`
      : 'never acked';

    /*
     * NOT YET. Danny's rule: five attempts before a drop.
     *
     * One missed round trip is not evidence. An agent mid-tool-call, a slow
     * model turn, a momentary fault and a dead session are indistinguishable at
     * the first unanswered probe — and calling that "silent" is exactly how the
     * roster tells somebody an agent is dead forty-five seconds after it sent a
     * message. The whole point of this module is to stop saying that, so it
     * must not start saying it one layer up.
     */
    if (attempts < maxAttempts) {
      return {
        state: LIVENESS.AWAITING_ACK,
        reason: `probe ${session.probeId ?? '?'} unanswered, attempt ${attempts} of ${maxAttempts}, `
          + `${ackNote}${pollNote}`,
        ageMs: at - sent,
      };
    }

    return {
      state: LIVENESS.SILENT,
      reason: `${attempts} probes unanswered (last ${Math.round((at - sent) / 1000)}s ago), ${ackNote}${pollNote}`,
      ageMs: at - sent,
    };
  }

  /*
   * NEVER PROBED IS NOT SILENT. Nobody asked, so nobody failed to answer, and
   * saying otherwise would be the confident wrong answer this file exists to
   * stop. Treat it exactly as the tool contract treats a null field: unknown,
   * never zero.
   */
  return {
    state: LIVENESS.UNKNOWN,
    reason: polled !== null
      ? `no probe has been sent; polling ${Math.round((at - polled) / 1000)}s ago proves a process, not an agent`
      : 'no probe has been sent and nothing has polled',
    ageMs: null,
  };
}

/**
 * Should a probe be sent to this session now?
 *
 * Refuses while one is outstanding and inside its grace, so a slow agent is not
 * buried under probes it is already answering — and so the ack that eventually
 * arrives is unambiguous about which probe it answers.
 */
export function probeDue(session, now, opts = {}) {
  const {
    probeIntervalMs, ackGraceMs, ackWindowMs, maxAttempts, recheckIntervalMs,
  } = { ...PROBE_DEFAULTS, ...opts };
  const at = typeof now === 'number' ? now : parseInstant(now);
  if (!isPlainObject(session) || at === null) return false;

  const sent = parseInstant(session.probeSentAt);
  const acked = parseInstant(session.lastAckAt);
  const attempts = Number.isInteger(session.probeAttempts) ? session.probeAttempts : 0;

  // One in flight and still within grace: wait for it.
  if (sent !== null && at - sent <= ackGraceMs && (acked === null || acked < sent)) return false;

  // Recently acked: no need to ask again yet.
  if (acked !== null && at - acked < Math.min(probeIntervalMs, ackWindowMs)) return false;

  // Never probed: ask.
  if (sent === null) return true;

  /*
   * ALREADY CALLED SILENT — RE-CHECK ANYWAY, JUST LESS OFTEN.
   *
   * "Also it's hard for them to refresh." A session that recovers has to be
   * able to rejoin without somebody noticing and restarting something by hand,
   * and a terminal state nothing ever re-examines is how a roster fills up with
   * rows that are wrong in the other direction. So silence is a verdict about
   * now, never a permanent label.
   */
  if (attempts >= maxAttempts) return at - sent >= recheckIntervalMs;

  /*
   * MID-SEQUENCE: THE NEXT ATTEMPT FOLLOWS THE GRACE, NOT THE HEALTHY INTERVAL.
   *
   * "5 attempts in a row, not all day." Spacing retries at probeIntervalMs
   * would stretch the budget across twenty-five minutes, and a roster that
   * takes that long to conclude anything is no better than the stale-window it
   * replaces. The burst resolves in about `maxAttempts * ackGraceMs`.
   */
  return at - sent >= ackGraceMs;
}

/**
 * Record that a probe was sent. Increments the consecutive-attempt count, which
 * is what `maxAttempts` is spent against.
 *
 * The counter lives on the session rather than being derived from timestamps
 * because "how many times have we asked" is not recoverable from "when did we
 * last ask" — and inferring it would be the kind of reconstruction CLAUDE.md's
 * second hollow gate is about, where a check agrees with itself instead of
 * reading what actually happened.
 */
export function recordProbe(session, { probeId, at }) {
  if (!isPlainObject(session) || !isNonEmptyString(probeId) || !isNonEmptyString(at)) return session;
  const attempts = Number.isInteger(session.probeAttempts) ? session.probeAttempts : 0;
  const acked = parseInstant(session.lastAckAt);
  const sent = parseInstant(session.probeSentAt);
  // A probe that follows a fresh ack starts a new sequence rather than continuing the old one.
  const continuing = sent !== null && (acked === null || acked < sent);
  return {
    ...session,
    probeId,
    probeSentAt: at,
    probeAttempts: continuing ? attempts + 1 : 1,
  };
}

/**
 * Apply a valid ack, returning the updated session. Returns the session
 * UNCHANGED when the ack does not answer the outstanding probe, so a caller
 * that forgets to check `ackMatches` cannot accidentally mark a dead agent
 * live — the refusal is the default rather than an extra step somebody has to
 * remember (rule 6: assert preconditions, do not guard on them).
 */
export function applyAck(session, ack) {
  if (!ackMatches(session, ack)) return session;
  // The attempt budget is CONSECUTIVE failures, so an answer resets it in full.
  return { ...session, lastAckAt: ack.at, probeId: null, probeSentAt: null, probeAttempts: 0 };
}
