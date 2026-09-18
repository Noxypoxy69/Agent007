/**
 * THE TWO toolDefs MUST AGREE ABOUT ANY TOOL THEY BOTH DEFINE.
 *
 * WHY THIS EXISTS, and it is the mechanism behind a live defect rather than a
 * tidiness rule.
 *
 * mcp/toolDefs.mjs opens with "THE TOOLS, ONCE, FOR EVERY TRANSPORT" and warns:
 * "Reimplementing is how the hosted surface and the local one start answering
 * differently about the same machine, which is the failure this whole project
 * keeps designing against." supabase/functions/mcp/_shared.js carries a SECOND,
 * larger toolDefs. So the thing that file warns about already happened.
 *
 * The cost is not hypothetical. Their read-tool descriptions are byte-identical,
 * and that is precisely HOW prose that is TRUE of the node collector -- "every
 * field is observed from git plumbing and the process table" -- arrived on the
 * hosted surface, which observes nothing and hardcodes six fields. The sentence
 * was accurate where it was written and travelled to somewhere it is false.
 * Copying kept the words in step while the stores diverged underneath them.
 *
 * test/sharedSpliceMatches.test.mjs pins src/ and bridge/ against the splice.
 * NOTHING pinned these two against each other.
 *
 * WHAT THIS DOES NOT DO. It does not demand the two files define the same SET of
 * tools -- the hosted surface legitimately carries write tools the node twin
 * does not. It demands that where both define a tool of the same name, a caller
 * gets the same promise. A divergence is either a bug or a decision; if it is a
 * decision it belongs in DECLARED below, with a reason, where a reader can
 * disagree with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { toolDefs as hostedDefs, INSTRUCTIONS as HOSTED_INSTRUCTIONS } from '../supabase/functions/mcp/_shared.js';
import { toolDefs as twinDefs, INSTRUCTIONS as TWIN_INSTRUCTIONS } from '../mcp/toolDefs.mjs';

/**
 * A store generous enough that both files build every tool they can.
 *
 * Neither is invoked here -- this compares DECLARATIONS, not behaviour -- but
 * both gate tool construction on the presence of store methods, so a thin store
 * would silently narrow the comparison and the gate would pass by covering less.
 */
function fullStore() {
  const nothing = async () => [];
  return {
    listSessions: nothing,
    getLanes: async () => ({}),
    listDelegations: nothing,
    getDelegation: nothing,
    listDecisions: nothing,
    listMessages: nothing,
    listTasks: nothing,
    listProposals: nothing,
    listPermissionRequests: nothing,
    assignTask: nothing,
    acceptTask: nothing,
    cancelTask: nothing,
    confirmProposal: nothing,
    supervisoryReport: nothing,
    sendMessage: nothing,
    recordOwnerDecision: nothing,
    decidePermissionRequest: nothing,
    submitPermissionRequest: nothing,
  };
}

const byName = (defs) => new Map(defs.map((d) => [d.name, d]));

const HOSTED = byName(hostedDefs(fullStore()));
const TWIN = byName(twinDefs(fullStore()));
const SHARED_NAMES = [...HOSTED.keys()].filter((n) => TWIN.has(n)).sort();

/**
 * Divergences that are DECIDED rather than accidental.
 *
 * Empty on purpose. An entry here is a claim that two transports should answer
 * differently about the same tool name, which needs a reason a later reader can
 * argue with -- not a place to silence a failure.
 */
const DECLARED = new Map([]);

test('THE POSITIVE FIRST: both files really did build tools', () => {
  /*
   * A parity loop over an empty intersection agrees perfectly and proves
   * nothing. This is the assertion that stops the gate passing because the
   * store was too thin to construct anything.
   */
  assert.ok(HOSTED.size >= 12, `hosted built ${HOSTED.size} tools`);
  assert.ok(TWIN.size >= 12, `twin built ${TWIN.size} tools`);
  assert.ok(SHARED_NAMES.length >= 8,
    `only ${SHARED_NAMES.length} tools are defined in both: ${SHARED_NAMES.join(', ')}`);
});

