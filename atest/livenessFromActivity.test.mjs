import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { isLive, observedCapacity, STALE_AFTER_MS } from '../supabase/functions/mcp/_shared.js';

/**
 * THE ROSTER DESCRIBED DAEMONS, NOT AGENTS.
 *
 * `observedCapacity` calls a registration offline once its heartbeat is older
 * than the stale window, and the only thing that ever moved a heartbeat was
 * `register-session --watch` -- a process each worker starts as a child of its
 * own shell. When the session ends the watcher dies with it. Nothing supervises
 * watchers, so nothing restarts one and nothing notices.
 *
 * MEASURED ON THIS BRIDGE, 2026-09-16. Every registration row had heartbeat_at
 * exactly equal to updated_at: registered once, never refreshed. code-d read
 * 163 minutes stale while it was merging to master. code-c read offline while
 * it was sending messages. code-b sat stale for six hours while making
 * authenticated calls to this very function. Meanwhile code-a was messaging
 * with no row at all.
 *
 * So a worker that is demonstrably talking to the Bridge is now recorded alive
 * by the act of talking, and the watcher becomes an optimisation instead of the
 * only source of truth.
 *
 * WHY index.ts IS READ AS TEXT. It is a Deno edge-function entrypoint and
 * nothing in this suite can import it -- the same reason a duplicate `const`
 * once took the Bridge down with 1079 tests green. Source assertions are what
 * this repository already does for that file, and comments are blanked first so
 * that nothing here can be satisfied by the prose explaining it.
 */

const src = await readFile(
  fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url)),
  'utf8',
);

