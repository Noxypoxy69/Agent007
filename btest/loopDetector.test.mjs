import test from 'node:test';
import assert from 'node:assert/strict';
import { clearOnProgress, createLoopState, observe } from '../src/loopDetector.mjs';

function run(fingerprints, options) {
  let state = createLoopState(options);
  let last = null;
  for (const fp of fingerprints) {
    const step = observe(state, fp);
    state = step.state;
    last = step.loop;
  }
  return { state, loop: last };
}

test('REPEAT: three identical attempts is a loop', () => {
  const { loop } = run(['a', 'a', 'a']);
  assert.equal(loop.kind, 'repeat');
  assert.equal(loop.fingerprint, 'a');
  assert.equal(loop.count, 3);
});

test('two identical attempts is NOT yet a loop -- a retry is allowed', () => {
  assert.equal(run(['a', 'a']).loop, null);
});

test('PROGRESS IS NOT A LOOP: all different never fires', () => {
  assert.equal(run(['a', 'b', 'c', 'd', 'e', 'f']).loop, null);
});

test('OSCILLATION: A B A B is a loop even though no attempt repeats twice in a row', () => {
  const { loop } = run(['a', 'b', 'a', 'b']);
  assert.equal(loop.kind, 'oscillation');
  assert.deepEqual(loop.fingerprints, ['a', 'b']);
});

test('A B A is not yet an oscillation', () => {
  assert.equal(run(['a', 'b', 'a']).loop, null);
});

test('A B C A B C is not reported as a two-state oscillation', () => {
  const { loop } = run(['a', 'b', 'c', 'a', 'b', 'c']);
  assert.equal(loop, null);
});

test('the window forgets: old repeats fall out', () => {
  // window 4, threshold 3 -- 'a' appears three times but only twice in the window
  const { loop } = run(['a', 'a', 'b', 'c', 'd', 'a'], { window: 4, repeatThreshold: 3 });
  assert.equal(loop, null);
});

test('clearing on progress resets the detector', () => {
  let { state } = run(['a', 'a']);
  state = clearOnProgress(state);
  assert.equal(observe(state, 'a').loop, null);
});

test('the state is a plain value, so it survives a restart', () => {
  const { state } = run(['a', 'a']);
  const revived = JSON.parse(JSON.stringify(state));
  const step = observe(revived, 'a');
  assert.equal(step.loop.kind, 'repeat', 'a worker that restarts must not forget it was looping');
});

test('a threshold below two would fire on a single attempt', () => {
  assert.throws(() => createLoopState({ repeatThreshold: 1 }), /at least 2/);
});

test('a window below the threshold could never fire', () => {
  assert.throws(() => createLoopState({ window: 2, repeatThreshold: 3 }), /below threshold/);
});

test('an empty fingerprint is refused', () => {
  assert.throws(() => observe(createLoopState(), ''), /non-empty/);
});
