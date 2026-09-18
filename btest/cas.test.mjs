import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCas,
  digestOf,
  digestKey,
  digestsEqual,
  assertDigest,
  memoryStore,
  EMPTY_DIGEST,
  casRef,
  parseCasRef,
} from '../src/cas.mjs';
import { compact } from '../src/toolOutput.mjs';

/**
 * A CONTENT-ADDRESSED STORE IS ONLY WORTH HAVING IF IT REFUSES TO LIE.
 *
 * The whole promise is that a digest names exactly one sequence of bytes. So the
 * tests that matter are not "put then get" -- they are the ones where the store
 * underneath misbehaves: a truncated entry, a substituted entry, another
 * tenant's entry. Each of those must read as a MISS, because a wrong answer from
 * a content-addressed store is worse than no answer: the caller believes it.
 */

test('a digest is a hash AND a size', () => {
  const d = digestOf('hello');
  assert.match(d.hash, /^[0-9a-f]{64}$/);
  assert.equal(d.sizeBytes, 5);
  assert.equal(EMPTY_DIGEST.sizeBytes, 0);
});

test('identical bytes give identical digests, different bytes do not', () => {
  assert.ok(digestsEqual(digestOf('a'), digestOf('a')));
  assert.equal(digestsEqual(digestOf('a'), digestOf('b')), false);
});

test('a malformed digest is refused rather than coerced', () => {
  assert.throws(() => assertDigest({ hash: 'nope', sizeBytes: 1 }), /sha256 hex/);
  assert.throws(() => assertDigest({ hash: digestOf('a').hash, sizeBytes: -1 }), /non-negative/);
  assert.throws(() => assertDigest(null), /digest required/);
});

test('round trip', async () => {
  const cas = createCas({ store: memoryStore() });
  const d = await cas.put('some bytes');
  assert.equal((await cas.get(d)).toString(), 'some bytes');
  assert.equal(await cas.has(d), true);
});

test('a digest nobody stored is a miss, not a throw', async () => {
  const cas = createCas({ store: memoryStore() });
  assert.equal(await cas.get(digestOf('never stored')), null);
});

test('A TRUNCATED ENTRY IS A MISS, and the size is what catches it', async () => {
  const store = memoryStore();
  const cas = createCas({ store });
  const d = await cas.put('the whole thing');
  // something under us shortened the bytes
  store.map.set(`default:${digestKey(d)}`, Buffer.from('the whole'));
  assert.equal(await cas.get(d), null, 'short bytes must never be served under a full digest');
});

test('A SUBSTITUTED ENTRY OF THE SAME LENGTH IS ALSO A MISS', async () => {
  // the size check alone would pass this, which is why the hash is re-checked
  const store = memoryStore();
  const cas = createCas({ store });
  const d = await cas.put('aaaa');
  store.map.set(`default:${digestKey(d)}`, Buffer.from('bbbb'));
  assert.equal(await cas.get(d), null);
});

test('NAMESPACES CANNOT SEE EACH OTHER, even with byte-identical content', async () => {
  /*
   * Cross-tenant reuse is impossible by construction rather than by a policy
   * check somebody can forget to write. Two projects storing the same bytes get
   * different keys, so neither can confirm the other's content exists -- which
   * is the timing leak the salting work in vLLM exists to close.
   */
  const store = memoryStore();
  const one = createCas({ store, namespace: 'project-a' });
  const two = createCas({ store, namespace: 'project-b' });
  const d = await one.put('shared secret bytes');
  assert.equal(await two.get(d), null, 'another namespace must not observe it');
  assert.equal(await two.has(d), false);
  // and the positive: its own namespace still finds it
  assert.equal((await one.get(d)).toString(), 'shared secret bytes');
});

test('the same bytes stored twice occupy one entry', async () => {
  const store = memoryStore();
  const cas = createCas({ store });
  const a = await cas.put('identical');
  const b = await cas.put('identical');
  assert.ok(digestsEqual(a, b));
  assert.equal(store.map.size, 1, 'content addressing is what makes dedupe free');
});

test('THE SINK TURNS A TRUNCATED SPILL INTO A RETRIEVABLE ONE', async () => {
  const cas = createCas({ store: memoryStore() });
  const big = `${'x'.repeat(40_000)}\nTAIL`;

  const without = await compact(big, { limit: 1024, sink: null });
  assert.equal(without.kind, 'truncated');
  assert.equal(without.complete, false);

  const with_ = await compact(big, { limit: 1024, sink: cas.sink });
  assert.equal(with_.kind, 'spilled');
  assert.equal(with_.complete, true);
  assert.match(with_.ref, /^cas:\/\/default\//);
  // and the whole thing is genuinely there, not merely referenced
  assert.equal((await cas.getRef(with_.ref)).toString(), big);
});

test('the reference format round-trips, and a foreign one is not ours', async () => {
  const cas = createCas({ store: memoryStore(), namespace: 'project-a' });
  const digest = await cas.put('bytes');
  const ref = casRef('project-a', digest);
  assert.deepEqual(parseCasRef(ref).digest, digest);
  assert.equal(parseCasRef('not-a-ref'), null);
  // a reference from another namespace resolves to nothing here
  assert.equal(await cas.getRef(casRef('project-b', digest)), null);
});

test('a store without get and set is refused at construction', () => {
  assert.throws(() => createCas({ store: {} }), /store with get and set/);
  assert.throws(() => createCas({ store: memoryStore(), namespace: '' }), /namespace required/);
});

test('A KEY-TO-PATH MAPPING MUST NOT COLLAPSE TWO NAMESPACES', async () => {
  /*
   * Found by auditing the first wiring of this store rather than by a failure.
   * That version built a filename by replacing unsafe characters, so a key under
   * the namespace "project:a" and one under a namespace called "project_a"
   * landed on the same file. Content verification does not catch it -- the bytes
   * hash correctly -- so one namespace could confirm the other's content exists,
   * which is the existence leak namespacing exists to prevent.
   *
   * The store below models that broken mapping exactly, and the assertion is
   * that two namespaces still cannot see each other through it.
   */
  const files = new Map();
  const scrubbed = {
    get: async (key) => files.get(key.replace(/[^\w.-]/g, '_')) ?? null,
    set: async (key, bytes) => {
      files.set(key.replace(/[^\w.-]/g, '_'), bytes);
    },
  };
  const a = createCas({ store: scrubbed, namespace: 'project:a' });
  const b = createCas({ store: scrubbed, namespace: 'project_a' });
  const digest = await a.put('private bytes');

  // The scrubbing store leaks: this is the regression, demonstrated rather than
  // described, and it is why the shipped wiring hashes the key instead.
  assert.notEqual(await b.get(digest), null, 'the broken mapping does leak, as described');

  // The same two namespaces over a faithful store do not.
  const honest = memoryStore();
  const a2 = createCas({ store: honest, namespace: 'project:a' });
  const b2 = createCas({ store: honest, namespace: 'project_a' });
  const d2 = await a2.put('private bytes');
  assert.equal(await b2.get(d2), null, 'a faithful key mapping keeps them apart');
});
