/**
 * THE COORDINATION GUARD: what may be assigned, to whom, and what may be said.
 *
 * ChatGPT becomes a coordinator here rather than an observer, which means these
 * rules are the only thing between "traffic control" and "an LLM handing
 * production work to a machine that died ten minutes ago".
 *
 * PURE. No clock, no network, no database. Liveness, collisions and dependency
 * state all arrive as arguments, so every refusal below can be tested without
 * standing anything up -- and the refusals are the point. An assignment guard
 * that has only been exercised on the happy path is decoration.
 *
 * WHAT A COORDINATOR MAY DO: assign existing tasks, send structured messages,
 * record owner decisions. WHAT IT MAY NOT: run a command, write a file, deploy,
 * merge, or execute SQL. None of those exist as a tool, so none can be reached
 * by phrasing a request cleverly -- the absence is the control, not a refusal
 * string a model could be talked out of.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);

/** Message types. A closed set: an unknown type is refused, not passed through. */
export const MESSAGE_TYPES = ['assignment', 'question', 'answer', 'status', 'blocker', 'handoff', 'review'];

/** Task states a task may be assigned FROM. */
export const ASSIGNABLE_FROM = ['runnable', 'returned'];

/**
 * Does this text look like something meant to be EXECUTED rather than read?
 *
 * A structured message carries prose for a person or an agent to read. The
 * moment it carries a command, the messaging channel becomes a remote shell
 * with extra steps -- and it would be a shell nobody audited, because it would
 * look like coordination traffic.
 *
 * DELIBERATELY CONSERVATIVE AND DELIBERATELY INCOMPLETE. This cannot catch
 * every way of expressing a command, and pretending otherwise would be worse
 * than useless. It catches the shapes that would actually be pasted into a
 * terminal, and the real control is that nothing downstream EXECUTES a message
 * body. This is defence in depth on top of that, not instead of it.
 *
 * WHAT WAS WRONG WITH THE FIRST VERSION, measured on a real day rather than
 * imagined. It matched a command word followed by any whitespace and any
 * character, ANYWHERE in the text. So "the collector does not ask git for a
 * commit" matched, and so did "written to drop into the source directory". Those
 * are not commands; they are this project's vocabulary. Roughly sixteen ordinary
 * paragraphs were refused in one morning, four of them an attempt to hand over a
 * work packet, and the refusal named nothing -- so the reader went hunting for
 * executable text in prose that had none, exactly as a status of "unreachable"
 * sends somebody to check a healthy network.
 *
 * The positive control existed and could not catch it: its four "ordinary prose"
 * fixtures avoided every word the system is actually about. A control too narrow
 * to reach the branch cannot fail for it.
 *
 * SO POSITION NOW CARRIES THE SIGNAL. A pasted command sits at the start of a
 * line, or after a shell operator that chains it to one. A command word in the
 * middle of a sentence is how people write about the tools they use all day.
 * Shapes that are unambiguous wherever they appear -- substitution, a pipe into
 * a shell, a recursive remove -- are still caught in any position.
 */

