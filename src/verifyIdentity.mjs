/**
 * ONE DERIVATION OF THE VERIFICATION IDENTITY. BOTH SIDES IMPORT IT.
 *
 * The verifier writes a result under a key; the Stop gate looks one up. If those
 * two computed the key separately they would drift the first time either
 * changed, and the failure would be silent in the worst direction: the gate
 * would find nothing, start another run, and the duplicate-suite problem this
 * whole change exists to remove would come back wearing a cache.
 *
 * This repository has already paid for that exact mistake. The grant store key
 * was computed in one place and read in another; across 17 roots on one machine
 * exactly one had a grant and it was not the one anybody was working in, and it
 * was re-diagnosed three times because a grant at the wrong key fails exactly
 * like the guard being strict. `repoStorePath` was the fix there. This is the
 * same move, made before the bug rather than after it.
 *
 * SEPARATE FROM src/verifyCache.mjs ON PURPOSE. That module is pure and decides;
 * this one MEASURES -- it runs git, reads the filesystem and the environment. A
 * pure decision layer that reached for git could not be tested, which is the
 * rule 10 split the rest of this repository keeps.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { runGit } from './safeGit.mjs';

/** The exact command a verification run stands for. */
export const VERIFY_COMMAND = 'node --test test/**/*.test.mjs';

/**
 * The working tree, by CONTENT.
 *
 * NOT HEAD, AND NOT JUST `git status`. An uncommitted edit changes what the
 * suite executes -- and `npm test`'s glob is expanded by node rather than by
 * git, so an UNTRACKED test file runs. Keying on a commit would reuse a PASS
 * across an edit, which is the defect a blind audit demonstrated live against
 * audit-pin: it certified a commit while an auditor read a working tree.
 *
 * `git status` alone reports THAT a file changed, not what it now contains, so
 * two different edits to one file would share a key and the second would get
 * the first's verdict. Each dirty file's content is hashed in.
 *
 * NUL-framed with an explicit length, so a path ending in digits cannot
 * concatenate with a length into the same string as a different pair.
 *
 * Returns null when git cannot be asked. No digest means no key means run it --
 * the direction that costs minutes rather than correctness.
 */
export function treeDigest(root) {
  try {
    const NUL = String.fromCharCode(0);
    const head = String(runGit(['-C', root, 'rev-parse', 'HEAD^{tree}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    const status = String(runGit(['-C', root, 'status', '--porcelain', '--untracked-files=all'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }));

    const h = createHash('sha256').update(head);
    const lines = status.split('\n').map((s) => s.trimEnd()).filter((s) => s.trim() !== '').sort();
    for (const line of lines) {
      /*
       * The porcelain format is two status characters, a space, then the path.
       * git QUOTES a path containing unusual bytes, so the quotes are stripped
       * -- a quoted and an unquoted spelling of one path must not produce two
       * different keys for one tree.
       */
      const rel = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
      let body = null;
      try { body = readFileSync(path.join(root, rel)); } catch { body = null; }
      const bodyHash = body === null
        ? 'absent'
        : createHash('sha256').update(body).digest('hex');
      h.update(`${NUL}${rel}${NUL}${body === null ? 0 : body.length}${NUL}${bodyHash}`);
    }
    return h.digest('hex');
  } catch {
    return null;
  }
}

/**
 * The environment the suite actually reads.
 *
 * AGENTBRIDGE_HOME alone decides whether a test sees the operator's real grants
 * and findings, which is the difference between a result about this repository
 * and a result about this machine's live state. A cached PASS taken with the
 * live store must not be reused by a run pointed at a temp directory, or the
 * reverse.
 */
export function envDigest(env = process.env) {
  const READS = ['AGENTBRIDGE_HOME', 'AGENTBRIDGE_AGENT_ID', 'CLAUDE_PROJECT_DIR', 'CI', 'NODE_OPTIONS'];
  const NUL = String.fromCharCode(0);
  return createHash('sha256')
    .update(READS.map((k) => `${k}=${env[k] ?? ''}`).join(NUL))
    .digest('hex')
    .slice(0, 16);
}

/** node version, platform and architecture: two of this suite's failures are Windows-and-node-24 only. */
export function toolchainFingerprint() {
  return `${process.version}-${process.platform}-${process.arch}`;
}

/** Everything `verifyKey` needs, measured. */
export function verificationIdentity(root, env = process.env) {
  return {
    tree_digest: treeDigest(root),
    command: VERIFY_COMMAND,
    toolchain: toolchainFingerprint(),
    env_digest: envDigest(env),
  };
}

/**
 * Where a result for this key lives.
 *
 * Under AGENTBRIDGE_HOME rather than in the repository: a verification is about
 * a tree that may never be committed, several sessions produce them at once, and
 * writing into the worktree would make every run produce repository drift that
 * the Stop gate then blocks on. Same place the grants, the polls and the
 * findings live.
 */
export function verifyRecordPath(key, home = process.env.AGENTBRIDGE_HOME || path.join(os.homedir(), '.agentbridge')) {
  return path.join(home, 'verify', `${key}.json`);
}
