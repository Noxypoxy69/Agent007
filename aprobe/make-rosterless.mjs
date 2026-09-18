/*
 * AUDIT SCAFFOLD — claim 5: does the corpus reach both widening directions BY
 * DESIGN, or via the roster accident (`code-a` alias "a", `code-d` alias "d")?
 *
 * v1 emptied ROSTER_IMPOSTORS and the gate's own "the roster yielded only 0
 * non-owner names" precondition fired and aborted the test before the loop —
 * correctly (that is rule 5 working), but it meant the variant measured
 * nothing. So this keeps the roster intact and removes it only from the corpus
 * the loop iterates, which is the thing under test.
 */
import fs from 'node:fs';

const src = fs.readFileSync('atest/ownerIdentityAnchored.test.mjs', 'utf8');
const from = 'const IMPOSTORS = [...ROSTER_IMPOSTORS, ...NEAR_MISSES];';
const to = 'const IMPOSTORS = [...NEAR_MISSES]; void ROSTER_IMPOSTORS; // AUDIT: derived near-misses only';
if (!src.includes(from)) { console.error('anchor not found'); process.exit(2); }
fs.mkdirSync('atest2', { recursive: true });
fs.writeFileSync('atest2/ownerIdentityRosterless.test.mjs', src.split(from).join(to));
const out = fs.readFileSync('atest2/ownerIdentityRosterless.test.mjs', 'utf8');
console.log('landed:', out.includes(to), '| old line gone:', !out.includes(from));
