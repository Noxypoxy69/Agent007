/*
 * AUDIT PROBE 7 — the SPLIT-BATCH case b5851bc's own comment describes:
 * "two events inside the same millisecond, split across batches".
 *
 * Cycle 0 delivers m1 only (m2 is not written yet). The cursor becomes m1's
 * own `at`. m2 is then written, inside the same millisecond.
 */
import { eventsFor, nextCursor } from '../supabase/functions/mcp/_shared.js';
import { advanceCursor } from '../scripts/bridge-session-poll.mjs';

const NOW = Date.parse('2026-09-18T20:00:00Z');
const m = (id, at) => ({ message_id: id, to_agent: 'code-b', from_agent: 'c8', type: 'note', created_at: at });
const M1 = m('m1', '2026-09-18T19:30:00.123456+00:00');
const M2 = m('m2', '2026-09-18T19:30:00.123999+00:00');

const renderCli = (events, cursor) => {
  const out = events.map((e) => `message   from ${e.from ?? '?'} [${e.type ?? '?'}]  at ${e.at}`);
  if (events.length) { out.push(`  cursor  ${cursor}`); out.push('  read the details ...'); }
  return `${out.join('\n')}\n`;
};

let cursor = '2026-09-18T19:00:00.000+00:00';
let rows = [M1];
const delivered = [];
for (let i = 0; i < 8; i += 1) {
  if (i === 1) rows = [M1, M2];              // m2 is written after the first batch
  const events = eventsFor({ messages: rows, agent_id: 'code-b', session_id: 's1', since: cursor });
  const serverCursor = nextCursor(events, cursor);
  const next = advanceCursor(cursor, renderCli(events, serverCursor), NOW);
  const moved = next !== cursor;
  delivered.push(events.map((e) => e.message_id).join(',') || '-');
  console.log(`cycle ${i}: delivered=[${events.map((e) => e.message_id).join(',')}]  `
    + `server cursor=${serverCursor}  client cursor ${moved ? '->' : 'STUCK AT'} ${next}`);
  cursor = next;
}
console.log('\ndeliveries per cycle:', delivered.join(' | '));
const tail = delivered.slice(2);
console.log(tail.every((d) => d === 'm2')
  ? '\n>>> m2 IS RE-DELIVERED ON EVERY CYCLE, FOR EVER.\n'
    + '>>> classifyCycle({status:0}) === "done"; the only setTimeout in supervise() is on the\n'
    + '>>> "retry" branch, so each of these cycles re-spawns the CLI with no delay at all.'
  : '\n(converged)');

console.log('\nwhy: advanceCursor compares with Date.parse (milliseconds)');
console.log('  Date.parse(".123456") =', Date.parse(M1.created_at));
console.log('  Date.parse(".123999") =', Date.parse(M2.created_at));
console.log('  equal ->  `if (t <= bestMs) continue;`  rejects the newer cursor.');

console.log('\nAT THE PARENT OF b5851bc the server would simply never have delivered m2');
console.log('(that was the defect); the loop is only reachable now that it does.');
