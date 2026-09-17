import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * A DEPLOYED VERSION NUMBER IN PROSE IS A CLOCK THAT ONLY TELLS YESTERDAY.
 *
 * Measured 2026-09-17, with live at v26:
 *
 *   docs/SITMAP.md    "deployed edge function | **still v20**"
 *   docs/ORDER.md     "/task and /renew are in the deployed version 20 right now"
 *
 * Six versions stale. SITMAP's line also named an assignee dark for hours and
 * an authorisation superseded twice. Nobody lied; somebody wrote a true
 * sentence and production moved six times underneath it.
 *
 * WHY THIS GATE AND NOT A BIGGER ONE. The obvious instinct is to lint every
 * claim of state, and I tried: test/doneClaims.test.mjs matches a FORMAT --
 * `**N. ~~thing~~ DONE` -- and across every document in this repository it sees
 * four claims, while ORDER.md alone carries thirty-seven state-ish lines. The
 * two stale versions above are a table cell and a sentence, so it saw neither.
 * Widening the regex chases an infinite set: prose has infinite shapes and you
 * cannot lint it for truth.
 *
 * SO LINT THE VALUE, NOT THE SENTENCE. A present-tense deployed-version literal
 * is mechanically findable no matter how the sentence is phrased, because the
 * rot is in the NUMBER. This gate forbids the number outright rather than
 * requiring it to be right -- "keep it updated" is what failed, twice, and
 * would fail again the next time somebody deploys without editing two markdown
 * files.
 *
 * HISTORY IS NOT A CLAIM AND IS ALLOWED. "version 20 shipped the outage fix"
 * is a statement about the past and stays true forever. Only the present tense
 * rots, so only the present tense is matched: still vN, currently vN, deployed
 * version N right now, vN is live.
 */

/** Present tense only. Past tense is history and history does not go stale. */
const PRESENT_TENSE_VERSION = [
  /\bstill\s+v(\d+)/i,
  /\bcurrently\s+v(\d+)/i,
  /\bdeployed\s+version\s+(\d+)\s+right now/i,
  /\bv(\d+)\s+is\s+(?:currently\s+)?live\b/i,
  /\blive\s+is\s+(?:still\s+)?v(\d+)/i,
];

async function docFiles() {
  const out = [];
  for (const name of await readdir(new URL('../docs/', import.meta.url))) {
    if (name.endsWith('.md')) out.push([`docs/${name}`, new URL(`../docs/${name}`, import.meta.url)]);
  }
  for (const name of ['CLAUDE.md', 'README.md', 'ARCHITECTURE.md', 'THREAT_MODEL.md', 'INSTALL.md']) {
    out.push([name, new URL(`../${name}`, import.meta.url)]);
  }
  return out;
}

test('no document states the CURRENT deployed version — that number rots', async () => {
  const hits = [];
  for (const [label, url] of await docFiles()) {
    let text;
    try { text = await readFile(url, 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      for (const rx of PRESENT_TENSE_VERSION) {
        if (rx.test(line)) hits.push(`${label}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(hits, [],
    'point at deploy/last-deployment.json or `agentbridge-deploy-check`, do not write the number down');
});

test('CONTROL: the gate really does fire on the shapes that went stale', () => {
  /*
   * Without this the test above passes against a regex that matches nothing,
   * which is exactly where a just-narrowed matcher hides. These are the two
   * real lines, verbatim in shape.
   */
  const real = [
    '| deployed edge function | **still v20** — Danny authorised a deploy at 08:18Z |',
    '`/task` and `/renew` are in the deployed version 20 right now, with `/dispatch`,',
    'live is still v20',
    'v20 is live',
  ];
  for (const line of real) {
    assert.ok(PRESENT_TENSE_VERSION.some((rx) => rx.test(line)), `must catch: ${line}`);
  }
});

test('CONTROL: history is left alone, or the gate fires on correct writing', () => {
  const history = [
    'version 17 and stopped being true when version 20 shipped the outage fix',
    'Version 20 is byte-identical to `origin/code-b/fifth-hosted-path` at `bb899fc`',
    'Version 22 was deployed by code-d, not by Danny from a desktop checkout',
    'version 23 shipped nothing, because it ran from a checkout without the branch',
  ];
  for (const line of history) {
    assert.equal(PRESENT_TENSE_VERSION.some((rx) => rx.test(line)), false,
      `must NOT fire on history: ${line}`);
  }
});
