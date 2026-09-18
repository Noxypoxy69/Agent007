import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { HOME } from './config.mjs';

/**
 * WHO IS ACTUALLY RUNNING, written by the workers themselves.
 *
 * This is the file that replaces the hand-authored roster. Nobody types it: a
 * session registers itself and refreshes a heartbeat, and everything else --
 * liveness, capacity, resolution -- is derived from these rows by
 * src/liveRegistry.mjs.
 *
 * NOT IN THE REPOSITORY. Runtime state, like config.json and delegations.json.
 * A registration naming an operator's worktree paths and session ids is exactly
 * the sort of thing that must not be pushed.
 *
 * ONE ROW PER SESSION, REPLACED ON EACH HEARTBEAT. This is the one store here
 * that is deliberately NOT append-only, because it is not a ledger: it is a
 * snapshot of the present, and a session's previous heartbeat has no evidentiary
 * value once a newer one exists. Contracts and owner decisions are append-only
 * because somebody is accountable for each record; a heartbeat is a fact about
 * this instant and nothing more.
 */

const REGISTRATIONS = () => path.join(HOME, 'registrations.json');

async function readJsonArray(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    // Not an array means corrupt, not empty. Returning [] would silently
    // discard every live worker on the next write -- and an empty registry
    // reads as "nobody is running", which refuses every delegation.
    if (!Array.isArray(parsed)) throw new Error(`${file} does not contain a JSON array`);
    return parsed;
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}

export const readRegistrations = () => readJsonArray(REGISTRATIONS());

export async function writeRegistrations(rows) {
  const file = REGISTRATIONS();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

/**
 * Record or refresh one session's registration.
 *
 * Keyed by session_id, so a heartbeat REPLACES that session's row and never
 * touches anybody else's. A worker cannot overwrite another worker's
 * registration through this path, which is the file-level half of "no agent may
 * invent another agent's session".
 */
export async function upsertRegistration(row) {
  const rows = await readRegistrations();
  const without = rows.filter((r) => r?.session_id !== row.session_id);
  const next = [...without, row].sort((a, b) =>
    String(a.session_id).localeCompare(String(b.session_id)));
  await writeRegistrations(next);
  return next;
}

/** Remove a session's registration — a clean shutdown, not a timeout. */
export async function removeRegistration(sessionId) {
  const rows = await readRegistrations();
  const next = rows.filter((r) => r?.session_id !== sessionId);
  await writeRegistrations(next);
  return { removed: rows.length - next.length, rows: next };
}
