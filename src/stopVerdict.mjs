/**
 * STOP-GATE VERDICT REUSE AND THE ONE-SUITE LOCK: the decisions, pure.
 *
 * WHY THIS EXISTS (FINDINGS F-31). Every seat's turn end ran the FULL suite on
 * the SAME unchanged shared checkout, often three or four at once; under that
 * load a run that takes ~78 s quiet took over 30 minutes and ended in
 * stop-deadline or an unnamed test-run-failed. scripts/claude-stop-gate.mjs
 * now (1) reuses a PASS recorded for byte-identical inputs, and (2) lets only
 * one suite run on the machine at a time, with the others waiting for it.
 *
 * OWNER RULING (a), T-147, 2026-09-24. A reused PASS certifies "these exact
 * inputs passed at <time> on this machine" -- NOT that the suite passes now.
 * The key cannot cover everything a suite verdict depends on, and the residual
 * is printed in every reused-pass message (REUSE_RESIDUAL below). Owner intent,
 * recorded: option (b), a hermetic suite, comes next, and would let the key be
 * honest without the residual.
 *
 * NOT A SECURITY BOUNDARY. The store and the lock live in the same user's
 * state directory; anyone who can run this gate can edit them. Stop is
 * honest-error detection (Constitutional Rule 1), and so is this.
 *
 * PURE: no filesystem, no spawn, no clock. The gate reads, hashes and times;
 * everything decided here can be imported and watched failing (CLAUDE.md
 * rule 10).
 */

import { createHash } from 'node:crypto';

export const VERDICT_STORE_LABEL = 'same-user; honest-error detection only';

/**
 * A reused PASS younger than this is FRESH. Older, and still inside
 * REUSE_WINDOW_MS, it is reused but LABELLED "NOT FRESH" (T-273). This was the
 * whole reuse window under owner ruling (a); it is now only the label's bound.
 */
export const MAX_REUSE_AGE_MS = 10 * 60 * 1000;

/*
 * ═══ T-273: ONE HOUR, AND ONLY WHILE THE NEWEST RECORD FOR THE KEY IS A PASS ═══
 *
 * OWNER DECISION, amending ruling (a): "1-hour reuse with immediate
 * state-change invalidation". MEASURED (T-264, T-265): 51 of 57 runs re-proved
 * a key that had already passed -- 94% of suite time -- every one just past
 * the 10-minute window.
 *
 * "Immediate state-change invalidation" is the KEY: any change to any keyed
 * input (one byte of a tracked file, an untracked file, the environment, the
 * gate script, the secrets dir ...) is a different key, and a different key has
 * no record to reuse. Nothing here ages a PASS out faster on a change; the
 * change simply is not the state the PASS was for.
 *
 * AND A NEWER NON-PASS WINS (T-265 P1-H1). Key a543adf9 recorded PASS x3,
 * FAIL, FAIL, PASS on byte-identical inputs: a flaky test, or state outside
 * the key, moved the verdict. The old rule picked the newest PASS and ignored
 * a newer FAIL, so a PASS was reusable ACROSS a FAIL for the same inputs. Now
 * the NEWEST record for the key decides: if it is a fail or a deadline, nothing
 * is reused until a new run passes.
 *
 * STATED COST, not closed: within the hour after a PASS nothing re-runs, so a
 * flaky failure in that hour is never OBSERVED. The two a543adf9 FAILs started
 * 1588 s and 1768 s after a PASS, inside 3600 s: under this window both would
 * have been reuses. test/stopVerdict.test.mjs pins that.
 */
export const REUSE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Environment variables EXCLUDED from the key: identifiers that differ per
 * Claude Code session or terminal and would stop two seats on the same bytes
 * from ever sharing a verdict. Each was checked: NO file under src/, bin/,
 * bridge/, mcp/, scripts/ or test/ reads any of them (ripgrep, plus a byte
 * search of the two NUL-framed files grep skips). Everything else the gate
 * passes to the suite -- PATH, HOME, TEMP, NODE_*, GIT_*, AGENTBRIDGE_*, ... --
 * is in the key. Compared case-insensitively, as Windows resolves them.
 *
 * T-264 added four that differ per SESSION rather than per tree: the effort
 * level, the entrypoint (a tab and an SDK subagent differ), the Claude Code
 * executable path (it moves on every auto-update) and the agent marker. The
 * "nothing reads it" claim is a TEST (test/stopVerdict.test.mjs), generated
 * over this list, over every file in the repository, case-insensitively.
 * STATED LIMIT: a reader that builds the name at runtime, or reads
 * process.env wholesale, is invisible to a byte scan.
 */
export const EXCLUDED_ENV = Object.freeze([
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'WT_SESSION', 'WT_PROFILE_ID',
  'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'AI_AGENT',
]);

/** Every part the key is computed over. A missing part means no key, so no reuse. */
export const KEY_PARTS = Object.freeze([
  'repoRoot', 'head', 'tracked', 'untracked', 'ignored', 'gateScriptSha256', 'suiteFiles',
  'nodeVersion', 'platform', 'arch', 'env', 'secrets',
]);

const EXCLUDED = new Set(EXCLUDED_ENV.map((k) => k.toUpperCase()));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The environment that goes into the key: every [name, value] except EXCLUDED_ENV, sorted. */
export function envForKey(env) {
  return Object.entries(env ?? {})
    .filter(([k]) => !EXCLUDED.has(String(k).toUpperCase()))
    .map(([k, v]) => [String(k), String(v)])
    .sort((a, b) => cmp(a[0].toUpperCase(), b[0].toUpperCase()) || cmp(a[0], b[0]));
}

/**
 * sha256 over every KEY_PART, in a fixed order, with every list sorted -- so
 * the same inputs give the same key whatever order the gate observed them in.
 * THROWS when a part is missing: a key that silently omits an input would
 * reuse a verdict across a change to it.
 */
