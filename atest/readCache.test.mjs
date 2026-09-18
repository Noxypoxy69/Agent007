import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadCache } from '../src/readCache.mjs';

const loader = (text) => async () => text;

test('first read is a miss, second identical read is unchanged', async () => {
  const cache = createReadCache();
  const first = await cache.read('src/a.mjs', { load: loader('contents') });
  const second = await cache.read('src/a.mjs', { load: loader('contents') });
  assert.equal(first.unchanged, false);
  assert.equal(second.unchanged, true);
  assert.equal(second.ref, first.ref);
  assert.equal(second.content, 'contents', 'the caller can still have the bytes');
});

test('SAME MTIME AND SIZE, DIFFERENT BYTES: still reported as changed', async () => {
  // a checkout, a stash pop or a generator inside one mtime tick. Identical
  // cheap identity, different content. Trusting the identity here feeds the
  // model a stale file it then reasons about confidently.
  const cache = createReadCache();
  const identity = { size: 8, mtimeMs: 1_726_000_000_000 };
  await cache.read('src/a.mjs', { load: loader('AAAAAAAA'), identity });
  const second = await cache.read('src/a.mjs', { load: loader('BBBBBBBB'), identity });
  assert.equal(second.unchanged, false);
  assert.equal(second.content, 'BBBBBBBB');
});

test('changing back to a previously seen content is still a change from the last read', async () => {
  const cache = createReadCache();
  await cache.read('a', { load: loader('one') });
  await cache.read('a', { load: loader('two') });
  const third = await cache.read('a', { load: loader('one') });
  assert.equal(third.unchanged, false);
});

test('different paths do not share an entry', async () => {
  const cache = createReadCache();
  await cache.read('a', { load: loader('same') });
  const b = await cache.read('b', { load: loader('same') });
  assert.equal(b.unchanged, false);
});

test('the ref identifies the content, not just the path', async () => {
  const cache = createReadCache();
  const one = await cache.read('a', { load: loader('one') });
  const two = await cache.read('a', { load: loader('two') });
  assert.notEqual(one.ref, two.ref);
});

test('invalidate forces the next read to report changed', async () => {
  const cache = createReadCache();
  await cache.read('a', { load: loader('x') });
  assert.equal(cache.invalidate('a'), true);
  assert.equal((await cache.read('a', { load: loader('x') })).unchanged, false);
});

test('eviction is bounded and oldest-first', async () => {
  const cache = createReadCache({ maxEntries: 2 });
  await cache.read('a', { load: loader('1') });
  await cache.read('b', { load: loader('2') });
  await cache.read('c', { load: loader('3') });
  assert.equal(cache.size, 2);
  // 'a' was evicted, so it reads as changed again
  assert.equal((await cache.read('a', { load: loader('1') })).unchanged, false);
});

test('a hit refreshes recency so a hot file is not evicted', async () => {
  const cache = createReadCache({ maxEntries: 2 });
  await cache.read('a', { load: loader('1') });
  await cache.read('b', { load: loader('2') });
  await cache.read('a', { load: loader('1') }); // hit, refreshes 'a'
  await cache.read('c', { load: loader('3') }); // evicts 'b'
  assert.equal((await cache.read('a', { load: loader('1') })).unchanged, true);
  assert.equal((await cache.read('b', { load: loader('2') })).unchanged, false);
});

test('stats separate a hit from a changed re-read', async () => {
  const cache = createReadCache();
  await cache.read('a', { load: loader('1') });
  await cache.read('a', { load: loader('1') });
  await cache.read('a', { load: loader('2') });
  assert.deepEqual(cache.stats(), { reads: 3, hits: 1, misses: 1, changed: 1 });
});

test('load is required -- the cache never answers without reading', async () => {
  const cache = createReadCache();
  await assert.rejects(() => cache.read('a', {}), /load required/);
});
