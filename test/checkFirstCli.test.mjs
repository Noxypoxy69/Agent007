import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));

async function cf(args, cwd = REPO) {
  try {
    const { stdout } = await run(process.execPath, [CLI, 'check-first', ...args], { cwd, maxBuffer: 32e6 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) { return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) }; }
}

test('a topic that HAS prior work says so rather than shrugging', async () => {
  const r = await cf(['roster liveness heartbeat', '--hours', '24']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /SOMEBODY MAY ALREADY BE ON THIS/);
  assert.match(r.stdout, /liveness-from-activity/, 'the branch that duplicated my work must be the thing it names');
});

test('a topic with no prior work does NOT cry wolf', async () => {
  const r = await cf(['zzqqxx wombat telegraph', '--hours', '24']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.includes('SOMEBODY MAY ALREADY BE ON THIS'), false);
  assert.match(r.stdout, /\(none\)/);
});

test('a flag value is not swallowed into the topic', async () => {
  // `check-first roster --hours 24` must not search for "roster 24".
  const r = await cf(['roster', '--hours', '24', '--json']);
  const d = JSON.parse(r.stdout);
  assert.equal(d.topic, 'roster', 'the flag value must not become part of the topic');
  assert.equal(d.hours, 24);
});

test('an unreachable server reports UNKNOWN and exits 2, never "nothing found"', async () => {
  const r = await cf(['roster liveness'], '/');
  assert.equal(r.code, 2, 'a failed lookup must not exit 0');
  assert.match(r.stderr + r.stdout, /LOOKUP INCOMPLETE|cannot|error/i);
  assert.equal(/\bSOMEBODY MAY ALREADY BE ON THIS\b/.test(r.stdout), false);
});

test('--hours refuses a value it cannot use', async () => {
  const r = await cf(['roster', '--hours', 'abc']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--hours/);
});

test('it is in HELP and the checklist is in CLAUDE.md', async () => {
  assert.match(await readFile(CLI, 'utf8'), /agentbridge check-first <topic>/);
  const md = await readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8');
  assert.match(md, /check-first/, 'the checklist must name the command');
  assert.match(md, /ls-remote/, 'and must say to ask the server, since stale refs caused the duplication');
});
