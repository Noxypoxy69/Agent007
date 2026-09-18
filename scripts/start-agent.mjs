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
 *   npm run agent -- code-a
 *   npm run agent -- code-b --lane agentbridge
 *   npm run agent -- fixer
 *
 * It validates the id against the registry, sets the variable, and execs claude
 * in this repository -- which also fixes the OTHER half of the problem, because
 * a session started from here loads .claude/settings.json and therefore the
 * guard, the Stop gate and the poll hook. A session started from the home
 * directory loads none of them; that is how one agent ran unguarded all night.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const agentId = argv.find((a) => !a.startsWith('--'));
const laneFlag = argv.indexOf('--lane');
const lane = laneFlag !== -1 ? argv[laneFlag + 1] : null;
const dryRun = argv.includes('--print');

/** Same shape the poll runner enforces, because this value becomes a filename there. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

if (!agentId || !SAFE.test(agentId)) {
  console.error('usage: npm run agent -- <agent-id> [--lane <lane>] [--print]');
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
    const f = path.join(homedir(), '.agentbridge', 'registrations.json');
    const rows = JSON.parse(readFileSync(f, 'utf8'));
    return [...new Set(rows.map((r) => r.agent_id).filter(Boolean))].sort();
  } catch { return []; }
}

const seen = known();
if (seen.length && !seen.includes(agentId)) {
  console.error(`agent id "${agentId}" has never registered on this machine.`);
  console.error(`known here: ${seen.join(', ')}`);
  console.error('');
  console.error('If that is deliberate, pass it again with --new to confirm.');
  console.error('Refusing by default because a typo here does not fail -- it creates a');
  console.error('SECOND identity on the roster, and work gets routed by that identity.');
  if (!argv.includes('--new')) process.exit(2);
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
console.log('(agent.cmd sets the variable in your shell and starts claude there.');
console.log(' npm run cannot: it pipes stdin, so claude comes up headless.)');
void spawn; // kept out of the launch path deliberately; see the comment above
