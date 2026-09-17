/**
 * WHAT THE MACHINE HAD WHEN THE BEAT WENT OUT.
 *
 * ═══ WHY THIS EXISTS: THREE AGENTS ASSERTED IT AND NOBODY MEASURED IT ═══
 *
 * On 2026-09-16 the roster went dark. b6 reported the watcher "killed for low
 * memory, twice within minutes -- under one gigabyte free of seven point seven,
 * with thirteen claude processes holding one point seven seven". Danny agreed.
 * I agreed. Nothing in this repository recorded a single number: `freemem`,
 * `totalmem`, `loadavg` and `memoryUsage` returned ZERO matches across src/,
 * bin/ and the edge function.
 *
 * So the one thing everybody was sure of was the one thing nobody had. And
 * b6's own figures argued against the consensus -- 1.77 GB of 7.7 is a quarter
 * of the machine, leaving about five gigabytes held by something unidentified.
 * Cutting agent sessions on that reading could remove a quarter of the usage
 * and leave the machine exactly as tight as before.
 *
 * ═══ THIS IS A DIAGNOSTIC, NOT A CONTROL ═══
 *
 * It decides nothing, gates nothing and refuses nothing. `liveness-from-
 * activity` already removed the watcher from the critical path, so a dead
 * watcher is a degraded optimisation rather than an outage. What is left is a
 * question of fact, and this answers it by writing down what was true at each
 * beat -- in particular at the LAST beat before a worker goes quiet, which is
 * the sample nobody can take after the fact.
 *
 * ═══ IT MUST NEVER BREAK A BEAT ═══
 *
 * A diagnostic that can fail the thing it observes is worse than no diagnostic:
 * it converts a memory question into an outage, and it does so exactly when the
 * machine is least able to cope. So every reading is wrapped, every failure
 * returns null, and `null` means UNKNOWN rather than zero -- the rule this
 * bridge already states for every field it serves. A reading that could not be
 * taken is not a machine with no memory.
 *
 * PURE. The `os` façade and the clock arrive as arguments, so the branches that
 * only appear on a machine under pressure can be tested on one that is not.
 */

const MB = 1024 * 1024;

/** A number, or null. Never NaN, never Infinity, never a string. */
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Bytes to whole megabytes, or null. Storing bytes makes every row unreadable. */
const mb = (bytes) => {
  const n = finite(bytes);
  return n === null ? null : Math.round(n / MB);
};

/**
 * Read what the machine has, defensively.
 *
 * @param os   an object shaped like node:os — injected so the failure modes are testable
 * @param now  ISO timestamp, supplied by the caller for the same reason
 */
export function readResources(os, { now } = {}) {
  const attempt = (fn) => { try { return fn(); } catch { return null; } };

  const total = mb(attempt(() => os?.totalmem?.()));
  const free = mb(attempt(() => os?.freemem?.()));

  /*
   * LOAD AVERAGE IS MEANINGLESS ON WINDOWS AND NODE SAYS SO BY RETURNING ZEROS.
   * Storing [0,0,0] there would be a measurement of nothing that reads as an
   * idle machine, which is the opposite of the truth we are chasing. The
   * platform decides whether the field exists at all.
   */
  const raw = attempt(() => os?.loadavg?.());
  const platform = attempt(() => os?.platform?.()) ?? null;
  const load1 = (platform === 'win32' || !Array.isArray(raw)) ? null : finite(raw[0]);

  return {
    at: typeof now === 'string' && now.trim() ? now : null,
    platform,
    memTotalMb: total,
    memFreeMb: free,
    // Derived here rather than at the read site, so every consumer computes it
    // the same way — and null-safe, because a percentage of unknown is unknown.
    memFreePct: (total && free !== null && total > 0)
      ? Math.round((free / total) * 1000) / 10
      : null,
    load1,
    cpus: finite(attempt(() => os?.cpus?.()?.length)),
  };
}

/**
 * Is this reading worth alarming about?
 *
 * SEPARATE FROM READING IT, because a threshold is a judgement and a reading is
 * a fact. Keeping them apart means the stored history stays useful when
 * somebody decides the threshold was wrong, which they will: the number below
 * is a guess until the history this module collects says otherwise, and it is
 * labelled a guess rather than dressed up as a finding.
 */
export const LOW_MEMORY_PCT = 15;

export function isLowMemory(reading, { thresholdPct = LOW_MEMORY_PCT } = {}) {
  const pct = reading?.memFreePct;
  // UNKNOWN IS NOT LOW. Treating a failed reading as an alarm would make a
  // permissions error look like an exhausted machine, and the operator would
  // go looking for memory they have plenty of.
  if (typeof pct !== 'number') return false;
  return pct < thresholdPct;
}

/**
 * Keep the newest `limit` rows.
 *
 * BOUNDED BECAUSE THIS RUNS FOREVER. An append-only diagnostic on a developer
 * machine is a slow disk leak, and a memory investigation that fills the disk
 * has changed the thing it was measuring.
 */
export const HISTORY_LIMIT = 500;

export function appendBounded(rows, reading, { limit = HISTORY_LIMIT } = {}) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const next = [...list, reading];
  return next.length <= limit ? next : next.slice(next.length - limit);
}
