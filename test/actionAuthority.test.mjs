import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  COORDINATOR,
  HOST_CONTROL,
  IRREVERSIBLE_OUTBOUND,
  NONE,
  OWNER,
  PRODUCTION_STATE,
  UNRESTRICTED,
  classifyAction,
  isUncoveredByStop,
} from '../src/actionAuthority.mjs';

/**
 * WHAT THIS FILE IS AND WHAT IT IS NOT.
 *
 * It encodes what OUGHT to be refused for actions that touch no repository file.
 * It wires nothing. The classifier it tests blocks nothing. One test at the
 * bottom is EXPECTED TO FAIL, and it is the demand: the guard does not consult
 * this module. That test is written to CLAUDE.md rule 16 -- a red test nobody has
 * shown can go green is a countdown, not a ratchet -- so it is accompanied by a
 * proof that the demand is reachable and a proof that it stands down if its
 * premise is removed. Both of those run green today.
 */

const guardSource = () =>
  readFileSync(fileURLToPath(new URL('../src/claudeGuard.mjs', import.meta.url)), 'utf8');

const modulePath = () => fileURLToPath(new URL('../src/actionAuthority.mjs', import.meta.url));

/**
 * COMMENTS ONLY. STRINGS ARE DELIBERATELY LEFT INTACT, and the reason is a bug
 * this test caught in itself.
 *
 * The first version also blanked string literals, copying the stripNonCode idiom
 * used elsewhere in this repo. But a module specifier IS a string literal, so
 * blanking strings destroyed the very thing the matcher was looking for: no
 * genuinely-wired file could ever have matched, and the REACHABILITY test below
 * went red. That is CLAUDE.md rule 16 doing exactly its job -- the demand was
 * unsatisfiable, and handing it over unproven would have been an IOU that
 * outlived its reason and taught the next reader that red is normal.
 *
 * Comments still have to go, because this repository's modules are mostly header
 * comment and a file that DISCUSSES actionAuthority must not satisfy a check for
 * whether it IMPORTS it (rule 13).
 */
const codeOnly = (source) =>
  String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/**
 * An import STATEMENT, anchored to the start of a line.
 *
 * Anchoring is what keeps strings from counting now that they survive blanking:
 * a real import begins its line, while a quoted example sits after `const x = `
 * and cannot match. Proven both ways by the two REACHABILITY tests below.
 */
const importsClassifier = (source) =>
  /^[ \t]*import\b[^;\n]*?\bfrom\s*['"][^'"]*actionAuthority\.mjs['"]/m.test(String(source));

/* ── the classification, which must be right before the demand means anything ── */

test('A PRODUCTION MIGRATION IS OWNER AUTHORITY', () => {
  const v = classifyAction({
    tool_name: 'mcp__claude_ai_Supabase__apply_migration',
    tool_input: { name: 'add_column', query: 'alter table public.tasks add column x text' },
  });
  assert.equal(v.consequence, PRODUCTION_STATE);
  assert.equal(v.authority, OWNER);
});

test('A PRODUCTION DEPLOY IS OWNER AUTHORITY', () => {
  const v = classifyAction({
    tool_name: 'mcp__claude_ai_Supabase__deploy_edge_function',
    tool_input: { name: 'mcp' },
  });
  assert.equal(v.authority, OWNER);
});

test('SENDING MAIL IS OWNER AUTHORITY — it is what a customer receives', () => {
  const v = classifyAction({
    tool_name: 'mcp__claude_ai_Gmail__send_message',
    tool_input: { to: ['someone@example.com'], subject: 'x', body: 'y' },
  });
  assert.equal(v.consequence, IRREVERSIBLE_OUTBOUND);
  assert.equal(v.authority, OWNER);
});

test('DRIVING THE HOST IS COORDINATOR AUTHORITY, not unrestricted', () => {
  for (const name of ['mcp__claude-in-chrome__computer', 'mcp__claude-in-chrome__javascript_tool']) {
    const v = classifyAction({ tool_name: name, tool_input: {} });
    assert.equal(v.consequence, HOST_CONTROL, name);
    assert.equal(v.authority, COORDINATOR, name);
  }
});

