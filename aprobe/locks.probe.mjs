/*
 * AUDIT PROBE 8 — claim 10, the THIRD tool on the same surface.
 *
 * 0a94bcb's own message: "one connection could answer `running: []` from
 * list_agents and `processes: null` from list_active_processes about the same
 * session in the same breath". It fixed list_agents and list_active_processes.
 * mcp/toolDefs.mjs:284 and its hosted twin still read `(s.locks ?? []).map(...)`
 * for list_locks.
 */
import { toolDefs as twin } from '../mcp/toolDefs.mjs';
import { toolDefs as hosted } from '../supabase/functions/mcp/_shared.js';

const UNMEASURED = {
  agentId: 'code-b', sessionId: 'danny-win-b1', lane: 'agentbridge',
  worktree: null, capacity: null, git: null,
  locks: null, processes: null, processProbeOk: null,
  lastSeenAt: '2026-09-18T20:00:00.000Z',
};
const store = {
  listSessions: async () => [UNMEASURED],
  getLanes: async () => ({}), listDecisions: async () => [], listMessages: async () => [],
};

const call = async (defs, name) => {
  const d = defs(store).find((x) => x.name === name);
  if (!d) return `<no such tool: ${name}>`;
  const out = await d.run({});
  return JSON.parse(out.content[0].text);
};

for (const [label, defs] of [['twin', twin], ['hosted', hosted]]) {
  const agents = await call(defs, 'list_agents');
  const locks = await call(defs, 'list_locks');
  const procs = await call(defs, 'list_active_processes');
  const row = (Array.isArray(agents) ? agents : agents.agents ?? agents.rows)[0];
  console.log(`\n${label}:`);
  console.log('  list_agents.locksHeld           =', JSON.stringify(row.locksHeld));
  console.log('  list_agents.running             =', JSON.stringify(row.running));
  console.log('  list_agents.dirtyFiles          =', JSON.stringify(row.dirtyFiles));
  console.log('  list_active_processes.processes =', JSON.stringify((Array.isArray(procs) ? procs : procs.rows)[0]?.processes));
  console.log('  list_active_processes.probeOk   =', JSON.stringify((Array.isArray(procs) ? procs : procs.rows)[0]?.processProbeOk));
  console.log('  list_locks                      =', JSON.stringify(locks));
  const locksRows = Array.isArray(locks) ? locks : (locks.locks ?? locks.rows ?? []);
  console.log(locksRows.length === 0
    ? '  >>> list_locks answers "no locks" for a session nobody measured, while list_agents\n'
      + '  >>> answers null for the SAME field on the SAME connection — the contradiction\n'
      + '  >>> 0a94bcb describes, one tool further along.'
    : '  (list_locks carries an unknown marker)');
}
