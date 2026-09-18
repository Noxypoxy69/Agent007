import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Lock discovery. Step 1 only *observes* locks written by other tooling
 * (e.g. the gates-can-fail mutation lock). It never creates, waits on,
 * or releases one.
 */
const DEFAULT_DIRS = ['.agentbridge/locks', '.locks'];

export async function discoverLocks(worktree, dirs = DEFAULT_DIRS) {
  const found = [];
  for (const d of dirs) {
    const abs = path.join(worktree, d);
    let names;
    try { names = await readdir(abs); } catch { continue; }
    for (const name of names) {
      const file = path.join(abs, name);
      let st;
      try { st = await stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      let meta = null;
      if (st.size > 0 && st.size < 64 * 1024) {
        try { meta = JSON.parse(await readFile(file, 'utf8')); } catch { meta = null; }
      }
      found.push({
        resource: name.replace(/\.(lock|json)$/i, ''),
        file: path.relative(worktree, file).replace(/\\/g, '/'),
        heldBy: meta?.agent ?? meta?.heldBy ?? null,
        pid: meta?.pid ?? null,
        acquiredAt: meta?.acquiredAt ?? st.mtime.toISOString(),
        ageSeconds: Math.round((Date.now() - st.mtimeMs) / 1000),
      });
    }
  }
  return found;
}
