import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const MAP = new URL('../docs/AGENTBRIDGE_MASTER_BUILD_MAP.md', import.meta.url);
const ROADMAP = new URL('../docs/ROADMAP.md', import.meta.url);

/**
 * THE MASTER MAP SAYS "NO NARROWER ROADMAP MAY SILENTLY REMOVE A REQUIREMENT".
 * This is that sentence, enforced.
 *
 * It exists because I committed exactly that failure. Handed a 734-line
 * specification, I wrote a 465-line roadmap, called it the map, and dropped 29
 * of 35 RPCs, 29 of 43 tables and the entire 34-row failure matrix. The owner
 * caught it by reading, which is the detection method this repository keeps
 * relying on and keeps paying for.
 *
 * A FIRST ATTEMPT AT THIS GATE WAS HOLLOW AND IS WORTH RECORDING. It matched
 * two keywords from each step title of the binding order and reported 16 of 17
 * steps covered — against a roadmap that had dropped fifteen subsystems. Title
 * words are cheap and appear anywhere; concrete artifact NAMES are not. RPC and
 * table identifiers are the tokens a summary cannot accidentally satisfy.
 *
 * RATCHET, NOT ABSOLUTE, and deliberately so. Twenty-nine absent RPCs is
 * inherited debt that cannot be cleared tonight, and a permanently red gate is
 * one people learn to ignore. The baseline may only ever go DOWN. Silence is
 * what the map forbids; a number that cannot grow makes omission loud.
 */

/** Measured 2026-09-17 against ROADMAP.md at 6b43c94. MAY ONLY DECREASE. */
const BASELINE = { rpcsAbsent: 29, tablesAbsent: 29 };

async function texts() {
  return { map: await readFile(MAP, 'utf8'), roadmap: await readFile(ROADMAP, 'utf8') };
}

function rpcNames(map) {
  const block = map.match(/```text\nregister_session[\s\S]*?\n```/);
  assert.ok(block, 'the master map must still define its RPC surface');
  return [...new Set([...block[0].matchAll(/^([a-z_]{4,})\s/gm)].map((m) => m[1]))];
}

test('the master map is present and still carries its spine', async () => {
  /*
   * A map that gets emptied is not hypothetical: a sibling repository had its
   * instructions file sit at 0 bytes for five days and nothing noticed.
   */
  const { map } = await texts();
  assert.ok(map.length > 20_000, `the master map looks truncated: ${map.length} bytes`);
  assert.match(map, /no narrower roadmap may silently remove a requirement/i,
    'the rule this gate enforces must still be stated in the map itself');
  assert.ok(rpcNames(map).length >= 30, 'the RPC surface must still be defined');
  const matrix = map.split('## 7.')[1]?.split('## 8.')[0] ?? '';
  const rows = (matrix.match(/^\| .+ \| .+ \|$/gm) || []).length;
  assert.ok(rows >= 30, `the failure-injection matrix must still be present, found ${rows} rows`);
});

test('RATCHET: the roadmap may not drop more of the map than it already has', async () => {
  const { map, roadmap } = await texts();
  const absent = rpcNames(map).filter((n) => !roadmap.includes(n));
  assert.ok(absent.length <= BASELINE.rpcsAbsent,
    `roadmap now omits ${absent.length} RPCs, baseline ${BASELINE.rpcsAbsent}. ` +
    `A narrower roadmap may not silently shed more of the map.\nNewly absent: ${absent.join(', ')}`);
  if (absent.length < BASELINE.rpcsAbsent) {
    // A baseline only ever goes down, and going down is the point.
    console.log(`  note: RPC coverage improved — lower BASELINE.rpcsAbsent to ${absent.length}`);
  }
});

test('RATCHET: table coverage, same rule', async () => {
  const { map, roadmap } = await texts();
  const tables = [...new Set([...map.matchAll(/^([a-z_]{5,})\n/gm)].map((m) => m[1]))];
  const absent = tables.filter((t) => !roadmap.includes(t));
  assert.ok(absent.length <= BASELINE.tablesAbsent,
    `roadmap now omits ${absent.length} tables, baseline ${BASELINE.tablesAbsent}.\nNewly absent: ${absent.join(', ')}`);
});

test('the roadmap declares the master map as its parent', async () => {
  /*
   * Without this, a reader who opens ROADMAP.md first has no way to learn that
   * a larger specification exists — which is precisely how the requirements got
   * lost the first time.
   */
  const { roadmap } = await texts();
  assert.match(roadmap, /AGENTBRIDGE_MASTER_BUILD_MAP/,
    'ROADMAP.md must name the master map as its parent, by filename');
  assert.match(roadmap, /not the complete definition|parent|subordinate/i,
    'and must say plainly that it is the narrower document');
});
