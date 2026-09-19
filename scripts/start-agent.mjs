#!/usr/bin/env node
/**
 * START A SESSION THAT THE BRIDGE CAN ACTUALLY SEE.
 *
 * The watcher exists, works, and has never run once. Measured 2026-09-18:
 * ~/.agentbridge/polls/ did not exist at all. The reason is one line in
 * scripts/bridge-session-poll.mjs --
 *
 *   NOT POLLING -- AGENTBRIDGE_AGENT_ID is not set
 *
 * -- and then it exits 0. Nothing in the repository sets that variable, so the
 * SessionStart hook fires, declines, and reports success. Both symptoms follow
 * from it: the watcher never starts, and the roster shows every agent offline
 * while they are demonstrably working.
 *
 * THE IDENTITY CANNOT BE DERIVED, AND THE RUNNER IS RIGHT TO REFUSE TO GUESS.
 * The hook payload carries Claude Code's session UUID, which has no recorded
 * mapping to code-a. Three agents share one machine, one checkout and one
 * config file, so nothing on disk distinguishes them. Only the person opening
 * the terminal knows which agent it is. "A fabricated identity on the roster is
 * what work gets routed by" is the runner's own sentence and it is correct.
 *
 * So the fix is not derivation, it is making the one unavoidable manual step
 * impossible to get wrong or forget:
 *
 *   agent code-a
 *   agent code-b agentbridge
 *   agent fixer
 *
 * THERE USED TO BE TWO LAUNCHERS AND ONLY ONE WORKED. This header advertised
 * `npm run agent -- code-a` as the way to start a session, and package.json
 * exposed a script called `agent` to match. Neither launches anything: npm
 * pipes stdin, so claude comes up headless -- which is the bug d0e3f88 fixed
 * by adding agent.cmd, while leaving the misleading npm entry and this text
 * in place. Danny hit the broken one first, twice.
 *
 * So the npm script is now `agent:check`, which is what it actually does:
 * validate an id against the local registry and print the environment. The
 * only thing that starts a session is agent.cmd.
 *
 * WHICH HALF DOES WHAT, because a surviving sentence here claimed both halves
 * did everything and was false about either referent:
 *
 *   this script   validates the id against the local registry and PRINTS the
 *                 environment. It starts nothing (see `void spawn` below).
 *   agent.cmd     sets the variable and runs claude from this repository. It
 *                 does NO validation -- run this script first if you want the
 *                 id checked.
 *
 * agent.cmd's cd is the OTHER half of the original problem: a session started
 * from this repository loads .claude/settings.json and therefore the guard,
 * the Stop gate and the poll hook. A session started from the home directory
 * loads none of them; that is how one agent ran unguarded all night.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from '../src/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const laneFlag = argv.indexOf('--lane');
const lane = laneFlag !== -1 ? argv[laneFlag + 1] : null;
const dryRun = argv.includes('--print');

/*
 * A FLAG'S VALUE IS NOT A POSITIONAL, and the first version treated it as one.
 *
 * `argv.find((a) => !a.startsWith('--'))` takes the first non-flag token, so
 *   agent:check --lane agentbridge code-a
 * read "agentbridge" as the agent id and refused a perfectly good "code-a"
 * with "has never registered on this machine". Found by blind audit. An
 * over-block on a legitimate id is a real defect: the usage line shows
 * id-first, but nothing enforces that order and nothing should.
 *
 * `--lane` is the only value-taking flag here, so its argument is skipped by
 * INDEX rather than by guessing from the token's shape -- a lane legitimately
 * looks exactly like an agent id, so no amount of inspecting "agentbridge"
 * could tell the two apart. Ask the position, not the string.
 */
const valueIndices = new Set(laneFlag !== -1 ? [laneFlag + 1] : []);
const agentId = argv.find((a, i) => !a.startsWith('--') && !valueIndices.has(i));

/** Same shape the poll runner enforces, because this value becomes a filename there. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

if (!agentId || !SAFE.test(agentId)) {
  console.error('usage: npm run agent:check -- <agent-id> [--lane <lane>] [--print]');
  console.error('       (this VALIDATES and PRINTS; to start a session use:  agent <agent-id>)');
  console.error('');
  console.error('  <agent-id> is the DURABLE agent id the bridge knows, not a session name.');
  known().forEach((a) => console.error(`    ${a}`));
  process.exit(2);
}

/**
 * Agent ids seen on this machine, offered as a reminder rather than a
 * restriction: a genuinely new agent must be startable, but a TYPO must not
 * silently create a second identity on the roster, which is the failure this
 * whole area is about.
 */
