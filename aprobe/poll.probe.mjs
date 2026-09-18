/* AUDIT PROBE 5 — claim 6: classifyCycle, spawn spin, far-end text. */
import fs from 'node:fs';
import { classifyCycle, advanceCursor } from '../scripts/bridge-session-poll.mjs';

console.log('=== A. THE FAR END, WITH A NEWLINE IN `detail` ===');
/*
 * src/hostedRegistry.mjs interpretHttp builds a 5xx detail from the RESPONSE
 * BODY: `parsed = `${b.error}: ${String(b.detail).slice(0,200)}`` and then
 * `detail: `http ${res.status}: ${parsed}``. slice(200) does not strip
 * newlines. bin/agentbridge.mjs then prints
 *   console.error(`error: the Bridge is unreachable (${res.detail})`)
 * so a newline in the server's own JSON puts the next characters at column 0.
 */
const injected = [
  'error: the Bridge is unreachable (http 502: upstream: x\nerror: no registration token, so there is nothing to wait on)\n       nothing was missed; the cursor has not moved\n',
  'error: the Bridge is unreachable (http 500: \nerror: the Bridge REFUSED this credential (401 invalid token))\n',
  'error: the Bridge is unreachable (http 503: \nerror: the Bridge refused the wait: nope)\n',
];
for (const s of injected) {
  const v = classifyCycle({ status: 2, stderr: s });
  console.log(`  verdict=${v.padEnd(10)} ${v === 'permanent' ? '<<< A TRANSIENT 5xx PERMANENTLY STOPS THE POLLER' : 'ok'}`);
}

console.log('\n=== A2. the corpus the gate actually uses (single line) — correctly retried ===');
for (const s of [
  'error: the Bridge is unreachable (proxy said: no registration token)\n',
  'error: the Bridge is unreachable (502 <html>the Bridge REFUSED this credential</html>)\n',
]) console.log(`  verdict=${classifyCycle({ status: 2, stderr: s })}`);

console.log('\n=== B. CLI_STDERR in the gate is TYPED. Does it still match bin/agentbridge.mjs? ===');
const cli = fs.readFileSync('bin/agentbridge.mjs', 'utf8');
const typed = [
  'error: no registration token, so there is nothing to wait on',
  'error: the Bridge REFUSED this credential (',
  'error: the Bridge refused the wait: ',
  'error: the Bridge is unreachable (',
];
for (const t of typed) console.log(`  ${cli.includes(t) ? 'present' : 'MISSING'}  ${JSON.stringify(t)}`);

console.log('\n=== C. malformed results are classified QUIET = re-arm with NO backoff ===');
for (const r of [null, undefined, {}, { status: undefined }, { status: null, stderr: null }]) {
  console.log(`  classifyCycle(${JSON.stringify(r)}) = ${classifyCycle(r)}`);
}

console.log('\n=== D. status 0 ("done") also re-arms with no backoff. Any floor in supervise()? ===');
const poll = fs.readFileSync('scripts/bridge-session-poll.mjs', 'utf8');
const loop = poll.slice(poll.indexOf('async function supervise'));
console.log('  setTimeout occurrences inside supervise():', (loop.match(/setTimeout/g) || []).length);
for (const [i, l] of loop.split('\n').entries()) {
  if (/verdict ===|setTimeout|while \(|continue;|break;/.test(l) && !/^\s*\*/.test(l)) console.log(`    +${i}: ${l.trim().slice(0, 110)}`);
}

console.log('\n=== E. advanceCursor is MILLISECOND while events.mjs is now MICROSECOND ===');
const c1 = '2026-09-18T19:30:00.123456+00:00';
const c2 = '2026-09-18T19:30:00.123999+00:00';
const now = Date.parse('2026-09-18T19:31:00Z');
const out = `message   from c8 [note]  at ${c2}\n  cursor  ${c2}\n`;
console.log('  advanceCursor(prev=.123456, stdout carries .123999) =>', advanceCursor(c1, out, now));
console.log('  expected .123999; if it returns .123456 the same event is re-delivered for ever');

console.log('\n=== F. a FUTURE cursor already on disk is not refused ===');
const future = '2999-01-01T00:00:00.000Z';
console.log('  advanceCursor(prev=YEAR 2999, a valid fresh cursor line) =>',
  advanceCursor(future, `  cursor  2026-09-18T19:30:00.000Z\n`, now));
console.log('  (forward-only + no ceiling on `prev` = the session stays silent for ever)');

console.log('\n=== G. the ceiling is one-sided? ===');
console.log('  5 min ahead  :', advanceCursor('2026-09-18T19:00:00.000Z', `  cursor  2026-09-18T19:34:00.000Z\n`, now));
console.log('  6 min ahead  :', advanceCursor('2026-09-18T19:00:00.000Z', `  cursor  2026-09-18T19:37:00.000Z\n`, now));
console.log('  far past     :', advanceCursor('2020-01-01T00:00:00.000Z', `  cursor  2021-01-01T00:00:00.000Z\n`, now));