export function verdictKey(parts) {
  const missing = KEY_PARTS.filter((p) => parts?.[p] === undefined);
  if (missing.length) throw new Error(`verdict key: missing part(s) ${missing.join(', ')}`);
  const sortRows = (rows) => [...rows].map((r) => (Array.isArray(r) ? r.map(String) : String(r)))
    .sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));
  const canonical = KEY_PARTS.map((p) => {
    const v = parts[p];
    return [p, Array.isArray(v) ? sortRows(v) : v];
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const OUTCOMES = new Set(['pass', 'fail', 'deadline']);
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && !Number.isNaN(Date.parse(s));

/** One store line. The label is on every record, so a stray copy still says what it is. */
export function formatVerdictRecord({ key, outcome, at, durationMs, counts }) {
  return `${JSON.stringify({ v: 1, label: VERDICT_STORE_LABEL, key, outcome, at, durationMs, counts })}\n`;
}

/**
 * Parse the append-only store. ANY malformed line makes the whole store
 * unusable ({ok:false}), because a store that cannot be read entirely cannot
 * be trusted partially -- and an unusable store means a full run, never a pass.
 * Empty text is a valid, empty store.
 */
export function parseVerdictStore(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'store was not text' };
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === '' && i === lines.length - 1) continue;
    let r;
    try { r = JSON.parse(line); } catch { return { ok: false, reason: `line ${i + 1} is not JSON` }; }
    if (!r || r.v !== 1 || r.label !== VERDICT_STORE_LABEL || typeof r.key !== 'string' || !/^[0-9a-f]{64}$/.test(r.key)
      || !OUTCOMES.has(r.outcome) || !isIso(r.at)) {
      return { ok: false, reason: `line ${i + 1} is not a verdict record` };
    }
    records.push(r);
  }
  return { ok: true, records };
}

/**
 * Rule 1 (T-273): among the records whose key equals the current key EXACTLY,
 * take the NEWEST, whatever its outcome. Reuse it only if it is a PASS younger
 * than maxAgeMs (and not dated in the future). A fail or a deadline is never
 * reused, and a fail or a deadline NEWER than a PASS blocks that PASS too. A
 * pass and a non-pass at the same instant count as the non-pass. A record for
 * the key with no readable time refuses reuse outright: its order is unknown.
 */
export function chooseReuse({ records, key, nowMs, maxAgeMs = REUSE_WINDOW_MS }) {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return { reuse: null, reason: 'no key' };
  if (!Array.isArray(records)) return { reuse: null, reason: 'no records' };
  let newest = null;
  let newestMs = -Infinity;
  for (const r of records) {
    if (r?.key !== key) continue;
    const t = Date.parse(r.at);
    if (Number.isNaN(t)) return { reuse: null, reason: 'a record for this key has no readable time' };
    if (t > newestMs || (t === newestMs && r.outcome !== 'pass')) { newest = r; newestMs = t; }
  }
  if (!newest) return { reuse: null, reason: 'no record for this key' };
  if (newest.outcome !== 'pass') return { reuse: null, reason: `the newest record for this key is a ${String(newest.outcome)}, not a pass` };
  const age = nowMs - newestMs;
  if (!(age >= 0 && age < maxAgeMs)) return { reuse: null, reason: 'the newest pass for this key is outside the reuse window' };
  return { reuse: newest, reason: null };
}

/** What a reused pass does and does NOT certify. Printed verbatim in every reused-pass message. */
export const REUSE_RESIDUAL = 'It does NOT cover network or production-server state, the live process table, the clock, or machine load, nor hand edits inside node_modules that npm\'s lockfile (node_modules/.package-lock.json) does not record.';

/*
 * THE ABA RESIDUAL (owner ruling, T-154 measured it in every file dimension). The
 * key is observed before the suite and before the record, so a change made and
 * REVERTED while the suite runs leaves both keys equal while the suite read the
 * other state. That is a measured limitation, stated on every reuse, not closed.
 */
const ABA_RESIDUAL = 'Identity matched at the pre-run and pre-save boundaries; changes made and reverted during the run are not excluded.';

export function reusedPassMessage(record, nowMs) {
  const ageMs = nowMs - Date.parse(record.at);
  const ageS = Math.round(ageMs / 1000);
  /* T-273: past the freshness bound the message says so, in its own sentence, before anything else is claimed. */
  const notFresh = ageMs >= MAX_REUSE_AGE_MS
    ? `NOT FRESH: this PASS is ${Math.floor(ageMs / 60_000)} minutes old, past the ${MAX_REUSE_AGE_MS / 60_000}-minute freshness bound; nothing the key covers has changed since, and nothing it does not cover has been re-checked since. `
    : '';
  return `[agentbridge:stop-verdict-reused] The suite was NOT run for this turn. ${notFresh}A PASS recorded ${ageS}s ago is reused because every keyed input is byte-identical (key ${record.key.slice(0, 16)}). `
    + `This reused pass certifies "these exact inputs passed at ${record.at} on this machine". ${REUSE_RESIDUAL} `
    + `${ABA_RESIDUAL} `
    + `Store: ${VERDICT_STORE_LABEL}.`;
}

/*
 * ═══ T-153: THE KEY IS OBSERVED MORE THAN ONCE ═══
 *
 * T-148 S16, measured: T-147 observed the key ONCE, before the lock wait, ran
 * the suite on the tree as it stood AFTER the wait, and recorded the outcome
 * under the old key. A waiter that started on a failing tree X, while the tree
 * became a passing Y, recorded Y's PASS as X's -- and the next gate on X reused
 * a PASS that X never earned. So the key is re-observed immediately before the
 * suite and immediately before recording, and a record is written only when all
 * three agree. Every reuse is keyed on the state as it is AT THAT MOMENT.
 */

/** A record is written only when the key was the same before the wait, before the suite and before recording. */
export function shouldRecord({ keyBeforeWait, keyBeforeSuite, keyBeforeRecord }) {
  const ok = (k) => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);
  return ok(keyBeforeWait) && keyBeforeWait === keyBeforeSuite && keyBeforeSuite === keyBeforeRecord;
}

/**
 * T-344 r2: THE OUTCOME-LOG ENTRY A COMPLETED RUN APPENDS -- 'fail', 'pass' or null (nothing). Pure (rule 10).
 *
 * A KNOWN RED IS A FAIL WHATEVER STATE THE RUN ENDED IN (verifier §5 F1). A run can print `not ok` for a test and
 * still end VERIFY_PARTIAL -- a shard that dies without a summary, an NTSTATUS crash, a killed shard -- and the gate
 * itself then names the failing test. Logging only VERIFY_FAILED left that red out of the write sequence, so the next
 * Stop got a hall pass. The cut path already logs `failingTests(output) > 0` as a FAIL; this is the same rule.
 *   - FAIL: the run ended VERIFY_FAILED, OR its output names at least one failing test. The key need not have held
 *     (a red seen on a moving tree still refuses a hall pass: the safe direction; verifier §5 F4 / MG1).
 *   - PASS: only VERIFY_PASSED with the key held through the run (shouldRecord), and no failing test named.
 *   - nothing: anything else, e.g. VERIFY_PARTIAL naming no failing test. A partial run proves neither way.
 */
export function completedOutcome({ state, failingOutput, keysAgree } = {}) {
  // T-353: failingOutput may be ONE text or the per-shard, per-stream segments of decisionTexts (below).
  const named = failuresIn(failingOutput).length;
  if (state === 'VERIFY_FAILED' || named > 0) return 'fail';
  if (state === 'VERIFY_PASSED' && keysAgree === true) return 'pass';
  return null;
}