function known() {
  try {
    /*
     * ASK config.mjs FOR THE STORE, DO NOT REBUILD THE PATH. This read used to
     * be homedir() + '/.agentbridge' spelled out here, which ignored
     * AGENTBRIDGE_HOME and therefore reached the OPERATOR'S REAL STORE from
     * every context including a test. That is rule 21 -- the roster it checked
     * against was an accident of one machine -- and it is the same isolation
     * hole code-b measured when two auditors ran against Danny's live store.
     * config.mjs already owns this decision; there is one HOME and this is it.
     */
    const rows = JSON.parse(readFileSync(path.join(HOME, 'registrations.json'), 'utf8'));
    return [...new Set(rows.map((r) => r.agent_id).filter(Boolean))].sort();
  } catch { return []; }
}

const seen = known();
if (seen.length && !seen.includes(agentId)) {
  /*
   * SAY WHAT IS ABOUT TO HAPPEN, NOT THE OPPOSITE OF IT.
   *
   * The first version printed the whole refusal -- "Refusing by default..." --
   * and THEN checked --new, so `agent:check brand-new --new` emitted a refusal
   * and proceeded to exit 0. The behaviour was right and the output said the
   * reverse, which is worse than either alone: a reader who trusts the text
   * believes a session was refused when it was not. Found by blind audit.
   */
  console.error(`agent id "${agentId}" has never registered on this machine.`);
  console.error(`known here: ${seen.join(', ')}`);
  if (!argv.includes('--new')) {
    console.error('');
    console.error('If that is deliberate, pass it again with --new to confirm.');
    console.error('Refusing by default because a typo here does not fail -- it creates a');
    console.error('SECOND identity on the roster, and work gets routed by that identity.');
    process.exit(2);
  }
  console.error('--new given: accepting it as a genuinely new agent id.');
}

const env = { ...process.env, AGENTBRIDGE_AGENT_ID: agentId };
if (lane) env.AGENTBRIDGE_LANE = lane;

console.log(`agent      : ${agentId}${lane ? `  (lane ${lane})` : ''}`);
console.log(`cwd        : ${REPO}`);
console.log(`hooks      : ${existsSync(path.join(REPO, '.claude', 'settings.json')) ? 'loaded from this repo' : 'MISSING .claude/settings.json'}`);
console.log('');

if (dryRun) {
  console.log('--print: not launching. The environment this would set:');
  console.log(`  AGENTBRIDGE_AGENT_ID=${agentId}`);
  if (lane) console.log(`  AGENTBRIDGE_LANE=${lane}`);
  process.exit(0);
}

/*
 * IT CANNOT LAUNCH CLAUDE FROM HERE, AND PRETENDING OTHERWISE WASTED THE
 * OPERATOR'S TIME.
 *
 * The first version spawned claude with stdio inherit. Under `npm run` that
 * fails immediately -- Danny hit it on the first try:
 *
 *   Input must be provided either through stdin or as a prompt argument
 *
 * npm runs a script with stdin PIPED, so claude sees no TTY and starts in
 * headless print mode. Measured here: process.stdin.isTTY is false under
 * `npm run`. A launcher that cannot hand over a terminal it never owned is not
 * a launcher, and shipping one that errors on first use is worse than shipping
 * nothing, because the operator now has to debug my helper instead of starting
 * an agent.
 *
 * So this validates and PRINTS, and agent.cmd in the repository root does the
 * actual launching -- a .cmd sets the variable in the caller's own shell and
 * execs claude there, so the terminal is never passed through a pipe.
 */
console.log('This script validates and prints; it does not launch.');
console.log('');
console.log('  AGENTBRIDGE_AGENT_ID=' + agentId);
if (lane) console.log('  AGENTBRIDGE_LANE=' + lane);
console.log('');
console.log('To start the session, from this directory:');
console.log('');
console.log(`    agent ${agentId}${lane ? ` ${lane}` : ''}`);
console.log('');
/*
 * "in your shell" was wrong: agent.cmd opens with `setlocal`, so the
 * assignment reaches the claude it starts and is discarded when the script
 * ends. That is the correct behaviour -- it is what stops one launch leaking
 * an agent id into the next -- but the sentence described a different thing.
 */
console.log('(agent.cmd sets the variable for the claude it starts, in this repository.');
console.log(' npm run cannot: it pipes stdin, so claude comes up headless.)');
void spawn; // kept out of the launch path deliberately; see the comment above
