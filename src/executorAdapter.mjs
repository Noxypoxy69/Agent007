/*
 * EXECUTOR ADAPTER. One shape for "run a unit of work", whatever runs it.
 *
 * Claude Code, a hosted API worker, a local script, a fake in a test -- the
 * loop above them must not care which. So an adapter declares an id and its
 * capabilities and provides `run`, and this module owns everything else:
 * validating the spec before anything starts, and normalising whatever comes
 * back into the small set of fields a decision is allowed to see.
 *
 * WHAT AN ADAPTER MAY NOT REPORT. Not test counts. Not the commit it produced.
 * Not whether it succeeded. Those are read from git and from the test output by
 * the evidence collector, because they are the facts a failing agent is most
 * motivated to get wrong. An adapter returning `tests` or `commit` is rejected
 * here rather than ignored -- silently dropping it means a future reader finds
 * the field in the adapter, assumes it is used, and builds on it.
 *
 * The normaliser refuses to invent an exit code. An adapter that says it exited
 * without saying with what has told us nothing, and "probably 0" is exactly the
 * assumption that turns a broken run into an accepted one.
 */

export const CAPABILITIES = Object.freeze([
  'shell', // may run commands
  'network', // may reach outside the workspace
  'write', // may modify the workspace
  'commit', // may create commits
]);

const SPEC_KEYS = Object.freeze(['taskId', 'attempt', 'cwd', 'argv', 'prompt', 'env', 'timeoutMs']);

const RAW_KEYS = Object.freeze([
  'outcome',
  'exitCode',
  'signal',
  'stdout',
  'stderr',
  'artifacts',
  'notes',
  'durationMs',
  /*
   * WHAT THE RUNNER SAW A PROMPT SAY. Added after the first real end-to-end run
   * of this pipeline refused its own executor: the `prompted` outcome shipped
   * with a `prompt` field, and this list rejected it as an unknown adapter
   * field. Every unit test passed, because they call an adapter's `run`
   * directly and never go through `execute`. The module was exercised; the path
   * was not.
   *
   * It is EVIDENCE rather than a claim -- a token the runner matched in the
   * child's own output -- so it is allowed here, unlike the USURPED fields
   * above, which are an adapter trying to judge its own work.
   */
  'prompt',
]);

// Fields an adapter is specifically forbidden to supply, named so the error can
// say why rather than "unknown field".
const USURPED = Object.freeze({
  tests: 'test counts are parsed from output by the evidence collector',
  commit: 'the commit is read from git, not reported by the work',
  verdict: 'no adapter decides whether its own run was acceptable',
  success: 'no adapter decides whether its own run was acceptable',
  /*
   * `failure` is written by THIS module when an adapter throws, and a decision
   * reads it. That is exactly why an adapter may not supply one: an adapter
   * that can label its own crash `transient` can buy itself retries forever.
   */
  failure: 'the crash reason is recorded by the runner, not reported by the work',
});

function fail(message) {
  throw new TypeError(`executor: ${message}`);
}

export function defineExecutor({ id, capabilities = [], run } = {}) {
  if (typeof id !== 'string' || id.trim() === '') fail('id must be a non-empty string');
  if (typeof run !== 'function') fail('run must be a function');
  if (!Array.isArray(capabilities)) fail('capabilities must be an array');
  for (const capability of capabilities) {
    if (!CAPABILITIES.includes(capability))
      fail(`unknown capability ${JSON.stringify(capability)}`);
  }
  return Object.freeze({ id, capabilities: Object.freeze([...capabilities]), run });
}

