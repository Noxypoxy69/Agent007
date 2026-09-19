import { detectCollisions } from '../bridge/collisions.mjs';
// Pure: no node builtins, no clock, no filesystem. Safe on the edge, which is
// why the resolution rules live in their own module rather than in the CLI.
import { resolveOwnerDecision, activeDecisions } from '../src/ownerDecisions.mjs';
// The SHARED staleness window. Imported rather than restated so this surface
// cannot answer "is this agent alive" differently from the rest of the system.
import { STALE_AFTER_MS } from '../src/liveRegistry.mjs';

/**
 * THE TOOLS, ONCE, FOR EVERY TRANSPORT.
 *
 * They used to live inside buildMcpServer, registered directly on the SDK's
 * McpServer. That was fine while every consumer was Node: stdio and the node
 * bridge both hand the SDK a req/res pair.
 *
 * A Cloudflare Worker cannot. StreamableHTTPServerTransport is written against
 * node's IncomingMessage and ServerResponse, and a Worker has neither -- it has
 * Request and Response. The choices were to reimplement the tools for the edge,
 * or to keep the SDK out of the definitions so both transports consume the same
 * source. Reimplementing is how the hosted surface and the local one start
 * answering differently about the same machine, which is the failure this whole
 * project keeps designing against.
 *
 * So: no SDK import here, no zod, no node builtins. Pure definitions over an
 * injected store, plus JSON Schema that the SDK path converts to zod and the
 * Worker serves verbatim.
 *
 * INPUT SCHEMAS ARE JSON SCHEMA, NOT ZOD, and that direction is deliberate.
 * JSON Schema is what the MCP wire protocol carries, so the Worker needs no
 * conversion at all; the SDK path converts once, in tools.mjs, where a
 * conversion bug fails loudly against the SDK's own validation. Declaring zod
 * here and generating JSON Schema would put the lossy step on the edge path,
 * which is the one nobody can attach a debugger to.
 *
 * READ-ONLY. Nothing here mutates, assigns work, or reaches the machine.
 * Adding a write tool is a decision with its own threat model, not a quiet
 * extension of this file.
 */

/** MCP tool results are content arrays; every tool here returns one JSON blob. */
export const jsonResult = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/**
 * The one instruction a hosted client ever receives.
 *
 * Lives beside the tools rather than in a README because a rule nobody
 * connected to the server can read is not a rule.
 */
/**
 * THE AUTHORITY PARAGRAPH IS DERIVED FROM THE TOOL LIST, NOT WRITTEN BESIDE IT.
 *
 * This file used to open with a flat "This server is read-only: it cannot assign
 * tasks, send messages, or run commands" -- and defines assign_task,
 * send_message and record_owner_decision further down, registered when the store
 * provides the write methods. Both statements were true when written. The file
 * changed underneath the sentence.
 *
 * The hosted copy in _shared.js was corrected for exactly this and explains
 * itself: "saying 'this server is read-only' to a coordinator that can in fact
 * assign work would be the server lying about its own authority." Somebody fixed
 * the lie on one surface and the other kept telling it, which is how
 * test/toolDefsParity.test.mjs found it -- nothing had ever compared the two
 * contracts, only the tool descriptions.
 *
 * COPYING THE CORRECTED TEXT ACROSS WOULD HAVE BEEN WRONG TOO, and that is the
 * part worth keeping. The hosted surface decides scope by TOKEN; this one
 * decides by STORE SHAPE, and a deployment that injects a read-only store really
 * does serve a read-only server. One fixed sentence would be false somewhere,
 * whichever one we picked.
 *
 * So it is chosen by the same thing that decides whether the tool exists. The
 * predicate is the presence of assign_task IN THE BUILT LIST rather than the
 * shape of the store, because the list is literally what the client receives:
 * text and capability are then two readings of one fact, and disagreement is not
 * expressible rather than merely absent today.
 */
