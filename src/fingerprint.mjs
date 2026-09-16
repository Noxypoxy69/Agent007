/*
 * FINGERPRINTS. "Have I already done exactly this and got exactly that?"
 *
 * A worker that retries is fine. A worker that retries IDENTICALLY is a loop,
 * and it burns a lease, a budget and a night. To tell them apart you need a
 * value that is stable across runs of the same failure and different across
 * runs of different failures. Both halves matter and they pull opposite ways:
 *
 *   NORMALISE TOO LITTLE and every attempt is unique, because a timestamp and
 *   a temp directory differ every time. The detector never fires.
 *   NORMALISE TOO MUCH and different failures collide, so real progress reads
 *   as a loop and the worker is stopped for succeeding.
 *
 * What is scrubbed below is only the things that vary between two runs of the
 * SAME event: clocks, pids, temp paths, durations, object addresses, and hex
 * blobs long enough to be a sha or a uuid. Line numbers, file names, assertion
 * text and error types are all kept, because those are how two different
 * failures differ.
 */

import { createHash } from 'node:crypto';

/*
 * TEMP PATHS ARE THE HARD ONE, and the first version of this file got it wrong
 * in the direction that matters. `/tmp/x9/a.mjs:12` and `/tmp/zz/b.mjs:12` are
 * DIFFERENT failures in different files; a scrubber that swallows the whole
 * path turns them into the same fingerprint, and the detector then stops a
 * worker for making progress. Caught by running it, not by reading it.
 *
 * So: the temp root and the random middle segments go, and the file name at the
 * end stays -- a segment is kept only if it looks like a file (it has a dot),
 * because a trailing directory name under /tmp is the random part.
 */
function scrubTempPath(match) {
  const segments = match.split(/[\\/]/).filter((part) => part !== '');
  const last = segments[segments.length - 1] ?? '';
  return last.includes('.') ? `<tmp>/${last}` : '<tmp>';
}

const SCRUBBERS = Object.freeze([
  // ISO timestamps, with or without fractional seconds and zone
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  // epoch milliseconds (13 digits) and seconds (10 digits)
  [/\b\d{13}\b/g, '<epoch>'],
  [/\b\d{10}\b/g, '<epoch>'],
  // durations a test runner prints on every line it ever prints
  [/\b\d+(?:\.\d+)?\s?ms\b/g, '<ms>'],
  [/\b\d+(?:\.\d+)?\s?s\b/g, '<s>'],
  // temp paths -- see scrubTempPath; keeps the file name, drops the run-unique
  // directories above it
  [/(?:\/tmp|\/var\/folders|[A-Za-z]:\\Temp)(?:[\\/][A-Za-z0-9_.-]+)*/gi, scrubTempPath],
  // pids
  [/\bpid[= ]\d+/gi, 'pid=<pid>'],
  // v8 object addresses
  [/0x[0-9a-f]{4,}/gi, '<addr>'],
  // shas, uuids and other hex identifiers -- LAST, so it cannot eat the
  // structured forms above before they match
  [/\b[0-9a-f]{7,64}\b/g, '<hex>'],
]);

export function normaliseForFingerprint(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/*
 * The fingerprint of one attempt. Two fields decide it:
 *
 *   WHAT WAS TRIED  the task, the base commit, the files that ended up changed
 *   WHAT CAME BACK  the outcome, the exit code, the failure text normalised
 *
 * `baseSha` is deliberately NOT scrubbed as hex: it is the one identifier whose
 * change means genuine progress, and scrubbing it would make a rebase onto a
 * fixed base look like the same attempt.
 */
export function fingerprintAttempt({
  taskId,
  baseSha = null,
  filesChanged = [],
  outcome = null,
  exitCode = null,
  failureText = '',
  testSummary = null,
} = {}) {
  if (typeof taskId !== 'string' || taskId === '') {
    throw new TypeError('fingerprintAttempt: taskId required');
  }
  const parts = [
    `task:${taskId}`,
    `base:${baseSha ?? 'none'}`,
    `files:${[...new Set(filesChanged)].sort().join(',')}`,
    `outcome:${outcome ?? 'none'}`,
    `exit:${exitCode ?? 'none'}`,
    testSummary === null
      ? 'tests:none'
      : `tests:${testSummary.passed}/${testSummary.failed}/${testSummary.skipped}`,
    `failure:${normaliseForFingerprint(failureText)}`,
  ];
  return sha256(parts.join('\n'));
}

/*
 * A shorter fingerprint over the failure alone, for "this is the same error in
 * a different file" questions. Kept separate rather than folded in, because a
 * detector that cannot tell those two apart has no way to say which one it saw.
 */
export function fingerprintFailure(failureText) {
  return sha256(normaliseForFingerprint(failureText));
}