/*
 * ═══ T-353: THE DECISION READS THE WHOLE SHARD STREAM, NOT THE DISPLAY TAIL ═══
 *
 * THE DEFECT (T-344 §8 V2-F1, HIGH, measured through the real gate). completedOutcome and the gate's cut path
 * decided from record.failing_output, which verifyRunner keeps as the last 6000 characters of each failing shard and
 * 16000 in all. A red printed early and followed by more than 6000 characters of ordinary output (120 passing tests
 * with long names) was gone before anything asked, so no FAIL entry was written and the next Stop got a HALL PASS.
 * The display may be truncated; a decision that reads the truncated display is the defect.
 *
 * So every shard stream is SCANNED AS IT ARRIVES (failureScanner) and only the lines failingTests can act on are
 * kept -- bounded, never the stream itself. The decision reads those excerpts (decisionTexts), one segment per shard
 * and stream, and a red named in ANY segment is a red (failuresIn sums them; a segment never outranks another).
 *
 * THE EXCERPT IS CHECKED AGAINST THE PARSER, NOT A COPY OF IT (hollow gate 2). A line is kept as an entry only when
 * failingTests ITSELF names a failure in that line, so the two cannot drift: test/stopVerdict.test.mjs compares
 * failingTests(excerpt) with failingTests(whole stream) over GENERATED streams and chunkings.
 *
 * KEPT, per stream:
 *   TAP  -- every `not ok` line failingTests counts, with its YAML block (capped at SCAN_LIMITS.yaml lines, then a
 *           synthetic `...` terminator, so a cut block cannot swallow the next one);
 *   spec -- every `✖ name (N ms)` line failingTests counts and the first non-blank indented line after it (its
 *           message); a `✖ failing tests:` header RESETS the spec part, exactly as failingTests reads only what
 *           follows the LAST header.
 * BOUNDED: each part holds at most SCAN_LIMITS.bucket characters -- but the FIRST entry of each part is always kept,
 * so a stream that names a red can never scan to an excerpt that names none. A line is held while it arrives up to
 * SCAN_LIMITS.line characters (its first and last halves; the middle of a longer line is dropped -- outside the
 * production domain, stated). Bytes are decoded as a stream, so a multi-byte `✖` split across chunks survives; a line
 * split across chunks is joined; CR, LF and CRLF end a line exactly as failingTests' own /\r\n?/ does.
 * PURE: no fs, no spawn; the runner feeds it chunks.
 */
const SCAN_LIMITS = Object.freeze({ line: 16384, bucket: 32768, yaml: 64 });   // reported by end() as `limits`
const SPEC_HEADER = '✖ failing tests:';
const indentOf = (l) => l.length - l.trimStart().length;

export function failureScanner(limits = {}) {
  const L = { ...SCAN_LIMITS, ...limits };
  const half = Math.max(1, Math.floor(L.line / 2));
  const decoder = new TextDecoder('utf-8');
  let cur = '';
  let head = null;          // the first half of an over-long line, once it has overflowed
  let pendingCR = false;    // the last chunk ended in \r: a leading \n in the next one is the same line break
  const tap = { lines: [], chars: 0, entries: 0, dropped: 0 };
  let spec = { lines: [], chars: 0, entries: 0, dropped: 0 };
  let mode = 'normal';      // 'normal' | 'afterTap' (a YAML block may start) | 'yaml'
  let tapIndent = 0;
  let yamlLines = 0;
  let specPending = false;  // the line after a kept spec entry may be its message
  let peak = 0;
  const retained = () => cur.length + (head?.length ?? 0) + tap.chars + spec.chars;
  const fits = (part, line) => part.chars + line.length + 1 <= L.bucket;
  const keep = (part, line) => { part.lines.push(line); part.chars += line.length + 1; };

  function line(text) {
    if (mode === 'afterTap') {
      if (text.trim() === '---') { keep(tap, text); mode = 'yaml'; yamlLines = 0; return; }
      mode = 'normal';
    }
    if (mode === 'yaml') {
      if (yamlLines < L.yaml && fits(tap, text)) {
        keep(tap, text);
        yamlLines += 1;
        if (text.trim() === '...' && indentOf(text) === tapIndent + 2) mode = 'normal';
        return;
      }
      keep(tap, `${' '.repeat(tapIndent + 2)}...`);   // cut the block HERE, then read this line normally
      mode = 'normal';
    }
    if (text.trim() === SPEC_HEADER) {
      spec = { lines: [text], chars: text.length + 1, entries: 0, dropped: spec.dropped, header: true, col0: 0 };
      specPending = false;
      return;
    }
    const named = (text.includes('not ok') || text.includes('✖')) && failingTests(text).length > 0;
    const isTap = named && text.trimStart().startsWith('not ok');
    // The first non-blank line after a spec entry is its message when indented. A NAMED line is never kept as a
    // message: it is kept as an entry below, and a TAP line kept twice would be counted twice (a TAP entry anywhere
    // outranks every spec entry in failingTests, so the spec message is not read at all then).
    if (specPending && text.trim() !== '') {
      specPending = false;
      if (/^\s/.test(text) && !named && fits(spec, text)) keep(spec, text);
      // A column-zero line ENDS the message search; mark it, or the next kept entry would be read as the message.
      else if (/^\S/.test(text) && !named) keep(spec, '--');
    }
    if (isTap) {
      if (tap.entries === 0 || fits(tap, text)) {
        keep(tap, text); tap.entries += 1; mode = 'afterTap'; tapIndent = indentOf(text);
      } else tap.dropped += 1;
      return;
    }
    if (named) {
      // After a header failingTests reads only column-zero entries, so the first of THOSE is always kept too.
      const col0 = indentOf(text) === 0;
      if (spec.entries === 0 || (spec.header && col0 && spec.col0 === 0) || fits(spec, text)) {
        keep(spec, text); spec.entries += 1; if (col0) spec.col0 = (spec.col0 ?? 0) + 1; specPending = true;
      } else { spec.dropped += 1; specPending = false; }
    }
  }
  function endLine() {
    const text = head === null ? cur : head + cur;
    cur = ''; head = null;
    line(text);
  }
  function piece(s) {
    if (!s) return;
    cur += s;
    if (cur.length > L.line) {
      if (head === null) head = cur.slice(0, half);
      cur = cur.slice(-half);
    }
  }
  function feed(s) {
    if (s === '') return;   // an empty chunk (or a partial UTF-8 sequence) must not forget a pending \r
    let from = 0;
    if (pendingCR) { pendingCR = false; if (s.startsWith('\n')) from = 1; }
    const re = /\r\n?|\n/g;
    re.lastIndex = from;
    let m;
    while ((m = re.exec(s)) !== null) {
      piece(s.slice(from, m.index));
      peak = Math.max(peak, retained());
      endLine();
      from = re.lastIndex;
    }
    piece(s.slice(from));
    if (s.endsWith('\r')) pendingCR = true;
    peak = Math.max(peak, retained());
  }
  let ended = null;
  let broken = null;
  return {
    /* NEVER THROWS: it runs inside a child's 'data' handler, where a throw would crash the gate, and a crashed gate
     * prints nothing -- which Claude Code reads as non-blocking. A chunk that cannot be read BREAKS the scan, and a
     * broken scan is reported in the refuse direction by end() below. */
    push(chunk) {
      if (ended || broken) return;
      try {
        feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
      } catch (e) { broken = String(e?.message ?? e).slice(0, 120) || 'unknown'; }
    },
    end() {
      if (ended) return ended;
      try {
        feed(decoder.decode());
      } catch (e) { broken ??= String(e?.message ?? e).slice(0, 120) || 'unknown'; }
      if (cur !== '' || head !== null) endLine();
      if (mode === 'yaml') keep(tap, `${' '.repeat(tapIndent + 2)}...`);
      // A scan that could not read its stream proves nothing either way: it NAMES that, so the decision refuses.
      if (broken) keep(spec, `✖ [agentbridge: the failure scan of this stream broke: ${broken.replace(/[\r\n]+/g, ' ')}] (0ms)`);
      peak = Math.max(peak, retained());
      // A blank line between the parts, so the spec part can never be read as the last TAP entry's YAML block.
      const text = tap.lines.length && spec.lines.length ? `${tap.lines.join('\n')}\n\n${spec.lines.join('\n')}` : [...tap.lines, ...spec.lines].join('\n');
      ended = { text, entries: tap.entries + spec.entries, dropped: tap.dropped + spec.dropped, peak, limits: L };
      return ended;
    },
  };
}

