import pg from 'pg';
import { createHash } from 'node:crypto';

const { Pool } = pg;
let pool;
export function db() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString, max: 5, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

const q = (sql, params) => db().query(sql, params);
export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export async function getMachine(id) {
  // Parameterised. Note `id` is validated as a UUID by the caller before it
  // ever reaches here; pg parameter binding handles the rest.
  const { rows } = await q('select * from agentbridge.machines where id = $1 and disabled = false', [id]);
  return rows[0] ?? null;
}

/** Returns false if the nonce was already used — i.e. this is a replay. */
export async function consumeNonce(machineId, nonce) {
  const { rowCount } = await q(
    'insert into agentbridge.nonces (machine_id, nonce) values ($1, $2) on conflict do nothing',
    [machineId, nonce]);
  return rowCount === 1;
}

/** Fixed-window limiter. Returns {allowed, count}. */
export async function bumpRate(machineId, limitPerMinute) {
  const { rows } = await q(`
    insert into agentbridge.rate_windows (machine_id, window_start, count)
    values ($1, date_trunc('minute', now()), 1)
    on conflict (machine_id, window_start)
      do update set count = agentbridge.rate_windows.count + 1
    returning count`, [machineId]);
  const count = rows[0].count;
  return { allowed: count <= limitPerMinute, count };
}

export async function recordHeartbeat(machineId, payload) {
  const client = await db().connect();
  try {
    await client.query('begin');
    await client.query('update agentbridge.machines set last_seen_at = now(), platform = $2 where id = $1',
      [machineId, payload.machine?.platform ?? null]);
    await client.query('insert into agentbridge.heartbeats (machine_id, payload) values ($1, $2)',
      [machineId, payload]);

    const seen = [];
    for (const s of payload.sessions ?? []) {
      const g = s.git ?? {};
      seen.push(s.agentId);
      await client.query(`
        insert into agentbridge.sessions (machine_id, agent_id, lane, worktree, branch, head_sha,
          base_sha, main_ref, main_sha, upstream, unpushed, ahead_main, behind_main,
          staged_count, dirty_count, lock_count, proc_count, git_ok, state, last_seen_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
        on conflict (machine_id, agent_id) do update set
          lane=excluded.lane, worktree=excluded.worktree, branch=excluded.branch,
          head_sha=excluded.head_sha, base_sha=excluded.base_sha, main_ref=excluded.main_ref,
          main_sha=excluded.main_sha, upstream=excluded.upstream, unpushed=excluded.unpushed,
          ahead_main=excluded.ahead_main, behind_main=excluded.behind_main,
          staged_count=excluded.staged_count, dirty_count=excluded.dirty_count,
          lock_count=excluded.lock_count, proc_count=excluded.proc_count,
          git_ok=excluded.git_ok, state=excluded.state, last_seen_at=now()`,
        [machineId, s.agentId, s.lane, s.worktree, g.branch ?? null, g.head ?? null,
         g.baseSha ?? null, g.mainRef ?? null, g.mainSha ?? null, g.upstream ?? null,
         g.unpushed ?? null, g.aheadOfMain ?? null, g.behindMain ?? null,
         (g.staged ?? []).length, (g.dirty ?? []).length,
         (s.locks ?? []).length, (s.processes ?? []).length, g.ok !== false, s]);
    }
    if (payload.lanes && Object.keys(payload.lanes).length) {
      await client.query('delete from agentbridge.lanes where machine_id = $1', [machineId]);
      for (const [name, globs] of Object.entries(payload.lanes)) {
        await client.query(
          'insert into agentbridge.lanes (machine_id, name, globs) values ($1,$2,$3)',
          [machineId, name, JSON.stringify(globs)]);
      }
    }

    // Agents removed from the local registry stop being reported; drop them so
    // the coordinator never sees a ghost session.
    if (seen.length) {
      await client.query('delete from agentbridge.sessions where machine_id = $1 and not (agent_id = any($2))',
        [machineId, seen]);
    } else {
      await client.query('delete from agentbridge.sessions where machine_id = $1', [machineId]);
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally { client.release(); }
}

export async function listSessions() {
  const { rows } = await q(`
    select s.*, m.label as machine_label
    from agentbridge.sessions s join agentbridge.machines m on m.id = s.machine_id
    order by s.lane, s.agent_id`);
  return rows.map((r) => ({ ...r.state, lastSeenAt: r.last_seen_at, machineLabel: r.machine_label }));
}

export async function getLanes() {
  const { rows } = await q('select name, globs from agentbridge.lanes');
  return Object.fromEntries(rows.map((r) => [r.name, r.globs]));
}

export async function checkReaderToken(token) {
  if (!token) return null;
  const { rows } = await q(
    'update agentbridge.reader_tokens set last_used_at = now() where token_sha256 = $1 and disabled = false returning label',
    [sha256(token)]);
  return rows[0]?.label ?? null;
}
