import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { HOME } from './config.mjs';

/**
 * Where delegation contracts and commit attributions live.
 *
 * BESIDE THE MACHINE'S STATE, NOT IN THE REPOSITORY. Both are coordination
 * data about who is doing what right now, not project history, and the same
 * rule already applies to config.json and registry.json: runtime state stays
 * out of git. `.agentbridge/` is gitignored, and a delegation naming an
 * operator's worktree paths and session ids is exactly the sort of thing that
 * should not be pushed.
 *
 * Deliberately boring: read the whole file, write the whole file. There is no
 * concurrent writer today, and a partial-update scheme would be the second
 * source of truth this project keeps warning itself about. If more than one
 * process ever writes these, this needs the same fail-fast lock the mutation
 * harness uses -- not a merge strategy.
 */

const DELEGATIONS = () => path.join(HOME, 'delegations.json');
const ATTRIBUTIONS = () => path.join(HOME, 'attributions.json');

/*
 * The Owner Decision Ledger. Append-only by discipline rather than by file
 * format: nothing here deletes a record, and the only field that changes after
 * creation is revoked_at. See src/ownerDecisions.mjs for why a superseded
 * decision stays readable forever.
 */
const DECISIONS = () => path.join(HOME, 'ownerDecisions.json');

async function readJsonArray(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    // A file that is not an array is corrupt, not empty. Returning [] would
    // silently discard every record on the next write.
    if (!Array.isArray(parsed)) throw new Error(`${file} does not contain a JSON array`);
    return parsed;
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeJsonArray(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

export const readDelegations = () => readJsonArray(DELEGATIONS());
export const writeDelegations = (rows) => writeJsonArray(DELEGATIONS(), rows);
export const readAttributions = () => readJsonArray(ATTRIBUTIONS());
export const writeAttributions = (rows) => writeJsonArray(ATTRIBUTIONS(), rows);
export const readDecisions = () => readJsonArray(DECISIONS());
export const writeDecisions = (rows) => writeJsonArray(DECISIONS(), rows);

/*
 * Token-budget measurements. A SEPARATE FILE FROM THE LEDGERS, on purpose.
 *
 * These are observations, not contracts. Mixing them into delegations.json
 * would put a growing append-only measurement stream inside the file whose
 * every record is a commitment somebody is accountable for -- and the
 * append-only assertions that protect the ledger would then be guarding rows
 * that are merely telemetry.
 *
 * Measurements are DESCRIPTIVE. Nothing reads this file to decide anything, and
 * nothing in src/tokenBudget.mjs produces message text, so a number recorded
 * here can never be fed back to an agent as prose or used to rank one.
 */
const MEASUREMENTS = () => path.join(HOME, 'tokenMeasurements.json');
export const readMeasurements = () => readJsonArray(MEASUREMENTS());
export const writeMeasurements = (rows) => writeJsonArray(MEASUREMENTS(), rows);
