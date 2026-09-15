import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * A COMMAND THAT EXISTS BUT IS NOT IN THE HELP IS A COMMAND NOBODY HAS.
 *
 * On 2026-09-15 a peer session reported two provenance defects it could not
 * repair, both for the same stated reason: "there is no withdraw/transition
 * command on the CLI and I am not hand-editing the store the whole system
 * trusts." That reasoning was correct and the conclusion was wrong.
 * `delegation-state` had existed for days and drives provenance.transition();
 * `may-integrate` is the hard gate in front of merging delegated work. Neither
 * appeared in HELP, so neither existed as far as any operator was concerned.
 *
 * The cost is not a typo. A second, duplicate contract for the same hole sat
 * open because the one person who spotted it believed the tool could not close
 * it -- which is the exact confusion the delegation ledger exists to prevent,
 * reintroduced by a missing line of documentation.
 *
 * This is a different bug class from the orphaned guards this project keeps
 * finding. Those had no call site. These had a call site and no DOOR: reachable
 * by the machine, invisible to the human. Both end the same way -- a control
 * that is not applied -- so both get a check.
 *
 * WHY PARSE THE DISPATCH RATHER THAN KEEP A LIST. A hand-maintained list of
 * commands is a third place to forget, and the failure it is guarding against
 * IS forgetting. The dispatch is the truth: if the CLI answers to a name, that
 * name is a command.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge.mjs', import.meta.url));

/**
 * Every name the dispatch compares `cmd` against.
 *
 * Deliberately a source parse, not an import: the command names only exist as
 * string literals inside main(), and running the file runs the CLI.
 */
async function dispatchedCommands() {
  const src = await readFile(CLI, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/cmd === '([a-z][a-z0-9-]*)'/g)) names.add(m[1]);
  return [...names].sort();
}

function help() {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, 'help'], { windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => resolve(`${stdout}${stderr}`));
  });
}

test('the dispatch is not empty — this test can actually see the commands', async () => {
  // A regex that matched nothing would make every assertion below vacuous and
  // the suite would pass loudest exactly when it had stopped looking.
  const cmds = await dispatchedCommands();
  assert.ok(cmds.length >= 10, `only found ${cmds.length} commands: ${cmds.join(', ')}`);
  // Anchor on commands that must always be there, so a refactor that renames
  // the dispatch variable fails here rather than silently finding zero.
  for (const known of ['delegate', 'delegations', 'status', 'workers']) {
    assert.ok(cmds.includes(known), `dispatch parse missed a known command: ${known}`);
  }
});

test('every dispatched command appears in the help text', async () => {
  const cmds = await dispatchedCommands();
  const text = await help();

  // `help` itself is the door, not a thing behind it.
  const exempt = new Set(['help']);

  const undocumented = cmds
    .filter((c) => !exempt.has(c))
    .filter((c) => !new RegExp(`agentbridge ${c}\\b`).test(text));

  assert.deepEqual(
    undocumented, [],
    `these commands run but are invisible to an operator reading --help:\n  ${undocumented.join('\n  ')}\n`
    + 'Add each to HELP in bin/agentbridge.mjs. A control nobody can find is not a control.',
  );
});

test('help lists nothing the dispatch will not answer to', async () => {
  // The other direction, and the one that rots quietly: a command removed in a
  // refactor leaves its help line behind, and an operator follows documentation
  // into "unknown command". Advertising a control that is gone is worse than
  // never advertising it, because it is trusted.
  const cmds = new Set(await dispatchedCommands());
  const text = await help();

  const advertised = [...text.matchAll(/^\s{2}agentbridge ([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
  const phantom = [...new Set(advertised)].filter((c) => !cmds.has(c) && c !== 'help');

  assert.deepEqual(
    phantom, [],
    `help advertises commands the CLI does not implement: ${phantom.join(', ')}`,
  );
});
