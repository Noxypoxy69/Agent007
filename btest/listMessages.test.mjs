import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefs, messagesQuery } from '../supabase/functions/mcp/_shared.js';

/**
 * A COORDINATOR THAT CAN ONLY SPEAK IS A MEGAPHONE.
 *
 * send_message shipped first and nothing could read the log back. The command
 * centre issued instructions to four agents and had no way to see one reply --
 * it could prove delivery and nothing about the answer. That is broadcasting
 * with extra steps, and it was reported from the other end as "one-way command
 * is proven, two-way reporting needs the inbox read tool", which is exactly
 * right.
 *
 * list_messages is a READ tool, so it is built from the read store and a
 * reader gets it too. Reading the coordination log is the same kind of act as
 * reading the roster: withholding it would leave the observer able to see who
 * exists but not what anybody said.
 */

const base = {
  listSessions: async () => [],
  getLanes: async () => ({}),
};

/** Capture the PostgREST query the tool builds, without a database. */
function storeWithSpy(rows = []) {
  const seen = [];
  return {
    seen,
    store: {
      ...base,
      async listMessages(args) { seen.push(args); return rows; },
    },
  };
}

const toolNamed = (store, name) => toolDefs(store).find((d) => d.name === name);

test('list_messages exists for a READER, not only a coordinator', () => {
  // The read store has no write methods at all; the tool must still be there.
  const def = toolNamed({ ...base, listMessages: async () => [] }, 'list_messages');
  assert.ok(def, 'a reader cannot see the coordination log');
  assert.equal(def.title, 'List messages');
});

test('a store with no listMessages builds no list_messages tool', () => {
  /*
   * The same discipline as every other tool here: a tool exists only when its
   * method does. A surface that cannot read must not advertise a reader.
   */
  assert.equal(toolNamed(base, 'list_messages'), undefined);
});

test('filters are passed through, and the result is reshaped for a reader', async () => {
  const { seen, store } = storeWithSpy([{
    message_id: 'm1',
    created_at: '2026-09-15T13:25:39.400Z',
    from_agent: 'chatgpt-command-center',
    to_agent: 'code-c',
    type: 'status',
    task_id: null,
    body: 'ChatGPT command center is now connected through Agent Bridge.',
  }]);

  const def = toolNamed(store, 'list_messages');
  const out = await def.run({ to_agent: 'code-c', since: '2026-09-15T13:00:00Z', limit: 10 });

  assert.deepEqual(seen[0], { to_agent: 'code-c', since: '2026-09-15T13:00:00Z', limit: 10 });

  const rows = JSON.parse(out.content[0].text);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    message_id: 'm1',
    at: '2026-09-15T13:25:39.400Z',
    from: 'chatgpt-command-center',
    to: 'code-c',
    type: 'status',
    task_id: null,
    body: 'ChatGPT command center is now connected through Agent Bridge.',
  });
});

test('the body is returned in full, never truncated', async () => {
  /*
   * A coordination log that abbreviates the one field a person actually reads
   * is a log nobody can act on. Length belongs to `limit`, not to the body.
   */
  const body = 'x'.repeat(4000);
  const { store } = storeWithSpy([{
    message_id: 'm', created_at: '2026-09-15T00:00:00Z',
    from_agent: 'a', to_agent: 'b', type: 'status', task_id: null, body,
  }]);

  const out = await toolNamed(store, 'list_messages').run({});
  assert.equal(JSON.parse(out.content[0].text)[0].body.length, 4000);
});

test('an empty inbox is an empty list, not an error', async () => {
  // "Nobody has replied yet" and "the request failed" must not look the same,
  // or the coordinator starts re-sending messages that were delivered.
  const { store } = storeWithSpy([]);
  const out = await toolNamed(store, 'list_messages').run({ to_agent: 'nobody' });
  assert.deepEqual(JSON.parse(out.content[0].text), []);
  assert.notEqual(out.isError, true);
});

test('the description tells the caller what an empty result means', () => {
  /*
   * The model reads this before it reads any row. Without it, an empty inbox
   * invites a retry of a message that was already delivered -- the same
   * confusion that made a 204 look like a failed write elsewhere in this
   * system.
   */
  const def = toolNamed({ ...base, listMessages: async () => [] }, 'list_messages');
  assert.match(def.description, /EMPTY RESULT MEANS NOBODY HAS REPLIED YET/);
  assert.match(def.description, /since/);
});

// ── the query itself ───────────────────────────────────────────────────────
test('newest first, and a default limit that is not unbounded', () => {
  const q = messagesQuery();
  assert.match(q, /^messages\?/);
  assert.match(q, /order=created_at\.desc/);
  assert.match(q, /limit=50/);
});

test('limit is clamped at both ends rather than trusted', () => {
  // These arrive from a model. 0 and negatives are nonsense PostgREST would
  // take literally, and an unbounded limit turns one tool call into the whole
  // log.
  assert.match(messagesQuery({ limit: 5 }), /limit=5/);
  assert.match(messagesQuery({ limit: 9999 }), /limit=200/);
  assert.match(messagesQuery({ limit: 0 }), /limit=50/);
  assert.match(messagesQuery({ limit: -3 }), /limit=1/);
  assert.match(messagesQuery({ limit: 'banana' }), /limit=50/);
});

test('filter values are ESCAPED, so a value cannot smuggle in another operator', () => {
  /*
   * PostgREST reads the query string as instructions. A raw `&` or `=` in a
   * value would be parsed as a new filter, widening a read past what was asked
   * for. These values come from a model's tool call, so they are untrusted in
   * exactly the way a form field is.
   */
  const q = messagesQuery({ to_agent: 'code-c&select=*&limit=99999' });
  assert.ok(!q.includes('to_agent=eq.code-c&select='), 'an injected operator survived');
  assert.match(q, /to_agent=eq\.code-c%26select/);
  assert.match(q, /limit=50/, 'the injected limit must not have replaced the real one');
});

test('a blank filter is omitted rather than matched as empty string', () => {
  // `to_agent=eq.` matches nothing, so a whitespace argument would silently
  // return an empty inbox that looks like "no replies".
  const q = messagesQuery({ to_agent: '   ', from_agent: '', task_id: null });
  assert.ok(!q.includes('to_agent=eq.'), q);
  assert.ok(!q.includes('from_agent=eq.'), q);
  assert.ok(!q.includes('task_id=eq.'), q);
});

test('since is exclusive, normalised to ISO, and REFUSES to be ignored', () => {
  const q = messagesQuery({ since: '2026-09-15T13:25:39.400Z' });
  assert.match(q, /created_at=gt\./, 'since must be exclusive, or polling re-reads the last message forever');
  assert.match(q, /2026-09-15T13%3A25%3A39\.400Z/);

  /*
   * An unparseable timestamp THROWS. Dropping it would hand back the whole
   * recent log to a caller that asked for a slice -- far too much rather than
   * too little, with nothing to indicate the filter had been discarded.
   */
  assert.throws(() => messagesQuery({ since: 'yesterday' }), /not a timestamp/);
});

test('every documented filter is declared in the input schema', () => {
  // A filter the model cannot see is a filter it will not use, and it will
  // pull the whole log instead and filter in its head.
  const def = toolNamed({ ...base, listMessages: async () => [] }, 'list_messages');
  for (const k of ['to_agent', 'from_agent', 'task_id', 'type', 'since', 'limit']) {
    assert.ok(def.input.properties[k], `${k} is missing from the schema`);
  }
  // Nothing is required: an unfiltered read of the recent log is a valid ask.
  assert.deepEqual(def.input.required, []);
});
