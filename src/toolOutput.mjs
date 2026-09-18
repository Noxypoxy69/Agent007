/*
 * ARTIFACT SPILL AND COMPACT TYPED TOOL OUTPUT.
 *
 * A tool returns 400KB of test log. Sending it to a model costs the window;
 * dropping it costs the diagnosis. So it spills: the bytes go to an artifact
 * store and what travels is a small typed record with the head, the tail, the
 * true size, a digest, and a ref that can fetch the rest.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: A TRUNCATED THING MUST SAY SO. Every
 * shape below carries `complete`, and it is a required field rather than an
 * optional flag, because a truncated stream is indistinguishable from a
 * finished one to the code reading it -- that is not a hypothetical here, it is
 * how every tool-backed answer got cut off mid-clause for a week and no gate
 * noticed. A consumer that ignores `complete` is at least ignoring something
 * that is there.
 *
 * AND SPILLING CAN FAIL. If the sink throws, the result is `truncated`, not
 * `spilled`: a ref that does not resolve is worse than no ref, because the
 * reader stops looking for the missing bytes once they think they know where
 * they are.
 */

import { createHash } from 'node:crypto';

const DEFAULT_LIMIT = 8 * 1024;
const HEAD_BYTES = 2048;
const TAIL_BYTES = 2048;

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

/*
 * Compact one blob of text.
 *
 *   { kind: "inline",    complete: true,  text }
 *   { kind: "spilled",   complete: true,  head, tail, ref, sha256, bytes, omittedBytes }
 *   { kind: "truncated", complete: false, head, tail, sha256, bytes, omittedBytes }
 *
 * `spilled` is complete because nothing was lost -- the bytes are retrievable
 * through `ref`. `truncated` is not, and says so in the one field a consumer
 * cannot fail to see.
 */
export async function compact(text, { limit = DEFAULT_LIMIT, sink = null, label = 'output' } = {}) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const bytes = Buffer.byteLength(value);
  if (bytes <= limit) {
    return Object.freeze({ kind: 'inline', complete: true, label, bytes, text: value });
  }

  const head = value.slice(0, HEAD_BYTES);
  const tail = value.slice(-TAIL_BYTES);
  const sha256 = digest(value);
  const omittedBytes = bytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
  const base = { label, bytes, sha256, head, tail, omittedBytes };

  if (sink === null || typeof sink.put !== 'function') {
    return Object.freeze({ kind: 'truncated', complete: false, ...base });
  }
  try {
    const ref = await sink.put({ label, sha256, bytes, text: value });
    if (typeof ref !== 'string' || ref === '') {
      // A sink that returns nothing has not stored anything we can name.
      return Object.freeze({ kind: 'truncated', complete: false, ...base });
    }
    return Object.freeze({ kind: 'spilled', complete: true, ref, ...base });
  } catch {
    return Object.freeze({ kind: 'truncated', complete: false, ...base });
  }
}

/*
 * The typed envelope a tool call returns. `ok` is set by the runner from the
 * call's real outcome -- a tool cannot declare its own success any more than an
 * executor can, and `error` on an ok result is refused rather than tolerated
 * because that combination is always a bug at the call site.
 */
export function typedToolOutput({ name, ok, value = null, error = null }) {
  if (typeof name !== 'string' || name === '') throw new TypeError('tool output needs a name');
  if (typeof ok !== 'boolean') throw new TypeError('tool output needs an explicit ok');
  if (ok && error !== null) throw new TypeError(`tool ${name}: ok result carries an error`);
  if (!ok && error === null) throw new TypeError(`tool ${name}: failed result carries no error`);
  return Object.freeze({ name, ok, value, error });
}

/*
 * How many bytes a compact record will cost the window, so a caller can budget
 * before sending rather than discover afterwards.
 */
export function compactSize(record) {
  if (record.kind === 'inline') return record.bytes;
  return Buffer.byteLength(record.head) + Buffer.byteLength(record.tail);
}