/**
 * T-353: the texts a decision reads for a record -- the scanned excerpts, one per shard and stream, when the runner
 * wrote them; otherwise (a record written before T-353) the display tail, as before.
 */
export function decisionTexts(record) {
  try {
    if (record && Array.isArray(record.failure_excerpts)) {
      return record.failure_excerpts.map((e) => (typeof e?.text === 'string' ? e.text : ''));
    }
    return [typeof record?.failing_output === 'string' ? record.failing_output : ''];
  } catch { return ['']; }   // total (outside the domain: records are parsed JSON, never proxies or getters)
}

/* One text or a list of segments, as a list of the STRINGS in it. Total: a container that cannot be read (outside the
 * production domain -- records are parsed JSON) is read as no text, exactly as a non-string was before T-353. */
function segmentsOf(texts) {
  try {
    return (Array.isArray(texts) ? [...texts] : [texts]).filter((t) => typeof t === 'string');
  } catch { return []; }
}

/** T-353: every failing test named in one text or in each of several segments -- a segment never hides another. */
export function failuresIn(texts) {
  return segmentsOf(texts).flatMap((t) => failingTests(t));
}

/** T-353: the one segment to NAME a failure from: the first naming a test that failed on its own account, else any. */
export function namingText(texts) {
  const list = segmentsOf(texts);
  return list.find((t) => failingTests(t).some((f) => !f.parent)) ?? list.find((t) => failingTests(t).length > 0) ?? '';
}

/** T-353: the text a failure REPORT is built from (a view): the segments that name a failure, in order. */
export function failureText(texts) {
  return segmentsOf(texts).filter((t) => failingTests(t).length > 0).join('\n');
}

/**
 * Reuse, run, or refuse -- the gate's whole wait, with every effect INJECTED so
 * each decision point can be driven and watched failing on its own (rule 10).
 *
 *   effects.currentKey()     the key over the inputs as they are NOW, or null
 *   effects.freshPass(key)   a reusable PASS record for exactly that key, or null
 *   effects.tryLock()        'taken' | 'held' | 'unusable' (unusable: run unlocked, as before T-147)
 *   effects.readLock()       the holder's lock, or 'vanished'
 *   effects.lockIsStale(l)   true when the holder is dead or past its own budget
 *   effects.breakLock()      move a stale lock aside
 *   effects.now(), effects.sleep(ms)
 *
 * Returns one of
 *   { action: 'reuse', record, at: 'start' | 'poll' | 'lock' }
 *   { action: 'run', keyBeforeWait, keyBeforeSuite, locked }
 *   { action: 'deadline', where: 'lock-attempt' | 'lock-held', holder }
 */
export async function acquireOrReuse({ effects, deadlineAt, minSuiteMs, pollMs }) {
  const keyBeforeWait = effects.currentKey();
  const startPass = keyBeforeWait ? effects.freshPass(keyBeforeWait) : null;
  if (startPass) return { action: 'reuse', record: startPass, at: 'start' };

  let locked = false;
  let key = keyBeforeWait;
  for (let attempt = 0; ; attempt += 1) {
    // Checked on EVERY iteration, so no path through this loop can outlive the budget.
    if (attempt > 0 && effects.now() > deadlineAt - minSuiteMs) return { action: 'deadline', where: 'lock-attempt', holder: null };
    const t = effects.tryLock();
    if (t === 'taken') { locked = true; break; }
    if (t === 'unusable') break;
    const held = effects.readLock();
    if (held === 'vanished') continue;
    if (effects.lockIsStale(held)) { effects.breakLock(); continue; }
    if (effects.now() + pollMs > deadlineAt - minSuiteMs) return { action: 'deadline', where: 'lock-held', holder: held };
    await effects.sleep(pollMs);
    /*
     * THE POLL RE-CHECK (T-148 G03). The run this gate is waiting on may have
     * recorded a PASS. It is taken only if the inputs are STILL the ones that PASS
     * was recorded for: the key is re-observed before approving, and a changed
     * tree moves this gate onto its new key instead.
     */
    if (key && effects.freshPass(key)) {
      const now = effects.currentKey();
      if (now && now === key) return { action: 'reuse', record: effects.freshPass(key), at: 'poll' };
      key = now;
    }
  }
  /*
   * THE RE-CHECK AT THE LOCK (T-148 G04), on the key as it is NOW: a run may have
   * finished between the last poll and taking the lock, and the tree may have
   * moved while this gate waited.
   */
  const keyBeforeSuite = effects.currentKey();
  const lockPass = keyBeforeSuite ? effects.freshPass(keyBeforeSuite) : null;
  if (lockPass) return { action: 'reuse', record: lockPass, at: 'lock', locked };
  return { action: 'run', keyBeforeWait, keyBeforeSuite, locked };
}

