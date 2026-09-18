/*
 * AUDIT SCAFFOLD — claim 5 asks whether the corpus reaches both widening
 * directions BY DESIGN or via the roster accident (`code-a` alias "a",
 * `code-d` alias "d"). This makes a verbatim copy of the gate with the ROSTER
 * contribution emptied, so only the OWNER_IDS-derived near-misses remain.
 * Nothing else is changed.
 */
import fs from 'node:fs';

const src = fs.readFileSync('atest/ownerIdentityAnchored.test.mjs', 'utf8');
const from = `const ROSTER_IMPOSTORS = ACTORS
  .filter((a) => a.actor_type !== 'owner')
  .flatMap((a) => [a.actor_id, ...(a.aliases ?? [])]);`;
if (!src.includes(from)) { console.error('anchor not found'); process.exit(2); }
const out = src
  .split(from)
  .join(`const ROSTER_IMPOSTORS = (ACTORS, []); // AUDIT: roster contribution removed`);
fs.mkdirSync('atest2', { recursive: true });
fs.writeFileSync('atest2/ownerIdentityRosterless.test.mjs', out);
console.log('wrote atest2/ownerIdentityRosterless.test.mjs; roster removed:', !out.includes(from));