export function validateSpec(spec, adapter) {
  if (spec === null || typeof spec !== 'object') fail('spec must be an object');
  for (const key of Object.keys(spec)) {
    if (!SPEC_KEYS.includes(key)) fail(`unknown spec field ${JSON.stringify(key)}`);
  }
  if (typeof spec.taskId !== 'string' || spec.taskId === '') fail('spec.taskId required');
  if (typeof spec.cwd !== 'string' || spec.cwd === '') fail('spec.cwd required');
  if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
    /*
     * There is no such thing as an execution without a deadline. A missing
     * timeout does not mean "be patient", it means a wedged worker holds its
     * lease until something else notices, which is the failure mode with the
     * longest detection time in the whole system.
     */
    fail('spec.timeoutMs must be a positive integer');
  }
  if (spec.argv !== undefined) {
    if (!Array.isArray(spec.argv) || spec.argv.length === 0) fail('spec.argv must be non-empty');
    for (const arg of spec.argv) {
      if (typeof arg !== 'string') fail('spec.argv entries must be strings');
    }
    if (!adapter.capabilities.includes('shell')) {
      fail(`adapter ${adapter.id} has no shell capability but the spec carries argv`);
    }
  }
  if (spec.env !== undefined) {
    if (spec.env === null || typeof spec.env !== 'object') fail('spec.env must be an object');
    for (const [name, value] of Object.entries(spec.env)) {
      if (typeof value !== 'string') fail(`spec.env.${name} must be a string`);
    }
  }
  if (spec.argv === undefined && spec.prompt === undefined) fail('spec needs argv or prompt');
  return spec;
}

/*
 * Normalise a raw adapter result. Returns the execution shape the evidence
 * collector consumes -- and only that shape.
 */
export function normaliseResult(raw) {
  if (raw === null || typeof raw !== 'object') fail('adapter returned a non-object');
  for (const key of Object.keys(raw)) {
    if (USURPED[key]) fail(`adapter may not report ${key}: ${USURPED[key]}`);
    if (!RAW_KEYS.includes(key)) fail(`unknown adapter result field ${JSON.stringify(key)}`);
  }

  const outcome = raw.outcome;
  if (outcome === 'exited') {
    if (!Number.isInteger(raw.exitCode)) {
      fail('adapter reported outcome exited without an integer exitCode');
    }
  } else if (!['timeout', 'crashed', 'refused', 'unreachable', 'prompted'].includes(outcome)) {
    fail(`adapter reported unknown outcome ${JSON.stringify(outcome)}`);
  } else if (raw.exitCode !== undefined && raw.exitCode !== null) {
    fail(`outcome ${outcome} cannot carry an exit code`);
  }

  return Object.freeze({
    outcome,
    exitCode: outcome === 'exited' ? raw.exitCode : null,
    signal: raw.signal ?? null,
    stdout: raw.stdout ?? undefined,
    stderr: raw.stderr ?? undefined,
    artifacts: Object.freeze([...(raw.artifacts ?? [])]),
    durationMs: raw.durationMs ?? null,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    prompt: raw.prompt ?? null,
  });
}

/*
 * Run one spec through one adapter.
 *
 * A throw from `run` is an execution outcome, not a program error: the loop
 * above must be able to record "this adapter blew up" and move on, rather than
 * unwinding and losing the attempt. It becomes `crashed`, with the message kept
 * as notes -- which, being notes, no decision reads.
 */
export async function execute(adapter, spec, io = {}) {
  validateSpec(spec, adapter);
  const now = io.now ?? (() => Date.now());
  const startedAt = now();
  let raw;
  try {
    raw = await adapter.run(spec, io);
  } catch (error) {
    const message = error?.message ?? String(error);
    return Object.freeze({
      outcome: 'crashed',
      exitCode: null,
      signal: null,
      stdout: undefined,
      stderr: undefined,
      artifacts: Object.freeze([]),
      durationMs: now() - startedAt,
      /*
       * SYSTEM EVIDENCE, NOT AGENT PROSE, and the distinction is the whole
       * point of this field.
       *
       * The reason used to go into `notes` alone. But notes is what the WORK
       * said -- resultEnvelope calls it "carried for a human, read by no
       * decision", and evidenceOf omits it on purpose. So the single fact that
       * separates a permanent crash from a transient one was filed in the one
       * field guaranteed to be ignored. `spawn ENOENT`, the shape executorLocal
       * produces when its empty-PATH launch cannot resolve a bare executable,
       * is deterministic: retrying it spends attempts on something that cannot
       * succeed, and the retry decision had no way to know.
       *
       * This did not come from the work, so it travels where a decision can
       * read it. `notes` keeps the same text for a human reading the envelope.
       */
      failure: Object.freeze({ kind: 'adapter-threw', adapter: adapter.id, message }),
      notes: `adapter ${adapter.id} threw: ${message}`,
    });
  }
  const normalised = normaliseResult(raw);
  return normalised.durationMs === null
    ? Object.freeze({ ...normalised, durationMs: now() - startedAt })
    : normalised;
}
