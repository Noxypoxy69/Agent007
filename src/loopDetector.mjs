/*
 * LOOP DETECTION over attempt fingerprints.
 *
 * Two shapes, because the system produces both and they need different tests:
 *
 *   REPEAT       the same fingerprint N times inside a window. A worker doing
 *                the identical thing and getting the identical failure.
 *   OSCILLATION  A B A B. Two states a worker flips between -- a fix that
 *                breaks the other test, and the revert that brings it back.
 *                Every individual attempt differs from the one before it, so a
 *                repeat detector alone never fires, and this is the shape that
 *                runs all night.
 *
 * The state is a value, not an object with methods: `observe` returns a new
 * state. That makes it safe to keep in a durable row and reconstruct, which is
 * the only way this survives a worker restart -- and a loop detector that
 * forgets everything when the worker restarts is a loop detector that never
 * fires against a worker that keeps restarting.
 */

const DEFAULTS = Object.freeze({ window: 6, repeatThreshold: 3, oscillationCycles: 2 });

export function createLoopState(options = {}) {
  const config = { ...DEFAULTS, ...options };
  if (config.repeatThreshold < 2) throw new RangeError('repeatThreshold must be at least 2');
  if (config.window < config.repeatThreshold) throw new RangeError('window is below threshold');
  return Object.freeze({ recent: Object.freeze([]), config: Object.freeze(config) });
}

function detectRepeat(recent, threshold) {
  const counts = new Map();
  for (const fp of recent) counts.set(fp, (counts.get(fp) ?? 0) + 1);
  for (const [fp, count] of counts) {
    if (count >= threshold) return { kind: 'repeat', fingerprint: fp, count };
  }
  return null;
}

/*
 * A B A B ... with A !== B. `cycles` is how many full A B pairs are required;
 * two pairs is four attempts, which is enough to be deliberate and few enough
 * to catch it before the budget is gone.
 */
function detectOscillation(recent, cycles) {
  const needed = cycles * 2;
  if (recent.length < needed) return null;
  const tail = recent.slice(-needed);
  const a = tail[0];
  const b = tail[1];
  if (a === b) return null;
  for (let i = 0; i < needed; i += 1) {
    if (tail[i] !== (i % 2 === 0 ? a : b)) return null;
  }
  return { kind: 'oscillation', fingerprints: [a, b], cycles };
}

/*
 * Record one attempt. Returns { state, loop } where `loop` is null or a
 * machine-readable description -- never a boolean alone, because the caller
 * that stops a worker has to be able to say in the record WHICH loop it saw.
 */
export function observe(state, fingerprint) {
  if (typeof fingerprint !== 'string' || fingerprint === '') {
    throw new TypeError('observe: fingerprint must be a non-empty string');
  }
  const recent = [...state.recent, fingerprint].slice(-state.config.window);
  const loop =
    detectRepeat(recent, state.config.repeatThreshold) ??
    detectOscillation(recent, state.config.oscillationCycles);
  return {
    state: Object.freeze({ recent: Object.freeze(recent), config: state.config }),
    loop: loop === null ? null : Object.freeze(loop),
  };
}

/*
 * Clearing on progress is the caller's decision, not this module's, because
 * only the caller knows what progress means for its task. Provided so that the
 * decision is at least explicit at the call site.
 */
export function clearOnProgress(state) {
  return Object.freeze({ recent: Object.freeze([]), config: state.config });
}
