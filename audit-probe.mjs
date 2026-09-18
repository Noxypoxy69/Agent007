import fs from 'node:fs';
import {
  classifyLiveness, probeDue, recordProbe, applyAck, ackMatches, parseInstant, PROBE_DEFAULTS,
} from './src/livenessProbe.mjs';
import { advanceCursor, classifyCycle, parseCursorInstant } from './scripts/bridge-session-poll.mjs';

// Read the SHIPPED `parse` out of src/events.mjs rather than retyping it (hollow gate 2).
const evSrc = fs.readFileSync('src/events.mjs', 'utf8');
const m = /const parse = \(v\) => \{[\s\S]*?\n\};/.exec(evSrc);
if (!m) throw new Error('could not locate src/events.mjs parse');
// eslint-disable-next-line no-new-func
const eventsParse = new Function(`${m[0]} return parse;`)();
console.log('extracted src/events.mjs parse, length', m[0].length, 'chars');

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const say = (n, v) => console.log(`${n.padEnd(52)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);

console.log('\n=== C7a: can a poll ever produce live? ===');
say('poll now, never probed', classifyLiveness({ lastPollAt: iso(NOW) }, NOW).state);
say('poll now, probe 1h ago, 5 attempts', classifyLiveness({ lastPollAt: iso(NOW), probeSentAt: iso(NOW - 3.6e6), probeAttempts: 5 }, NOW).state);
say('lastPollAt in a LIVE-looking field?', classifyLiveness({ lastPollAt: iso(NOW), lastAckAt: null }, NOW).state);

console.log('\n=== C7b: clock backwards / future timestamps ===');
say('ack dated year 3000', classifyLiveness({ lastAckAt: '3000-01-01T00:00:00Z' }, NOW).state);
say('ack 1h in the future', classifyLiveness({ lastAckAt: iso(NOW + 3.6e6) }, NOW).state);
say('probeSentAt 1h future, attempts 99', classifyLiveness({ probeSentAt: iso(NOW + 3.6e6), probeAttempts: 99 }, NOW).state);
say('probeDue with probeSentAt 1h future', probeDue({ probeSentAt: iso(NOW + 3.6e6), probeAttempts: 99 }, NOW));
const s0 = recordProbe({ agent: 'x' }, { probeId: 'p1', at: iso(NOW) });
const forged = applyAck(s0, { probeId: 'p1', at: '3000-01-01T00:00:00Z' });
say('applyAck ACCEPTS a year-3000 ack.at', JSON.stringify(forged));
say('  classify 1 year later', classifyLiveness(forged, NOW + 365 * 864e5).state);
say('  probeDue 1 year later', probeDue(forged, NOW + 365 * 864e5));

console.log('\n=== C7c: probeAttempts hostile values ===');
for (const a of [-1000, -1, 0, 1, 4, 5, 4.5, NaN, 1e9, '5', null, undefined]) {
  const st = classifyLiveness({ probeSentAt: iso(NOW - 6e5), probeAttempts: a }, NOW);
  const due = probeDue({ probeSentAt: iso(NOW - 6e5), probeAttempts: a }, NOW);
  say(`attempts=${String(a)}`, `${st.state} / due=${due}`);
}

console.log('\n=== C7d: five attempts as a BURST ===');
let s = { agent: 'a' };
let t = NOW;
const stamps = [];
while (stamps.length < 5 && t - NOW <= 60 * 60 * 1000) {
  if (probeDue(s, t)) { s = recordProbe(s, { probeId: `p${stamps.length + 1}`, at: iso(t) }); stamps.push(t); }
  t += 1000;
}
say('5 probes span (s)', (stamps[4] - stamps[0]) / 1000);
say('gaps (s)', stamps.slice(1).map((x, i) => (x - stamps[i]) / 1000));
say('state after 5th + grace', classifyLiveness(s, stamps[4] + PROBE_DEFAULTS.ackGraceMs + 1).state);
say('probeDue right after silent', probeDue(s, stamps[4] + PROBE_DEFAULTS.ackGraceMs + 1));
say('probeDue after recheck window', probeDue(s, stamps[4] + PROBE_DEFAULTS.recheckIntervalMs));

console.log('\n=== C7e: budget is consecutive ===');
let s2 = { agent: 'b' };
s2 = recordProbe(s2, { probeId: 'q1', at: iso(NOW) });
s2 = recordProbe(s2, { probeId: 'q2', at: iso(NOW + 31000) });
s2 = recordProbe(s2, { probeId: 'q3', at: iso(NOW + 62000) });
say('attempts after 3 unanswered', s2.probeAttempts);
const s3 = applyAck(s2, { probeId: 'q3', at: iso(NOW + 63000) });
say('after valid ack', JSON.stringify(s3));
say('attempts after ack then probe', recordProbe(s3, { probeId: 'q4', at: iso(NOW + 400000) }).probeAttempts);
say('ack AFTER budget spent revives', classifyLiveness(applyAck(s, { probeId: 'p5', at: iso(stamps[4] + 99999) }), stamps[4] + 100000).state);

console.log('\n=== C7f: ack hygiene ===');
const base = recordProbe({}, { probeId: 'P', at: iso(NOW) });
say('ack names a DIFFERENT probe', ackMatches(base, { probeId: 'Q', at: iso(NOW + 1) }));
say('ack predates its probe', ackMatches(base, { probeId: 'P', at: iso(NOW - 1) }));
say('ack with no probe outstanding', ackMatches({ probeId: null }, { probeId: 'P', at: iso(NOW) }));
const a1 = applyAck(base, { probeId: 'P', at: iso(NOW + 1) });
say('replay of same ack is a no-op', JSON.stringify(a1) === JSON.stringify(applyAck(a1, { probeId: 'P', at: iso(NOW + 2) })));
say('ack probeId " P " (padded)', ackMatches(base, { probeId: ' P ', at: iso(NOW + 1) }));

console.log('\n=== C7g: recordProbe twice with the SAME id ===');
let d = recordProbe({}, { probeId: 'same', at: iso(NOW) });
d = recordProbe(d, { probeId: 'same', at: iso(NOW + 31000) });
say('attempts after duplicate id', d.probeAttempts);
say('ack to the FIRST send now rejected', ackMatches(d, { probeId: 'same', at: iso(NOW + 5000) }));

console.log('\n=== C5: parseCursorInstant vs src/events.mjs parse (and livenessProbe.parseInstant) ===');
const CASES = [
  '2026-09-18T12:00:00.123456Z', '2026-09-18T12:00:00.123456789Z', '2026-09-18T12:00:00.1Z',
  '2026-09-18T12:00:00.12Z', '2026-09-18T12:00:00.123Z', '2026-09-18T12:00:00Z',
  '2026-09-18T12:00:00+00:00', '2026-09-18T12:00:00.123456+05:30', '2026-09-18T12:00:00.000001Z',
  '2026-09-18T12:00:00.999999Z', '1960-01-01T00:00:00.123456Z', '1960-01-01T00:00:00Z',
  '2026-09-18 12:00:00.123456+00', 'garbage', '', null, undefined, 0, 12345,
  '2026-09-18T12:00:00.123456', '2026-09-18', 'Invalid Date', '2026-09-18T12:00:00.12345Z',
  '2026-09-18T12:00:00.1234567890123Z', 'Fri, 18 Sep 2026 12:00:00 GMT',
];
let differ = 0;
for (const c of CASES) {
  const a = parseCursorInstant(c); const b = eventsParse(c);
  if (a !== b) differ++;
  console.log(`  ${String(JSON.stringify(c)).padEnd(36)} poll=${String(a).padEnd(18)} events=${String(b).padEnd(18)} ${a === b ? '' : '*** DIFFER ***'}  livenessMs=${parseInstant(c)}`);
}
say('C5 divergences', differ);

console.log('\n=== C5b: cursor ceiling with microsecond units ===');
const now = Date.parse('2026-09-18T12:00:00.000Z');
const mk = (ts) => `cursor ${ts}\n`;
say('accepts a cursor 1 min in future', advanceCursor('2026-09-18T11:00:00Z', mk('2026-09-18T12:01:00.000000Z'), now));
say('rejects a cursor 6 min in future', advanceCursor('2026-09-18T11:00:00Z', mk('2026-09-18T12:06:00.000000Z'), now));
say('rejects year 3000', advanceCursor('2026-09-18T11:00:00Z', mk('3000-01-01T00:00:00Z'), now));
say('adopts .123999 over .123456', advanceCursor('2026-09-18T11:59:00.123456Z', mk('2026-09-18T11:59:00.123999Z'), now));
say('refuses .123456 over .123999', advanceCursor('2026-09-18T11:59:00.123999Z', mk('2026-09-18T11:59:00.123456Z'), now));
say('exactly at ceiling (+5min)', advanceCursor('2026-09-18T11:00:00Z', mk('2026-09-18T12:05:00.000000Z'), now));

console.log('\n=== C6: classifyCycle first-line verdict ===');
const POISON = [
  ['far-end body newline-injects the phrase', { status: 2, stderr: 'error: the Bridge is unreachable (502 <html>\nerror: no registration token\n</html>)\n' }],
  ['CRLF injection', { status: 2, stderr: 'error: the Bridge is unreachable (502\r\nerror: no registration token\r\n)\r\n' }],
  ['leading-space injection', { status: 2, stderr: 'error: unreachable (\n  error: no registration token\n)\n' }],
  ['genuine: no registration token', { status: 2, stderr: 'error: no registration token\n       set AGENTBRIDGE_REGISTRATION_TOKEN\n' }],
  ['genuine: refused the wait + detail', { status: 2, stderr: 'error: the Bridge refused the wait: 409 unknown-session\n' }],
  ['genuine: REFUSED credential', { status: 2, stderr: 'error: the Bridge REFUSED this credential (401)\n       check the token, not the network\n' }],
  ['genuine with CRLF line ends', { status: 2, stderr: 'error: no registration token\r\n       set AGENTBRIDGE...\r\n' }],
  ['genuine, detail contains a newline', { status: 2, stderr: 'error: the Bridge refused the wait: 409\nunknown\n' }],
  ['a node warning precedes the verdict', { status: 2, stderr: '(node:1234) ExperimentalWarning: x\nerror: no registration token\n' }],
  ['a blank line precedes the verdict', { status: 2, stderr: '\nerror: no registration token\n' }],
  ['token-file failure', { status: 2, stderr: 'agentbridge: cannot read token file\n' }],
];
for (const [name, r] of POISON) say(name, classifyCycle(r));
