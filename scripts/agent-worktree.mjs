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
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentWorkspacePlan, startupRefusal } from '../src/agentWorkspace.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const say = (s) => process.stderr.write(`${s}\n`);

const git = (args, cwd = REPO) => spawnSync('git', args, { cwd, encoding: 'utf8' });

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
const hasBranch = git(['rev-parse', '--verify', '--quiet', `refs/heads/${plan.branch}`]).status === 0;
const add = hasBranch
  ? git(['worktree', 'add', dir, plan.branch])
  : git(['worktree', 'add', dir, '-b', plan.branch]);

if (add.status !== 0 || !existsSync(path.join(dir, '.git'))) {
  say(`[agentbridge:no-workspace] could not create ${dir}: ${(add.stderr || add.stdout || '').trim() || 'unknown'}`);
  say('REFUSING TO START in the shared worktree: two sessions in one tree is what makes every verification '
    + 'unreliable. If the branch is checked out elsewhere, or a stale worktree holds the path, run '
    + '`git worktree prune` and try again.');
  process.exit(1);
}

say(`[agentbridge:workspace] created ${dir} on ${plan.branch}`);
process.stdout.write(dir);
