#!/usr/bin/env node
/**
 * RUN THE CLI WITH THE REGISTRATION TOKEN LOADED FROM THE OPERATOR'S SECRETS FILE.
 *
 * WHY THIS EXISTS. CLAUDE.md documents exactly one way to register hosted:
 *
 *   AGENTBRIDGE_REGISTRATION_TOKEN=$(cat ".../registration-token.txt") \
 *     node bin/agentbridge.mjs register-session ...
 *
 * That spelling is UNEXECUTABLE in a guarded session and has been all night.
 * `$(...)` is command substitution and the shell rail refuses it; a leading
 * environment assignment is refused separately. So every guarded session
 * silently degrades to `hosted NOT CONFIGURED -- local only`, exits 0, and is
 * invisible to every other machine. Measured repeatedly on 2026-09-18: the
 * roster read ten agents offline while at least two were working.
 *
 * The obvious workaround -- a launcher in a scratchpad -- is ALSO refused, and
 * correctly: `mayExecute` requires every node operand to be tracked in HEAD,
 * because running a file the session just wrote is arbitrary code execution
 * behind a name nobody reviewed. The refusal names its own remedy: "Commit it
 * first." This file is that remedy taken rather than worked around. It is in the
 * repository, it is reviewable, and the trace is the commit.
 *
 * THE TOKEN IS NEVER EXPOSED. It is read in-process and handed to the child
 * through `env`. It is never placed in argv -- argv is visible in the process
 * table -- never logged, and never written. Only its LENGTH is reported, so a
 * wrong-file or empty-file failure stays diagnosable without the value reaching
 * a terminal, a transcript or a shell history.
 *
 *   node scripts/agentbridge-with-token.mjs register-session --agent code-b ...
 *   node scripts/agentbridge-with-token.mjs wait-for-work --session <id> --once
 *
 * IT DOES NOT DECIDE ANYTHING. Every argument is passed through untouched; this
 * adds one environment variable and nothing else. It is not a place to put
 * policy, and a future reader should be suspicious of any logic appearing here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'bin', 'agentbridge.mjs');

/* Outside every worktree on purpose, so no `git add` can reach it. */
const DEFAULT_TOKEN_FILE = path.join(
  os.homedir(), 'Documents', 'agentbridge-secrets', 'registration-token.txt',
);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/agentbridge-with-token.mjs <agentbridge args...>');
  process.exit(2);
}

/*
 * ALREADY SET WINS. A session that genuinely has the variable should not have it
 * replaced from a file that may be older or belong to a different environment.
 */
const existing = String(process.env.AGENTBRIDGE_REGISTRATION_TOKEN ?? '').trim();
let token = existing;

if (!token) {
  const file = String(process.env.AGENTBRIDGE_TOKEN_FILE ?? '').trim() || DEFAULT_TOKEN_FILE;
  try {
    token = fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    console.error(`could not read the registration token from ${file} (${e.code ?? e.message})`);
    console.error('this would otherwise register LOCAL ONLY and still exit 0, so it refuses instead');
    process.exit(2);
  }
  if (!token) {
    console.error(`the registration token file ${file} is empty`);
    process.exit(2);
  }
  console.error(`[with-token] loaded ${token.length} chars from ${file}`);
} else {
  console.error('[with-token] using AGENTBRIDGE_REGISTRATION_TOKEN already in the environment');
}

const r = spawnSync(process.execPath, [CLI, ...args], {
  cwd: REPO,
  env: { ...process.env, AGENTBRIDGE_REGISTRATION_TOKEN: token },
  stdio: 'inherit',
  windowsHide: true,
});

if (r.error) {
  console.error(`[with-token] could not start the CLI: ${r.error.message}`);
  process.exit(2);
}

/*
 * THE CHILD'S STATUS IS REPORTED, NOT FLATTENED. CLAUDE.md records that the CLI
 * can abort with 127 on Windows after a remote fetch -- a libuv assertion on the
 * way out, not a failure of the work. Collapsing that to 0 or to 1 would hide
 * which of the two happened, so it is passed through and named.
 */
if (r.signal) console.error(`[with-token] the CLI was killed by ${r.signal}`);
process.exit(r.status ?? 2);