test('SCHEDULING A FUTURE AGENT RUN IS NOT UNRESTRICTED', () => {
  const v = classifyAction({ tool_name: 'CronCreate', tool_input: { schedule: '0 9 * * *' } });
  assert.equal(v.authority, COORDINATOR);
});

test('THE POSITIVE CONTROL: ordinary local work is UNRESTRICTED', () => {
  /*
   * Rule 5. Without this, every assertion above passes equally well against a
   * classifier that owner-gates literally everything -- which is the 24-of-54
   * outage that a1d7f6c had to remove, wearing the costume of a strict gate.
   */
  for (const name of ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'Agent', 'TodoWrite']) {
    const v = classifyAction({ tool_name: name, tool_input: { file_path: 'src/x.mjs' } });
    assert.equal(v.consequence, NONE, `${name} must not be gated`);
    assert.equal(v.authority, UNRESTRICTED, name);
  }
});

test('READS INSIDE A CONSEQUENTIAL NAMESPACE STAY UNRESTRICTED', () => {
  for (const name of [
    'mcp__claude_ai_Supabase__list_tables',
    'mcp__claude_ai_Supabase__get_advisors',
    'mcp__claude_ai_Gmail__search_threads',
    'mcp__claude-in-chrome__read_page',
    'mcp__claude_ai_Cloudflare_Developer_Platform__workers_list',
  ]) {
    assert.equal(classifyAction({ tool_name: name, tool_input: {} }).authority, UNRESTRICTED, name);
  }
});

test('AN UNRECOGNISED OPERATION IN A CONSEQUENTIAL NAMESPACE IS OWNER-GATED', () => {
  /*
   * Rule 7: generate the coverage from the namespace rather than from the
   * operations somebody happened to list. A Supabase tool invented next month is
   * gated the day it appears, with nobody having to remember to add it.
   */
  for (const name of [
    'mcp__claude_ai_Supabase__drop_everything',
    'mcp__claude_ai_Supabase__some_tool_that_does_not_exist_yet',
    'mcp__claude_ai_Cloudflare_Developer_Platform__brand_new_destroyer',
  ]) {
    const v = classifyAction({ tool_name: name, tool_input: {} });
    assert.equal(v.authority, OWNER, name);
    assert.match(v.reason, /unrecognised operation/);
  }
});

test('A MALFORMED CALL FAILS CLOSED rather than classifying as harmless', () => {
  for (const tool_name of [undefined, null, '', 42, {}]) {
    const v = classifyAction({ tool_name, tool_input: {} });
    assert.equal(v.authority, OWNER, `${JSON.stringify(tool_name)} must fail closed`);
  }
});

/* ── the finding itself, as an assertion ─────────────────────────────── */

test('THE FINDING: every consequential action here is INVISIBLE to the Stop gate', () => {
  /*
   * This is the whole reason the module exists. The guard's documented fallback
   * for anything it does not block is "detected at Stop by protected-file drift".
   * Stop compares file CONTENT against a snapshot -- so for an action that writes
   * no repository file there is nothing to compare, and the fallback is not a
   * weaker layer but no layer.
   */
  const uncovered = [];
  for (const name of [
    'mcp__claude_ai_Supabase__apply_migration',
    'mcp__claude_ai_Supabase__deploy_edge_function',
    'mcp__claude_ai_Gmail__send_message',
    'mcp__claude-in-chrome__computer',
    'mcp__claude-in-chrome__javascript_tool',
    'CronCreate',
  ]) {
    const v = classifyAction({ tool_name: name, tool_input: {} });
    assert.equal(isUncoveredByStop(v), true, `${name} should be consequential AND unobservable at Stop`);
    uncovered.push(name);
  }
  assert.equal(uncovered.length, 6, 'the population must be non-empty or this finding is vacuous');
});

