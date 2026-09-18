import test from 'node:test';
import assert from 'node:assert/strict';
import { compileContext, contextRef } from '../src/contextCompiler.mjs';
import { createReadCache } from '../src/readCache.mjs';

const file = (path, text) => ({ path, load: async () => text });
const big = 'hello '.repeat(50);

test('THE SECOND ATTEMPT SENDS A REFERENCE INSTEAD OF THE FILE', async () => {
  // readCache's whole purpose, exercised through a consumer for the first time
  const cache = createReadCache();
  const files = [file('a.txt', big)];
  const first = await compileContext(files, { cache });
  const second = await compileContext(files, { cache });

  assert.equal(first.files[0].unchanged, false);
  assert.equal(second.files[0].unchanged, true);
  assert.ok(second.bytesSent < first.bytesSent, 'the second compile sent no less');
  assert.match(second.text, /^unchanged:a\.txt@[0-9a-f]{16}$/);
  assert.equal(second.text, contextRef('a.txt', first.files[0].hash));
});

test('A CACHE PER ATTEMPT CAN NEVER REPORT A HIT', async () => {
  /*
   * The mistake that makes the whole module decorative while looking wired: a
   * fresh cache each time is always a miss, the saving is always zero, and
   * nothing anywhere errors.
   */
  const files = [file('a.txt', big)];
  const a = await compileContext(files);
  const b = await compileContext(files);
  assert.equal(b.files[0].unchanged, false, 'an unshared cache reported a hit, which is impossible');
  assert.equal(b.bytesSaved, 0);
  assert.equal(a.digest, b.digest, 'two cold compiles of the same files are the same prompt');
});

test('THE DIGEST IS OF WHAT WAS SENT, NOT OF THE FILES', async () => {
  /*
   * The property the attempt record depends on. Identical files, different
   * sent form -- bodies the first time, references the second. Hashing file
   * CONTENT would call these equal and tell the loop detector the context was
   * unchanged, in the one case where the prompt had quietly shrunk.
   */
  const cache = createReadCache();
  const files = [file('a.txt', big)];
  const first = await compileContext(files, { cache });
  const second = await compileContext(files, { cache });
  assert.notEqual(first.digest, second.digest);
});

test('the same files in a different order are a different prompt', async () => {
  const one = await compileContext([file('a.txt', 'A'), file('b.txt', 'B')]);
  const two = await compileContext([file('b.txt', 'B'), file('a.txt', 'A')]);
  assert.notEqual(one.digest, two.digest, 'a model reads them in the order they arrive');
});

test('LENGTH FRAMING: ONE FILE CANNOT IMPERSONATE TWO', async () => {
  /*
   * THE FIRST VERSION OF THIS TEST WAS HOLLOW AND I WROTE IT. It claimed path
   * `b` + body `c` collides with path `bc` + body `` -- but the sent form
   * already embeds the path, so those differ whether or not anything is framed.
   * Removing the framing left the test green, which is the exact shape this
   * repository is built around: a check that passes while proving nothing.
   *
   * The real collision is across FILE BOUNDARIES. Concatenated without frames,
   * two files run together into one string, and a single file whose CONTENT
   * spells out the second file's header produces that same string. That is a
   * prompt an agent could author, and it would make two different contexts
   * compare equal.
   */
  const two = await compileContext([file('a', '1'), file('b', '2')]);
  const one = await compileContext([file('a', '1bb\n2')]);
  assert.notEqual(one.digest, two.digest, 'one file impersonated two');
});

test('A SAVING IS NEVER REPORTED AS NEGATIVE', async () => {
  /*
   * A reference is longer than a very short file, so the naive subtraction goes
   * negative and a caller summing these across an attempt gets a total arguing
   * the cache COST tokens. It saved nothing there; that is what zero means.
   */
  const cache = createReadCache();
  const files = [file('tiny.txt', 'x')];
  await compileContext(files, { cache });
  const second = await compileContext(files, { cache });
  assert.equal(second.files[0].unchanged, true);
  assert.equal(second.bytesSaved, 0, `reported ${second.bytesSaved}`);
});

test('a changed file is sent in full again, and the hash is what decides', async () => {
  const cache = createReadCache();
  await compileContext([file('a.txt', 'first')], { cache });
  // same path, same length, different bytes: size and mtime would call this
  // unchanged. Only the hash catches it.
  const changed = await compileContext([file('a.txt', 'FIRST')], { cache });
  assert.equal(changed.files[0].unchanged, false);
  assert.match(changed.text, /FIRST/);
});

test('a file with no load is refused rather than silently skipped', async () => {
  await assert.rejects(() => compileContext([{ path: 'a.txt' }]), /needs a load/);
  await assert.rejects(() => compileContext([{ load: async () => 'x' }]), /needs a path/);
  await assert.rejects(() => compileContext('not an array'), /must be an array/);
});
