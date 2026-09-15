import { detectCollisions } from '../bridge/collisions.mjs';
// Pure: no node builtins, no clock, no filesystem. Safe on the edge, which is
// why the resolution rules live in their own module rather than in the CLI.
import { resolveOwnerDecision } from '../src/ownerDecisions.mjs';

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
export const INSTRUCTIONS =
  'Live engineering state for multi-agent Git worktrees. Every field is observed from git ' +
  'plumbing and the process table on the developer machine, not reported by the agents ' +
  'themselves, so an agent cannot misreport its own state here. Fields that could not be ' +
  'determined are null — treat null as unknown, never as zero. This server is read-only: ' +
  'it cannot assign tasks, send messages, or run commands.\n\n' +
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
      run: async () => jsonResult((await listSessions()).map((s) => ({
        agentId: s.agentId, lane: s.lane, machine: s.machineLabel,
        branch: s.git?.branch ?? null, head: s.git?.head ?? null,
        baseSha: s.git?.baseSha ?? null,
        unpushed: s.git?.unpushed ?? null,
        dirtyFiles: (s.git?.dirty ?? []).length,
        locksHeld: (s.locks ?? []).map((l) => l.resource),
        running: (s.processes ?? []).map((p) => p.kind),
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
        'an exact match; `"commandline"` is a substring match and can miss processes. If ' +
        'processProbeOk is false, an empty list does NOT mean nothing is running.',
      input: obj(),
      run: async () => jsonResult((await listSessions()).map((s) => ({
        agentId: s.agentId, processProbeOk: s.processProbeOk !== false, processes: s.processes ?? [],
      }))),
    },
    {
      name: 'list_locks',
      title: 'List locks',
      description: 'Observed lock files per worktree, with holder and age.',
      input: obj(),
      run: async () => jsonResult((await listSessions()).flatMap((s) =>
        (s.locks ?? []).map((l) => ({ agentId: s.agentId, worktree: s.worktree, ...l })))),
    },
    {
      name: 'get_collision_summary',
      title: 'Get collision summary',
      description:
        'Derived findings: shared worktrees, duplicate lanes, lock contention, cross-lane ' +
        'uncommitted writes, unpushed work, main divergence, stale sessions. Each finding ' +
        'carries the evidence it was derived from.',
      input: obj(),
      run: async () => {
        const [sessions, lanes] = await Promise.all([listSessions(), getLanes()]);
        return jsonResult(detectCollisions(sessions, { lanes }));
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

  return defs;
}