/** Blank comments, length-preserving, so a match is CODE and never prose. */
function codeOnly(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

const code = codeOnly(src);

/**
 * Comments AND string interiors blanked, length-preserving, so braces can be
 * counted. Quotes are kept so the shape of the code survives; only what is
 * between them is emptied.
 */
function braceSafe(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') { out[j] = ' '; j += 1; }
        if (j < text.length && text[j] !== '\n' && text[j] !== '\r') out[j] = ' ';
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// Same length as `code`, so every index is interchangeable between them.
const braces = braceSafe(code);

/**
 * The exact extent of one `if (path === '<p>') { ... }`, by brace matching.
 *
 * NOT "up to the next handler". That was the first version and it was wrong in
 * the way that matters: /wait is the LAST path handler, so its range ran to
 * end-of-file and swallowed the coordinator block beneath it. A test asking
 * "is this call inside a worker path" then answered yes for a call planted in
 * the coordinator path, and two mutations sailed through green.
 */
function handlerRange(path) {
  const start = code.indexOf(`if (path === '${path}'`);
  assert.notEqual(start, -1, `no handler for ${path}`);
  const open = braces.indexOf('{', start);
  assert.notEqual(open, -1, `no block for ${path}`);
  let depth = 0;
  for (let i = open; i < braces.length; i += 1) {
    if (braces[i] === '{') depth += 1;
    else if (braces[i] === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  assert.fail(`unbalanced braces in the ${path} handler`);
}

function handler(path) {
  const { start, end } = handlerRange(path);
  return code.slice(start, end);
}

/* ── positive control ─────────────────────────────────────────────────── */

test('POSITIVE CONTROL: the source is readable and is the real entrypoint', () => {
  // Every assertion below is a search, and a search passes vacuously against an
  // empty string. A non-match is not evidence the search ran.
  assert.ok(code.length > 50_000, `index.ts is ${code.length} bytes; that is not the real file`);
  assert.match(code, /session_registrations/, 'this file does not touch the registry at all');
});

test('POSITIVE CONTROL: comment blanking did not eat the code', () => {
  // If codeOnly over-blanked, every negative assertion below would pass for the
  // wrong reason -- which is the exact failure this repository has hit twice.
  assert.match(code, /async function touchLiveness/, 'blanking removed the helper itself');
  assert.doesNotMatch(
    handler('/task'),
    /ACTIVITY IS LIVENESS/,
    'comments survived blanking, so a prose match could satisfy these tests',
  );
});

/* ── the fix: talking to the Bridge is checking in ────────────────────── */

test('touchLiveness writes a fresh heartbeat for the named session', () => {
  const at = code.indexOf('async function touchLiveness');
  const body = code.slice(at, code.indexOf('\n}', at));
  assert.match(body, /session_registrations\?session_id=eq\./, 'it does not target one session row');
  assert.match(body, /heartbeat_at/, 'it does not write heartbeat_at');
  assert.match(body, /encodeURIComponent/, 'the session id is interpolated unescaped');
});

test('a failed heartbeat does not fail the request it rode on', () => {
  /*
   * The stamp is a side effect of a real call. Letting it throw would turn a
   * correct /return into an error because bookkeeping failed -- a worse bug
   * than the one being fixed, and the kind that gets the fix reverted.
   */
  const at = code.indexOf('async function touchLiveness');
  const body = code.slice(at, code.indexOf('\n}', at));
  assert.match(body, /catch\s*\{[\s\S]*return false/, 'a failed stamp is not contained');
});

for (const path of ['/task', '/return', '/wait']) {
  test(`${path} records the caller as alive`, () => {
    assert.match(
      handler(path),
      /await touchLiveness\(/,
      `${path} verifies the caller's session and then does not record it as alive, `
        + 'so an agent can work all day through this endpoint and still read offline',
    );
  });
}

test('/review records the reviewer as alive', () => {
  assert.match(handler('/review/claim'), /await touchLiveness\(/);
});

/* ── the constraint that makes it sound ───────────────────────────────── */

test('THE SECURITY PROPERTY: liveness is stamped ONLY in worker paths', () => {
  /*
   * LOAD-BEARING, and the reason this is not simply "stamp on every
   * authenticated call". A coordinator token names any agent it likes in
   * from_agent. If that stamped a heartbeat, the command centre could forge
   * liveness for a worker that died hours ago, and the roster would lose the
   * one thing it is for: telling a live worker from somebody talking about one.
   *
   * THE FIRST VERSION OF THIS TEST WAS DECORATION, AND A MUTATION PROVED IT.
   * It sliced the file from the first mention of coordinator_tokens and
   * searched only that tail, so a stamp planted ANYWHERE ABOVE that point --
   * including in the coordinator path itself -- was invisible. Planting exactly
   * that left all thirteen assertions green.
   *
   * So the question is no longer "is there a call in the bad place", which
   * requires guessing where bad is. It is "is EVERY call in a good place",
   * which enumerates the whole file and cannot be dodged by position.
   */
  const allowed = ['/task', '/return', '/wait', '/review/claim'].map(handlerRange);

  const calls = [];
  const NEEDLE = 'touchLiveness(';
  for (let i = code.indexOf(NEEDLE); i !== -1; i = code.indexOf(NEEDLE, i + 1)) {
    // Skip the declaration itself: it is the definition, not a use.
    if (code.slice(Math.max(0, i - 25), i).includes('async function ')) continue;
    calls.push(i);
  }

  assert.ok(calls.length >= 4, `expected a call in each worker path, found ${calls.length}`);

  const stray = calls
    .filter((i) => !allowed.some((a) => i >= a.start && i < a.end))
    .map((i) => {
      const line = code.slice(0, i).split('\n').length;
      return `line ${line}: ${(src.split('\n')[line - 1] ?? '').trim()}`;
    });

  assert.deepEqual(
    stray,
    [],
    'touchLiveness is called outside the worker paths that verify a session. A stamp reachable '
      + 'from a coordinator or reader token lets the command centre vouch for a worker that died '
      + 'hours ago.',
  );
});

/* ── one seat per agent per machine, and only the dead ones go ────────── */

test('retireStaleSeats removes only seats that are NOT live', () => {
  /*
   * A live second seat is not debris: one agent can hold two worktrees. Quietly
   * deleting one would replace resolveLiveAgent's visible ambiguous-session
   * refusal with an invisible choice, which is the worse of the two.
   */
  const at = code.indexOf('async function retireStaleSeats');
  assert.notEqual(at, -1, 'retireStaleSeats is missing');
  const body = code.slice(at, code.indexOf('\n}', at));
  assert.match(body, /isLive\(/, 'it does not check liveness, so it can delete a working seat');
  assert.match(body, /continue/, 'there is no skip path for a live seat');
});

test('retireStaleSeats never reaches another machine', () => {
  /*
   * guard_session_owner enforces ownership on (agent_id, machine_id). This
   * respects the same boundary instead of inventing a weaker one beside it.
   */
  const at = code.indexOf('async function retireStaleSeats');
  const body = code.slice(at, code.indexOf('\n}', at));
  assert.match(body, /machine_id=eq\./, 'it is not scoped to this machine');
  assert.match(body, /agent_id=eq\./, 'it is not scoped to this agent');
});

test('registration reports which seats it retired', () => {
  // Cleanup nobody can see is indistinguishable from cleanup that did not run.
  assert.match(code, /retired_seats:/, 'the register response hides what it deleted');
});

/* ── the rule these defend, from the shared module ────────────────────── */

test('a fresh heartbeat is live and a stale one is not', () => {
  const now = new Date('2026-09-16T23:00:00Z').toISOString();
  const fresh = { heartbeat_at: new Date(Date.parse(now) - 1000).toISOString(), capacity: 'idle' };
  const stale = {
    heartbeat_at: new Date(Date.parse(now) - STALE_AFTER_MS - 1000).toISOString(),
    capacity: 'idle',
  };
  assert.equal(isLive(fresh, { now }), true);
  assert.equal(isLive(stale, { now }), false);
  // And this is the line that made a working agent read as shut down.
  assert.equal(observedCapacity(stale, { now }), 'offline');
  assert.equal(observedCapacity(fresh, { now }), 'idle');
});