/*
 * THIS PARAGRAPH USED TO CLAIM MORE THAN THE SERVER DELIVERS, and the claim was
 * the strongest kind: "Every field is observed from git plumbing and the process
 * table on the developer machine, not reported by the agents themselves, so an
 * agent cannot misreport its own state here."
 *
 * On the node collector that is true. On the hosted surface it is false for
 * eight fields. index.ts projects agentId, lane, machineLabel, worktree,
 * capacity, sessionId, repoId and git.head straight out of
 * `session_registrations`, a table its own comment describes as "populated
 * entirely from the POST /register body" and stamps `runtime-self-registration`.
 * Those are exactly the fields an agent would want to lie about — which lane it
 * is in, which worktree it holds, whether it has capacity.
 *
 * Telling a reader "an agent cannot misreport its own state here" while handing
 * it self-reported state is worse than saying nothing, because it discourages
 * the scepticism that would otherwise catch the lie. Found by blind audit.
 *
 * SO THE SENTENCE NOW SEPARATES THE TWO, rather than being narrowed to
 * uselessness or forked per transport. A reader can weigh a field by where it
 * came from, which is the thing the original sentence was reaching for and
 * overshot. Nulling the four unmeasurable fields (10fcb31) made a different
 * half of this paragraph true; this is the remaining half.
 */
const PREAMBLE =
  'Live engineering state for multi-agent Git worktrees. WHERE A FIELD CAME FROM DECIDES HOW ' +
  'MUCH IT IS WORTH, AND THIS SERVER WILL NOT PRETEND OTHERWISE. Dirty files, locks and ' +
  'running processes, when present, are OBSERVED from git plumbing and the process table, so ' +
  'an agent cannot misreport them. EVERYTHING ELSE IS SELF-REPORTED at registration and is ' +
  'only as honest as the agent that registered — agent id, session id, lane, repo, worktree, ' +
  'machine, declared capacity, AND THE COMMIT SHA, which the worker derived from git on its ' +
  'own machine and then told us. A HEAD here is a claim about a measurement, not a ' +
  'measurement. Fields that could not be determined are null — treat null as unknown, never ' +
  'as zero.\n\n';

const AUTHORITY_READER =
  'THIS CONNECTION IS READ-ONLY, AND THAT IS A PROPERTY OF YOUR TOOL LIST RATHER THAN A ' +
  'PROMISE ABOUT THE SERVER. Nothing you can call assigns work, sends a message, or records a ' +
  'decision: those tools are ABSENT from tools/list, not present and refusing. A caller with ' +
  'more authority sees a longer list than yours. If you expected a tool and it is not listed, ' +
  'you do not have it — that is not a temporary condition to retry or work around.\n\n';

const AUTHORITY_WRITER =
  'WHAT THIS SERVER CAN DO DEPENDS ON YOUR SCOPE, AND THE TOOL LIST IS THE ANSWER. This ' +
  'connection carries write tools: assign_task, send_message and record_owner_decision are in ' +
  'your list and they act. A read-only caller sees none of them. If a tool is not in ' +
  'tools/list you do not have it — that is not a temporary condition to retry or work around. ' +
  'This text said "this server is read-only" for as long as that was true of every caller, ' +
  'and saying it to someone who can in fact assign work would be the server lying about its ' +
  'own authority.\n\n';

const ABSENT_AT_EVERY_SCOPE =
  'WHAT IS ABSENT AT EVERY SCOPE, INCLUDING A WRITER: shell, SQL, file writes, deploy, merge, ' +
  'command execution. A message body is prose for a person or an agent to READ and is never ' +
  'executed by anything. There is no path from this server to a command on any machine.\n\n';

const GUIDANCE =
  'QUERY THIS SERVER BEFORE ASKING A PERSON. Branches, HEADs, bases, worktrees, locks and ' +
  'running processes are all here and are authoritative. Do not ask the operator to paste a ' +
  'status brief or a file list; call the tool. A pasted summary is a stale copy of something ' +
  'this server holds live.\n\n' +
  'THEN SPEAK ONLY TO WHAT CHANGED. Report deltas, decisions, anomalies and unresolved risk. ' +
  'Do not restate state you just read — reference the agent or task id instead and let the ' +
  'reader query it.\n\n' +
  'EXCEPT FOR EVIDENCE, WHICH IS NEVER ABBREVIATED. Security findings, failed gates, mutation ' +
  'results, contract violations, ambiguous provenance and unresolved risk are reported in full ' +
  'every time. Brevity applies to restating known state, never to the proof that something was ' +
  'actually checked. A short report that drops evidence is worse than a long one that carries it.';

