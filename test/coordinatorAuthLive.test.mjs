import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * TOKEN → SCOPE, CERTIFIED AGAINST THE LIVE SERVER.
 *
 * ═══ WHAT THIS FILE IS FOR, AND WHAT IT IS NOT ═══
 *
 * test/coordinatorAuth.test.mjs certifies SCOPE → TOOLS: given a store shaped
 * like a reader's, toolDefs must not build a write tool. It is pure, it is
 * authored by code-d, and it proves the mechanism is correct.
 *
 * It cannot prove that a READER TOKEN produces a reader's store. That step —
 * bearer string to token table to store shape — happens inside index.ts, which
 * the suite cannot import, and it is the step where a typo promotes a reader to
 * a coordinator. The two files together certify the whole path; either alone
 * leaves the interesting half unproven.
 *
 *   coordinatorAuth.test.mjs      SCOPE  → TOOLS    pure, hermetic, always runs
 *   this file                     TOKEN  → SCOPE    live, requires credentials
 *
 * b6 asked for this as its item 2 and named both conditions: it must skip
 * CLEANLY AND VISIBLY when a token is absent, and it must say in its header
 * which half it certifies so nobody reads one as the other. Both are honoured
 * below. b6 did not get to it; the assembly line is over, so I have.
 *
 * ═══ IT READS. IT NEVER WRITES. ═══
 *
 * Every call here is tools/list. Nothing is assigned, accepted, cancelled,
 * messaged or decided. A certification that mutates the thing it certifies is
 * not a certification, and this one runs against PRODUCTION.
 *
 * ═══ WHY IT SKIPS RATHER THAN FAILS WITHOUT TOKENS ═══
 *
 * A red test for a reason the reader must ignore is one they learn to ignore,
 * and then the real red goes unread too. But a SILENT skip is worse than
 * either: it renders "I could not check" identically to "I checked and it was
 * fine", which is the defect this project has found more times than any other.
 * So every skip says out loud what was not checked and why.
 */

const URL_ = process.env.AGENTBRIDGE_MCP_URL
  ?? 'https://ornbhvaijcpsbcgquzhd.supabase.co/functions/v1/mcp';

const SECRETS = process.env.AGENTBRIDGE_SECRETS_DIR
  ?? join(homedir(), 'Documents', 'agentbridge-secrets');

/** Read a token by PIPING from disk. It is never printed, logged or asserted on. */
async function token(file) {
  try {
    const raw = await readFile(join(SECRETS, file), 'utf8');
    const t = raw.trim();
    return t.length >= 16 ? t : null;
  } catch { return null; }
}

async function toolNames(bearer) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, names: (body?.result?.tools ?? []).map((t) => t.name), body };
}

const WRITE_TOOLS = [
  'assign_task', 'accept_task', 'cancel_task', 'confirm_proposal',
  'send_message', 'record_owner_decision',
];

// ── the certification ──────────────────────────────────────────────────────

test('A READER TOKEN YIELDS A READER SURFACE — on the live server', async (t) => {
  const reader = await token('reader-token-chatgpt.txt');
  if (!reader) {
    return t.skip('NOT CHECKED: no reader token on this machine. '
      + 'TOKEN→SCOPE is UNVERIFIED here; coordinatorAuth.test.mjs still covers SCOPE→TOOLS.');
  }

  const { status, names } = await toolNames(reader);
  assert.equal(status, 200, 'the reader token was refused; this certifies nothing');
  assert.ok(names.length > 0, 'a reader got an empty surface, so the absences below are vacuous');

  for (const w of WRITE_TOOLS) {
    assert.ok(!names.includes(w),
      `a READER TOKEN produced the write tool "${w}" on the live server`);
  }
});

test('A COORDINATOR TOKEN YIELDS THE WRITE SURFACE — the positive control', async (t) => {
  /*
   * Load-bearing, not decoration. Every assertion above is satisfied by a
   * server that hands nobody anything, and a boundary that refuses everyone is
   * an outage rather than a boundary.
   */
  const coord = await token('coordinator-token.txt');
  if (!coord) {
    return t.skip('NOT CHECKED: no coordinator token on this machine. '
      + 'The reader-side absences above are therefore UNPROVEN — a server refusing '
      + 'everyone would satisfy them.');
  }

  const { status, names } = await toolNames(coord);
  assert.equal(status, 200);
  for (const w of WRITE_TOOLS) {
    assert.ok(names.includes(w), `the coordinator surface is missing "${w}"`);
  }
});

test('THE READER SURFACE IS A STRICT SUBSET, measured rather than assumed', async (t) => {
  const [reader, coord] = [await token('reader-token-chatgpt.txt'), await token('coordinator-token.txt')];
  if (!reader || !coord) {
    return t.skip('NOT CHECKED: both tokens are required to compare surfaces. '
      + `missing: ${[!reader && 'reader', !coord && 'coordinator'].filter(Boolean).join(', ')}`);
  }

  const r = (await toolNames(reader)).names;
  const c = (await toolNames(coord)).names;

  const extra = r.filter((n) => !c.includes(n));
  assert.deepEqual(extra, [], 'a reader has a tool the coordinator does not; the surfaces are not nested');
  assert.ok(c.length > r.length, `coordinator ${c.length} is not larger than reader ${r.length}`);
});

test('NO TOKEN, AT ANY CLASS, EXPOSES AN EXECUTION SURFACE', async (t) => {
  /*
   * The invariant that matters most and the one a scope bug would break
   * quietly. Shell, SQL, deploy and file writes are absent by NOT EXISTING,
   * not by refusing — so this asserts absence from the live tool list rather
   * than trusting a refusal string.
   */
  const checks = [['reader-token-chatgpt.txt', 'reader'], ['coordinator-token.txt', 'coordinator']];
  let ran = 0;

  for (const [file, label] of checks) {
    const tok = await token(file);
    if (!tok) continue;
    ran += 1;
    const { names } = await toolNames(tok);
    for (const bad of ['shell', 'exec', 'run_command', 'sql', 'query', 'deploy', 'write_file', 'merge']) {
      assert.ok(!names.some((n) => n.includes(bad)),
        `the ${label} surface exposes something matching "${bad}"`);
    }
  }

  if (ran === 0) {
    return t.skip('NOT CHECKED: no tokens on this machine, so the execution-surface '
      + 'invariant is UNVERIFIED live. It is still covered hermetically by '
      + 'coordinatorAuth.test.mjs "no scope, at any size, exposes an execution surface".');
  }
  assert.ok(ran > 0);
});

test('A REGISTRATION TOKEN IS NOT A READER — the classes are not interchangeable', async (t) => {
  /*
   * Four tables exist so that a token of one class cannot act as another. This
   * is the assertion that would catch them being merged into one table with a
   * scope column, which is the change the design refuses.
   */
  const reg = await token('registration-token.txt');
  if (!reg) {
    return t.skip('NOT CHECKED: no registration token. Class separation is UNVERIFIED live.');
  }

  const { status } = await toolNames(reg);
  assert.equal(status, 401,
    'a REGISTRATION token was accepted by the MCP surface; the token classes have merged');
});
