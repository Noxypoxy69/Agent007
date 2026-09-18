/*
 * AUDIT PROBE 6 — end to end: the real server function and the real client
 * function, wired the way the running system wires them.
 *
 *   server : supabase/functions/mcp/_shared.js  eventsFor + nextCursor   (/wait)
 *   client : scripts/bridge-session-poll.mjs    advanceCursor            (supervise)
 *   CLI    : bin/agentbridge.mjs prints `  cursor  ${cursor}`            (rendered)
 *
 * Nothing is reimplemented: the only thing this file writes is the loop that
 * already exists in supervise().
 */
import { eventsFor, nextCursor } from '../supabase/functions/mcp/_shared.js';
import { advanceCursor } from '../scripts/bridge-session-poll.mjs';

const NOW = Date.parse('2026-09-18T20:00:00Z');

/* Two messages inside ONE millisecond — exactly the case b5851bc fixed. */
const MESSAGES = [
  { message_id: 'm1', to_agent: 'code-b', from_agent: 'c8', type: 'note', created_at: '2026-09-18T19:30:00.123456+00:00' },
  { message_id: 'm2', to_agent: 'code-b', from_agent: 'c8', type: 'note', created_at: '2026-09-18T19:30:00.123999+00:00' },
];

/** What bin/agentbridge.mjs prints for a batch, verbatim from its source. */
const renderCli = (events, cursor) => {
  const out = events.map((e) => `message   from ${e.from ?? '?'} [${e.type ?? '?'}]  at ${e.at}`);
  if (events.length) {
    out.push(`  cursor  ${cursor}`);
    out.push('  read the details with `agentbridge workers` or the coordination log');
  }
  return `${out.join('\n')}\n`;
};

const run = (label) => {
  console.log(`\n--- ${label} ---`);
  let cursor = '2026-09-18T19:00:00.000+00:00';
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    const events = eventsFor({ messages: MESSAGES, agent_id: 'code-b', session_id: 's1', since: cursor });
    const serverCursor = nextCursor(events, cursor);
    const stdout = renderCli(events, serverCursor);
    const next = advanceCursor(cursor, stdout, NOW);
    seen.push(events.map((e) => e.message_id).join('+') || '-');
    console.log(`  cycle ${i}: delivered=[${events.map((e) => e.message_id).join(',')}]  server cursor=${serverCursor}  client keeps=${next}`);
    if (next === cursor && events.length) {
      console.log('  >>> THE CLIENT CURSOR DID NOT MOVE WHILE EVENTS WERE DELIVERED.');
      console.log('  >>> classifyCycle({status:0}) = "done", and the only setTimeout in supervise()');
      console.log('  >>> is on the "retry" branch, so this re-spawns with no delay, for ever.');
    }
    cursor = next;
  }
  console.log(`  deliveries: ${seen.join(' , ')}`);
};

run('two events in ONE millisecond (the case b5851bc fixed on the server)');

/* Control: the same loop with the events a millisecond apart converges. */
const APART = [
  { message_id: 'm1', to_agent: 'code-b', from_agent: 'c8', type: 'note', created_at: '2026-09-18T19:30:00.123000+00:00' },
  { message_id: 'm2', to_agent: 'code-b', from_agent: 'c8', type: 'note', created_at: '2026-09-18T19:30:01.000000+00:00' },
];
const runWith = (rows, label) => {
  console.log(`\n--- ${label} ---`);
  let cursor = '2026-09-18T19:00:00.000+00:00';
  for (let i = 0; i < 4; i += 1) {
    const events = eventsFor({ messages: rows, agent_id: 'code-b', session_id: 's1', since: cursor });
    const sc = nextCursor(events, cursor);
    cursor = advanceCursor(cursor, renderCli(events, sc), NOW);
    console.log(`  cycle ${i}: delivered=[${events.map((e) => e.message_id).join(',')}]  cursor=${cursor}`);
  }
};
runWith(APART, 'CONTROL: events a millisecond apart — converges and goes quiet');
