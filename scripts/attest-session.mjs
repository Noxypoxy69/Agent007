#!/usr/bin/env node
/**
 * THE LAUNCHER'S HALF OF THE EXECUTION-PROFILE SPLIT.
 *
 * Run by agent.cmd immediately before it exec's `claude`, and by nothing else.
 * It writes a PENDING attestation; the SessionStart hook consumes it and binds
 * it to one session id. See src/sessionEvidence.mjs for why that ordering is
 * the anchor rather than any secret.
 *
 * WHY A SCRIPT OF ITS OWN RATHER THAN A SUBCOMMAND OF bin/agentbridge.mjs.
 * Two reasons, and the second is the one that decided it. A launcher needs this
 * to be fast and to have no chance of failing on unrelated CLI wiring. And
 * another session is actively working in bin/agentbridge.mjs in this same
 * worktree -- it named that file as its collision surface before this was
 * written, so adding CLI surface there would have been a collision anybody
 * could have predicted and nobody would have caught until both commits landed.
 *
 * IT NEVER FAILS THE LAUNCH. A session that starts without an attestation is
 * contained, which is the safe outcome and the documented default. Refusing to
 * start the terminal because a JSON file could not be written would be a
 * control that costs an operator their session to protect nothing.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePendingAttestation } from '../src/sessionEvidence.mjs';
import { MANUAL_TRUSTED, PROFILES } from '../src/sessionPolicy.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = argv.indexOf('--profile');
const requested = flag !== -1 ? argv[flag + 1] : MANUAL_TRUSTED;

if (!PROFILES.includes(requested)) {
  process.stdout.write(`attest-session: ${requested} is not an execution profile; nothing written\n`);
  process.exit(0);
}

/*
 * THE REPO ROOT IS THIS SCRIPT'S OWN LOCATION, NOT cwd.
 *
 * agent.cmd cds into the agent's worktree before launching, and the store key
 * is derived from the canonical git COMMON dir -- which is the same for a
 * repository and all of its linked worktrees. So both spellings key the same
 * file and this is belt and braces rather than a fix. Deriving it from the
 * script's location means it stays true if the launcher's cd ever moves.
 */
const result = writePendingAttestation(REPO, requested);

process.stdout.write(result.ok
  ? `attest-session: ${requested} attested for the next session to start\n`
  : `attest-session: NOT attested (${result.reason}); the session will be contained\n`);
process.exit(0);