/**
 * Rule 2: may this gate take the one-suite lock?
 *   'free'  -- no lock file
 *   'held'  -- a live holder within its own budget
 *   'stale' -- the holder is dead, or the lock is older than the holder's budget
 * An unreadable lock (mid-write, or garbage) is 'held' until its file is older
 * than the fallback budget, then 'stale' -- never free on sight.
 */
export function lockState({ lock, nowMs, pidAlive, fallbackBudgetMs }) {
  if (lock === null || lock === undefined) return 'free';
  if (lock.unreadable) {
    return nowMs - lock.mtimeMs > fallbackBudgetMs ? 'stale' : 'held';
  }
  const started = Date.parse(lock.startedAt);
  if (Number.isNaN(started) || !Number.isInteger(lock.pid)) {
    return nowMs - (lock.mtimeMs ?? nowMs) > fallbackBudgetMs ? 'stale' : 'held';
  }
  if (pidAlive === false) return 'stale';
  const budget = Number.isFinite(lock.budgetMs) && lock.budgetMs > 0 ? lock.budgetMs : fallbackBudgetMs;
  return nowMs - started > budget ? 'stale' : 'held';
}

/*
 * ═══ T-273: A FAILING RUN KEEPS THE NAME OF WHAT FAILED ═══
 *
 * T-269: key a543adf9 failed twice (1 of 2099) and the failing test could not
 * be named, because the gate printed only status and counts and DISCARDED the
 * output. Every intermittent red was undiagnosable, and a green re-run proved
 * nothing about it. So on a non-pass the gate now keeps the failing tests'
 * NAMES and each one's FIRST message line -- never the stack, never the
 * whole output -- redacted and capped, and names the first in its refusal.
 *
 * PURE: the gate supplies the output text and the values to redact.
 */
export const FAILURE_LIMITS = Object.freeze({ tests: 25, name: 200, message: 300, bytes: 8192, minSecret: 8 });

