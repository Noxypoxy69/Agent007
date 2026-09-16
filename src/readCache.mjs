/*
 * UNCHANGED-READ DEDUPE.
 *
 * A worker reads the same file on attempt 1, 2 and 3. The bytes are identical
 * every time and they are paid for every time. This cache answers the second
 * read with "unchanged, you already have it" and a ref, so the caller sends a
 * one-line reference instead of the file.
 *
 * IT SAVES TOKENS, NOT I/O, AND THAT IS DELIBERATE. The file is loaded and
 * hashed on every read. It would be cheaper to trust size and mtime and skip
 * the load -- and it would be wrong: a checkout, a `git stash pop` or a
 * generator can produce different content with the same size in the same
 * mtime tick, and a cache that says "unchanged" about changed bytes feeds the
 * model a stale file that it then reasons about confidently. Cheap identity is
 * used only to skip the HASH COMPARISON, never to skip the read.
 *
 * So: mtime and size are a hint. The hash is the answer.
 */

import { createHash } from 'node:crypto';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function createReadCache({ hash = sha256, maxEntries = 512 } = {}) {
  // insertion-ordered; oldest evicted first
  const entries = new Map();
  const stats = { reads: 0, hits: 0, misses: 0, changed: 0 };

  /*
   * `load` returns the content. It is injected rather than imported so the
   * "same mtime, different bytes" case is a two-line fixture instead of a
   * filesystem race nobody can reproduce on purpose.
   */
  async function read(path, { load, identity = null } = {}) {
    if (typeof path !== 'string' || path === '') throw new TypeError('readCache: path required');
    if (typeof load !== 'function') throw new TypeError('readCache: load required');
    stats.reads += 1;

    const content = await load();
    const digestValue = hash(content);
    const previous = entries.get(path);

    if (previous !== undefined && previous.hash === digestValue) {
      stats.hits += 1;
      // refresh recency
      entries.delete(path);
      entries.set(path, { hash: digestValue, identity, bytes: previous.bytes });
      return Object.freeze({
        path,
        unchanged: true,
        hash: digestValue,
        bytes: previous.bytes,
        ref: `${path}@${digestValue.slice(0, 12)}`,
        content,
      });
    }

    if (previous !== undefined) stats.changed += 1;
    else stats.misses += 1;

    const bytes = Buffer.byteLength(content);
    entries.delete(path);
    entries.set(path, { hash: digestValue, identity, bytes });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }

    return Object.freeze({
      path,
      unchanged: false,
      hash: digestValue,
      bytes,
      ref: `${path}@${digestValue.slice(0, 12)}`,
      content,
    });
  }

  /*
   * Forget one path. Called when something outside the cache is known to have
   * written it -- a merge, a revert, a fresh worktree. Forgetting is always
   * safe; the next read simply reports changed.
   */
  function invalidate(path) {
    return entries.delete(path);
  }

  return Object.freeze({
    read,
    invalidate,
    get size() {
      return entries.size;
    },
    stats: () => Object.freeze({ ...stats }),
  });
}
