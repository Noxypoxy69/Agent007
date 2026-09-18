import {
  classifyLiveness, probeDue, recordProbe, applyAck, ackMatches, parseInstant, PROBE_DEFAULTS, LIVENESS,
} from './src/livenessProbe.mjs';
import { parse as eventsParse } from './src/events.mjs';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const say = (n, v) => console.log(`${n.padEnd(52)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);

console.log('=== C7a: can a poll ever produce live? ===');
say('poll now, never probed', classifyLiveness({ lastPollAt: iso(NOW) }, NOW));
say('poll now, probe 1h ago, 5 attempts', classifyLiveness({ lastPollAt: iso(NOW), probeSentAt: iso(NOW - 3.6e6), probeAttempts: 5 }, NOW));

console.log('\n=== C7b: clock going backwards / future timestamps ===');
say('ack dated year 3000 -> ?', classifyLiveness({ lastAckAt: '3000-01-01T00:00:00Z' }, NOW));
say('ack 1h in the future    -> ?', classifyLiveness({ lastAckAt: iso(NOW + 3.6e6) }, NOW));
say('probeSentAt 1h future, attempts 99', classifyLiveness({ probeSentAt: iso(NOW + 3.6e6), probeAttempts: 99 }, NOW));
say('probeDue with probeSentAt 1h future', probeDue({ probeSentAt: iso(NOW + 3.6e6), probeAttempts: 99 }, NOW));
// Can an AGENT set that? applyAck takes ack.at verbatim.
const s0 = recordProbe({ agent: 'x' }, { probeId: 'p1', at: iso(NOW) });
const forged = applyAck(s0, { probeId: 'p1', at: '3000-01-01T00:00:00Z' });
say('applyAck accepts a year-3000 ack.at', JSON.stringify(forged));
say('  -> classify 1 year later', classifyLiveness(forged, NOW + 365 * 864e5));

console.log('\n=== C7c: probeAttempts negative / NaN / huge / float ===');
for (const a of [-1000, -1, 0, 1, 4, 5, 4.5, NaN, 1e9, '5', null, undefined]) {
  const st = classifyLiveness({ probeSentAt: iso(NOW - 6e5), probeAttempts: a }, NOW);
  const due = probeDue({ probeSentAt: iso(NOW - 6e5), probeAttempts: a }, NOW);
  say(`attempts=${String(a)} classify/due`, `${st.state} / due=${due}`);
}

console.log('\n=== C7d: five attempts as a BURST ===');
let s = { agent: 'a' };
let t = NOW;
const stamps = [];
for (let i = 0; i < 12 && stamps.length < 5; i += 0) {
  if (probeDue(s, t)) { s = recordProbe(s, { probeId: `p${stamps.length + 1}`, at: iso(t) }); stamps.push(t); }
  t += 1000;
  if (t - NOW > 60 * 60 * 1000) break;
}
say('5 probes span (s)', (stamps[4] - stamps[0]) / 1000);
say('gaps (s)', stamps.slice(1).map((x, i) => (x - stamps[i]) / 1000));
say('state after 5th + grace', classifyLiveness(s, stamps[4] + PROBE_DEFAULTS.ackGraceMs + 1).state);
// After silent: recheck interval
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
const s4 = recordProbe(s3, { probeId: 'q4', at: iso(NOW + 400000) });
say('attempts after ack then probe', s4.probeAttempts);

console.log('\n=== C7f: ack hygiene ===');
const base = recordProbe({}, { probeId: 'P', at: iso(NOW) });
say('ack names a DIFFERENT probe', ackMatches(base, { probeId: 'Q', at: iso(NOW + 1) }));
say('ack predates its probe', ackMatches(base, { probeId: 'P', at: iso(NOW - 1) }));
say('ack with no probe outstanding', ackMatches({ probeId: null }, { probeId: 'P', at: iso(NOW) }));
const acked1 = applyAck(base, { probeId: 'P', at: iso(NOW + 1) });
const acked2 = applyAck(acked1, { probeId: 'P', at: iso(NOW + 2) });
say('replay of same ack changes nothing', JSON.stringify(acked1) === JSON.stringify(acked2));
say('ack probeId with padding " P "', ackMatches(base, { probeId: ' P ', at: iso(NOW + 1) }));

console.log('\n=== C7g: recordProbe twice with the SAME id ===');
let d = recordProbe({}, { probeId: 'same', at: iso(NOW) });
d = recordProbe(d, { probeId: 'same', at: iso(NOW + 31000) });
say('attempts after duplicate id', d.probeAttempts);
say('ack to the FIRST send now rejected', ackMatches(d, { probeId: 'same', at: iso(NOW + 5000) }));

console.log('\n=== C5: parseInstant vs src/events.mjs parse ===');
const CASES = [
  '2026-09-18T12:00:00.123456Z', '2026-09-18T12:00:00.123456789Z', '2026-09-18T12:00:00.1Z',
  '2026-09-18T12:00:00.12Z', '2026-09-18T12:00:00.123Z', '2026-09-18T12:00:00Z',
  '2026-09-18T12:00:00+00:00', '2026-09-18T12:00:00.123456+05:30', '2026-09-18T12:00:00.000001Z',
  '2026-09-18T12:00:00.999999Z', '1960-01-01T00:00:00.123456Z', '1960-01-01T00:00:00Z',
  '2026-09-18 12:00:00.123456+00', 'garbage', '', null, undefined, 0, 12345,
  '2026-09-18T12:00:00.123456', '2026-09-18', 'Invalid Date',
];
for (const c of CASES) {
  let a; let b;
  try { a = parseInstant(c); } catch (e) { a = 'THROW ' + e.message; }
  try { b = eventsParse(c); } catch (e) { b = 'THROW ' + e.message; }
  const agree = a === b || (Number.isNaN(a) && Number.isNaN(b));
  console.log(`  ${String(JSON.stringify(c)).padEnd(34)} liveness=${String(a).padEnd(18)} events=${String(b).padEnd(18)} ${agree ? '' : '*** DIFFER ***'}`);
}