const oneLine = (s, max) => {
  const flat = String(s ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** The first line of a TAP YAML `error:` value starting at lines[i] (the `error:` line itself). */
function yamlErrorFirstLine(lines, i, keyIndent) {
  const v = lines[i].slice(keyIndent + 'error:'.length).trim();
  if (/^[|>][-+]?$/.test(v)) {                       // block scalar: the first non-empty, more-indented line
    for (let j = i + 1; j < lines.length; j += 1) {
      const ind = lines[j].length - lines[j].trimStart().length;
      if (lines[j].trim() === '') continue;
      if (ind <= keyIndent) return '';
      return lines[j].trim();
    }
    return '';
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"')) { try { return String(JSON.parse(v)); } catch { return v; } }
  return v;
}

/**
 * The failing tests named in `node --test` output, in the order printed:
 * [{ name, message, parent }]. TAP (`not ok N - name`, the gate's reporter) is
 * read when present; otherwise the spec reporter's "failing tests:" section
 * (the default reporter when piped, which the merged gate's runner uses), and
 * failing that, any `✖ name (N ms)` line. parent:true marks a TAP entry that
 * failed only because a subtest did. A `# TODO` / `# SKIP` not-ok is not a failure.
 */
export function failingTests(text) {
  const lines = (typeof text === 'string' ? text : '').replace(/\r\n?/g, '\n').split('\n');
  const tap = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)not ok \d+(?: - (.*))?$/.exec(lines[i]);
    if (!m) continue;
    const rawName = m[2] ?? '';
    if (/(^|[^\\])#\s*(TODO|SKIP)\b/i.test(rawName)) continue;
    const indent = m[1].length;
    let message = '';
    let parent = false;
    if ((lines[i + 1] ?? '').trim() === '---') {
      for (let j = i + 2; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() === '...' && l.length - l.trimStart().length === indent + 2) break;
        const ind = l.length - l.trimStart().length;
        if (ind !== indent + 2) continue;
        if (/^failureType:\s*'subtestsFailed'/.test(l.trim())) parent = true;
        if (l.trim().startsWith('error:') && message === '') message = yamlErrorFirstLine(lines, j, ind);
      }
    }
    tap.push({ name: rawName.replace(/\\(.)/g, '$1'), message, parent });
  }
  if (tap.length) return tap;
  const spec = [];
  const header = lines.map((l) => l.trim()).lastIndexOf('✖ failing tests:');
  const from = header === -1 ? 0 : header + 1;
  const entry = header === -1 ? /^\s*✖ (.+?) \([\d.]+m?s\)$/ : /^✖ (.+?) \([\d.]+m?s\)$/;
  for (let i = from; i < lines.length; i += 1) {
    const m = entry.exec(lines[i]);
    if (!m) continue;
    let message = '';
    if (header !== -1) {
      for (let j = i + 1; j < lines.length && message === ''; j += 1) {
        if (/^\S/.test(lines[j])) break;             // the next entry, or "test at ..."
        message = lines[j].trim();
      }
    }
    spec.push({ name: m[1], message, parent: false });
  }
  return spec;
}

/** The test to name first: the first that failed on its own account, else the first of any kind. */
export function firstFailing(failures) {
  const list = Array.isArray(failures) ? failures : [];
  return list.find((f) => !f.parent) ?? list[0] ?? null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The spellings a value can take on its way into a test's output (hostile checklist E). */
export function secretSpellings(value) {
  const v = String(value ?? '');
  const json = JSON.stringify(v).slice(1, -1);
  const set = new Set([
    v, json, JSON.stringify(json).slice(1, -1), v.replace(/'/g, "''"), v.replace(/'/g, "\\'"),
    // backslashes doubled (TAP and JSON escape them), turned into slashes (file URLs), or DROPPED (a TAP
    // name that was never escaped, then unescaped by failingTests)
    v.replace(/\\/g, '\\\\'), v.replace(/\\/g, '/'), v.replace(/\\/g, ''), encodeURIComponent(v), encodeURI(v),
    Buffer.from(v, 'utf8').toString('base64'), Buffer.from(v, 'utf8').toString('base64url'),
  ]);
  return [...set].filter((s) => s.length >= FAILURE_LIMITS.minSecret);
}

/**
 * Every spelling of every value (>= FAILURE_LIMITS.minSecret characters),
 * case-insensitively, becomes `[redacted:<label>]`; so do JWT-, bearer- and
 * vendor-token-shaped strings. STATED LIMIT: a value shorter than the minimum,
 * a fragment of one, or a transform not in secretSpellings passes through.
 */
export function redactSecrets(text, secrets) {
  let out = String(text ?? '');
  const labelOf = new Map();
  for (const s of Array.isArray(secrets) ? secrets : []) {
    const v = String(s?.value ?? '').trim();
    if (v.length < FAILURE_LIMITS.minSecret) continue;
    for (const sp of secretSpellings(v)) if (!labelOf.has(sp.toLowerCase())) labelOf.set(sp.toLowerCase(), String(s?.label ?? 'secret'));
  }
  if (labelOf.size) {
    // ONE pass, longest spelling first, so a longer spelling is never pre-empted by a shorter one inside it.
    const alts = [...labelOf.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    out = out.replace(new RegExp(alts.join('|'), 'gi'), (m) => `[redacted:${labelOf.get(m.toLowerCase()) ?? 'secret'}]`);
  }
  return out
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted:jwt]')
    .replace(/\b(?:sb_secret_|sb_publishable_|sk-|ghp_|gho_|github_pat_|xox[abpr]-)[A-Za-z0-9_-]{12,}/gi, '[redacted:token]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted:token]');
}

/** `<at>-<key8>.txt`, safe as a Windows file name. A missing or malformed key is `nokey`. */
export function failureFileName(at, key) {
  const k = typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? key.slice(0, 8) : 'nokey';
  return `${String(at).replace(/[^0-9A-Za-z-]/g, '-')}-${k}.txt`;
}

/**
 * The text kept for a non-pass: header, counts, then each failing test's name
 * and first message line -- redacted, one line each, capped per field, per
 * test count and in total. Returns { text, first, named }: `first` is the
 * redacted name to put in the refusal, or null when nothing could be named.
 */
export function failureReport({ output, at, key, outcome, counts, secrets }) {
  const L = FAILURE_LIMITS;
  const all = failingTests(output);
  // Redact BEFORE capping: a cap first could cut a secret in half and leave a fragment no spelling matches.
  // (The 1 MB bound only keeps a pathological line finite; the cap below is far smaller.)
  const clean = (s, max) => oneLine(redactSecrets(String(s ?? '').slice(0, 1_000_000), secrets), max);
  const head = firstFailing(all);
  const lines = [
    'agentbridge stop-gate failures v1 (names and first message lines only; redacted; same-user, honest-error detection only)',
    `at: ${oneLine(at, 40)}`,
    `key: ${typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? key.slice(0, 16) : 'none'}`,
    `outcome: ${oneLine(outcome, 20)}`,
    `counts: ${oneLine(JSON.stringify(counts ?? null), 300)}`,
    `failing tests named: ${all.length}${all.length > L.tests ? ` (first ${L.tests} kept)` : ''}`,
  ];
  for (const f of all.slice(0, L.tests)) {
    lines.push(`not ok - ${clean(f.name, L.name)}${f.parent ? ' (a subtest failed)' : ''}`);
    if (f.message) lines.push(`    ${clean(f.message, L.message)}`);
  }
  let text = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(text, 'utf8') > L.bytes) {
    text = `${Buffer.from(text, 'utf8').subarray(0, L.bytes - 40).toString('utf8').replace(/�+$/, '')}\n[truncated at ${L.bytes} bytes]\n`;
  }
  return { text, first: head ? clean(head.name, L.name) : null, named: all.length };
}

/** The line a refusal carries. Names the first failing test, or says that none could be named. */
export function failureRefusalLine({ first, named, file }) {
  const where = file ? `kept in ${file}` : 'NOT kept: the failure file could not be written';
  return first
    ? `[agentbridge:stop-failing-test] First failing test: "${first}" (${named} failing test(s) named; ${where}).`
    : `[agentbridge:stop-failing-test] No failing test could be named from the output (${where}).`;
}

/*
 * ═══ T-273: THE HALL PASS ═══
 *
 * OWNER (typed, relayed by the Controller): "if your job runs late you can't be
 * dinged if it runs." A turn whose verification could not FINISH -- the suite
 * was still running at the budget, or another session's run held the one-suite
 * lock -- used to be refused with stop-deadline, which charged the turn for the
 * machine's load. It now ends with a HALL PASS instead:
 *
 *   - tagged [agentbridge:stop-hall-pass], meaning UNVERIFIED, STILL OWED. It is
 *     NEVER an approval, and it writes NO pass record, so nothing can reuse it;
 *   - the owed key is written to guard-sessions/stop-debts/, per repository and
 *     session;
 *   - that session's NEXT Stop must settle it: a PASS for the owed key, or a PASS
 *     recorded after the hall pass (a later state), clears it; a FAIL refuses and
 *     names the failing test; and a debt cannot be deferred by a second hall pass.
 *
 * NEVER issued when: the suite had already FAILED (a `not ok` in what ran), the
 * LAST ENTRY of the outcome log for these inputs is a FAIL, the outcome log
 * cannot be read, there is no key to owe, or this session already owes one.
 * Every refusal of a hall pass says why.
 *
 * NOT A SECURITY BOUNDARY (Constitutional Rule 1): the debt file is same-user
 * state, like the store and the lock. Deleting it by hand forgives the debt;
 * this is honest-error detection, not enforcement against the session.
 */
export const HALL_PASS_CAUSES = Object.freeze(['suite-running', 'lock-held']);
export const DEBT_LABEL = 'stop-gate hall pass: unverified, still owed; same-user, honest-error detection only';

/*
 * ═══ T-344: THE HALL-PASS DECISION READS ONE SOURCE -- THE OUTCOME LOG ═══
 *
 * WHY A REDESIGN (live/T-339/REPORT.md). T-273 r1-r3 each added a state source to this decision -- the carried
 * last_completed, the failure files, a doubt marker -- and every blind verify (T-292, T-323, T-331) found the hole
 * at an INTERACTION between two of them: a carried older PASS outranked a newer failure file (T-331 V1), a zeroed
 * failure file read as "no failure" (V2). So there is now exactly one source for "what is known about these
 * inputs": an APPEND-ONLY, per-key OUTCOME LOG, one entry per completed run, each carrying a SEQUENCE NUMBER.
 *
 *   - An entry is written for: a run that completed PASSED (and whose key did not move during it), a run that
 *     completed FAILED, and a run cut at the budget AFTER it had printed a `not ok` (a known red; cut: true).
 *     Nothing else: a PARTIAL, a deadline with nothing failed, an attach or a reuse proved nothing new.
 *   - WRITE ORDER IS THE ORDER OF EVENTS, BY CONSTRUCTION: entry N is the file <N as 12 digits>.json, published
 *     with an exclusive create (verifyRunner.appendOutcome), so two writers can never both be entry N. Timestamps
 *     are carried for people and never compared (hostile checklist K: a clock can step either way).
 *   - The decision is the LAST entry: PASS -> a hall pass is allowed; FAIL -> refused, naming the failing test the
 *     entry carries; no entry ever -> allowed (the Controller's "none" ruling).
 *   - ANYTHING MALFORMED ANYWHERE in the log refuses (checklist U): a NUL-filled, empty or half-written entry, a
 *     gap or a stray name, an entry for another key or with the wrong sequence number, a directory that cannot be
 *     listed. A log that cannot be read entirely cannot be trusted partially.
 *   - Verify records and failure files are VIEWS. Their CONTENT never decides allow or refuse: a record that says
 *     VERIFY_FAILED beside a log whose last entry is a PASS allows, and the reverse refuses. The failure files are
 *     read only to point at where the detail is kept.
 *
 * ONE EXCEPTION, STATED (T-344 acceptance 1 keeps T-331's 25-case corrupt-record matrix): a verify record for these
 * inputs that EXISTS but cannot be read (NUL-filled, empty, truncated, not an object with a known state) VETOES a
 * hall pass. It can only refuse -- its content never allows and never decides which outcome is known -- so it cannot
 * recreate the V1 shape, where one source's content outranked another's. The gate passes it as recordUnreadable.
 *
 * NOT A SECURITY BOUNDARY (Constitutional Rule 1): the log is same-user state. A deliberately forged well-formed
 * entry, or deleting the log (which reads as "none"), is outside this contract -- honest-error detection only.
 */
export const OUTCOME_LOG_LABEL = 'stop-gate outcome log: one entry per completed run, ordered by seq; same-user, honest-error detection only';
export const OUTCOME_OUTCOMES = Object.freeze(['pass', 'fail']);
const OUTCOME_ENTRY_KEYS = Object.freeze(['v', 'label', 'key', 'seq', 'outcome', 'at', 'first', 'cut', 'session']);
const OUTCOME_NAME = /^(\d{12})\.json$/;
const KEY64 = /^[0-9a-f]{64}$/;
/** The outcome log is keyed like the verify record: by the STORE key (verifyCache.verifyKey), 32 hex. */
const LOG_KEY = /^[0-9a-f]{32}$/;

/** The file name of entry `seq` (1-based): twelve digits, so a directory listing sorts in write order. */
export function outcomeEntryName(seq) {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > 999_999_999_999) throw new Error(`outcome log: bad sequence number ${String(seq)}`);
  return `${String(seq).padStart(12, '0')}.json`;
}

