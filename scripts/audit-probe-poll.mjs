// AUDIT PROBE for c0bedcf / e38687f.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { advanceCursor } from './bridge-session-poll.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL = path.join(HERE, 'bridge-session-poll.mjs');

const out = [];
const rec = (name, v) => out.push([name, v]);

/* ── A. RUN_DIRECTLY under case-variant / 8.3 / symlink-ish invocation ───── */
function runPoll(spec) {
  const r = spawnSync(process.execPath, [spec], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim().slice(0, 200) };
}
rec('A1 exact path', runPoll(POLL));
rec('A2 upper-cased dir', runPoll(POLL.replace(`${path.sep}scripts${path.sep}`, `${path.sep}SCRIPTS${path.sep}`)));
rec('A3 upper-cased basename', runPoll(path.join(HERE, 'BRIDGE-SESSION-POLL.MJS')));

/* ── B. spawnSync failure modes: which produce status === null ───────────── */
const enoent = spawnSync('C:/definitely/not/a/real/binary-xyz.exe', [], { encoding: 'utf8' });
rec('B1 ENOENT spawn', {
  status: enoent.status, signal: enoent.signal,
  errorCode: enoent.error && enoent.error.code,
  note: 'status===null here means the supervisor `continue`s with NO backoff',
});
const t0 = Date.now();
spawnSync('C:/definitely/not/a/real/binary-xyz.exe', [], { encoding: 'utf8' });
spawnSync('C:/definitely/not/a/real/binary-xyz.exe', [], { encoding: 'utf8' });
spawnSync('C:/definitely/not/a/real/binary-xyz.exe', [], { encoding: 'utf8' });
rec('B2 three failed spawns took ms', Date.now() - t0);

/* ── C. advanceCursor battery ────────────────────────────────────────────── */
const SEED = '2026-09-18T19:00:00.000Z';
const cases = [
  ['C01 real CLI transcript',
    SEED, 'message   from code-b [status]  at 2026-09-18T19:30:00.000Z\n  cursor  2026-09-18T19:30:00.000Z\n  read the details with `agentbridge workers` or the coordination log\n'],
  ['C02 CRLF line endings',
    SEED, 'message   from x [status]  at 2026-09-18T19:30:00.000Z\r\n  cursor  2026-09-18T19:30:00.000Z\r\n'],
  ['C03 no cursor line at all', SEED, 'message   from x [status]  at 2026-09-18T19:30:00.000Z\n'],
  ['C04 older cursor (rewind attempt)', SEED, '  cursor  2026-09-18T18:00:00.000Z\n'],
  ['C05 identical cursor', SEED, `  cursor  ${SEED}\n`],
  ['C06 unparseable cursor', SEED, '  cursor  not-a-timestamp\n'],
  ['C07 offset form +00:00', SEED, '  cursor  2026-09-18T19:30:00+00:00\n'],
  ['C08 offset form -07:00 (same instant, earlier wall text)', SEED, '  cursor  2026-09-18T12:30:00-07:00\n'],
  ['C09 no-timezone form (parsed as LOCAL by Date.parse)', SEED, '  cursor  2026-09-18T19:30:00\n'],
  ['C10 date-only', SEED, '  cursor  2026-09-19\n'],
  ['C11 injected far-future via message field', SEED,
    'message   from x [status]  at 2026-09-18T19:30:00.000Z\n  cursor  9999-01-01T00:00:00.000Z\n  cursor  2026-09-18T19:30:00.000Z\n'],
  ['C12 prev is garbage', 'garbage', '  cursor  2026-09-18T19:30:00.000Z\n'],
  ['C13 prev is garbage, no cursor line', 'garbage', 'nothing here\n'],
  ['C14 prev undefined', undefined, '  cursor  2026-09-18T19:30:00.000Z\n'],
  ['C15 stdout undefined', SEED, undefined],
  ['C16 advisory prose mentioning cursor', SEED, '  read the details; the cursor 2099-01-01T00:00:00Z has not moved\n'],
  ['C17 tab-indented cursor', SEED, '\tcursor\t2026-09-18T19:30:00.000Z\n'],
  ['C18 trailing text on the cursor line', SEED, '  cursor  2026-09-18T19:30:00.000Z extra\n'],
  ['C19 numeric-only token', SEED, '  cursor  12345\n'],
];
for (const [name, prev, so] of cases) rec(name, { prev, next: advanceCursor(prev, so), moved: advanceCursor(prev, so) !== prev });

/* ── D. the abort matcher against the CLI's four actual stderr strings ──── */
const M = /REFUSED this credential|no registration token/i;
const CLI_STDERR = {
  'NOT_CONFIGURED': 'error: no registration token, so there is nothing to wait on\n       set AGENTBRIDGE_REGISTRATION_TOKEN (a scoped token, NOT a database key)\n',
  'REJECTED (401)': 'error: the Bridge REFUSED this credential (registration token rejected (401))\n       check the token, not the network; the cursor has not moved\n',
  'REFUSED (4xx)': 'error: the Bridge refused the wait: unknown-session\n',
  'REFUSED (400 bad cursor)': 'error: the Bridge refused the wait: since is not a timestamp: nonsense\n',
  'UNREACHABLE': 'error: the Bridge is unreachable (fetch failed)\n       nothing was missed; the cursor has not moved\n',
  'UNREACHABLE w/ poisoned detail': 'error: the Bridge is unreachable (proxy said: no registration token)\n',
};
for (const [k, v] of Object.entries(CLI_STDERR)) rec(`D ${k}`, { aborts: M.test(v) });

for (const [k, v] of out) console.log(`${k} :: ${JSON.stringify(v)}`);