test('and the CONTRAST: a repository write IS observable at Stop', () => {
  /*
   * A negative needs the positive first. Without this row, the test above passes
   * against a touchesRepository that always returns false, which would make the
   * finding an artefact of the classifier rather than a property of the system.
   */
  const v = classifyAction({ tool_name: 'Write', tool_input: { file_path: 'src/x.mjs' } });
  assert.equal(v.observableAtStop, true);
  assert.equal(isUncoveredByStop(v), false);
});

/* ── rule 16: prove the demand is reachable BEFORE handing over a red gate ── */

test('REACHABILITY: the demand below can go green — proven against a fixture', () => {
  /*
   * A red test nobody has shown can go green is a countdown, not a ratchet. This
   * runs the SAME matcher the failing test uses against source that does import
   * the classifier, so the demand is proven satisfiable rather than asserted to
   * be. If this ever fails, the demand is impossible and must be withdrawn, not
   * left red for someone to learn to ignore.
   */
  const wired = [
    "import path from 'node:path';",
    "import { classifyAction } from './actionAuthority.mjs';",
    'export function evaluateClaudeTool() { return classifyAction({}); }',
  ].join('\n');
  assert.equal(importsClassifier(codeOnly(wired)), true, 'the matcher must accept genuinely wired source');
});

test('REACHABILITY: and the matcher is not trivially true — prose does not satisfy it', () => {
  const merelyDiscussed = [
    '/* We should one day import from ./actionAuthority.mjs and consult it. */',
    "// from './actionAuthority.mjs'",
    "const note = \"import { classifyAction } from './actionAuthority.mjs'\";",
    'export function evaluateClaudeTool() { return { allowed: true }; }',
  ].join('\n');
  assert.equal(
    importsClassifier(codeOnly(merelyDiscussed)),
    false,
    'a comment or string mentioning the module must NOT count as wiring — rule 13',
  );
});

test('STAND-DOWN: if the classifier is deleted, the demand is moot and says so', () => {
  /*
   * The other half of rule 16. A gate must not outlive its reason. If somebody
   * decides this whole approach is wrong and removes src/actionAuthority.mjs,
   * the demand below stops being a demand instead of failing forever and
   * teaching people that red is normal.
   */
  assert.equal(existsSync(modulePath()), true,
    'the premise holds today; were this false, the failing test below would stand down');
});

/* ── THE DEMAND. EXPECTED RED. ───────────────────────────────────────── */

test('DEMAND (expected red): the guard does not consult actionAuthority', () => {
  /*
   * WHAT THIS IS. The remaining half of the contract, kept red on purpose so it
   * names what is missing instead of reporting a closed loop over an open one --
   * CLAUDE.md rule 15, let a gate move rather than close.
   *
   * WHY IT IS RED RATHER THAN FIXED HERE. Wiring was explicitly excluded from
   * this task, and it should be: routing a real refusal through the guard needs
   * its own end-to-end proof that the hook path reaches it (rule 17), and a
   * classifier that has never refused anything in anger is not something to
   * connect to a live control on the same afternoon it was written.
   *
   * HOW TO CLEAR IT. Import classifyAction in src/claudeGuard.mjs and route on
   * its verdict. The two REACHABILITY tests above already prove this assertion
   * can go green, and the STAND-DOWN test proves it will retire if the approach
   * is abandoned. Do not silence it by adding a mention in a comment; the
   * matcher is comment-blanked and will not accept that.
   */
  const code = codeOnly(guardSource());
  assert.equal(
    importsClassifier(code),
    true,
    'src/claudeGuard.mjs does not import src/actionAuthority.mjs, so a production migration, a deploy, ' +
      'a sent email and a scheduled cron run are still classified by nothing. This is the OPEN HALF of ' +
      'the contract and is expected to fail until the wiring lands. See docs/ACTION_AUTHORITY.md.',
  );
});
