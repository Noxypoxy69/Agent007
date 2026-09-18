#!/usr/bin/env node
/**
 * THE LAST THING BETWEEN A PAYLOAD AND A HOSTED DATABASE.
 *
 * Its own entry point rather than a subcommand of bin/agentbridge.mjs, for the
 * same reason the collision guard has one: that CLI is a choke-point two lanes
 * would edit at once. Wiring it in is one line and belongs to whoever owns that
 * file, at integration.
 *
 * Reads a payload on stdin or from --file, so it can be piped straight from the
 * existing command without that command changing:
 *
 *   agentbridge heartbeat --dry-run | agentbridge-preflight
 *   agentbridge-preflight --file payload.json
 *
 * THE CONTRACT, which is the only part a caller consumes:
 *
 *   0  clean
 *   1  leaks found — do not publish
 *   2  cannot run: no payload, unreadable, not JSON
 *
 * EXIT 2 IS NOT EXIT 0, and the difference is the whole design. A preflight that
 * cannot read its input has not established that the payload is safe; it has
 * established nothing. Treating that as "clean" publishes on the strength of a
 * check that never ran, which is worse than not having the check — the operator
 * believes they were protected.
 *
 * --identity lets a caller scan for a name that is not this machine's, which is
 * what makes the regression fixture possible: the committed test carries an
 * invented operator, because a fixture with the real one would be the leak.
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { scanPayload, machineIdentity, formatLeaks } from '../src/payloadGuard.mjs';

const EXIT_CLEAN = 0;
const EXIT_LEAKS = 1;
const EXIT_CANNOT_RUN = 2;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const file = flag('file');
  let text;
  if (file) {
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      process.stderr.write(`agentbridge: cannot read ${file}: ${err?.message ?? err}\n`);
      process.exit(EXIT_CANNOT_RUN);
    }
  } else {
    text = await readStdin();
  }

  if (!text || !text.trim()) {
    process.stderr.write('agentbridge: no payload on stdin and no --file given\n');
    process.exit(EXIT_CANNOT_RUN);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    process.stderr.write(`agentbridge: payload is not JSON: ${err?.message ?? err}\n`);
    process.exit(EXIT_CANNOT_RUN);
  }

  /*
   * --identity user,home,host — for scanning on behalf of another machine. The
   * defaults come from os, so the ordinary case needs no arguments at all.
   */
  const raw = flag('identity');
  let identity = machineIdentity();
  if (raw) {
    const [username = '', homedir = '', hostname = ''] = raw.split(',');
    identity = { username, homedir, hostname };
  }

  const { ok, leaks } = scanPayload(payload, identity);
  if (!ok) {
    process.stderr.write(`${formatLeaks(leaks)}\n`);
    process.exit(EXIT_LEAKS);
  }
  process.exit(EXIT_CLEAN);
}

main().catch((err) => {
  /*
   * An unexpected throw is exit 2, never 0 — and never 1 either. "The guard
   * crashed" and "the payload is dirty" are different facts and a caller that
   * retries on one should not retry on the other.
   */
  process.stderr.write(`agentbridge: preflight could not run: ${err?.message ?? err}\n`);
  process.exit(EXIT_CANNOT_RUN);
});
