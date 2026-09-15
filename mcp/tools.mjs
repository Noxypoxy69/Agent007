import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectCollisions } from '../bridge/collisions.mjs';

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

/**
 * READ-ONLY TOOL SURFACE.
 *
 * Step 1 exposes no tool that mutates anything, assigns work, or reaches the
 * machine. Adding a write tool here is a Step 3 decision with its own threat
 * model — not a quiet extension of this file.
 */
/**
 * @param {object} store  must provide listSessions() and getLanes()
 *
 * REQUIRED, with no default, on purpose. A default would import
 * bridge/store.mjs -- and therefore `pg` -- into every consumer of this file,
 * including the Cloudflare Worker, where a node TCP driver cannot run at all.
 * Making the caller supply the store keeps the tool DEFINITIONS free of any
 * backing store, so the same seven tools serve stdio, node and the edge.
 *
 * Validated rather than assumed: a store missing a method would otherwise fail
 * inside a tool call as "listSessions is not a function", surfacing to the
 * model as a broken tool rather than a wiring mistake.
 */
export function buildMcpServer(store) {
  if (!store || typeof store.listSessions !== 'function' || typeof store.getLanes !== 'function') {
    throw new TypeError('buildMcpServer(store): store must provide listSessions() and getLanes()');
  }
  const { listSessions, getLanes } = store;

  const server = new McpServer(
    { name: 'agentbridge', version: '0.1.0' },
    { capabilities: { tools: {} },
      instructions:
        'Live engineering state for multi-agent Git worktrees. Every field is observed from git ' +
        'plumbing and the process table on the developer machine, not reported by the agents ' +
        'themselves, so an agent cannot misreport its own state here. Fields that could not be ' +
        'determined are null — treat null as unknown, never as zero. This server is read-only: ' +
        'it cannot assign tasks, send messages, or run commands.' });

  server.registerTool('list_agents', {
    title: 'List agents',
    description: 'All registered agents with lane, branch, HEAD, and staleness. Start here.',
    inputSchema: {},
  }, async () => {
    const sessions = await listSessions();
    return json(sessions.map((s) => ({
      agentId: s.agentId, lane: s.lane, machine: s.machineLabel,
      branch: s.git?.branch ?? null, head: s.git?.head ?? null,
      baseSha: s.git?.baseSha ?? null,
      unpushed: s.git?.unpushed ?? null,
      dirtyFiles: (s.git?.dirty ?? []).length,
      locksHeld: (s.locks ?? []).map((l) => l.resource),
      running: (s.processes ?? []).map((p) => p.kind),
      lastSeenAt: s.lastSeenAt,
    })));
  });

  server.registerTool('get_agent_state', {
    title: 'Get agent state',
    description: 'Full snapshot for one agent: git state, locks, processes, file lists.',
    inputSchema: { agentId: z.string().describe('e.g. "code-c"') },
  }, async ({ agentId }) => {
    const s = (await listSessions()).find((x) => x.agentId === agentId);
    return json(s ?? { error: 'no such agent', agentId });
  });

  server.registerTool('list_worktrees', {
    title: 'List worktrees',
    description: 'Worktree paths and which agent is registered to each.',
    inputSchema: {},
  }, async () => json((await listSessions()).map((s) =>
    ({ worktree: s.worktree, agentId: s.agentId, lane: s.lane, branch: s.git?.branch ?? null }))));

  server.registerTool('get_git_state', {
    title: 'Get git state',
    description: 'Branch, HEAD, merge-base, origin/main, upstream, unpushed count, ahead/behind.',
    inputSchema: { agentId: z.string().optional().describe('omit for all agents') },
  }, async ({ agentId }) => {
    const all = await listSessions();
    const rows = (agentId ? all.filter((s) => s.agentId === agentId) : all)
      .map((s) => ({ agentId: s.agentId, lane: s.lane, ...(s.git ?? {}) }));
    return json(rows);
  });

  server.registerTool('list_active_processes', {
    title: 'List active processes',
    description:
      'Verify/test/lint/agent processes associated with each worktree. `confidence:"cwd"` is ' +
      'an exact match; `"commandline"` is a substring match and can miss processes. If ' +
      'processProbeOk is false, an empty list does NOT mean nothing is running.',
    inputSchema: {},
  }, async () => json((await listSessions()).map((s) =>
    ({ agentId: s.agentId, processProbeOk: s.processProbeOk !== false, processes: s.processes ?? [] }))));

  server.registerTool('list_locks', {
    title: 'List locks',
    description: 'Observed lock files per worktree, with holder and age.',
    inputSchema: {},
  }, async () => json((await listSessions()).flatMap((s) =>
    (s.locks ?? []).map((l) => ({ agentId: s.agentId, worktree: s.worktree, ...l })))));

  server.registerTool('get_collision_summary', {
    title: 'Get collision summary',
    description:
      'Derived findings: shared worktrees, duplicate lanes, lock contention, cross-lane ' +
      'uncommitted writes, unpushed work, main divergence, stale sessions. Each finding ' +
      'carries the evidence it was derived from.',
    inputSchema: {},
  }, async () => {
    const [sessions, lanes] = await Promise.all([listSessions(), getLanes()]);
    return json(detectCollisions(sessions, { lanes }));
  });

  return server;
}
