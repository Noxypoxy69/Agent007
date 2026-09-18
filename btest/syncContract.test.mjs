import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSupersession } from '../src/supersession.mjs';
import { publish } from '../src/client.mjs';

/**
 * A PROMISE IS TRUTHY. THAT IS THE WHOLE BUG CLASS.
 *
 * Hand an async implementation to a callback contract that is consumed
 * synchronously, and the consumer decides on a Promise object it never looked
 * inside. Nothing catches it: it typechecks, it lints, and the module's own
 * tests pass because they inject synchronous stubs. The only symptom is a
 * decision made on a value that was never inspected.
 *
 * It happened here on 2026-09-15. supersession.mjs does
 * `resolveSha(sha) === true`; the first caller ever written against it passed
 * an async function returning the resolved sha. The module compared a Promise
 * to true, and refused a perfectly real commit while reporting that the commit
 * did not exist.
 *
 * WHICH DIRECTION IT FAILS IS LUCK UNLESS SOMEBODY PINS IT. Both synchronous
 * consumers in this repository demand an explicit `=== true`, so both fail
 * CLOSED:
 *
 *   supersession.mjs   resolveSha(sha) === true          refuses
 *   client.mjs         !verdict || verdict.ok !== true   refuses
 *
 * Written the ordinary way -- `if (!check(x))` or `if (verdict.ok === false)`
 * -- the identical mistake would fail OPEN, and in client.mjs that means the
 * payload guard is bypassed and personal data ships. The defensive spelling is
 * load-bearing, not stylistic, and this file exists so it cannot be "tidied"
 * into the ordinary one.
 */

const SHA = 'a'.repeat(40);

const base = {
  id: 'c-1',
  supersedes: 'd-old',
  reason: 'a reason long enough to be meaningful',
  replacement_task_id: 'd-new',
  recorded_by_agent: 'lead',
  recorded_by_session: 'lead',
  recorded_at: '2026-09-15T06:00:00.000Z',
};

test('a synchronous resolver is accepted — the positive control', () => {
  // Without this, "async is refused" could simply mean everything is refused.
  const r = createSupersession(
    { ...base, replacement_head_sha: SHA },
    { resolveSha: (s) => s === SHA },
  );
  assert.equal(r.ok, true, r.errors?.join('; '));
});

test('an ASYNC resolver is refused, and the error names the async fault', () => {
  const r = createSupersession(
    { ...base, replacement_head_sha: SHA },
    { resolveSha: async (s) => s === SHA },
  );
  assert.equal(r.ok, false, 'an async resolver satisfied a synchronous contract');

  const msg = r.errors.join(' ');
  assert.match(msg, /Promise/, 'the error must name the real fault');
  assert.match(msg, /SYNCHRONOUS/i);
  // The old message sent people hunting for a bad sha when the sha was fine.
  assert.doesNotMatch(msg, /does not resolve to a commit/,
    'an async resolver must not be reported as a bad sha');
});

test('a resolver returning a truthy NON-true value is still refused', () => {
  // The general rule the Promise case is one instance of: only an explicit
  // `true` is a pass. A sha string is the tempting wrong return.
  for (const answer of [SHA, 1, 'yes', {}, []]) {
    const r = createSupersession(
      { ...base, replacement_head_sha: SHA },
      { resolveSha: () => answer },
    );
    assert.equal(r.ok, false, `a resolver returning ${JSON.stringify(answer)} was accepted`);
  }
});

test('publish() FAILS CLOSED when handed an async scanner', async () => {
  /*
   * The consequence here is disclosure, not a confusing message. If a Promise
   * verdict read as a pass, the payload guard would be bypassed and whatever
   * the scanner would have caught ships.
   */
  const cfg = { bridgeUrl: 'https://example.invalid', machineId: 'm', secret: 's'.repeat(64) };
  let transmitted = false;
  const scan = async () => ({ ok: true, leaks: [] });

  const r = await publish(cfg, { anything: 'here' }, {
    scan,
    // If this ever runs, the guard let an uninspected payload through.
    fetchImpl: async () => { transmitted = true; return { ok: true, json: async () => ({}) }; },
  });

  assert.equal(r.ok, false, 'an async scanner was treated as a clean payload');
  assert.equal(r.reason, 'payload-leaks');
  assert.equal(transmitted, false, 'THE PAYLOAD WAS TRANSMITTED after an uninspected scan');
});

test('publish() still accepts a real synchronous clean verdict', async () => {
  // The positive control for the above: the guard is not simply refusing all.
  const cfg = { bridgeUrl: '', machineId: 'm', secret: 's'.repeat(64) };
  const r = await publish(cfg, { a: 1 }, { scan: () => ({ ok: true, leaks: [] }) });
  // No bridge URL configured, so it stops there -- but it got PAST the scan,
  // which is the thing being proven.
  assert.equal(r.reason, 'no-bridge-url');
});

test('the defensive spelling is still in the source, in both consumers', async () => {
  /*
   * Structural, and deliberately so. The behavioural tests above pass under
   * BOTH spellings today, because both happen to refuse a Promise. What they
   * cannot see is the day somebody rewrites the condition into the ordinary
   * form, at which point the identical async mistake starts failing OPEN and
   * every test here still passes.
   *
   * So the spelling itself is pinned. If this goes red, do not loosen it --
   * read the block comment at the top of this file first.
   */
  const client = await readFile(fileURLToPath(new URL('../src/client.mjs', import.meta.url)), 'utf8');
  assert.match(client, /verdict\.ok !== true/,
    'client.mjs must demand an explicit `ok === true`. Anything laxer fails OPEN '
    + 'on an async scanner and ships an uninspected payload.');

  const sup = await readFile(fileURLToPath(new URL('../src/supersession.mjs', import.meta.url)), 'utf8');
  assert.match(sup, /=== true/,
    'supersession.mjs must compare the resolver answer to true explicitly.');
});