/** Unambiguous wherever they appear: no sentence contains these by accident. */
const ALWAYS = [
  ['substitution', /\$\([^)]*\)/],
  ['backtick-substitution', /`[^`\n]+`/],
  ['script-tag', /<script\b/i],
  ['pipe-to-shell', /\|\s*(sh|bash|zsh|pwsh|powershell)\b/i],
  ['recursive-remove', /\brm\s+-[a-z]*[rf]/i],
  ['privilege-escalation', /(^|[\s;&|])sudo\s+\S/i],
];

/** Words that are only a command when they START a command. */
const COMMANDS =
  'rm|curl|wget|chmod|chown|kill|scp|ssh|nc|eval|exec|git|npm|npx|node|python|bash|sh|powershell|pwsh|cmd';

/**
 * Command-SHAPED, not merely command-adjacent: a flag, a path, a URL, a quoted
 * argument, or a redirect. "npm run verify" qualifies; "npm is the package
 * manager" does not.
 *
 * ═══ A STALE BUILD SERVES THE REMOTE CONNECTOR — MEASURED 2026-09-16 ═══
 *
 * I first wrote this block claiming the deployed EDGE FUNCTION had drifted from
 * this file. That was wrong, it was inferred from black-box probes, and it was
 * committed. Corrected here from the actual bytes:
 *
 *   The Supabase edge function is at VERSION 21, and the guard region in its
 *   `_shared.js` is normalised-IDENTICAL to this file, 1132 characters each.
 *   Running the deployed code against the four probe bodies returns null for
 *   all four, exactly as this file does. It would have accepted every one.
 *   `check-deployed-instructions.mjs` also reports INSTRUCTIONS agree, 21
 *   sentences, both sides -- the first clean result that gate has produced.
 *
 * SO THE REFUSALS CAME FROM SOMEWHERE ELSE, and the refusal text says where.
 * The message a remote client receives ends at "nobody audited" and is
 * byte-identical to the text at f06b57e^. The version in this file and in the
 * deployed function appends `Matched <rule> on <token>`, added by f06b57e on
 * 2026-09-16 06:39Z -- the commit that fixed exactly this over-broad rule after
 * it refused sixteen ordinary paragraphs in one morning.
 *
 * The Cloudflare worker is not the culprit either: it is a pure proxy.
 * `callDataPlane` forwards the JSON-RPC body to `env.DATA_PLANE_URL` and
 * returns the response verbatim. It contains no guard at all.
 *
 * THEREFORE `DATA_PLANE_URL` RESOLVES TO A BUILD OLDER THAN f06b57e, and it is
 * not the version-21 function. There is a third serving surface behind the two
 * in CLAUDE.md's table, its address lives in a Cloudflare secret and in no
 * file, and it is the one every remote MCP client actually talks to. That is
 * the same defect the table itself describes: a thing that works and cannot be
 * found.
 *
 * NOTHING IN THIS REPOSITORY NEEDS CHANGING FOR IT. f06b57e is on origin/master
 * and on work/support-modules. The fix is not missing; it is unshipped to that
 * endpoint. Repointing the variable or redeploying what it serves closes it,
 * and neither is a code change.
 *
 * Until then a report naming a tool by name may simply not arrive, and the
 * sender is told the body looks like a command rather than which word did it.
 * It has cost three messages across two agents.
 *
 */
const ARGUMENT = String.raw`(-{1,2}[a-z]|[./~]|[a-z]+:\/\/|["']|\w+\s+-{1,2}[a-z]` +
  // a runner naming a package and then an action: "npx wrangler deploy"
  String.raw`|[\w@/-]+\s+(deploy|install|run|publish|start|build|test)\b` +
  String.raw`|(deploy|install|run|publish|start|build|test)\b)`;

/** At the start of a line, allowing indentation and a shell prompt. */
const AT_LINE_START = new RegExp(
  String.raw`^[ \t]*[$>#]?[ \t]*(${COMMANDS})\s+${ARGUMENT}`,
  'im',
);

/** Or chained after an operator, which is a command position wherever it sits. */
const AFTER_OPERATOR = new RegExp(String.raw`[;&|]{1,2}\s*(${COMMANDS})\s+${ARGUMENT}`, 'i');

/** A statement, not a sentence containing a verb that is also a keyword. */
const SQL_STATEMENT = new RegExp(
  String.raw`^[ \t]*(drop|delete|truncate|alter|insert|update)\s+(table|from|into)\b`,
  'im',
);

/**
 * What matched, and where. The refusal already knows this; withholding it is
 * what turned a one-second correction into a morning of bisection.
 */
export function executableMatch(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();

  for (const [rule, re] of ALWAYS) {
    const m = re.exec(t);
    if (m) return { rule, token: m[0].slice(0, 40) };
  }
  for (const [rule, re] of [
    ['command-at-line-start', AT_LINE_START],
    ['command-after-operator', AFTER_OPERATOR],
    ['sql-statement', SQL_STATEMENT],
  ]) {
    const m = re.exec(t);
    if (m) return { rule, token: m[0].trim().slice(0, 40) };
  }
  return null;
}

export function looksExecutable(text) {
  return executableMatch(text) !== null;
}

/**
 * AN AGENT ID IS A SLUG, AND A NAME NOBODY ANSWERS TO IS A BLACK HOLE.
 *
 * Measured on the live log, 98 messages: ten distinct identity strings for what
 * are actually six actors. The coordinator alone sent under four names --
 * "chatgpt", "chatgpt-command-center", "chatgpt-work" and "chatgpt-work
 * coordinator" -- and two names, code-b and b6, had received twenty-nine
 * messages between them while having sent none, ever.
 *
 * Nothing was broken in the sense of erroring. Every one of those sends
 * returned ok, because the only rule was that the field was non-empty. A typo
 * or a variant silently opens a new mailbox that nobody reads, and the sender
 * is told it worked. One lane spent a whole morning writing to a name the
 * recipient was not listening on, and neither side saw a reply.
 *
 * THE SHAPE RULE COSTS NOTHING AND CATCHES THE VARIANT WITH A SPACE IN IT.
 * Every real id here is a slug. "chatgpt-work coordinator" is a description
 * that got into an identifier field, and it is refused now.
 *
 * THE REGISTRY RULE IS THE REAL ONE and needs the live roster, so it applies
 * only when a caller supplies it. Note the two outcomes are NOT the same:
 * an UNKNOWN name is a mistake and is refused, while a KNOWN but offline agent
 * is a normal thing to write to -- queued work for a worker that is restarting
 * is the whole point of a durable channel. resolveLiveAgent already draws
 * exactly that distinction for assignment; messages simply never used it.
 */
/**
 * THE CANONICAL ROSTER, AND WHY AN ALIAS TABLE IS NOT BUREAUCRACY.
 *
 * A REGISTRY RULE WITHOUT ALIASES WOULD HAVE SEVERED THE ONE WORKING CHANNEL.
 * The rule committed earlier today refuses a recipient that is not in the live
 * roster. The live roster is built from daemon heartbeats, so it holds code-b,
 * code-c, code-d and b6 and nothing else. Every message code-c has ever sent
 * upward went to "chatgpt-work", which no daemon registers and which that rule
 * would therefore have refused the moment its call site started passing live
 * sessions. The fix was written to stop messages vanishing and would instead
 * have stopped them being sent. Its positive control did not catch this because
 * it asserted the SHAPE rule against the real ids and the REGISTRY rule against
 * an invented roster that contained the coordinator -- a fixture that could not
 * construct the real case, so it could not fail for it.
 *
 * REGISTRATION IS NOT EXISTENCE. A coordinator and an owner are actors with no
 * daemon and no worktree; they are addressed constantly and heartbeat never.
 * Absence from the heartbeat roster means "not running", which for a worker is
 * information and for a coordinator is just how coordinators are.
 *
 * SO IDENTITY RESOLVES BEFORE IT IS CHECKED. Ten identity strings were in use
 * for six actors, and the coordinator seat alone answered to four. Renaming by
 * decree loses the mail addressed to the old name; the alias table keeps every
 * historical string routable while there is one canonical id per seat.
 *
 * WHAT IS RECORDED HERE AND WHAT IS NOT. The letters are the owner's decision
 * ledger, not an inference: d-owner-team-order-20260915 fixes the team as
 * C, B, D, A, and d-owner-identity-a-20260915 states that b6 is Agent A. Those
 * are recorded owner words. Identity is NEVER inferred from a branch, a
 * worktree or a session name -- b6 runs in a worktree called wt-release-verify
 * and that says nothing about who b6 is.
 */
export const ACTORS = [
  { actor_id: 'code-c', actor_type: 'worker', display_name: 'C', aliases: ['c'] },
  /*
   * b6 IS CODE-A, AND THIS TABLE SAID OTHERWISE FOR MOST OF A DAY.
   *
   * The ledger moved three times and I followed it one step behind each time:
   *   d-owner-identity-a-20260915    "b6 is Agent A."      superseded
   *   d-owner-identity-b6-20260916   "b6 is b"             superseded
   *   d-owner-identity-b6-20260916b  "b6 is code-a"        ACTIVE, 08:30:48Z
   *
   * I built the whole alias layer on the middle one AT 09:24Z -- fifty-four
   * minutes after it had already been superseded. Nothing was wrong with the
   * ledger; I stopped reading it and started working from what I remembered it
   * saying. Code C caught this by going back to the source when my instruction
   * and the record disagreed, which is the behaviour this file exists to support
   * and which I had stopped practising myself.
   *
   * SO THE DECISION IS READ, NOT REMEMBERED. Anyone changing this table checks
   * get_owner_decisions first and matches the ACTIVE row; a superseded statement
   * still reads perfectly true on its own, which is exactly why quoting the one
   * you happen to recall is not evidence.
   *
   * THE SEAT IS OCCUPIED, WHICH MATTERS MORE THAN THE NAME. A liveness check
   * answers "is anybody running under this id". Ownership asks "does this id
   * belong to somebody". They differ precisely when a worker is offline -- b6 is
   * offline right now -- and taking a free-looking seat is how two workers end up
   * with one name the moment the sleeper wakes.
   */
  { actor_id: 'code-a', actor_type: 'worker', display_name: 'A', aliases: ['a', 'b6'] },
  { actor_id: 'code-b', actor_type: 'worker', display_name: 'B', aliases: ['b'] },
  { actor_id: 'code-d', actor_type: 'worker', display_name: 'D', aliases: ['d'] },
  {
    actor_id: 'c8',
    actor_type: 'coordinator',
    display_name: 'Work lane / execution lead',
    aliases: ['claude-work', 'chatgpt-work', 'chatgpt-work-coordinator'],
  },
  {
    actor_id: 'chatgpt',
    actor_type: 'coordinator',
    display_name: 'Command center',
    aliases: ['chatgpt-command-center'],
  },
  { actor_id: 'danny', actor_type: 'owner', display_name: 'Danny', aliases: ['owner'] },
];

/**
 * An alias resolves to its canonical id; anything else is returned unchanged.
 *
 * Unchanged rather than null on purpose: this function answers "what is this
 * called canonically", and refusing an unknown name is a DIFFERENT question
 * that validateMessage asks against the roster. Folding the two would make an
 * unknown recipient indistinguishable from an unaliased one.
 */
export function canonicalActor(value, actors = ACTORS) {
  if (!nonEmpty(value)) return null;
  const want = value.trim().toLowerCase();
  for (const a of arr(actors)) {
    if (!a) continue;
    if (String(a.actor_id).toLowerCase() === want) return a.actor_id;
    if (arr(a.aliases).some((x) => String(x).toLowerCase() === want)) return a.actor_id;
  }
  return value.trim();
}

/**
 * Every id a message may be addressed to: the live roster PLUS the declared
 * actors that have no daemon. Canonical ids only -- the caller canonicalises
 * first, so an alias is never separately listed as a name you could have meant.
 */
export function knownActorIds(sessions, actors = ACTORS) {
  const ids = new Set();
  for (const s of arr(sessions)) if (s?.agent_id) ids.add(canonicalActor(s.agent_id, actors));
  for (const a of arr(actors)) if (a?.actor_type !== 'worker') ids.add(a.actor_id);
  return [...ids].sort();
}

/**
 * EVERY STRING AN ACTOR MUST POLL TO SEE ALL OF ITS OWN MAIL.
 *
 * CANONICALISING ON THE WAY IN IS ONLY HALF OF IT, AND THE HALF I HAD DONE.
 * A message is stored under the literal recipient string it was sent with, and a
 * reader asks for its own id. So folding b6 into code-b fixes what a SENDER may
 * write and fixes nothing about what B can READ: mail addressed to code-b sits
 * in a string the live b6 session never queries, and mail addressed to b6 sits
 * in one the other registration never queries. That is how one actor with two
 * registrations ends up with nineteen unread in one pile and ten in the other.
 *
 * Until every reader expands its own aliases, a canonical id is the RIGHT name
 * and not always the REACHABLE one, and the two have to be said separately
 * rather than hoped to coincide.
 */
export function inboxNames(value, actors = ACTORS) {
  const id = canonicalActor(value, actors);
  if (!id) return [];
  const actor = arr(actors).find((a) => a?.actor_id === id);
  if (!actor) return [id];
  return [...new Set([actor.actor_id, ...arr(actor.aliases)])];
}

/**
 * The line every message opens with, naming who is speaking and what that is worth.
 *
 * WRITTEN BECAUSE THE TEAM READ MY MESSAGES AS DANNY'S. Four handoffs went out
 * this morning and came back reported as instructions from the owner. The
 * envelope carries from_agent correctly; whatever surfaces these to a worker
 * does not show it, so the body is the only place provenance survives, and a
 * body that does not say who is speaking gets attributed to whoever pasted it.
 *
 * THIS IS NOT A COURTESY, IT IS THE AUTHORITY BOUNDARY. An owner decision is
 * recorded, superseded rather than edited, and binding. A coordinator handoff is
 * prose with no authority at all, and the entire decision ledger is worthless if
 * the two are indistinguishable on arrival -- a worker that takes coordination
 * for a ruling has been given an owner it never checked. Advisory text must
 * never be able to become authority just by being read.
 */
export function messagePreamble(from, actors = ACTORS) {
  const id = canonicalActor(from, actors);
  const actor = arr(actors).find((a) => a?.actor_id === id);
  const kind = actor?.actor_type ?? 'unknown';
  const weight = kind === 'owner'
    ? 'This is the owner speaking. It is binding, and it is in the decision ledger.'
    : 'This is coordination and carries NO owner authority. Only the decision '
      + 'ledger does. If it reads like a ruling from Danny, it is not one.';
  return `[from ${id ?? 'unknown'} -- ${kind}] ${weight}`;
}

/**
 * A SESSION MAY NOT REGISTER UNDER ANOTHER ACTOR'S NAME.
 *
 * MEASURED, NOT IMAGINED. `social-sparks-app-c8` registered as agent `code-b`
 * at 07:49Z, two minutes before this lane first signed as c8. Everything
 * downstream then recorded B's work under a string that reads as mine --
 * `t-loop-proof` is stored with `returned_by: social-sparks-app-c8`, which is
 * the first end-to-end loop this system ever ran, attributed on its face to the
 * wrong actor.
 *
 * NOTHING WAS WRONG IN THE DATA. The registration correctly maps that session
 * to code-b, so a resolver gets the right answer. The damage is to every human
 * and every log line that reads the session id and believes it, which is most
 * of them -- an identifier that lies is worse than one that is missing, because
 * a missing one gets looked up.
 *
 * WHY THE LAST SEGMENT AND NOT THE WHOLE STRING. These ids are
 * `<where-it-was-launched>-<which-session>`, and the prefix is a machine or a
 * repository. `danny-win-10` legitimately begins with the OWNER's id; refusing
 * on any segment would reject the three sessions that have worked all week and
 * teach everyone to switch the check off. The suffix is the part that names the
 * session, and it is the part that collided.
 *
 * AN ALIAS OF YOUR OWN ACTOR IS FINE, and this is the case that shows the rule
 * is about identity rather than about strings: `social-sparks-app-b6`
 * registering as `code-b` is correct, because `b6` IS code-b by
 * d-owner-identity-b6-20260916. The same table that resolves a recipient
 * answers this, so the two cannot drift apart.
 */
export function validateSessionId(sessionId, agentId, actors = ACTORS) {
  const shape = validateAgentId(sessionId, 'session_id');
  if (shape) return shape;

  const segments = String(sessionId).trim().toLowerCase().split(/[-_.]/).filter(Boolean);
  const suffix = segments[segments.length - 1];
  if (!suffix) return null;

  const claimed = canonicalActor(suffix, actors);
  const mine = nonEmpty(agentId) ? canonicalActor(agentId, actors) : null;

  /*
   * canonicalActor returns the input unchanged for a name it does not know, so
   * a suffix only "claims" an actor when it resolved to a DIFFERENT id than the
   * one it started as -- that is what distinguishes `c8` from `10` or `f1`.
   */
  const isAnActor = arr(actors).some(
    (a) => a?.actor_id === claimed
      && (String(a.actor_id).toLowerCase() === suffix
        || arr(a.aliases).some((x) => String(x).toLowerCase() === suffix)),
  );
  if (!isAnActor) return null;
  if (mine !== null && claimed === mine) return null;

  return `session_id ${JSON.stringify(sessionId)} ends in ${JSON.stringify(suffix)}, which is `
    + `${claimed}${mine ? `, not ${mine}` : ''}. A session named after another actor makes every `
    + 'log line and every returned-by field attribute this work to somebody who did not do it';
}

export const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function validateAgentId(value, field) {
  if (!nonEmpty(value)) return `${field} is required`;
  if (!AGENT_ID.test(value.trim())) {
    return `${field} ${JSON.stringify(value)} is not an agent id: ids are slugs, `
      + 'so a space or punctuation usually means a description reached an identifier field';
  }
  return null;
}

/**
 * Validate a structured message.
 *
 * Fixed fields only. There is no free-form envelope, no attachment, and no
 * field whose contents are interpreted by anything.
 */
export function validateMessage(m = {}, { sessions = null } = {}) {
  const errors = [];

  const fromBad = validateAgentId(m.from_agent, 'from_agent');
  if (fromBad) errors.push(fromBad);
  const toBad = validateAgentId(m.to_agent, 'to_agent');
  if (toBad) errors.push(toBad);

  /*
   * An unknown recipient is refused; a known one that is offline is fine and is
   * reported as a note rather than an error, because queueing work for a worker
   * that is restarting is what a durable channel is for.
   */
  if (!toBad && Array.isArray(sessions)) {
    const to = canonicalActor(m.to_agent);
    const roster = knownActorIds(sessions);
    if (!roster.includes(to)) {
      errors.push(
        `to_agent ${JSON.stringify(m.to_agent)} is not a known actor, so nothing would `
          + `ever read it. Known actors: ${roster.join(', ') || '(none)'}`,
      );
    }
  }
  if (!MESSAGE_TYPES.includes(m.type)) {
    errors.push(`type must be one of ${MESSAGE_TYPES.join(', ')}`);
  }
  if (!nonEmpty(m.body)) errors.push('body is required');
  else if (m.body.length > 8000) errors.push('body exceeds 8000 characters');
  else {
    /*
     * NAME WHAT MATCHED. The old refusal said only that the body looked like a
     * command, which sent readers looking for executable text in paragraphs
     * that had none. The guard knows the token and the rule; saying so turns a
     * dead end into a correction.
     */
    const hit = executableMatch(m.body);
    if (hit) {
      errors.push(
        `body looks like a command rather than a message: a coordination channel that `
          + `carries executable text is a remote shell nobody audited. Matched ${hit.rule} `
          + `on ${JSON.stringify(hit.token)} -- this is a LEXICAL match on the text, not a `
          + `judgement about intent, so rephrasing that fragment is enough`,
      );
    }
  }
  if (m.task_id != null && !nonEmpty(m.task_id)) errors.push('task_id must be a string when present');

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a DURABLE agent id to its one live session.
 *
 * ONE IMPLEMENTATION, SHARED BY THE CLI AND THE EDGE. laneRegistry.resolveWorker
 * answers the same question for a registry parsed from a YAML FILE, and its
 * input shape is different; bundling it to the edge would also drag a 188-line
 * YAML parser somewhere no file exists. So LIVE-registry resolution lives here,
 * where both callers already load it, rather than being written twice and
 * drifting the first time one is fixed.
 *
 * The three outcomes are the ones this system turns on everywhere: exactly one
 * live session resolves, none refuses, several refuse as ambiguous AND name the
 * candidates. Silently picking the newest would "work" and send the contract to
 * the wrong runtime, which is the failure the registry exists to prevent.
 *
 * @param {Array}  sessions  rows from registryFromSessions — capacity is already
 *                           staleness-adjusted there, so a stale row reads
 *                           'offline' and is excluded without a second clock.
 * @param {string} agent_id  the durable identity a person types
 */
export function resolveLiveAgent(sessions, agent_id) {
  if (!nonEmpty(agent_id)) return { ok: false, reason: 'no-agent-named', candidates: [] };
  const all = arr(sessions);

  // "Unknown" and "known but not running" are different answers, and a
  // coordinator needs to tell a typo from a worker that has gone away.
  if (!all.some((s) => s?.agent_id === agent_id)) {
    return { ok: false, reason: 'unknown-agent', candidates: [] };
  }

  const candidates = all.filter((s) => s?.agent_id === agent_id && s?.capacity !== 'offline');
  if (candidates.length === 0) return { ok: false, reason: 'no-live-session', candidates: [] };
  if (candidates.length > 1) {
    return { ok: false, reason: 'ambiguous-session', candidates: candidates.map((s) => s.session_id) };
  }

  const s = candidates[0];
  return {
    ok: true,
    agent_id,
    session_id: s.session_id,
    repo_id: s.repo_id ?? null,
    worktree_id: s.worktree_id ?? null,
    lane_id: s.lane_id ?? null,
    capacity: s.capacity ?? null,
    heartbeat_at: s.heartbeat_at ?? null,
  };
}

/**
 * MAY THIS TASK GO TO THIS WORKER, RIGHT NOW?
 *
 * Every refusal is separately reachable, and each is here because the
 * alternative is a specific, nameable failure:
 *
 *   no task / no worker      a contract addressed to nothing
 *   wrong state              re-assigning work somebody already holds
 *   unsatisfied dependency   starting work whose input does not exist yet
 *   upstream already done    burning a worker on work that is no longer needed
 *   not live / stale         a contract addressed to a machine that is gone
 *   ambiguous                the right agent, the wrong runtime
 *   repo or lane mismatch    correct work, wrong tree
 *   path collision           two workers editing the same file
 *   stale base               work branched from a commit master has moved past
 *
 * @param {object} task       the task row
 * @param {object} worker     resolved session {session_id, agent_id, repo_id, capacity, ...}
 * @param {object} context    {tasks, assignments, headSha, isLive}
 */
export function canAssign(task, worker, context = {}) {
  const errors = [];
  const tasks = arr(context.tasks);
  const assignments = arr(context.assignments);

  if (!task || !nonEmpty(task.task_id)) {
    return { ok: false, errors: ['no such task'] };
  }
  if (!worker || !nonEmpty(worker.session_id) || !nonEmpty(worker.agent_id)) {
    return { ok: false, errors: ['no resolved worker: the target must come from the live registry, not a typed name'] };
  }

  if (!ASSIGNABLE_FROM.includes(task.state)) {
    errors.push(`task is "${task.state}"; only ${ASSIGNABLE_FROM.join(' or ')} work can be assigned`);
  }

  /*
   * LIVENESS IS INJECTED, NOT ASSUMED. The caller passes the same isLive used
   * everywhere else; a guard with its own idea of "live" is a second answer to
   * a question that must have one.
   */
  const live = typeof context.isLive === 'function' ? context.isLive(worker) : null;
  if (live === null) errors.push('liveness was not evaluated: refusing rather than guessing');
  else if (!live) errors.push(`worker ${worker.session_id} is not live (capacity ${worker.capacity ?? 'unknown'})`);

  if (worker.capacity === 'offline') errors.push(`worker ${worker.session_id} declared itself offline`);

  // Repo and lane must match where the work actually is.
  if (nonEmpty(task.repo_id) && nonEmpty(worker.repo_id)
      && task.repo_id !== worker.repo_id) {
    errors.push(`task is in repo "${task.repo_id}" but ${worker.session_id} is in "${worker.repo_id}"`);
  }
  if (nonEmpty(task.lane_id) && nonEmpty(worker.lane_id)
      && task.lane_id !== worker.lane_id) {
    errors.push(`task is in lane "${task.lane_id}" but ${worker.session_id} holds lane "${worker.lane_id}"`);
  }

  // ── dependencies ────────────────────────────────────────────────────────
  const byId = new Map(tasks.map((t) => [t?.task_id, t]));
  for (const dep of arr(task.depends_on)) {
    const d = byId.get(dep);
    if (!d) {
      errors.push(`depends on "${dep}", which does not exist`);
    } else if (d.state !== 'accepted') {
      errors.push(`depends on "${dep}", which is "${d.state}" and not accepted`);
    }
  }

  /*
   * ALREADY-SATISFIED UPSTREAM. A task whose work another task has already
   * delivered is not runnable, it is finished -- assigning it spends a worker
   * on a diff that will come back empty, and the delegation lifecycle then
   * refuses the return because head equals base. Catching it here is the
   * difference between a refusal now and a wasted session.
   */
  if (nonEmpty(task.supersededBy)) {
    errors.push(`already satisfied by "${task.supersededBy}"`);
  }

  // ── path collisions against work already assigned ───────────────────────
  const mine = new Set([...arr(task.allowed_paths), ...arr(task.shared_paths)]);
  const forbidden = new Set(arr(task.forbidden_paths));
  for (const p of mine) {
    if (forbidden.has(p)) {
      // Precedence is forbidden > allowed, so an ambiguous contract fails
      // closed rather than granting the wider permission.
      errors.push(`path "${p}" is both allowed and forbidden: ambiguous contract`);
    }
  }

  for (const a of assignments) {
    if (!a || a.task_id === task.task_id) continue;
    if (!['assigned', 'returned'].includes(a.state)) continue;
    const theirs = new Set(arr(a.allowed_paths));
    for (const p of arr(task.allowed_paths)) {
      // SHARED paths are declared overlap and are allowed to collide; ALLOWED
      // paths are exclusive, and two workers holding one is the collision this
      // whole system exists to prevent.
      if (theirs.has(p) && !arr(a.shared_paths).includes(p) && !arr(task.shared_paths).includes(p)) {
        errors.push(`path "${p}" is already held by task "${a.task_id}" (${a.assigned_session ?? 'unassigned'})`);
      }
    }
  }

  // ── base freshness ──────────────────────────────────────────────────────
  if (nonEmpty(context.headSha) && nonEmpty(task.base_sha)
      && task.base_sha !== context.headSha) {
    errors.push(`base ${task.base_sha.slice(0, 12)} is stale; the tree is at ${context.headSha.slice(0, 12)}. `
      + 're-resolve the base rather than assigning work from a commit the tree has moved past');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The record written when an assignment is permitted.
 *
 * Provenance travels WITH the assignment rather than being reconstructed later:
 * who assigned it, to which runtime, and from which base. A coordinator that
 * cannot be traced is a coordinator nobody can audit.
 */
export function assignmentRecord(task, worker, { by, at }) {
  return {
    task_id: task.task_id,
    state: 'assigned',
    assigned_agent: worker.agent_id,
    assigned_session: worker.session_id,
    assigned_by: by,
    assigned_at: at,
  };
}

/**
 * ═══ CLOSING THE LOOP: RETURN, THEN ACCEPT ═══════════════════════════════════
 *
 * assign_task shipped alone, so the hosted plane could hand work out and had no
 * way to take it back. A coordinator that can only assign is a dispatcher with
 * no idea whether anything was done.
 *
 * WHO MAY MOVE A TASK, AND WHY IT MATTERS THAT THEY ARE DIFFERENT PEOPLE.
 *
 *   assign   coordinator   "do this"
 *   return   THE WORKER    "I did this, here is the commit"
 *   accept   coordinator   "I looked, it counts"
 *
 * The middle one is the worker's OWN testimony about its OWN work, and it is
 * the reason this is not simply three coordinator tools. A coordinator that
 * could record a return would be writing the worker's evidence for it, and the
 * accept that followed would be the same party on both sides of a review. The
 * whole point of a returned state is that somebody else put it there.
 *
 * That was the temptation worth naming: the quickest way to give a coordinator
 * an accept button is to let it mark work returned first. It would have closed
 * the loop on screen and proved nothing at all.
 */

/** Only work a worker has RETURNED can be accepted. */
export const ACCEPTABLE_FROM = ['returned'];

/** Terminal states. Nothing moves out of these. */
export const TERMINAL = ['accepted', 'cancelled'];

/**
 * MAY THIS WORKER RETURN THIS TASK?
 *
 * The worker names itself; the caller supplies the registry row it resolved to.
 * A return is only accepted for the session the task was ASSIGNED to, so a
 * worker cannot return somebody else's work -- by accident or otherwise.
 */
export function canReturn(task, worker, { headSha } = {}) {
  const errors = [];

  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };
  if (!worker || !nonEmpty(worker.session_id)) {
    return { ok: false, errors: ['no resolved worker: a return must come from a registered session'] };
  }

  if (task.state !== 'assigned') {
    errors.push(`task is "${task.state}"; only assigned work can be returned`);
  }

  /*
   * THE SESSION MUST MATCH, NOT THE AGENT.
   *
   * Matching on agent_id alone would let any session claiming to be code-b
   * return code-b's work, and sessions are exactly what this registry exists to
   * tell apart. The agent is checked too, so a session id reused under a new
   * identity cannot inherit the assignment.
   */
  if (nonEmpty(task.assigned_session) && task.assigned_session !== worker.session_id) {
    errors.push(`task is assigned to session "${task.assigned_session}", not "${worker.session_id}"`);
  }
  if (nonEmpty(task.assigned_agent) && nonEmpty(worker.agent_id)
      && task.assigned_agent !== worker.agent_id) {
    errors.push(`task is assigned to agent "${task.assigned_agent}", not "${worker.agent_id}"`);
  }

  /*
   * A RETURN CARRIES A COMMIT OR IT IS NOT A RETURN.
   *
   * "Done" with no sha is a claim nobody can check, and it is the shape every
   * unverifiable status update in this project has taken. The reviewer needs
   * something to look at.
   */
  if (!nonEmpty(headSha)) {
    errors.push('a return requires the head sha of the work, resolved through git and never typed');
  } else if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    errors.push('head sha must be a full 40-character sha');
  }

  return { ok: errors.length === 0, errors };
}

/** The record written when a return is permitted. */
export function returnRecord(task, worker, { headSha, notes = null, at }) {
  return {
    task_id: task.task_id,
    state: 'returned',
    returned_by: worker.session_id,
    returned_at: at,
    returned_head_sha: headSha,
    returned_notes: nonEmpty(notes) ? notes : null,
  };
}

/**
 * MAY THIS BE ACCEPTED?
 *
 * Acceptance is the coordinator's own act and needs no worker, but it refuses
 * on a task nobody returned -- accepting straight from `assigned` would be
 * signing off work that was never handed in.
 */
export function canAccept(task, { at } = {}) {
  const errors = [];

  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };

  if (TERMINAL.includes(task.state)) {
    errors.push(`task is already "${task.state}"`);
  } else if (!ACCEPTABLE_FROM.includes(task.state)) {
    errors.push(`task is "${task.state}"; only returned work can be accepted`
      + ' — accepting unreturned work signs off something nobody handed in');
  }

  // The sha the worker returned is what is being accepted. Without it there is
  // nothing to point at afterwards and "accepted" means only that somebody said so.
  if (task.state === 'returned' && !nonEmpty(task.returned_head_sha)) {
    errors.push('the return carries no head sha, so there is nothing to accept');
  }

  if (!nonEmpty(at)) errors.push('a timestamp is required');

  return { ok: errors.length === 0, errors };
}

export function acceptRecord(task, { by, at }) {
  return {
    task_id: task.task_id,
    state: 'accepted',
    accepted_by: by,
    accepted_at: at,
    // The accepted sha is pinned from the RETURN, never re-read at accept time:
    // the reviewer accepted a specific commit, and the branch may have moved on
    // between the review and the click.
    accepted_head_sha: task.returned_head_sha ?? null,
  };
}

/**
 * MAY THIS BE CANCELLED?
 *
 * Cancelling accepted work would erase a completed contract rather than
 * withdraw an outstanding one, so it is refused; supersede it instead.
 */
export function canCancel(task, { reason } = {}) {
  const errors = [];
  if (!task || !nonEmpty(task.task_id)) return { ok: false, errors: ['no such task'] };
  if (TERMINAL.includes(task.state)) {
    errors.push(`task is already "${task.state}" and cannot be cancelled`);
  }
  if (!nonEmpty(reason)) {
    errors.push('a reason is required: a task that vanishes without one is indistinguishable from a bug');
  }
  return { ok: errors.length === 0, errors };
}

export function cancelRecord(task, { by, at, reason }) {
  return {
    task_id: task.task_id,
    state: 'cancelled',
    cancelled_by: by,
    cancelled_at: at,
    cancelled_reason: reason,
  };
}
