import { createHash } from 'node:crypto';
import { createReadCache } from './readCache.mjs';

/*
 * THE CONTEXT COMPILER: what an attempt is told, and a digest of exactly that.
 *
 * readCache has been built, tested and imported by nothing since it was
 * written. That is the fifth orphan in this repository and the pattern is
 * always the same: a correct module with no consumer, which means no evidence
 * it solves the problem it was built for. This is its consumer, and writing it
 * turned up two things the cache alone could not have shown.
 *
 * WHAT THE DIGEST IS FOR, AND IT IS NOT CACHING. The attempt record stores a
 * contextDigest so two attempts can be compared: a retry that failed
 * identically on identical context is a loop, and a retry that failed after the
 * context changed is a different question. Without a digest computed from what
 * was ACTUALLY sent, that field is a claim.
 *
 * SO THE DIGEST COVERS THE SENT FORM, NOT THE FILES. An unchanged file is sent
 * as a one-line reference rather than its bytes, so two attempts over identical
 * files can send genuinely different context. Hashing the file contents would
 * call those two the same and blind the loop detector in exactly the case it
 * exists for: an agent going round again on a prompt that quietly shrank
 * underneath it.
 *
 * ORDER IS PART OF THE DIGEST. The same files in a different order are a
 * different prompt, and a model reads them in the order they arrive.
 *
 * PURE ABOUT EVERYTHING BUT THE READ. `load` is injected per file, so this
 * module never touches a filesystem and a test hands it a string.
 */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/** What an unchanged file becomes. Short, and it names the hash. */
export function contextRef(path, hash) {
  return `unchanged:${path}@${String(hash).slice(0, 16)}`;
}

/**
 * Compile one attempt's context.
 *
 * @param files [{ path, load }]  load returns the file's text
 * @param cache a readCache, shared ACROSS attempts. A fresh one per attempt can
 *              never report a hit, which is the whole point of it existing.
 */
export async function compileContext(files, { cache = null, hash = null } = {}) {
  if (!Array.isArray(files)) throw new TypeError('compileContext: files must be an array');
  const reader = cache ?? createReadCache();
  const digest = createHash('sha256');
  const parts = [];
  const manifest = [];
  let bytesSent = 0;
  let bytesSaved = 0;

  for (const file of files) {
    if (!file || !nonEmpty(file.path)) throw new TypeError('compileContext: every file needs a path');
    if (typeof file.load !== 'function') {
      throw new TypeError(`compileContext: ${file.path} needs a load`);
    }

    const result = await reader.read(file.path, {
      load: file.load,
      identity: file.identity ?? null,
    });
    const sent = result.unchanged
      ? contextRef(file.path, result.hash)
      : `${file.path}\n${result.content}`;

    /*
     * LENGTH-FRAMED, like the artifact digest next door. Without it a file
     * named `b` holding `c` and a file named `bc` holding nothing hash the
     * same, and two different prompts compare equal.
     */
    digest.update(`${file.path}\u0000${sent.length}\u0000${sent}\u0000`);
    parts.push(sent);

    if (result.unchanged) bytesSaved += (result.bytes ?? 0) - sent.length;
    bytesSent += sent.length;
    manifest.push(Object.freeze({
      path: file.path,
      hash: result.hash,
      unchanged: Boolean(result.unchanged),
      sentBytes: sent.length,
    }));
  }

  return Object.freeze({
    text: parts.join('\n'),
    digest: hash ? hash(parts.join('\n')) : digest.digest('hex'),
    files: Object.freeze(manifest),
    bytesSent,
    /*
     * NEVER NEGATIVE, AND THAT IS NOT COSMETIC. A reference is longer than a
     * very short file, so a naive subtraction reports a saving of minus forty,
     * and a caller summing these across an attempt gets a total arguing the
     * cache cost tokens. It did not save anything there. It saved nothing.
     */
    bytesSaved: Math.max(0, bytesSaved),
  });
}
