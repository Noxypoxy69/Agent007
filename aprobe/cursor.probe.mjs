/* AUDIT PROBE 3 — claim 7/8: the microsecond cursor and the future-cursor ceiling. */
import { eventsFor, nextCursor } from '../src/events.mjs';
import { eventsFor as hEventsFor, nextCursor as hNextCursor } from '../supabase/functions/mcp/_shared.js';

const msg = (id, at, to = 'code-b') => ({ message_id: id, to_agent: to, created_at: at, from_agent: 'c8', type: 'note' });
const feed = (msgs, since) => eventsFor({ messages: msgs, agent_id: 'code-b', session_id: 's1', since });

console.log('=== A. does Date.parse TRUNCATE or ROUND >3 fractional digits? ===');
for (const s of ['2026-09-18T19:30:00.1239Z', '2026-09-18T19:30:00.1231Z', '2026-09-18T19:30:00.9999999Z', '2026-09-18T19:30:00.999999Z']) {
  console.log(`  ${s.padEnd(30)} Date.parse=${Date.parse(s)}  (ms frac=${Date.parse(s) % 1000})`);
}

console.log('\n=== B. the same-millisecond drop, before/after ===');
const A = '2026-09-18T19:30:00.123456+00:00';
const B = '2026-09-18T19:30:00.123999+00:00';
console.log('  events after cursor=A:', feed([msg('m1', A), msg('m2', B)], A).map((e) => e.message_id));
console.log('  hosted            :', hEventsFor({ messages: [msg('m1', A), msg('m2', B)], agent_id: 'code-b', session_id: 's1', since: A }).map((e) => e.message_id));

console.log('\n=== C. IS THE CURSOR STILL EXCLUSIVE? (inclusive would re-deliver forever) ===');
console.log('  cursor == the event\'s own at ->', feed([msg('m1', A)], A).length, 'event(s) (0 required)');
console.log('  microsecond-identical strings ->', feed([msg('m1', '2026-09-18T19:30:00.123456Z')], '2026-09-18T19:30:00.123456+00:00').length, '(0 required)');

console.log('\n=== D. A MILLISECOND-TRUNCATED CURSOR RE-DELIVERS FOR EVER ===');
let cursor = null;
const rows = [msg('m1', A)];
for (let i = 0; i < 4; i += 1) {
  const evs = feed(rows, cursor);
  const raw = nextCursor(evs, cursor);
  // what a client does if it round-trips the cursor through a JS Date:
  cursor = raw ? new Date(raw).toISOString() : raw;
  console.log(`  poll ${i}: delivered=${evs.map((e) => e.message_id).join(',') || '-'}  nextCursor(raw)=${raw}  stored=${cursor}`);
}

console.log('\n=== E. nextCursor USES > ON STRINGS; the feed SORTS with localeCompare ===');
const mixed = ['2026-09-18T19:30:00Z', '2026-09-18T19:30:00.000001Z'];
console.log('  "Z" vs ".000001Z" code-unit >   :', mixed[0] > mixed[1], '(true means the NON-fractional is "newer")');
console.log('  localeCompare                   :', mixed[0].localeCompare(mixed[1]));
console.log('  nextCursor picks                :', nextCursor(mixed.map((at, i) => ({ at, kind: 'message', message_id: `x${i}` }))));
console.log('  numeric truth (parse order)     : .000001Z is later');
const evsE = feed([msg('m1', mixed[0]), msg('m2', mixed[1])], null);
const cE = nextCursor(evsE, null);
console.log('  after one poll cursor =', cE, '-> next poll re-delivers:', feed([msg('m1', mixed[0]), msg('m2', mixed[1])], cE).map((e) => e.message_id));

console.log('\n=== F. sort order vs comparison order (localeCompare ignores punctuation?) ===');
const sortProbe = feed([msg('m1', '2026-09-18T19:30:00Z'), msg('m2', '2026-09-18T19:30:00.000001Z')], null);
console.log('  emitted order:', sortProbe.map((e) => `${e.message_id}@${e.at}`).join('  '));

console.log('\n=== G. other parse shapes ===');
const shapes = [
  '2026-09-18T19:30:00.123456+05:30',
  '2026-09-18T14:00:00.123456-05:00',
  '2026-09-18T19:30:00+00:00',
  '2026-09-18T19:30:00.1+00:00',
  '2026-09-18T19:30:00.12+00:00',
  '2026-09-18T19:30:00.1234567+00:00',
  '1969-12-31T23:59:59.123456Z',
  '1900-01-01T00:00:00.000500Z',
  '2026-09-18 19:30:00.123456+00',
  'not a date',
];
for (const s of shapes) {
  let r;
  try { r = feed([msg('m', '2999-01-01T00:00:00Z')], s).length; r = `since accepted (${r} ev)`; } catch (e) { r = `THREW: ${e.message}`; }
  console.log(`  ${s.padEnd(34)} ${r}`);
}

console.log('\n=== H. ordering of two events differing only past ms, via the sort ===');
const o = feed([msg('m2', '2026-09-18T19:30:00.123999Z'), msg('m1', '2026-09-18T19:30:00.123456Z')], null);
console.log('  ', o.map((e) => e.message_id).join(' -> '), '(m1 -> m2 required)');

console.log('\n=== I. surfaces agree? ===');
const cases = [[null], [A], ['2026-09-18T19:30:00.123Z']];
for (const [since] of cases) {
  const a = feed([msg('m1', A), msg('m2', B)], since).map((e) => e.message_id).join(',');
  const b = hEventsFor({ messages: [msg('m1', A), msg('m2', B)], agent_id: 'code-b', session_id: 's1', since }).map((e) => e.message_id).join(',');
  console.log(`  since=${String(since).padEnd(34)} src=[${a}] hosted=[${b}] ${a === b ? '' : '<<< DISAGREE'}`);
  const na = nextCursor(feed([msg('m1', A), msg('m2', B)], since), since);
  const nb = hNextCursor(hEventsFor({ messages: [msg('m1', A), msg('m2', B)], agent_id: 'code-b', session_id: 's1', since }), since);
  if (String(na) !== String(nb)) console.log(`    <<< nextCursor DISAGREE src=${na} hosted=${nb}`);
}
