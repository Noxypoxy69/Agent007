import test from 'node:test';
import assert from 'node:assert/strict';
import { compact, compactSize, typedToolOutput } from '../src/toolOutput.mjs';

const big = 'A'.repeat(20_000) + 'TAIL_MARKER';

test('small output stays inline and is complete', async () => {
  const record = await compact('hello', { limit: 100 });
  assert.equal(record.kind, 'inline');
  assert.equal(record.complete, true);
  assert.equal(record.text, 'hello');
});

test('large output spills, and spilled IS complete because the bytes exist', async () => {
  const store = new Map();
  const sink = {
    put: async ({ sha256, text }) => {
      store.set(sha256, text);
      return `artifact://${sha256}`;
    },
  };
  const record = await compact(big, { limit: 1000, sink });
  assert.equal(record.kind, 'spilled');
  assert.equal(record.complete, true);
  assert.match(record.ref, /^artifact:\/\//);
  assert.equal(store.get(record.sha256), big, 'the whole thing is retrievable');
  assert.equal(record.bytes, Buffer.byteLength(big));
  assert.ok(record.tail.endsWith('TAIL_MARKER'), 'the end of the log is not the part to lose');
});

test('A TRUNCATED THING SAYS SO: no sink means complete is false', async () => {
  const record = await compact(big, { limit: 1000, sink: null });
  assert.equal(record.kind, 'truncated');
  assert.equal(record.complete, false);
  assert.equal(record.ref, undefined);
  assert.equal(record.bytes, Buffer.byteLength(big), 'the real size is still reported');
  assert.ok(record.omittedBytes > 0);
});

test('A FAILING SINK IS NOT A SPILL: a ref that does not resolve is worse than none', async () => {
  const record = await compact(big, {
    limit: 1000,
    sink: {
      put: async () => {
        throw new Error('R2 is down');
      },
    },
  });
  assert.equal(record.kind, 'truncated');
  assert.equal(record.complete, false);
  assert.equal(record.ref, undefined);
});

test('a sink that stores nothing and returns nothing is not a spill either', async () => {
  const record = await compact(big, { limit: 1000, sink: { put: async () => '' } });
  assert.equal(record.kind, 'truncated');
  assert.equal(record.complete, false);
});

test('every shape carries complete', async () => {
  const shapes = [
    await compact('small', { limit: 100 }),
    await compact(big, { limit: 100, sink: { put: async () => 'ref://1' } }),
    await compact(big, { limit: 100 }),
  ];
  for (const shape of shapes) assert.equal(typeof shape.complete, 'boolean');
});

test('compactSize reports what a compact record costs the window', async () => {
  const record = await compact(big, { limit: 1000, sink: { put: async () => 'ref://1' } });
  assert.ok(compactSize(record) < record.bytes / 4, 'spilling has to actually save something');
  assert.equal(compactSize(await compact('hi', { limit: 10 })), 2);
});

test('a tool cannot report ok alongside an error', () => {
  assert.throws(() => typedToolOutput({ name: 't', ok: true, error: 'boom' }), /carries an error/);
});

test('a failed tool result with no error is refused', () => {
  assert.throws(() => typedToolOutput({ name: 't', ok: false }), /carries no error/);
});

test('ok must be explicit, never inferred', () => {
  assert.throws(() => typedToolOutput({ name: 't' }), /explicit ok/);
  assert.throws(() => typedToolOutput({ name: 't', ok: 'yes' }), /explicit ok/);
});
