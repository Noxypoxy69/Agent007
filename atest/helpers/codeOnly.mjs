/**
 * BLANK EVERY COMMENT, KEEPING THE FILE THE SAME LENGTH.
 *
 * Source-text gates read comments, and comments are where the identifier being
 * guarded is MOST LIKELY to be written down — the better the file is
 * documented, the more certain the false match. This repository documents
 * heavily, which makes the failure endemic rather than incidental.
 *
 * It has now bitten twice, in two different files, in the same week:
 *
 *   leaseWiring.test.mjs   renaming the call away from `claim_task` left the
 *                          suite green, because the block comment above the
 *                          call explains claim_task by name. Four of its twelve
 *                          assertions had the hole. code-b found it.
 *
 *   theWritesAreWired.test.mjs  the per-site check accepted `claim_task`
 *                          anywhere in the file. Proved by mutation: strip
 *                          assign's predicate, add a comment naming claim_task,
 *                          and the gate stays GREEN. code-d found it, in its
 *                          own file, after telling somebody else to look for it.
 *
 * Two independent copies of the fix is how they drift, so it lives here once.
 *
 * BLANKING RATHER THAN DELETING keeps every index, offset and line number
 * aligned with the real file, which ordering assertions depend on.
 *
 * STRING BODIES ARE SKIPPED, NOT BLANKED. A quoted "//" inside a URL is not a
 * comment, and the identifier inside `rpc('claim_task')` is the call itself —
 * blanking it would remove the very thing a gate is looking for.
 *
 * Adapted from code-b's implementation in leaseWiring.test.mjs, which was
 * verified against the real 1,173-line entrypoint before being lifted: every
 * regex literal in that file was traced by hand, and a line-by-line diff of
 * blanked-versus-original found ZERO code lines swallowed.
 */
export function codeOnly(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '"' || ch === "'" || ch === '`') {
      // Skip the string body, so a quoted "//" is not mistaken for a comment.
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      i = j + 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }

    i += 1;
  }

  return out.join('');
}
