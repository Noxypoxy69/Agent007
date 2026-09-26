/*
 * T-353 (T-344 §8 V2-F1): THE STOP GATE'S FAIL DECISION READS THE WHOLE SHARD STREAM, NOT THE DISPLAY TAIL.
 *
 * verifyRunner keeps failing_output as a DISPLAY: the last 6000 characters of each failing shard, 16000 in all. The
 * decision used to read it, so a red followed by more output than that was a hall pass. Now every shard stream is
 * scanned as it arrives (stopVerdict.failureScanner) and the decision reads record.failure_excerpts
 * (stopVerdict.decisionTexts / failuresIn). This file drives:
 *   1. the scanner against failingTests ITSELF over GENERATED streams and chunkings (hollow gate 2: the excerpt is
 *      compared with the parser's reading of the whole stream, never with a copy of the parser's rules);
 *   2. GENERATED lengths around both limits (5999/6000/6001 per shard, 15999/16000/16001 in all) through
 *      runVerification, with the red in the first, a middle and the last shard, on stderr, split across chunks, and
 *      after multi-byte UTF-8 -- each asserting FIRST that the display tail really lost the red where it should (rule 9);
 *   3. the bound: a 10 MB stream is scanned in bounded memory.
 * The real gate is driven in test/stopGateOneSource.test.mjs (T-353 tests there).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as SV from '../src/stopVerdict.mjs';
import { runVerification, readRecord } from '../src/verifyRunner.mjs';

/* ── a seeded generator: the same streams on every run, so a red names its case ── */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

const PIECES = [
  () => '✔ filler test with a name (0.5ms)',
  () => '▶ a suite',
  () => '  ✔ passing subtest (1ms)',
  () => '✖ spec red alpha (1.5ms)',
  () => '  ✖ indented spec red beta (2ms)',
  () => '    AssertionError [ERR_ASSERTION]: boom',
  () => '',
  () => '   ',
  () => '✖ failing tests:',
  () => 'test at file:///x/a.test.mjs:3:1',
  () => '✖ looks red but carries no duration',
  () => 'not ok 3 - tap red gamma\n  ---\n  duration_ms: 1\n  failureType: \'testCodeFailure\'\n  error: |-\n    gamma broke\n  ...',
  () => 'not ok 4 - tap parent delta\n  ---\n  failureType: \'subtestsFailed\'\n  error: \'1 subtest failed\'\n  ...',
  () => '    not ok 1 - nested tap epsilon\n      ---\n      error: "nested"\n      ...',
  () => 'not ok 5 - tap todo # TODO later',
  () => 'not ok 6 - tap unterminated zeta\n  ---\n  error: |-\n    zeta',
  () => 'multi-byte é ✓ 日本 ✖ ✔ ℹ text',
  () => 'ok 7 - tap passing',
];

function genStream(r) {
  const n = 3 + Math.floor(r() * 30);
  const parts = [];
  for (let i = 0; i < n; i += 1) parts.push(pick(r, PIECES)());
  const eol = () => pick(r, ['\n', '\n', '\n', '\r\n', '\r']);
  return parts.join('\n').split('\n').map((l) => l + eol()).join('');
}

function chunkings(r, text) {
  const buf = Buffer.from(text, 'utf8');
  const bytes = [];
  for (let i = 0; i < buf.length;) { const k = 1 + Math.floor(r() * 7); bytes.push(buf.subarray(i, i + k)); i += k; }
  const strs = [];
  for (let i = 0; i < text.length;) { const k = 1 + Math.floor(r() * 11); strs.push(text.slice(i, i + k)); i += k; }
  return { whole: [buf], bytes, singleBytes: [...buf].map((b) => Buffer.from([b])), strings: strs };
}

function scanChunks(chunks, limits) {
  const s = SV.failureScanner(limits);
  for (const c of chunks) s.push(c);
  return s.end();
}