/**
 * The contract for THIS connection, given the tools it will actually be handed.
 *
 * @param {Array<{name:string}>} defs  the built tool list, as returned by toolDefs()
 */
export function instructionsFor(defs = []) {
  const writes = Array.isArray(defs) && defs.some((d) => d?.name === 'assign_task');
  return PREAMBLE + (writes ? AUTHORITY_WRITER : AUTHORITY_READER) + ABSENT_AT_EVERY_SCOPE + GUIDANCE;
}

/**
 * The read-only contract, kept as a named export because callers and tests
 * import it. It is now DERIVED rather than written out, so it cannot drift from
 * the reader branch of instructionsFor -- which is the failure this whole change
 * is about, one layer smaller.
 */
export const INSTRUCTIONS = instructionsFor([]);

const OUTSTANDING = ['assigned', 'rejected'];
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });

/**
 * @param {object} store  listSessions() and getLanes() required;
 *                        listDelegations() optional — see the tail of this file.
 * @returns {Array<{name,title,description,input,run}>}
 */
export function toolDefs(store) {
  if (!store || typeof store.listSessions !== 'function' || typeof store.getLanes !== 'function') {
    throw new TypeError('toolDefs(store): store must provide listSessions() and getLanes()');
  }
  const { listSessions, getLanes, listDelegations, listDecisions } = store;

  const defs = [
    {
      name: 'list_agents',
      title: 'List agents',
      description: 'All registered agents with lane, branch, HEAD, and staleness. Start here.',
      input: obj(),
      /*
       * sessionId, repoId, worktree and capacity are projected here so this one
       * tool answers the whole "who is running and where" question. They were
       * absent, which forced `agentbridge workers` to read the database
       * directly with a service key to get facts this tool already had -- and
       * that key is the thing the registration write path exists to eliminate.
       *
       * A worker on a machine that has not adopted session registration reports
       * null for these rather than being hidden: unknown and absent are
       * different answers.
       */
      run: async () => jsonResult((await listSessions()).map((s) => ({
        agentId: s.agentId, lane: s.lane, machine: s.machineLabel,
        sessionId: s.sessionId ?? null,
        repoId: s.repoId ?? null,
        worktree: s.worktree ?? null,
        capacity: s.capacity ?? null,
        branch: s.git?.branch ?? null, head: s.git?.head ?? null,
        baseSha: s.git?.baseSha ?? null,
        unpushed: s.git?.unpushed ?? null,
        /*
         * NULL IS UNKNOWN. `(s.git?.dirty ?? []).length` reports 0 for a
         * session nobody measured, which is indistinguishable from a clean
         * tree, and the same for locks and processes. The hosted surface was
         * corrected for this; the node twin was not, so one connection could
         * answer `running: []` from list_agents and `processes: null` from
         * list_active_processes about the same session in the same breath.
         *
         * The parity gate compares DECLARATIONS -- descriptions and schemas --
         * and says so itself, so it was green across this the whole time. Two
         * tools contradicting each other about one fact is not something a
         * declaration comparison can see.
         */
        dirtyFiles: Array.isArray(s.git?.dirty) ? s.git.dirty.length : null,
        locksHeld: Array.isArray(s.locks) ? s.locks.map((l) => l.resource) : null,
        running: Array.isArray(s.processes) ? s.processes.map((p) => p.kind) : null,
        lastSeenAt: s.lastSeenAt,
      }))),
    },
    {
      name: 'get_agent_state',
      title: 'Get agent state',
      description: 'Full snapshot for one agent: git state, locks, processes, file lists.',
      input: obj({ agentId: { type: 'string', description: 'e.g. "code-c"' } }, ['agentId']),
      run: async ({ agentId }) => {
        const s = (await listSessions()).find((x) => x.agentId === agentId);
        return jsonResult(s ?? { error: 'no such agent', agentId });
      },
    },
    {
      name: 'list_worktrees',
      title: 'List worktrees',
      description: 'Worktree paths and which agent is registered to each.',
      input: obj(),
      run: async () => jsonResult((await listSessions()).map((s) => ({
        worktree: s.worktree, agentId: s.agentId, lane: s.lane, branch: s.git?.branch ?? null,
      }))),
    },
    {
      name: 'get_git_state',
      title: 'Get git state',
      description: 'Branch, HEAD, merge-base, origin/main, upstream, unpushed count, ahead/behind.',
      input: obj({ agentId: { type: 'string', description: 'omit for all agents' } }),
      run: async ({ agentId } = {}) => {
        const all = await listSessions();
        return jsonResult((agentId ? all.filter((s) => s.agentId === agentId) : all)
          .map((s) => ({ agentId: s.agentId, lane: s.lane, ...(s.git ?? {}) })));
      },
    },
    {
      name: 'list_active_processes',
      title: 'List active processes',
      description:
        'Verify/test/lint/agent processes associated with each worktree. `confidence:"cwd"` is ' +
        'an exact match; `"commandline"` is a substring match and can miss processes. ' +
        'processProbeOk is TRUE only when a probe actually ran: false means it ran and failed, ' +
        'null means this surface never looked. Unless it is true, an empty list does NOT mean ' +
        'nothing is running.',
      input: obj(),
      run: async () => jsonResult((await listSessions()).map((s) => ({
        /*
         * `!== false` COERCED AN UNKNOWN INTO A CLAIM. It read null as true,
         * which is the one answer the description says a caller may rely on, so
         * a store that never probed was reported as having probed and found
         * nothing. Kept in step with the hosted copy on purpose: these two files
         * serve the same tool names and test/toolDefsParity.test.mjs fails if
         * they drift.
         */
        agentId: s.agentId,
        processProbeOk: typeof s.processProbeOk === 'boolean' ? s.processProbeOk : null,
        processes: Array.isArray(s.processes) ? s.processes : null,
      }))),
    },
    {
      name: 'list_locks',
      title: 'List locks',
      description: 'Lock files per worktree, with holder and age. A FLAT LIST CANNOT SAY '
        + '"unknown": a session whose locks were never measured contributes nothing here and is '
        + 'indistinguishable from one holding no locks. Check locksHeld in list_agents — null '
        + 'there means unmeasured — before reading an absence as "not held".',
      input: obj(),
      run: async () => jsonResult((await listSessions()).flatMap((s) =>
        /*
         * THE THIRD TOOL, MISSED WHEN THE OTHER TWO WERE FIXED — and on the
         * hosted surface it is unconditional: index.ts hardcodes `locks: null`
         * for every session, so this answered `[]` on every call while
         * list_agents answered `null` about the same session. That is verbatim
         * the self-contradiction 0a94bcb was written to remove.
         *
         * A session whose locks were never measured contributes nothing rather
         * than contributing "no locks", so an unmeasured agent cannot look
         * lock-free. The flat shape has no slot to say "unknown" per row, which
         * is a real gap and is named in the tool's description rather than
         * papered over here.
         */
        (Array.isArray(s.locks) ? s.locks : []).map((l) => ({ agentId: s.agentId, worktree: s.worktree, ...l })))),
    },
    {
      name: 'get_collision_summary',
      title: 'Get collision summary',
      description:
        'Derived findings: shared worktrees, duplicate lanes, lock contention, cross-lane ' +
        'uncommitted writes, unpushed work, main divergence, stale sessions. Each finding ' +
        'carries the evidence it was derived from. ' +
        'A finding whose code ends in -dormant is a real registry conflict in which fewer ' +
        'than two of the parties could be acting, so it is reported as info rather than ' +
        'critical: two offline sessions cannot contend. It is DEMOTED, NEVER HIDDEN, and ' +
        'carries the state of each party, so it still tells you what to clean up.',
      input: obj(),
      run: async () => {
        const [sessions, lanes] = await Promise.all([listSessions(), getLanes()]);
        /*
         * ONE QUESTION, ONE ANSWER: the staleness window is the SHARED one.
         *
         * detectCollisions defaults to 90 seconds, which predates both the
         * 120-second heartbeat interval and the 600-second liveness window the
         * rest of this system uses. Left at the default, a perfectly healthy
         * worker is reported stale for a quarter of every heartbeat cycle --
         * and it was: get_supervisory_report called code-c an idle live worker
         * while get_collision_summary called the same agent stale, in the same
         * second, on the same rows.
         *
         * Worse, that wrong arithmetic reached a real conclusion: lane
         * "agentbridge" was demoted to dormant because the guard believed all
         * three claimants were stale, when one of them was live. The verdict
         * happened to be right; the reasoning was not, which is the kind of
         * agreement that stops being lucky at the worst moment.
         */
        return jsonResult(detectCollisions(sessions, {
          lanes, staleAfterSeconds: STALE_AFTER_MS / 1000,
        }));
      },
    },
  ];

  /*
   * CONTRACTS ARE MACHINE-LOCAL, BY DECISION.
   *
   * The delegation ledger lives in a JSON file on the operator's machine and is
   * not transmitted. Serving it from a hosted backend would mean sending task
   * text and path globs to a database outside the machine, and that was
   * declined deliberately -- so the hosted surface offers state and not
   * contracts, while stdio offers both.
   *
   * Registered conditionally rather than always-present-and-throwing: a model
   * cannot tell a broken server from an unsupported backend, and a tool that
   * exists but fails for half its callers is the worse of the two.
   */
  if (typeof listDelegations === 'function') {
    defs.push({
      name: 'list_delegations',
      title: 'List delegations',
      description:
        'Task contracts: who owes what, from which base commit, and which files they may and ' +
        'may not touch. READ THIS INSTEAD OF ASKING FOR A BRIEF — it is the authoritative copy. ' +
        'Defaults to outstanding work only (assigned or rejected); pass includeAll for history. ' +
        'NOTE: contracts are addressed by session id, which does not yet resolve to the agentId ' +
        'used by the other tools — that mapping is being built, so do not infer it.',
      input: obj({
        session: { type: 'string', description: 'filter to one session id, e.g. "danny-win-f1"' },
        includeAll: { type: 'boolean', description: 'include returned/accepted/withdrawn too' },
      }),
      run: async ({ session, includeAll = false } = {}) => {
        const rows = await listDelegations();
        const mine = session ? rows.filter((d) => d?.assigned_session === session) : rows;
        const picked = includeAll ? mine : mine.filter((d) => OUTSTANDING.includes(d?.state));
        return jsonResult(picked.map((d) => ({
          id: d.id, state: d.state, task: d.task, lane: d.lane_id ?? null,
          from: d.assigning_session, to: d.assigned_session,
          baseSha: d.base_sha, headSha: d.head_sha ?? null,
          allowedPaths: d.allowed_paths ?? [],
          sharedPaths: d.shared_paths ?? [],
          forbiddenPaths: d.forbidden_paths ?? [],
          auditOk: d.audit ? d.audit.ok : null,
        })));
      },
    });
    defs.push({
      name: 'get_delegation',
      title: 'Get delegation',
      description:
        'One contract in full, including its audit result and state history. Use after ' +
        'list_delegations when you need the evidence rather than the summary.',
      input: obj({ id: { type: 'string', description: 'e.g. "d-schedule-safety"' } }, ['id']),
      run: async ({ id }) => {
        const d = (await listDelegations()).find((x) => x.id === id);
        return jsonResult(d ?? { error: 'no such delegation', id });
      },
    });
  }

  /*
   * THE OWNER DECISION LEDGER — call this BEFORE putting a question to the
   * builder.
   *
   * Registered only when the store carries the ledger, for the same reason as
   * the contract tools above: a tool that exists but fails for half its callers
   * is worse than one that is honestly absent.
   *
   * WHY THERE IS NO WRITE TOOL HERE, AND WHY THERE MUST NEVER BE ONE. A
   * decision is the builder's authority. If an agent could record one, an agent
   * could grant itself permission, and the ledger would certify precisely the
   * thing it exists to constrain. Writing goes through `agentbridge
   * owner-decide` on the machine, where validateDecision refuses any record
   * whose created_by is not the owner. Two locks -- a read-only surface, and an
   * authorship check behind it -- because one lock on this is not enough.
   */
  if (typeof listDecisions === 'function') {
    defs.push({
      name: 'resolve_owner_decision',
      title: 'Resolve owner decision',
      description:
        'ASK THIS BEFORE ASKING THE BUILDER ANYTHING. Returns what the owner has already '
        + 'decided about an action in this context, so the same question is never put to them '
        + 'twice. Outcomes: "allowed" (proceed, do not ask), "denied" (refuse, do not ask), '
        + '"owner_required" (escalate), "no_decision" (ask ONCE, then record the answer with '
        + '`agentbridge owner-decide`). Narrower scope wins: task > lane > repo > project > '
        + 'bridge. A narrow approval NEVER widens — approval to deploy staging for one task is '
        + 'not approval to deploy production, nor to deploy for another task.',
      input: obj({
        action: {
          type: 'string',
          description: 'the classified action, e.g. "deploy.production", "commit", "spend.cloudflare"',
        },
        project: { type: 'string', description: 'project scope, if known' },
        repo: { type: 'string', description: 'repository scope, if known' },
        lane: { type: 'string', description: 'lane scope, if known' },
        task: { type: 'string', description: 'task or delegation id, if known' },
      }, ['action']),
      run: async ({ action, project, repo, lane, task } = {}) => {
        const rows = await listDecisions();
        return jsonResult(resolveOwnerDecision(rows, action, { project, repo, lane, task }));
      },
    });
  }

  /*
   * ── THE COORDINATOR SURFACE ────────────────────────────────────────────
   *
   * Registered ONLY when the store provides write methods, and the store only
   * provides them when the caller presented a coordinator token. So for a
   * reader these tools do not exist -- not "exist and refuse", which a model
   * can be talked into retrying, but absent from tools/list and answering
   * "no such tool" identically to a name that was never defined.
   *
   * WHAT IS DELIBERATELY NOT HERE: shell, SQL, file writes, deploy, merge,
   * command execution. Their absence is the control. A refusal string is
   * something a model argues with; a missing tool is not.
   */
  const { listTasks, assignTask, createTask, sendMessage, recordOwnerDecision } = store;

  if (typeof listTasks === 'function') {
    defs.push({
      name: 'list_tasks',
      title: 'List tasks',
      description:
        'Coordination tasks with state (runnable, assigned, blocked, returned, accepted, '
        + 'cancelled), lane, repo, base commit, path contract and dependencies. Read this '
        + 'before assigning anything: a task that is blocked or already assigned is not work '
        + 'you can hand out.',
      input: obj({ state: { type: 'string', description: 'filter to one state' } }),
      run: async ({ state } = {}) => {
        const rows = await listTasks();
        return jsonResult(state ? rows.filter((t) => t?.state === state) : rows);
      },
    });
  }

  if (typeof assignTask === 'function') {
    defs.push({
      name: 'assign_task',
      title: 'Assign task',
      description:
        'Assign an existing task to a worker, BY DURABLE AGENT ID. The Bridge resolves the '
        + 'agent to its live session itself — never pass a session id you read somewhere. '
        + 'REFUSES, rather than warning, when: the worker is stale, offline or ambiguous; the '
        + 'task is not runnable or returned; a dependency is unsatisfied; the work is already '
        + 'satisfied upstream; a path collides with another assignment; the repo or lane does '
        + 'not match; or the base commit is stale. A refusal names every reason at once.',
      input: obj({
        task_id: { type: 'string', description: 'an existing task id' },
        agent_id: { type: 'string', description: 'durable agent id, e.g. "code-b"' },
      }, ['task_id', 'agent_id']),
      run: async ({ task_id, agent_id }) => jsonResult(await assignTask({ task_id, agent_id })),
    });
  }

  if (typeof createTask === 'function') {
    defs.push({
      name: 'create_task',
      title: 'Create task',
      description:
        'Put a new task in the queue. THIS IS NOT ASSIGNMENT — creating work and handing it out '
        + 'are separate acts, and a task is born unassigned. REFUSES, rather than writing a row '
        + 'that can never be used, when: the id is not file-safe or already exists; lane, repo, '
        + 'title or allowed_paths are missing; allowed_paths is empty (which means "unrestricted" '
        + 'to a reader and "nothing" to a collision check); a path escapes the repository; '
        + 'base_sha is not a full lowercase commit sha; the task depends on itself; or the paths '
        + 'overlap a task still in play. The author is taken from your token, never from this '
        + 'call — an author you can type is a claim, not a record.',
      input: obj({
        task_id: { type: 'string', description: 'file-safe id, e.g. "t-fix-the-cursor"' },
        title: { type: 'string', description: 'what this task is, readable on a roster' },
        lane_id: { type: 'string', description: 'the lane it belongs to' },
        repo_id: { type: 'string', description: 'the repo it belongs to' },
        allowed_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'repo-relative paths this task may touch. Non-empty: this is the collision guard.',
        },
        forbidden_paths: { type: 'array', items: { type: 'string' } },
        shared_paths: { type: 'array', items: { type: 'string' } },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'task ids that must finish first' },
        base_sha: { type: 'string', description: 'full lowercase 40-character commit sha, or omit' },
      }, ['task_id', 'title', 'lane_id', 'repo_id', 'allowed_paths']),
      run: async (args) => jsonResult(await createTask(args)),
    });
  }

  if (typeof sendMessage === 'function') {
    defs.push({
      name: 'send_message',
      title: 'Send message',
      description:
        'Send a STRUCTURED coordination message to a worker. Fixed fields only: task_id, '
        + 'from_agent, to_agent, type, body. The body is prose for a person or an agent to '
        + 'READ — it is never executed by anything, and a body that looks like a command is '
        + 'refused. This is not a way to run something on another machine.',
      input: obj({
        to_agent: { type: 'string', description: 'durable agent id of the recipient' },
        from_agent: { type: 'string', description: 'who is speaking' },
        type: {
          type: 'string',
          description: 'assignment | question | answer | status | blocker | handoff | review',
        },
        body: { type: 'string', description: 'plain prose, max 8000 chars' },
        task_id: { type: 'string', description: 'the task this concerns, if any' },
      }, ['to_agent', 'from_agent', 'type', 'body']),
      run: async (m) => jsonResult(await sendMessage(m)),
    });
  }

  if (typeof recordOwnerDecision === 'function') {
    defs.push({
      name: 'record_owner_decision',
      title: 'Record owner decision',
      description:
        'Append a scoped decision the OWNER has made, so no worker asks it again. '
        + 'Append-only: an existing decision is never edited, only superseded or revoked. '
        + 'owner_id and created_by must be the same person — a coordinator may RECORD what '
        + 'the owner decided, and may not decide on their behalf.',
      input: obj({
        decision_id: { type: 'string' },
        owner_id: { type: 'string', description: 'the builder whose decision this is' },
        statement: { type: 'string', description: "the owner's own words" },
        scope_type: { type: 'string', description: 'bridge | project | repo | lane | task' },
        scope_id: { type: 'string', description: 'required unless scope_type is bridge' },
        effect: { type: 'string', description: 'allow | deny | require_owner' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'e.g. ["deploy.*"]' },
        supersedes: { type: 'string', description: 'a decision id this replaces' },
      }, ['decision_id', 'owner_id', 'statement', 'scope_type', 'effect', 'capabilities']),
      run: async (d) => jsonResult(await recordOwnerDecision(d)),
    });
  }

  if (typeof listDecisions === 'function') {
    defs.push({
      name: 'get_owner_decisions',
      title: 'Get owner decisions',
      description:
        'Every standing decision, including superseded and revoked ones, so the history of '
        + 'what the owner said is visible and not just what is currently in force. Use '
        + 'resolve_owner_decision to ask whether a specific action is permitted.',
      input: obj({ includeInactive: { type: 'boolean', description: 'default true' } }),
      run: async ({ includeInactive = true } = {}) => {
        const rows = await listDecisions();
        const live = new Set(activeDecisions(rows).map((d) => d.decision_id));
        return jsonResult(rows
          .filter((d) => includeInactive || live.has(d.decision_id))
          .map((d) => ({
            ...d,
            state: d.revoked_at ? 'revoked' : (live.has(d.decision_id) ? 'active' : 'superseded'),
          })));
      },
    });
  }

  return defs;
}