test('A TOOL DEFINED IN BOTH MAKES THE SAME PROMISE IN BOTH', () => {
  const diverged = [];
  for (const name of SHARED_NAMES) {
    if (DECLARED.has(name)) continue;
    const a = HOSTED.get(name);
    const b = TWIN.get(name);
    if (a.description !== b.description) {
      diverged.push({
        name,
        hosted: String(a.description ?? '').slice(0, 110),
        twin: String(b.description ?? '').slice(0, 110),
      });
    }
  }
  assert.deepEqual(diverged, [],
    `these tools describe themselves differently depending on which transport serves them:\n${
      diverged.map((d) => `  ${d.name}\n    hosted: ${d.hosted}\n    twin:   ${d.twin}`).join('\n')}`);
});

test('A TOOL DEFINED IN BOTH ACCEPTS THE SAME INPUT IN BOTH', () => {
  const diverged = [];
  for (const name of SHARED_NAMES) {
    if (DECLARED.has(name)) continue;
    const a = JSON.stringify(HOSTED.get(name).input ?? HOSTED.get(name).inputSchema ?? null);
    const b = JSON.stringify(TWIN.get(name).input ?? TWIN.get(name).inputSchema ?? null);
    if (a !== b) diverged.push({ name, hosted: a, twin: b });
  }
  assert.deepEqual(diverged, [],
    `these tools accept different arguments depending on which transport serves them:\n${
      diverged.map((d) => `  ${d.name}\n    hosted: ${d.hosted}\n    twin:   ${d.twin}`).join('\n')}`);
});

test('THE SENTENCE THAT TRAVELLED: INSTRUCTIONS is identical on both surfaces', () => {
  /*
   * THIS GATE PASSED THE DAY IT WAS WRITTEN, AND THAT IS THE FINDING.
   *
   * It was written expecting red. The two files' descriptions turned out to be
   * byte-identical -- which is not the absence of the defect, it IS the defect.
   * The same prose serves a store that observes git and the process table, and a
   * store that hardcodes six fields. Copying kept the words in step while the
   * stores diverged underneath them, so a gate comparing DECLARATIONS can never
   * see it. Recorded here rather than quietly dropped, because a gate whose
   * motivating defect it cannot detect is exactly the thing this repository is
   * named after, and the next reader deserves to know which property this holds.
   *
   * WHAT IT HOLDS, AND WHY THAT IS STILL WORTH HAVING. Identical prose across
   * two surfaces is only correct when it is TRUE of both. The contract already
   * contains the clause that makes that achievable -- "fields that could not be
   * determined are null, treat null as unknown, never as zero" -- and the fix
   * for the hosted store is to obey it rather than to fork the sentence. Once it
   * does, shared wording is right rather than misleading, and this is what stops
   * it drifting apart again. Until then, this pins the thing that must NOT be
   * fixed by editing one copy: forking INSTRUCTIONS per transport would make two
   * surfaces promise different things under the same tool names, which is the
   * failure mcp/toolDefs.mjs was written to prevent.
   */
  assert.equal(typeof HOSTED_INSTRUCTIONS, 'string');
  assert.ok(HOSTED_INSTRUCTIONS.length > 200, 'INSTRUCTIONS is suspiciously short');
  assert.equal(
    HOSTED_INSTRUCTIONS, TWIN_INSTRUCTIONS,
    'INSTRUCTIONS has forked between the two transports: the same tool names now '
    + 'promise different things depending on who serves them',
  );
});

test('THE CONTROL: the comparison can actually fail', () => {
  /*
   * CLAUDE.md rule 1. A parity gate that never sees a difference is green
   * whether the files agree or the comparison is broken.
   */
  const a = { name: 'x', description: 'one', input: { type: 'object' } };
  const b = { name: 'x', description: 'two', input: { type: 'object', properties: {} } };
  assert.notEqual(a.description, b.description, 'the description comparison is inert');
  assert.notEqual(JSON.stringify(a.input), JSON.stringify(b.input), 'the schema comparison is inert');
});

test('EVERY DECLARED DIVERGENCE NAMES A TOOL THAT EXISTS IN BOTH', () => {
  /*
   * A stale exemption is worse than none: it silences a name nobody is checking
   * any more, and reads as coverage. Same rule the orphan gate applies to its
   * KNOWN list -- it may only shrink.
   */
  for (const [name, reason] of DECLARED) {
    assert.ok(HOSTED.has(name) && TWIN.has(name),
      `declared divergence for ${name}, which is no longer defined in both`);
    assert.ok(typeof reason === 'string' && reason.trim().length > 20,
      `declared divergence for ${name} needs a reason a reader can disagree with`);
  }
});