test('T-353 GENERATED: failingTests(excerpt) equals failingTests(whole stream) for every stream and every chunking', () => {
  const r = rng(353);
  let named = 0; let tapNamed = 0; let headers = 0; let splitGlyphs = 0; let cases = 0;
  for (let i = 0; i < 400; i += 1) {
    const text = genStream(r);
    const want = SV.failingTests(text);
    if (want.length) named += 1;
    if (/^\s*not ok \d+/m.test(text) && want.length) tapNamed += 1;
    if (text.includes('✖ failing tests:')) headers += 1;
    for (const [how, chunks] of Object.entries(chunkings(r, text))) {
      if (how === 'singleBytes' && i % 10 !== 0) continue;
      if (how === 'bytes' && chunks.some((c) => c.length && (c[c.length - 1] & 0xC0) === 0x80 || (c[0] & 0xC0) === 0x80)) splitGlyphs += 1;
      const got = SV.failingTests(scanChunks(chunks).text);
      assert.deepEqual(got, want, `stream #${i} chunked "${how}": the excerpt reads differently from the whole stream\n${JSON.stringify(text)}`);
      cases += 1;
    }
  }
  // POSITIVES FIRST (rule 5): the generator produced every shape the scanner must carry.
  assert.ok(named > 150, `premise: many generated streams name a failure (${named})`);
  assert.ok(tapNamed > 50, `premise: TAP-named streams were generated (${tapNamed})`);
  assert.ok(headers > 50, `premise: streams with a "failing tests:" header were generated (${headers})`);
  assert.ok(splitGlyphs > 50, `premise: multi-byte characters were split across chunks (${splitGlyphs})`);
  assert.ok(cases > 1000, `premise: enough cases ran (${cases})`);
});

test('T-353 a red split across chunk boundaries, byte by byte, is still named -- including inside the ✖ glyph', () => {
  const red = '✖ first rig test (1.25ms)\n  AssertionError: rig says red\n';
  const text = `${'✔ pass (1ms)\n'.repeat(3)}${red}${'✔ after (1ms)\n'.repeat(3)}`;
  const buf = Buffer.from(text, 'utf8');
  const at = buf.indexOf(Buffer.from('✖'));
  assert.ok(at > 0, 'premise: the glyph is in the stream');
  for (let cut = at; cut <= at + 12; cut += 1) {
    for (const cut2 of [cut + 1, cut + 5, buf.length - 1]) {
      const chunks = [buf.subarray(0, cut), buf.subarray(cut, cut2), buf.subarray(cut2)];
      const got = SV.failuresIn([scanChunks(chunks).text]).map((f) => f.name);
      assert.deepEqual(got, ['first rig test'], `cut at byte ${cut}/${cut2}: a red split across chunks was dropped`);
    }
  }
});

test('T-353 CR, LF and CRLF split across chunks end a line exactly as failingTests does', () => {
  for (const [a, b] of [['✖ x (1ms)\r', '\n  msg\r\n'], ['✖ x (1ms)\r', '\r\n  msg'], ['✖ x (1ms)', '\r\n\r\n  msg\r']]) {
    const want = SV.failingTests(a + b);
    assert.equal(want.length, 1, 'premise: the whole text names one failure');
    assert.deepEqual(SV.failingTests(scanChunks([a, '', Buffer.alloc(0), b]).text), want, JSON.stringify([a, b]));
  }
});

test('T-353 BOUNDED: a 10 MB shard stream is scanned in bounded memory, and an early red survives it', (t) => {
  const s = SV.failureScanner();
  s.push(Buffer.from('✖ early red (1ms)\n  AssertionError: early\n'));
  const chunk = Buffer.from('✔ passing filler line with some text in it (0.1ms)\n'.repeat(1000), 'utf8');
  let fed = 0;
  while (fed < 10 * 1024 * 1024) { s.push(chunk); fed += chunk.length; }
  const r = s.end();
  assert.ok(fed >= 10 * 1024 * 1024, 'premise: 10 MB were fed');
  assert.deepEqual(SV.failingTests(r.text).map((f) => f.name), ['early red']);
  assert.deepEqual(r.limits, { line: 16384, bucket: 32768, yaml: 64 }, 'the stated limits');
  const bound = r.limits.line + 2 * r.limits.bucket;
  assert.ok(r.peak <= bound, `peak retained ${r.peak} chars exceeds the bound ${bound}`);
  assert.ok(r.text.length <= 2 * r.limits.bucket, 'the excerpt is bounded');
  t.diagnostic(`T-353 measured: 10 MB (${fed} bytes) scanned, peak retained ${r.peak} characters`);
});

