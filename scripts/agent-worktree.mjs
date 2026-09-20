#!/usr/bin/env node
/**
 * Resolve (and if needed create) the calling agent's own worktree.
 *
 *   node scripts/agent-worktree.mjs <agent-id> [--print]
 *
 * Prints the worktree PATH on stdout and nothing else, so `agent.cmd` can
 * capture it with a `for /f`. Every explanation goes to stderr. Exits non-zero
 * on any refusal, and the launcher must treat that as fatal -- see
 * `startupRefusal` in src/agentWorkspace.mjs for why falling back to the
 * shared tree is worse than not starting.
 *
 * WHY A NODE SCRIPT AND NOT MORE .cmd. The decision -- is this id safe as a
 * directory name, where does the worktree go -- is in src/agentWorkspace.mjs
 * and is unit-tested. A launcher cannot be tested by the suite, because
 * running it starts a Claude session, so anything it decides is untested by
 * construction. This file is the thin effectful shell around a tested
 * decision.
 *
 * THIS IS NOT RUNNABLE FROM A GUARDED SESSION and that is expected: the rail
 * refuses `git worktree` categorically. It runs from `agent.cmd`, which is
 * the launcher and is never judged by the rail. An agent asking for its own
 * isolation after the fact is too late anyway -- the session has already
 * loaded in whatever tree it started in.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentWorkspacePlan, startupRefusal } from '../src/agentWorkspace.mjs';
import { runGit } from '../src/safeGit.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const say = (s) => process.stderr.write(`${s}\n`);

/*
 * THROUGH safeGit, NOT spawnSync, AND THE SUITE ENFORCES IT.
 *
 * `.git/config` can name commands git runs on ordinary operations -- set
 * core.fsmonitor to a script and a plain `git status` executes it -- and
 * `.git/` is neither tracked nor in PROTECTED_PATHS, so such a file is
 * invisible to every path rule we have. runGit strips that surface.
 *
 * I wrote this file with a bare `spawnSync('git', ...)` and
 * test/safeGit.test.mjs caught it: "EVERY git invocation under src, bin and
 * scripts goes through safeGit, wrapper or not". That gate exists because the
 * flags previously lived in two places while seven other call sites had none.
 *
 * runGit THROWS on a non-zero exit rather than returning a status, so every
 * call here is wrapped. Getting that wrong is how a conversion to this wrapper
 * turns a handled failure into a crash.
 */
const gitOk = (args, cwd = REPO) => {
  try {
    runGit(args, { cwd });
    return { ok: true, detail: '' };
  } catch (e) {
    return { ok: false, detail: String(e?.stderr || e?.stdout || e?.message || '').trim() };
  }
};

const [, , rawId, ...rest] = process.argv;
const printOnly = rest.includes('--print');

const plan = agentWorkspacePlan(rawId, { repoRoot: REPO.replace(/\\/g, '/') });
const refusal = startupRefusal(plan);
if (refusal) {
  say(refusal);
  process.exit(2);
}

const dir = path.normalize(plan.dir);

if (existsSync(path.join(dir, '.git'))) {
  say(`[agentbridge:workspace] reusing ${dir} on ${plan.branch}`);
  process.stdout.write(dir);
  process.exit(0);
}

if (printOnly) {
  say(`[agentbridge:workspace] would create ${dir} on ${plan.branch} (nothing was created)`);
  process.stdout.write(dir);
  process.exit(0);
}

/*
 * REUSE THE BRANCH IF IT EXISTS, NEVER RESET IT.
 *
 * `git worktree add -B` would move the branch to HEAD, which silently
 * discards an agent's previous unmerged work the first time its worktree is
 * pruned and recreated. That is the destroy-the-evidence failure the
 * workspace manager has a header about, arriving through a convenience flag.
 */
const hasBranch = gitOk(['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`]).ok;
const add = hasBranch
  ? gitOk(['worktree', 'add', dir, plan.branch])
  : gitOk(['worktree', 'add', dir, '-b', plan.branch]);

/*
 * THE DIRECTORY IS CHECKED AS WELL AS THE EXIT CODE. An exit status is a proxy
 * for "the worktree exists"; the far end is the worktree existing. They agree
 * until they do not, which is exactly when this matters.
 */
if (!add.ok || !existsSync(path.join(dir, '.git'))) {
  say(`[agentbridge:no-workspace] could not create ${dir}: ${add.detail || 'unknown'}`);
  say('REFUSING TO START in the shared worktree: two sessions in one tree is what makes every verification '
    + 'unreliable. If the branch is checked out elsewhere, or a stale worktree holds the path, run '
    + '`git worktree prune` and try again.');
  process.exit(1);
}

say(`[agentbridge:workspace] created ${dir} on ${plan.branch}`);
process.stdout.write(dir);
