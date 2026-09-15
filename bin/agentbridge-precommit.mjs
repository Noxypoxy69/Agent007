#!/usr/bin/env node
/**
 * THE PRE-COMMIT COLLISION GUARD, AS A PROCESS.
 *
 * Its own entry point rather than a subcommand of bin/agentbridge.mjs, and that
 * is deliberate: the shared CLI is a choke-point two lanes would edit at once,
 * which is the exact class of collision this guard exists to stop. Wiring it in
 * as `agentbridge precommit` is one line, and it belongs to whoever owns that
 * file, at integration.
 *
 * ALL THIS FILE DOES IS I/O AND AN EXIT CODE. Every rule lives in
 * src/collisionGuard.mjs, pure. That split is the only reason the refusal
 * contract can be tested against real git repositories through a real child
 * process while the rules themselves stay testable in a millisecond.
 *
 * THE CONTRACT, WHICH IS THE WHOLE POINT:
 *
 *   0  allow — clean, or warnings only
 *   1  refuse
 *   2  cannot run — no registry, unreadable git, no resolvable lane
 *
 * A hook consumes the code and nothing else. Wording here is for a person and
 * is never asserted on.
 *
 * IDENTITY, IN PRECEDENCE ORDER. The lane may be given explicitly, named in the
 * environment, or inferred from the branch — and inference is last on purpose.
 * A guard that guesses your lane from the branch and guesses wrong blocks
 * correct work, so an explicit answer always wins, and an ambiguous inference
 * refuses rather than picking.
 *
 *   --lane <id>
 *   AGENTBRIDGE_LANE
 *   the unique lane whose branch_patterns match the current branch
 *
 * USAGE
 *   agentbridge-precommit [--lane <id>] [--registry <file>] [--strict-shared]
 *                         [--branch <name>] [--worktree <path>] [--staged <a,b>]
 *
 * The last three exist so the tests can drive it without a git repository in a
 * particular state; in normal use they are read from git.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseLaneRegistry, validateRegistry, laneMatchesBranch } from '../src/laneRegistry.mjs';
import {
  evaluateCommit,
  formatFindings,
  EXIT_CANNOT_RUN,
  EXIT_ALLOW,
} from '../src/collisionGuard.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
};
const has = (name) => argv.includes(`--${name}`);

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 60000 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout ?? '').trim() });
    });
  });
}

/**
 * Where the registry lives. An explicit --registry wins; otherwise
 * AGENTBRIDGE_LANES, then the conventional file at the repo root.
 *
 * Note it is NOT silently skipped when absent. A missing registry is exit 2,
 * never exit 0 — see rule 7 in collisionGuard.mjs.
 */
async function readRegistry(cwd) {
  const candidates = [
    flag('registry'),
    process.env['AGENTBRIDGE_LANES'],
    path.join(cwd, 'lanes.registry.yml'),
    path.join(cwd, 'lanes.registry.example.yml'),
  ].filter(Boolean);

  for (const file of candidates) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const reg = parseLaneRegistry(text, { source: path.basename(file) });
      const v = validateRegistry(reg);
      if (!v.ok) return { registry: null, registryError: `${file}: ${v.errors.join('; ')}` };
      return { registry: reg, registryError: null };
    } catch (err) {
      return { registry: null, registryError: `${file}: ${err?.message ?? String(err)}` };
    }
  }
  return {
    registry: null,
    registryError: `no lane registry found (looked for ${candidates.join(', ')})`,
  };
}

/** Explicit, then environment, then a UNIQUE branch match. Never a guess. */
function resolveLane(registry, branch) {
  const explicit = flag('lane') || process.env['AGENTBRIDGE_LANE'];
  if (explicit) return explicit;
  if (!registry || !branch) return null;
  const matches = registry.lanes.filter((l) => laneMatchesBranch(l, branch) === true);
  return matches.length === 1 ? matches[0].lane_id : null;
}

async function main() {
  const cwd = process.cwd();

  const repoRoot = (await git(['rev-parse', '--show-toplevel'], cwd)).out || cwd;
  const { registry, registryError } = await readRegistry(repoRoot);

  const branch = flag('branch') ?? ((await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).out || null);

  const stagedFlag = flag('staged');
  let stagedPaths;
  if (stagedFlag !== null) {
    stagedPaths = stagedFlag.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    const r = await git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT'], cwd);
    if (!r.ok) {
      // Unreadable git is "cannot run", not "nothing staged". The difference
      // matters: the second would wave every commit through.
      process.stderr.write('agentbridge: could not read the staged file list from git\n');
      process.exit(EXIT_CANNOT_RUN);
    }
    stagedPaths = r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  const worktree = flag('worktree') ?? repoRoot;
  const laneId = resolveLane(registry, branch);

  const result = evaluateCommit({
    registry,
    registryError,
    laneId,
    branch,
    worktree,
    stagedPaths,
    strictShared: has('strict-shared'),
  });

  if (result.findings.length) {
    const text = formatFindings(result.findings, { laneId });
    (result.exitCode === EXIT_ALLOW ? process.stdout : process.stderr).write(`${text}\n`);
  }
  process.exit(result.exitCode);
}

main().catch((err) => {
  /*
   * An unexpected throw is exit 2, never 0. A guard whose crash reads as
   * "allowed" is worse than no guard: it fails open exactly when something
   * unusual is happening.
   */
  process.stderr.write(`agentbridge: collision guard could not run: ${err?.message ?? err}\n`);
  process.exit(EXIT_CANNOT_RUN);
});