test('T-353 BOUNDED: ten thousand reds keep the FIRST entries (never zero) and count what they dropped', () => {
  const lines = Array.from({ length: 10_000 }, (_, i) => `✖ red number ${i} with a longish name to fill the bucket (1ms)`);
  const r = scanChunks([`${lines.join('\n')}\n`]);
  const got = SV.failingTests(r.text);
  assert.ok(got.length > 0, 'a stream full of reds scanned to an excerpt that names none');
  assert.equal(got[0].name, 'red number 0 with a longish name to fill the bucket');
  assert.ok(r.dropped > 0 && r.text.length <= r.limits.bucket + 200, `bounded: dropped ${r.dropped}, text ${r.text.length}`);
  // A tiny bucket still keeps the first entry of each kind, and the first column-zero entry after a header.
  const tiny = scanChunks([`not ok 1 - a very long tap red name\n${lines[0]}\n  ✖ sub (1ms)\n✖ failing tests:\n  ✖ indented (1ms)\n✖ after header (1ms)\n`], { bucket: 8 });
  assert.deepEqual(SV.failingTests(tiny.text).map((f) => f.name), ['a very long tap red name']);
  assert.match(tiny.text, /^✖ after header \(1ms\)$/m, `the first column-zero entry after a header was dropped: ${JSON.stringify(tiny.text)}`);
  const specOnly = scanChunks([`${lines[0]}\n${lines[1]}\n`], { bucket: 8 });
  assert.deepEqual(SV.failingTests(specOnly.text).map((f) => f.name), ['red number 0 with a longish name to fill the bucket'], 'a full bucket dropped the FIRST spec entry');
});

test('T-353 a chunk the scanner cannot read never throws (it runs in a data handler) and BREAKS the scan in the refuse direction', () => {
  const ok = SV.failureScanner();
  ok.push(Buffer.from('✔ fine (1ms)\n'));
  assert.equal(SV.failingTests(ok.end().text).length, 0, 'POSITIVE CONTROL: a readable passing stream names nothing');
  for (const bad of [123, Symbol('x'), { length: -1 }, null]) {
    const s = SV.failureScanner();
    s.push(Buffer.from('✔ fine (1ms)\n'));
    assert.doesNotThrow(() => s.push(bad), `push(${String(bad?.toString?.() ?? bad)}) threw`);
    const r = s.end();
    assert.match(SV.failingTests(r.text)[0]?.name ?? '', /the failure scan of this stream broke/, `an unreadable chunk ${String(bad?.toString?.() ?? bad)} read as a clean stream: ${JSON.stringify(r.text)}`);
  }
});

test('T-353 an over-long line is held by its two halves, so a red at the end of a 1 MB line is still named', () => {
  const r = scanChunks([`✖ ${'n'.repeat(1_000_000)} tail name (1ms)\n`]);
  assert.equal(SV.failingTests(r.text).length, 1);
  assert.ok(r.peak <= r.limits.line + 2 * r.limits.bucket, `peak ${r.peak}`);
});

test('T-353 decisionTexts / failuresIn: a red in ANY segment counts -- first, middle, last -- and no segment hides another', () => {
  const seg = (t) => ({ shard: 1, stream: 'stdout', text: t });
  const red = '✖ the red (1ms)';
  for (const where of [0, 1, 2]) {
    const texts = ['', '', ''].map((x, i) => (i === where ? red : '✔ fine (1ms)'));
    const rec = { state: 'VERIFY_PARTIAL', failing_output: '', failure_excerpts: texts.map(seg) };
    assert.deepEqual(SV.decisionTexts(rec), texts);
    assert.equal(SV.failuresIn(SV.decisionTexts(rec)).length, 1, `red in segment ${where} was not counted`);
    assert.equal(SV.completedOutcome({ state: 'VERIFY_PARTIAL', failingOutput: SV.decisionTexts(rec), keysAgree: true }), 'fail', `segment ${where}`);
  }
  // A later segment's empty "failing tests:" header must not hide an earlier segment's red (it would in ONE text).
  const texts = [red, '✖ failing tests:'];
  assert.equal(SV.failingTests(texts.join('\n')).length, 0, 'premise: joined into one text, the later header hides the red');
  assert.equal(SV.failuresIn(texts).length, 1, 'split per segment, the red is counted');
  // A record written before T-353 (no failure_excerpts) falls back to the display tail, as before.
  assert.deepEqual(SV.decisionTexts({ failing_output: 'tail' }), ['tail']);
  assert.deepEqual(SV.decisionTexts({}), ['']);
  // Naming prefers a red that failed on its own account.
  const parentOnly = 'not ok 1 - parent\n  ---\n  failureType: \'subtestsFailed\'\n  ...';
  assert.equal(SV.namingText([parentOnly, red]), red);
  assert.equal(SV.namingText([parentOnly]), parentOnly);
  assert.equal(SV.failureText(['✔ ok (1ms)', red]), red);
});

/* ── through runVerification, with scripted shards that emit chunks ── */