/** One entry's text: a single JSON line ending in a newline (a write cut short has no newline, and is malformed). */
export function formatOutcomeEntry({ key, seq, outcome, at, first = null, cut = false, session = null }) {
  if (typeof key !== 'string' || !LOG_KEY.test(key)) throw new Error('outcome log: an entry needs a 32-hex store key');
  if (!OUTCOME_OUTCOMES.includes(outcome)) throw new Error(`outcome log: an entry is a pass or a fail, not ${String(outcome)}`);
  outcomeEntryName(seq);
  const name = first === null || first === undefined ? null : oneLine(first, FAILURE_LIMITS.name);
  return `${JSON.stringify({
    v: 1, label: OUTCOME_LOG_LABEL, key, seq, outcome, at: String(at), first: name || null, cut: cut === true, session: session === null || session === undefined ? null : oneLine(session, 200),
  })}\n`;
}

/**
 * Read the log for `key` from a directory listing the gate made:
 *   listing = { missing: true }                        -- the directory does not exist: nothing ever completed
 *           | { error: '<why>' }                       -- it exists but could not be listed
 *           | { entries: [{ name, text } | { name, error }] }
 * Returns { ok: true, count, last } (last = the entry with the highest sequence number, or null) or
 * { ok: false, why }. TOTAL: it never throws, for any value (checklist T) -- a throw would be a refusal nobody chose.
 */
export function parseOutcomeLog({ key, listing } = {}) {
  const bad = (why) => ({ ok: false, why });
  try {
    if (typeof key !== 'string' || !LOG_KEY.test(key)) return bad('no store key to read the outcome log for');
    if (listing === null || typeof listing !== 'object') return bad('the outcome log was not listed');
    if (listing.missing === true) return { ok: true, count: 0, last: null };
    if (listing.error !== undefined) return bad(`the outcome log could not be listed (${oneLine(listing.error, 80)})`);
    const raw = listing.entries;
    if (!Array.isArray(raw)) return bad('the outcome log listing has no entries array');
    const bySeq = new Map();
    for (const e of raw) {
      const name = e?.name;
      const m = typeof name === 'string' ? OUTCOME_NAME.exec(name) : null;
      if (!m) return bad(`the outcome log holds a stray entry ${JSON.stringify(oneLine(name, 80))}`);
      const seq = Number(m[1]);
      if (seq < 1 || bySeq.has(seq)) return bad(`the outcome log holds an impossible entry name ${name}`);
      bySeq.set(seq, e);
    }
    let last = null;
    for (let seq = 1; seq <= bySeq.size; seq += 1) {
      const e = bySeq.get(seq);
      if (!e) return bad(`the outcome log has a gap: entry #${seq} is missing among ${bySeq.size}`);
      if (e.error !== undefined) return bad(`outcome log entry #${seq} could not be read (${oneLine(e.error, 80)})`);
      const text = e.text;
      if (typeof text !== 'string') return bad(`outcome log entry #${seq} is not text`);
      if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return bad(`outcome log entry #${seq} is not one complete line (cut short, empty or NUL-filled)`);
      // T-344 r2 (§5 rig row "CRLF-terminated"): the gate writes LF only, and JSON.parse tolerates a raw CR, so a CR
      // (a line-ending conversion or a hand edit) is malformed like a BOM is: refused, never parsed around.
      if (text.includes('\r')) return bad(`outcome log entry #${seq} is not one complete line (it contains a carriage return)`);
      let r;
      try { r = JSON.parse(text); } catch { return bad(`outcome log entry #${seq} is not JSON`); }
      if (!isPlain(r)) return bad(`outcome log entry #${seq} is not an object`);
      const keys = Object.keys(r);
      if (keys.length !== OUTCOME_ENTRY_KEYS.length || !OUTCOME_ENTRY_KEYS.every((k) => Object.hasOwn(r, k))) return bad(`outcome log entry #${seq} does not have exactly the entry fields`);
      if (r.v !== 1 || r.label !== OUTCOME_LOG_LABEL) return bad(`outcome log entry #${seq} is not an outcome entry`);
      if (r.key !== key) return bad(`outcome log entry #${seq} is for another key`);
      if (r.seq !== seq) return bad(`outcome log entry #${seq} says it is #${String(r.seq)}`);
      if (!OUTCOME_OUTCOMES.includes(r.outcome)) return bad(`outcome log entry #${seq} has no known outcome`);
      if (!isIso(r.at)) return bad(`outcome log entry #${seq} has no valid time`);
      if (!(r.first === null || (typeof r.first === 'string' && r.first.length > 0 && r.first.length <= FAILURE_LIMITS.name))) return bad(`outcome log entry #${seq} names its failing test malformedly`);
      if (typeof r.cut !== 'boolean') return bad(`outcome log entry #${seq} has a malformed cut flag`);
      if (!(r.session === null || typeof r.session === 'string')) return bad(`outcome log entry #${seq} has a malformed session`);
      last = { seq, outcome: r.outcome, at: r.at, first: r.first, cut: r.cut };
    }
    return { ok: true, count: bySeq.size, last };
  } catch {
    return bad('the outcome log listing could not be examined');
  }
}

