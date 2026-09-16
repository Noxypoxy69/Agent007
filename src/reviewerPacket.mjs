/*
 * THE REVIEWER PACKET. What a reviewer is allowed to see.
 *
 * The packet is built from the ENVELOPE'S EVIDENCE PROJECTION and nothing else.
 * The worker's notes are not in it. Not summarised, not quoted, not attached
 * "for context" -- absent. A reviewer that can read the author's account of the
 * work will eventually weigh it, and at that moment the author is deciding
 * whether the author's work is acceptable.
 *
 * `assertNoProse` below is the enforcement, and it is checked on every build
 * rather than in a test: a test proves today's fields are clean, and a field
 * added next month is the one that leaks. It compares the serialised packet
 * against the notes string it was told to exclude, so it catches prose that
 * arrived by a route nobody predicted.
 */

import { evidenceOf, verdictFor } from './resultEnvelope.mjs';

export const PACKET_VERSION = 1;

function fail(message) {
  throw new Error(`reviewer packet: ${message}`);
}

/*
 * Build the packet. `diffRef` and `logRef` are REFERENCES -- the reviewer
 * fetches them if it wants them, and fetching a diff is reading the code, which
 * is fine. Reading the author's summary is not.
 */
export function buildReviewerPacket({ envelope, diffRef = null, logRef = null, contract = null }) {
  const evidence = evidenceOf(envelope);
  const verdict = verdictFor(envelope);

  const packet = Object.freeze({
    version: PACKET_VERSION,
    taskId: evidence.taskId,
    attempt: evidence.attempt,
    evidence,
    // the mechanical verdict, so a reviewer can see what the machine already
    // knows and disagree explicitly rather than re-deriving it
    machineVerdict: verdict,
    contract: contract === null ? null : Object.freeze({ ...contract }),
    diffRef,
    logRef,
  });

  assertNoProse(packet, envelope.notes ?? '');
  return packet;
}

/*
 * Refuse to ship a packet that contains the worker's prose.
 *
 * A FIXED PREFIX IS NOT ENOUGH, which the first version of this got wrong: if
 * the leak truncates the notes -- a summary field with its own cap, a log line
 * that wrapped -- a prefix comparison misses it, and the check passes over the
 * exact leak it exists to catch. So it slides a window across the whole of the
 * notes instead, and any window that turns up in the serialised packet is a
 * leak wherever it came from.
 *
 * Very short notes are skipped: a handful of characters would match inside a
 * sha and fail every build, and a check that is red for a reason you must
 * ignore is a check people learn to ignore.
 */
const WINDOW = 24;
const STEP = 8;

export function assertNoProse(packet, notes) {
  if (typeof notes !== 'string') return;
  const text = notes.trim();
  if (text.length < WINDOW) return;
  const serialised = JSON.stringify(packet);
  const windows = [];
  for (let i = 0; i + WINDOW <= text.length; i += STEP) windows.push(text.slice(i, i + WINDOW));
  /*
   * And one anchored at the END. Stepping by 8 leaves up to seven characters of
   * tail that no window covers, so a leak of the last sentence alone walks
   * straight past -- which is what the test caught. The final window closes it.
   */
  windows.push(text.slice(-WINDOW));

  for (const window of windows) {
    if (serialised.includes(window)) {
      fail(`worker prose reached the reviewer packet: ${JSON.stringify(window)}`);
    }
  }
}