function scripted(shards) {
  let n = 0;
  return () => {
    const spec = shards[n];
    n += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 30_000 + n;
    child.kill = () => true;
    setImmediate(() => {
      for (const [stream, chunk] of spec.chunks) child[stream].emit('data', chunk);
      child.emit('close', spec.code);
    });
    return child;
  };
}

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 't353-root-'));
  const home = mkdtempSync(path.join(tmpdir(), 't353-home-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(path.join(root, 'test'));
  for (let i = 0; i < files; i += 1) writeFileSync(path.join(root, 'test', `f${i}.test.mjs`), '');
  return { root, home };
}

async function run(t, shards) {
  const { root, home } = fixture(t, shards.length);
  const key = 't353'.repeat(8);
  await runVerification({ root, key, identity: { t: 't353' }, shards: shards.length, concurrency: 1, home, spawnFn: scripted(shards) });
  const rec = readRecord(key, home);
  assert.ok(rec, 'precondition: a record was persisted');
  assert.equal(rec.shards?.length, shards.length, 'precondition: every shard ran');
  return rec;
}

const RED = '✖ first rig test (1.2ms)\n  AssertionError: rig says red\n';
/* Exactly n characters of passing spec output ending in a newline. Its first line may be a fragment of a `✔` line,
 * which names nothing (asserted below), so the character count is exact. */
const filler = (n) => {
  const line = '✔ filler rig test with a deliberately long name that fills the shard output tail (0.1ms)\n';
  const s = line.repeat(Math.ceil(n / line.length) + 1);
  const out = s.slice(s.length - n);
  assert.equal(SV.failingTests(out).length, 0, 'premise: filler names nothing');
  return out;
};

test('T-353 GENERATED LIMITS, per shard: the red with 5999/6000/6001 characters from its start to the end -- the decision names it every time', async (t) => {
  for (const dist of [5999, 6000, 6001, 6002, 12_000, 100_000]) {
    const out = `${'✔ before (1ms)\n'.repeat(5)}${RED}${filler(dist - RED.length)}`;
    const redAt = out.indexOf('✖ first rig test');
    assert.equal(out.length - redAt, dist, `premise: the red starts exactly ${dist} characters from the end`);
    const rec = await run(t, [{ code: 1, chunks: [['stdout', Buffer.from(out, 'utf8')]] }]);
    const tailNames = SV.failingTests(String(rec.failing_output)).length;
    // Rule 9: the fixture reaches the defect exactly where the display tail loses the red (6000 characters).
    assert.equal(tailNames > 0, dist <= 6000, `premise: the DISPLAY tail names the red only within 6000 characters (dist ${dist})`);
    const texts = SV.decisionTexts(rec);
    assert.deepEqual(SV.failuresIn(texts).map((f) => f.name), ['first rig test'], `dist ${dist}: the decision lost a red the stream printed`);
    assert.equal(SV.completedOutcome({ state: rec.state, failingOutput: texts, keysAgree: true }), 'fail', `dist ${dist}: no FAIL for a printed red (state ${rec.state})`);
  }
});

test('T-353 GENERATED LIMITS, in all: 15999/16000/16001 characters after the red across shards, the red in the first, a middle and the last shard', async (t) => {
  for (const total of [15_999, 16_000, 16_001, 16_002]) {
    for (const where of [0, 1, 2]) {
      // Three failing shards, each UNDER the 6000 per-shard limit, so only the 16000 total can lose the red. The display
      // joins them as s0 + '\n---\n' + s1 + '\n---\n' + s2, so a red at the start of s0 sits `total` characters from its end.
      const sizes = [total - 10_010, 5_000, 5_000];
      assert.ok(sizes[0] < 6_000 && sizes[0] > RED.length, 'premise: every shard is under the per-shard limit');
      const shards = sizes.map((n, i) => ({ code: 1, chunks: [['stdout', Buffer.from(i === where ? `${RED}${filler(n - RED.length)}` : filler(n), 'utf8')]] }));
      const rec = await run(t, shards);
      const texts = SV.decisionTexts(rec);
      assert.deepEqual(SV.failuresIn(texts).map((f) => f.name), ['first rig test'], `total ${total}, red in shard ${where}: lost`);
      assert.equal(SV.completedOutcome({ state: rec.state, failingOutput: texts, keysAgree: true }), 'fail', `total ${total}, shard ${where}`);
      if (where === 0) {
        assert.equal(String(rec.failing_output).length, Math.min(total, 16_000), 'premise: the display is the joined shards, cut at 16000');
        assert.equal(SV.failingTests(String(rec.failing_output)).length > 0, total <= 16_000, `premise: the DISPLAY names the first shard's red only within 16000 characters (total ${total})`);
      }
    }
  }
});

test('T-353 the red in a NON-LAST failing shard, with another failing shard after it, is counted (T-344 V2-F2 / W-SV2)', async (t) => {
  const rec = await run(t, [
    { code: 1, chunks: [['stdout', Buffer.from(`${RED}${filler(200)}`)]] },
    { code: 1, chunks: [['stdout', Buffer.from(filler(200))]] },
  ]);
  assert.deepEqual(rec.shards.map((x) => x.exitCode), [1, 1], 'premise: BOTH shards failed, the red is in the first');
  const texts = SV.decisionTexts(rec);
  assert.equal(SV.completedOutcome({ state: rec.state, failingOutput: texts, keysAgree: true }), 'fail', `the red in a non-last failing shard was lost: ${JSON.stringify(rec.failure_excerpts)}`);
  assert.deepEqual(rec.failure_excerpts.map((e) => `${e.shard}:${e.stream}`), ['1:stdout'], 'observed: only shard 1 names anything');
});

test('T-353 MANY reds in a later shard neither hide nor displace the first shard\'s red: every red is counted, the first is named first', async (t) => {
  const many = Array.from({ length: 400 }, (_, i) => `✖ later red ${String(i).padStart(3, '0')} with a name long enough (1ms)`).join('\n');
  const rec = await run(t, [
    { code: 1, chunks: [['stdout', Buffer.from(`${RED}${filler(200)}`)]] },
    { code: 1, chunks: [['stdout', Buffer.from(`${many}\n${filler(200)}`)]] },
  ]);
  assert.ok(many.length > 16_000 && many.length < SV.failureScanner().end().limits.bucket,`premise: the later reds alone exceed 16000 characters and fit one bucket (${many.length})`);
  const texts = SV.decisionTexts(rec);
  const all = SV.failuresIn(texts);
  assert.equal(all.length, 401, `every red is counted from the scanned stream, got ${all.length}`);
  assert.equal(SV.firstFailing(all)?.name, 'first rig test', 'the FIRST red is named first');
  assert.equal(SV.failingTests(SV.namingText(texts))[0]?.name, 'first rig test', 'the naming segment is the first shard\'s');
});

test('T-353 the red on STDERR with the passing output on stdout; the red split across chunks; multi-byte UTF-8 before it', async (t) => {
  const rb = Buffer.from(RED, 'utf8');
  const cases = {
    stderr: [['stdout', Buffer.from(filler(3000))], ['stderr', rb], ['stdout', Buffer.from(filler(9000))]],
    'split in the glyph': [['stdout', rb.subarray(0, 1)], ['stdout', rb.subarray(1, 2)], ['stdout', Buffer.concat([rb.subarray(2), Buffer.from(filler(9000))])]],
    'split in the name, stderr between': [['stdout', rb.subarray(0, 9)], ['stderr', Buffer.from('noise on stderr\n')], ['stdout', Buffer.concat([rb.subarray(9), Buffer.from(filler(9000))])]],
    'multi-byte before': [['stdout', Buffer.from(`${'é日本✓ℹ'.repeat(500)}\n`).subarray(0, 7)], ['stdout', Buffer.concat([Buffer.from(`${'é日本✓ℹ'.repeat(500)}\n`).subarray(7), rb, Buffer.from(filler(9000))])]],
  };
  for (const [name, chunks] of Object.entries(cases)) {
    const rec = await run(t, [{ code: 1, chunks }]);
    assert.equal(SV.failingTests(String(rec.failing_output)).length, 0, `${name}: premise: the display tail does not name the red`);
    const texts = SV.decisionTexts(rec);
    assert.deepEqual(SV.failuresIn(texts).map((f) => f.name), ['first rig test'], `${name}: the decision lost the red`);
    if (name === 'stderr') assert.equal(rec.failure_excerpts[0].stream, 'stderr', 'the red was read from stderr');
  }
});

test('T-353 a PASS writes no excerpts; a failing run that names nothing writes an empty list (the decision writes nothing for it)', async (t) => {
  const summary = 'ℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 5\n';
  const pass = await run(t, [{ code: 0, chunks: [['stdout', Buffer.from(`✔ ok (1ms)\n${summary}`)]] }]);
  assert.equal(pass.state, 'VERIFY_PASSED', `premise: a PASS (${pass.why})`);
  assert.equal(pass.failure_excerpts, null);
  const quiet = await run(t, [{ code: 1, chunks: [['stdout', Buffer.from(filler(9000))]] }]);
  assert.notEqual(quiet.state, 'VERIFY_PASSED', 'premise: not a PASS');
  assert.deepEqual(quiet.failure_excerpts, []);
  assert.equal(SV.completedOutcome({ state: quiet.state, failingOutput: SV.decisionTexts(quiet), keysAgree: true }), quiet.state === 'VERIFY_FAILED' ? 'fail' : null);
});