/** A verify record that EXISTS and cannot be read as an object with a known state. (Missing is not unreadable.) */
export function recordIsUnreadable(text) {
  try {
    const rec = JSON.parse(String(text));
    return !isPlain(rec) || !VERIFY_STATES.includes(rec.state);
  } catch { return true; }
}

/**
 * Issue a hall pass? { issue: true, why: null } or { issue: false, why, knownFail?, first?, seq? }.
 *   log               -- parseOutcomeLog's answer for these inputs: THE source
 *   failuresSeen      -- `not ok` lines in what THIS run printed before it was cut (0, or it refuses)
 *   recordUnreadable  -- the one veto (see above); must be exactly false to issue
 * A known FAIL is reported even when a debt is also owed, so the refusal can name the failing test (T-331 V3).
 */
export function hallPassDecision({ cause, key, debt, log, failuresSeen, recordUnreadable } = {}) {
  if (!HALL_PASS_CAUSES.includes(cause)) return { issue: false, why: `a hall pass covers only a run still going or a held lock, not "${String(cause)}"` };
  if (typeof key !== 'string' || !KEY64.test(key)) return { issue: false, why: 'no key could be observed, so there is nothing to owe' };
  if (!(Number.isInteger(failuresSeen) && failuresSeen === 0)) {
    return { issue: false, why: 'the suite had already FAILED before it was stopped, so this is a failure, not a late job' };
  }
  if (log?.ok !== true || !Number.isSafeInteger(log.count)) {
    return { issue: false, why: `the outcome log for these inputs could not be read (${oneLine(log?.why ?? 'no log', 200)}), so a known FAIL cannot be ruled out` };
  }
  const owes = debt
    ? `this session already owes verification from an earlier hall pass (key ${String(debt.key ?? 'unknown').slice(0, 16)}, since ${String(debt.at ?? 'unknown')}); a debt must be settled by a PASS and cannot be deferred again`
    : null;
  const last = log.last;
  if (last !== null && last?.outcome !== 'pass') {
    if (last?.outcome === 'fail') {
      return {
        issue: false, knownFail: true, first: typeof last.first === 'string' ? last.first : null, seq: last.seq,
        why: `the newest completed result for these inputs is a FAIL (outcome log entry #${last.seq}${last.cut ? ', a run cut after it failed' : ''}); a known red does not get a hall pass${owes ? `; and ${owes}` : ''}`,
      };
    }
    return { issue: false, why: 'the last outcome log entry for these inputs is neither a pass nor a fail' };
  }
  if (owes) return { issue: false, why: owes };
  if (recordUnreadable !== false) {
    return { issue: false, why: 'the verify record for these inputs exists but cannot be read (as a crash leaves it), so this gate\'s own state is damaged and no hall pass is given' };
  }
  return { issue: true, why: null };
}

export const VERIFY_STATES = Object.freeze(['VERIFY_REQUESTED', 'VERIFY_RUNNING', 'VERIFY_PARTIAL', 'VERIFY_PASSED', 'VERIFY_FAILED', 'VERIFY_TIMED_OUT']);
const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * The first failing test named in a failure file this module wrote (failureReport), or null. The file must be for
 * the given key: its `key:` line must equal the key's first 16 characters (a file NAME carries only 8).
 */
export function firstFailingFromReport(text, key) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key) || !lines.includes(`key: ${key.slice(0, 16)}`)) return null;
  const tests = lines.filter((l) => l.startsWith('not ok - '));
  const leaf = tests.find((l) => !l.endsWith(' (a subtest failed)')) ?? tests[0];
  return leaf ? leaf.slice('not ok - '.length).replace(/ \(a subtest failed\)$/, '') : null;
}

/** The debt file's text. */
export function formatDebt({ session, key, at, cause }) {
  return `${JSON.stringify({ v: 1, label: DEBT_LABEL, session: session ?? null, key, at, cause })}\n`;
}

/**
 * Parse a debt file. Anything that is not a well-formed debt is STILL A DEBT
 * (fail closed): { key: null, at: null, corrupt: true } -- it can then be
 * settled only by a PASS from a fresh run, never by a reuse.
 */
export function parseDebt(text) {
  try {
    const d = JSON.parse(text);
    if (d && d.v === 1 && d.label === DEBT_LABEL && typeof d.key === 'string' && /^[0-9a-f]{64}$/.test(d.key) && isIso(d.at)) {
      return { key: d.key, at: d.at, cause: d.cause ?? null, corrupt: false };
    }
  } catch { /* fall through */ }
  return { key: null, at: null, cause: null, corrupt: true };
}

/**
 * Does a PASS record settle a debt? Only a PASS, and only one for the owed key,
 * or one recorded at or after the hall pass. A corrupt debt is settled by
 * neither (only a fresh run's PASS, which the gate handles itself).
 * CONTROLLER RULING (T-273 r2, on T-292 F2): a PASS for a LATER state settles the debt, because the debt means
 * "this session's work is unverified", and a PASS for the current state verifies it.
 */
export function debtSettledBy({ debt, record }) {
  if (!debt) return true;
  if (debt.corrupt || record?.outcome !== 'pass') return false;
  if (record.key === debt.key) return true;
  const t = Date.parse(record.at);
  return !Number.isNaN(t) && t >= Date.parse(debt.at);
}

/** The hall-pass message. It says, first, that this is NOT an approval. */
export function hallPassMessage({ key, cause, file }) {
  const why = cause === 'suite-running'
    ? 'the suite was still running when this gate\'s budget ran out, and was stopped'
    : 'another Stop gate\'s run held the one-suite lock until this gate\'s budget ran out';
  return `[agentbridge:stop-hall-pass] UNVERIFIED, STILL OWED -- this is NOT an approval and NOT a pass: ${why}. `
    + `The turn ends because a late job is not a failed one, but nothing was verified. The owed inputs (key ${String(key).slice(0, 16)}) are recorded in ${file}. `
    + 'This session\'s NEXT Stop must settle it: a PASS for these inputs or a later state clears it, a FAIL refuses and names the failing test, and it cannot be deferred by a second hall pass.';
}
