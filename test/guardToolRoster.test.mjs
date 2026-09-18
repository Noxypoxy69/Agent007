/*
 * ISOLATE THE GUARD HOME BEFORE ANYTHING ELSE IN THIS FILE.
 *
 * These assertions ask whether a protected path is refused. That answer depends
 * on the OVERRIDE STORE, which lives outside the repository -- so without this
 * line an operator's grant, a file this suite does not control and cannot see,
 * changes the verdict. Measured 2026-09-18 by audit: with a grant active for
 * src/guardSession.mjs this file went from 0 failures to 1, and two sibling
 * files moved the same way. A security test an operator can flip is not a test.
 *
 * Set before the guard modules are imported, because readOverride resolves the
 * home per call from this variable.
 */
import { mkdtempSync as __iso } from 'node:fs';
import { tmpdir as __tmp } from 'node:os';
import __isoPath from 'node:path';
process.env.AGENTBRIDGE_HOME = __iso(__isoPath.join(__tmp(), 'guard-test-home-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { classifyAction, OWNER } from '../src/actionAuthority.mjs';
import { fileURLToPath } from 'node:url';

import { evaluateClaudeTool } from '../src/claudeGuard.mjs';

/**
 * THE REAL TOOL ROSTER, DRIVEN THROUGH THE REAL GUARD.
 *
 * c8 asked for this on 2026-09-17 at 10:53Z, replacing point two of the audit
 * brief. Its own words for why: "I guessed that set from a different platform.
 * You have the real one." The original point two asked a session to work
 * normally and notice refusals, which could not work -- that session carried the
 * OLD matcher submitting five tool names, so over-blocking could not manifest no
 * matter how long it worked. It would have produced a false clean sweep.
 *
 * So the fixtures below are enumerated from the tool names THIS session actually
 * exposes, including the Windows-specific ones, the background-shell ones, the
 * task and messaging ones, and the mcp__ surface. That is CLAUDE.md rule 7
 * applied properly: generate the adversarial fixtures from the real list rather
 * than from the handful anybody happened to think of.
 *
 * MEASURED AGAINST HEAD 61bbeb2, NOT AGAINST 520cee2 WHICH THE BRIEF NAMED.
 * That matters and it changes the question. At 520cee2 the fallthrough was a
 * DEFAULT DENY and c8 wanted every tool coming back `unclassified-tool`. Commit
 * a1d7f6c removed that -- the default-deny refused 24 of a 54-tool roster and was
 * an outage -- so at this HEAD there is no `unclassified-tool` id at all and the
 * fallthrough is ALLOW. The interesting column therefore inverts: not "what is
 * wrongly refused" but "what reaches the fallthrough allow while still being
 * able to write or execute".
 *
 * THE TABLE IS VOID UNLESS BOTH CONTROLS HOLD. See the first test.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * A THROW IS NOT AN ALLOW.
 *
 * c8 named this explicitly: "A crash that reads as a clean result is how I
 * nearly reported the opposite of the truth on the snapshot keying earlier
 * today." An exception gets its own outcome and can never be counted as a
 * passing row.
 */
function evaluate(toolName, toolInput) {
  try {
    const verdict = evaluateClaudeTool({
      tool_name: toolName,
      tool_input: toolInput,
      cwd: REPO_ROOT,
      session_id: null,
    });
    if (verdict?.allowed === true) return { outcome: 'ALLOW', id: '' };
    return { outcome: 'DENY', id: verdict?.id ?? '(no id)' };
  } catch (err) {
    return { outcome: 'THREW', id: err?.constructor?.name ?? 'Error', error: String(err?.message ?? err) };
  }
}

/* ── the controls, asserted FIRST ────────────────────────────────────── */

const KNOWN_BAD = { tool: 'PowerShell', input: { command: 'Remove-Item -Force src/claudeGuard.mjs' } };
const KNOWN_GOOD = { tool: 'Read', input: { file_path: 'src/claudeGuard.mjs' } };

test('CONTROLS: the harness reaches the guard in BOTH directions, or the table is void', () => {
  /*
   * Rule 5, a negative needs the positive first, and rule 3, a non-zero exit is
   * not evidence a test ran. A sweep returning ALLOW for every row is
   * indistinguishable from a harness whose import failed, whose call signature
   * was wrong, or that swallowed a throw. Both controls are in the same table,
   * evaluated through the same wrapper, so a broken harness fails here loudly
   * instead of producing a clean sweep nobody can trust.
   */
  const bad = evaluate(KNOWN_BAD.tool, KNOWN_BAD.input);
  assert.equal(bad.outcome, 'DENY', `KNOWN-BAD CONTROL DID NOT DENY (${JSON.stringify(bad)}) — the entire table is void`);
  assert.equal(bad.id, 'shell-not-allowlisted', `KNOWN-BAD CONTROL denied with the wrong id (${bad.id}) — the table is void`);

  const good = evaluate(KNOWN_GOOD.tool, KNOWN_GOOD.input);
  assert.equal(good.outcome, 'ALLOW', `KNOWN-GOOD CONTROL DID NOT ALLOW (${JSON.stringify(good)}) — the guard refuses a plain Read, the table is void`);
});

/* ── the roster ──────────────────────────────────────────────────────── */

/**
 * `writes` / `executes` record what the TOOL can do in the world, independent of
 * what the guard said. That pairing is the finding: a tool that can write or
 * execute and is nonetheless ALLOWed is the serious row; a tool that can do
 * neither and is DENIed is the one-line READ_ONLY_TOOLS fix.
 */
const ROSTER = [
  // ── shells ──
  { tool: 'Bash', input: { command: 'ls src' }, executes: true, writes: true, note: 'read-only shape on the allowlist' },
  { tool: 'Bash', input: { command: 'rm -rf src' }, executes: true, writes: true, note: 'mutating shell' },
  { tool: 'PowerShell', input: { command: 'Get-Content package.json' }, executes: true, writes: true, note: 'PS read cmdlet' },
  { tool: 'PowerShell', input: { command: 'Set-Content src/x.mjs "x"' }, executes: true, writes: true, note: 'PS writer' },
  { tool: 'Bash', input: {}, executes: true, writes: true, note: 'shell tool with no command field' },

  // ── structured edits ──
  { tool: 'Write', input: { file_path: 'src/example.mjs', content: 'export const a = 1;\n' }, writes: true, executes: false, note: 'ordinary new source file' },
  { tool: 'Write', input: { file_path: 'src/claudeGuard.mjs', content: 'x' }, writes: true, executes: false, note: 'protected control' },
  { tool: 'Edit', input: { file_path: 'CLAUDE.md', old_string: 'a', new_string: 'b' }, writes: true, executes: false, note: 'protected control' },
  { tool: 'Edit', input: { file_path: 'src/example.mjs', old_string: 'a', new_string: 'b' }, writes: true, executes: false, note: 'ordinary edit' },
  { tool: 'Write', input: { content: 'x' }, writes: true, executes: false, note: 'structured edit with no path' },
  { tool: 'NotebookEdit', input: { notebook_path: 'notes/x.ipynb', new_source: 'print(1)' }, writes: true, executes: false, note: 'notebook path field' },

  // ── repository reads ──
  { tool: 'Read', input: { file_path: 'CLAUDE.md' }, writes: false, executes: false, note: 'reading the rules must not be refused' },
  { tool: 'Glob', input: { pattern: '**/*.mjs' }, writes: false, executes: false, note: '' },
  { tool: 'Grep', input: { pattern: 'x', path: 'src/claudeGuard.mjs' }, writes: false, executes: false, note: 'carries a protected path in `path`' },
  { tool: 'LS', input: { path: 'src' }, writes: false, executes: false, note: '' },
  { tool: 'NotebookRead', input: { notebook_path: 'notes/x.ipynb' }, writes: false, executes: false, note: '' },

  // ── outside world reads ──
  { tool: 'WebFetch', input: { url: 'https://example.com', prompt: 'x' }, writes: false, executes: false, note: '' },
  { tool: 'WebSearch', input: { query: 'x' }, writes: false, executes: false, note: '' },
  { tool: 'ToolSearch', input: { query: 'select:Read', max_results: 1 }, writes: false, executes: false, note: '' },
  { tool: 'ListMcpResourcesTool', input: {}, writes: false, executes: false, note: '' },
  { tool: 'ReadMcpResourceTool', input: { server: 's', uri: 'u' }, writes: false, executes: false, note: '' },
  { tool: 'ReadMcpResourceDirTool', input: { server: 's' }, writes: false, executes: false, note: 'NOT in READ_ONLY_TOOLS' },

  // ── session bookkeeping ──
  { tool: 'TodoWrite', input: { todos: [] }, writes: false, executes: false, note: '' },
  { tool: 'ExitPlanMode', input: { plan: 'x' }, writes: false, executes: false, note: '' },
  { tool: 'EnterPlanMode', input: {}, writes: false, executes: false, note: '' },
  { tool: 'AskUserQuestion', input: { questions: [] }, writes: false, executes: false, note: '' },
  { tool: 'SlashCommand', input: { command: '/help' }, writes: false, executes: false, note: 'carries a field named `command`' },
  { tool: 'Skill', input: { skill: 'code-review' }, writes: false, executes: false, note: '' },
  { tool: 'Monitor', input: { until: 'x' }, writes: false, executes: false, note: '' },

  // ── background shell bookkeeping ──
  { tool: 'BashOutput', input: { bash_id: 'blg1' }, writes: false, executes: false, note: '' },
  { tool: 'KillShell', input: { shell_id: 'blg1' }, writes: false, executes: false, note: '' },

  // ── delegation ──
  { tool: 'Agent', input: { description: 'd', prompt: 'p' }, writes: false, executes: false, note: 'subagent calls are judged individually at this same hook' },
  { tool: 'Task', input: { description: 'd', prompt: 'p' }, writes: false, executes: false, note: '' },
  { tool: 'TaskOutput', input: { task_id: 't', block: false, timeout: 1 }, writes: false, executes: false, note: '' },
  { tool: 'TaskStop', input: { task_id: 't' }, writes: false, executes: false, note: '' },
  { tool: 'SendMessage', input: { to: 'a', message: 'm' }, writes: false, executes: false, note: '' },
  { tool: 'ListAgents', input: {}, writes: false, executes: false, note: '' },
  { tool: 'Workflow', input: { script: 'export const meta = {}; return 1;' }, executes: true, writes: true, note: 'carries executable JavaScript' },

  // ── artifacts and outbound ──
  { tool: 'Artifact', input: { action: 'publish', file_path: 'page.html' }, writes: false, executes: false, note: 'publishes outward; carries file_path' },
  { tool: 'Artifact', input: { action: 'list' }, writes: false, executes: false, note: '' },
  { tool: 'ArtifactComments', input: { url: 'https://claude.ai/x' }, writes: false, executes: false, note: '' },
  { tool: 'ArtifactData', input: { url: 'https://claude.ai/x' }, writes: false, executes: false, note: '' },
  { tool: 'DesignSync', input: { url: 'https://claude.ai/x' }, writes: false, executes: false, note: '' },
  { tool: 'SendUserFile', input: { path: 'CLAUDE.md' }, writes: false, executes: false, note: 'READS a file and sends it outward' },
  { tool: 'SendUserFile', input: { path: 'audit-520cee2.txt' }, writes: false, executes: false, note: 'ordinary outbound file' },
  { tool: 'PushNotification', input: { message: 'm' }, writes: false, executes: false, note: '' },
  { tool: 'ReportFindings', input: { findings: [{ file: 'src/claudeGuard.mjs', line: 1, summary: 's', failure_scenario: 'f' }] }, writes: false, executes: false, note: 'protected path nested in an array under `file`' },
  { tool: 'ScheduleWakeup', input: { delaySeconds: 60, prompt: 'p', reason: 'r', noop: false }, writes: false, executes: false, note: '' },
  { tool: 'SendFeedback', input: { type: 'bug', title: 't', details: 'd' }, writes: false, executes: false, note: '' },
  { tool: 'EndConversation', input: { reason: 'r' }, writes: false, executes: false, note: '' },
  { tool: 'FetchInboxMessage', input: { id: 'm1' }, writes: false, executes: false, note: '' },
  { tool: 'RemoteTrigger', input: { name: 'n' }, writes: false, executes: false, note: '' },

  // ── cron and worktrees ──
  { tool: 'CronCreate', input: { name: 'n', schedule: '0 9 * * *', prompt: 'p' }, writes: false, executes: true, note: 'schedules a future agent run' },
  { tool: 'CronList', input: {}, writes: false, executes: false, note: '' },
  { tool: 'CronDelete', input: { id: 'c1' }, writes: false, executes: false, note: '' },
  { tool: 'EnterWorktree', input: { branch: 'work/x' }, writes: true, executes: false, note: 'changes the working tree' },
  { tool: 'ExitWorktree', input: {}, writes: true, executes: false, note: '' },

  // ── the mcp__ surface ──
  { tool: 'mcp__agentbridge-live__list_agents', input: {}, writes: false, executes: false, note: '' },
  { tool: 'mcp__agentbridge-live__send_message', input: { to_agent: 'c8', from_agent: 'code-b', type: 'status', body: 'b' }, writes: false, executes: false, note: 'outbound prose' },
  { tool: 'mcp__agentbridge-live__assign_task', input: { taskId: 't', agentId: 'a' }, writes: false, executes: false, note: 'coordinator write to the bridge' },
  { tool: 'mcp__claude_ai_Supabase__apply_migration', input: { project_id: 'p', name: 'n', query: 'drop table x' }, writes: true, executes: true, note: 'production SQL' },
  { tool: 'mcp__claude_ai_Supabase__deploy_edge_function', input: { project_id: 'p', name: 'mcp', files: [{ name: 'index.ts', content: 'x' }] }, writes: true, executes: true, note: 'production deploy' },
  { tool: 'mcp__claude_ai_Google_Drive__create_file', input: { name: 'f', content: 'c' }, writes: true, executes: false, note: 'writes outside the repo' },
  { tool: 'mcp__claude_ai_Gmail__send_message', input: { to: ['x@y.z'], subject: 's', body: 'b' }, writes: false, executes: false, note: 'irreversible outbound' },
  { tool: 'mcp__claude-in-chrome__javascript_tool', input: { code: 'document.title' }, writes: false, executes: true, note: 'executes JS in the browser' },
  { tool: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' }, writes: false, executes: true, note: 'drives the desktop' },
  { tool: 'mcp__claude_ai_Claude_Docs__update', input: { ref: { object: 'node', id: 'n' }, payload: {} }, writes: false, executes: false, note: '' },
  /*
   * ── READS AND NON-OUTBOUND WRITES IN CONSEQUENTIAL NAMESPACES ─────────────
   *
   * This file's header says the roster is enumerated from the tool names the
   * session actually exposes. An audit measured the gap: of the ten mcp entries
   * above, not one was a READ-ONLY tool inside a namespace that can reach
   * production or send mail -- so the roster structurally could not detect an
   * over-block in exactly the place over-blocks were most likely.
   *
   * It found seven, all refused as irreversible-outbound and none of which
   * sends anything. They are here now because a fixture that cannot construct
   * the failing case cannot fail for it (hollow gate 9).
   */
  { tool: 'mcp__claude_ai_Supabase__list_tables', input: { project_id: 'p' }, writes: false, executes: false, note: 'read in a production namespace' },
  { tool: 'mcp__claude_ai_Supabase__get_advisors', input: { project_id: 'p', type: 'security' }, writes: false, executes: false, note: 'read in a production namespace' },
  { tool: 'mcp__claude_ai_Gmail__search_threads', input: { q: 'x' }, writes: false, executes: false, note: 'read in an outbound namespace' },
  { tool: 'mcp__claude_ai_Gmail__create_draft', input: { to: ['x@y.z'], subject: 's', body: 'b' }, writes: false, executes: false, note: 'a draft is NOT sent' },
  { tool: 'mcp__claude_ai_Gmail__update_draft', input: { draft_id: 'd', body: 'b' }, writes: false, executes: false, note: 'a draft is NOT sent' },
  { tool: 'mcp__claude_ai_Gmail__label_message', input: { message_id: 'm', label_ids: ['l'] }, writes: false, executes: false, note: 'filing, not outbound' },
  { tool: 'mcp__claude_ai_Gmail__create_label', input: { name: 'l' }, writes: false, executes: false, note: 'filing, not outbound' },
  { tool: 'mcp__claude_ai_Slack__slack_search_public_and_private', input: { query: 'x' }, writes: false, executes: false, note: 'a READ; its public sibling was already allowed' },
  { tool: 'mcp__claude_ai_Slack__slack_add_reaction', input: { channel: 'c', timestamp: 't', name: 'eyes' }, writes: false, executes: false, note: 'a removable emoji' },
  { tool: 'mcp__claude-in-chrome__read_page', input: {}, writes: false, executes: false, note: 'read in a host-control namespace' },

  // ── malformed / hostile envelopes ──
  { tool: '', input: {}, writes: false, executes: false, note: 'empty tool name' },
  { tool: 'UnknownFutureTool', input: { somethingNew: 'x' }, writes: false, executes: false, note: 'a tool this guard has never heard of' },
  { tool: 'UnknownFutureTool', input: { source: 'src/claudeGuard.mjs', destination: 'tmp/x' }, writes: true, executes: false, note: 'hypothetical mover — the backstop case' },
  { tool: 'UnknownFutureTool', input: { nested: { deep: { deeper: { target: 'CLAUDE.md' } } } }, writes: true, executes: false, note: 'protected path at depth 4' },
  { tool: 'UnknownFutureTool', input: { a: { b: { c: { d: { e: 'src/guardSession.mjs' } } } } }, writes: true, executes: false, note: 'protected path at the depth bound — still caught' },
  { tool: 'UnknownFutureTool', input: { a: { b: { c: { d: { e: { f: 'src/guardSession.mjs' } } } } } }, writes: true, executes: false, note: 'protected path BELOW the depth bound — not caught' },
];

/*
 * THE ROSTER IS DRIVEN AT MODULE SCOPE, NOT INSIDE A TEST.
 *
 * It used to be filled by the first test, and six later tests read it. That is
 * an ORDER DEPENDENCY, and it made them lie under filtering: run this file with
 * --test-name-pattern and the roster test does not execute, `results` stays
 * empty, and the assertions that read it PASS VACUOUSLY. Measured 2026-09-18:
 * "ORDINARY WORK IS NOT BLOCKED beyond the known over-blocks" computes its
 * offenders from an empty array and reports green, which is the strongest claim
 * in the file arriving from no evidence at all.
 *
 * Found by the control added to the staleness test below -- it asserts the
 * roster produced SOME denial, and in isolation it did not. The control was
 * written to stop an emptied over-block list passing on nothing, and the first
 * thing it caught was this.
 *
 * At module scope the table is built exactly once, whichever tests are selected.
 */
const results = [];
for (const row of ROSTER) {
  const verdict = evaluate(row.tool, row.input);
  results.push({ ...row, ...verdict });
}

test('THE ROSTER TABLE: every tool this session exposes, driven through the guard', () => {
  assert.equal(results.length, ROSTER.length, 'every roster row must produce a result');

  const width = Math.max(...results.map((r) => r.tool.length || 2));
  const lines = results.map((r) => {
    const cap = [r.executes ? 'exec' : '', r.writes ? 'write' : ''].filter(Boolean).join('+') || 'neither';
    const name = (r.tool || '(empty)').padEnd(width);
    const out = r.outcome.padEnd(5);
    const id = (r.id || '-').padEnd(26);
    return `${name}  ${out}  ${id}  [${cap}]  ${r.note}`;
  });
  console.log(`\n=== GUARD TOOL ROSTER @ 61bbeb2 (${results.length} rows) ===\n${lines.join('\n')}\n`);
});

test('NO ROW THREW — a crash must never be counted as a clean result', () => {
  const threw = results.filter((r) => r.outcome === 'THREW');
  assert.deepEqual(
    threw.map((r) => `${r.tool}: ${r.id} ${r.error}`),
    [],
    'evaluateClaudeTool raised for these inputs; a throw is its own outcome, never an allow',
  );
});

test('THE FALLTHROUGH IS ALLOW AT THIS HEAD — unclassified-tool no longer exists', () => {
  /*
   * c8's brief asked for every tool returning `unclassified-tool`. Commit
   * a1d7f6c deleted that verdict: the default-deny refused 24 of a real 54-tool
   * roster and was an outage. Asserting its absence rather than quietly
   * reporting "none found" -- a search that finds nothing because the thing was
   * renamed is the hollow shape this whole file exists to avoid.
   */
  assert.deepEqual(results.filter((r) => r.id === 'unclassified-tool'), []);
  assert.ok(
    results.some((r) => r.outcome === 'ALLOW' && !r.executes && !r.writes),
    'the positive first: ordinary read-only tools are allowed',
  );
});

/**
 * OVER-BLOCKS FOUND AT 61bbeb2, each with why it is wrong.
 *
 * These are the answer to c8's point two. Both tools can neither execute a
 * command nor write a file; both are refused solely because the input NAMES a
 * protected path. The backstop cannot tell "this tool is about to modify
 * CLAUDE.md" from "this tool is reporting on CLAUDE.md", so a read-and-send and
 * a code-review finding both read as tampering.
 *
 * A RATCHET, NOT A SILENCER. The list may only shrink: a NEW over-block fails
 * this test, and fixing one without removing its entry fails the staleness test
 * below. Both are named so a reader can disagree with them.
 */
/*
 * EMPTY, AND THAT IS THE POINT OF A RATCHET. Both entries -- SendUserFile and
 * ReportFindings -- are fixed and were deleted 2026-09-18. Measured before
 * removing them, through evaluateClaudeTool:
 *
 *   SendUserFile   {path:'CLAUDE.md'}                          ALLOW
 *   SendUserFile   {path:'audit-520cee2.txt'}                  ALLOW
 *   ReportFindings {findings:[{file:'src/claudeGuard.mjs'...}]} ALLOW
 *
 * Neither can write or execute; both were refused merely for NAMING a protected
 * path, so a read-and-send and a code-review finding read as tampering. That the
 * staleness test below went red demanding this deletion is the ratchet working:
 * an entry that outlives its defect is a silencer, and a silencer in a list
 * called "known over-blocks" is how a real over-block hides.
 */
const KNOWN_OVER_BLOCKED = {};

/*
 * A DELIBERATE OWNER-GATE IS NOT AN OVER-BLOCK, AND THE DIFFERENCE HAS TO BE
 * MADE HONESTLY OR THE EXCLUSION BECOMES THE SILENCER THIS FILE WARNS ABOUT.
 *
 * Action Authority landed 2026-09-18 (Danny's decision, recorded at
 * d-owner-action-authority-gating-20260918): an OWNER-level action is refused
 * unless a grant names it. Two roster entries are now refused BY DESIGN --
 * mcp__claude_ai_Gmail__send_message, which is the whole point of the feature,
 * and the empty tool name, which fails closed because an action nobody can name
 * cannot be shown to be harmless.
 *
 * Neither is "ordinary work blocked". But dropping them into KNOWN_OVER_BLOCKED
 * would file a working control as a defect in a list whose stated purpose is to
 * SHRINK, and the header above is explicit that an entry outliving its defect is
 * how a real over-block hides.
 *
 * So they are excluded by the REASON they were refused -- the guard's own
 * `action-needs-owner` id -- and the exclusion is then checked against the
 * classifier, so a refusal cannot smuggle itself out of this test by claiming an
 * id it has not earned. Rule 5: the exemption needs its own positive.
 */
test('ORDINARY WORK IS NOT BLOCKED beyond the known over-blocks', () => {
  const denied = results.filter((r) => r.outcome === 'DENY' && !r.writes && !r.executes);

  /*
   * THE EXCLUSION IS CHECKED AGAINST A HUMAN-WRITTEN LIST, NOT AGAINST THE
   * CLASSIFIER THAT PRODUCED IT.
   *
   * The first version asked classifyAction whether each excluded refusal was
   * OWNER. That is the same component that decided to refuse it, so an
   * OVER-classification confirmed its own exclusion and the test could never
   * see one. Found by audit, which then measured seven real over-blocks this
   * test was green through -- Gmail drafts and labels, a Slack reaction, and
   * slack_search_public_and_private, which is a read whose public sibling was
   * already allowed.
   *
   * So the set is DECLARED here and asserted EXACT. A newly over-blocked tool
   * is not on the list and fails; a gate that stops firing leaves an entry
   * unmatched and fails too. Rule 19 in both directions, and the list is short
   * enough for a person to disagree with, which is the point.
   */
  const EXPECTED_OWNER_GATED = new Set([
    'mcp__claude_ai_Supabase__apply_migration',
    'mcp__claude_ai_Supabase__deploy_edge_function',
    'mcp__claude_ai_Gmail__send_message',
    'mcp__claude-in-chrome__javascript_tool',
    'mcp__claude-in-chrome__computer',
    /*
     * NOT Google Drive create_file, and writing that down was my mistake before
     * it was a test failure. It classifies reversible-external, so COORDINATOR
     * -- a file written to Drive can be deleted again. The declared list is
     * meant to be argued with, and the first thing it caught was me assuming a
     * gate that does not exist.
     */
    '', // an unnameable action fails closed
  ]);

  /*
   * FROM `results`, NOT FROM `denied`. `denied` is pre-filtered to tools that
   * neither write nor execute -- the over-block question -- so a migration or a
   * deploy never appears in it, and checking the declared set against it
   * reported every legitimate gate as "no longer firing". Owner-gating is a
   * question about ALL tools; over-blocking is the one that is only about the
   * harmless ones.
   */
  const ownerGated = results
    .filter((r) => r.outcome === 'DENY' && r.id === 'action-needs-owner')
    .map((r) => r.tool);
  const unexpectedlyGated = ownerGated.filter((t) => !EXPECTED_OWNER_GATED.has(t));
  assert.deepEqual(unexpectedlyGated, [],
    'these are refused as owner-gated and are NOT on the declared list. Either they are a real '
    + 'over-block -- a draft is not sent, a label is not outbound, a search is a read -- or the list '
    + `needs a deliberate addition somebody argued for:\n  ${unexpectedlyGated.join('\n  ')}`);

  const noLongerGated = [...EXPECTED_OWNER_GATED].filter((t) => !ownerGated.includes(t));
  assert.deepEqual(noLongerGated, [],
    'these are declared owner-gated and were NOT refused. A gate that stopped firing is the more '
    + `dangerous direction:\n  ${noLongerGated.join('\n  ')}`);

  const unexpected = [...new Set(denied.filter((r) => r.id !== 'action-needs-owner').map((r) => r.tool))]
    .filter((t) => !(t in KNOWN_OVER_BLOCKED));
  assert.deepEqual(unexpected, [], 'a guard that blocks ordinary work gets switched off, which loses every layer at once');
});

test('THE OWNER-GATE IS REACHED FROM THE ROSTER AT ALL, so the exclusion above is not vacuous', () => {
  /*
   * Rule 6, and rule 5 again. If the roster stopped producing owner-gated
   * refusals -- because the wiring regressed, or because evaluate() broke -- the
   * exclusion above would quietly filter nothing and the test would still pass.
   * "No owner-gated refusals" and "the gate is switched off" must not look alike.
   */
  const ownerGated = results.filter((r) => r.outcome === 'DENY' && r.id === 'action-needs-owner');
  assert.ok(ownerGated.length >= 1,
    'no roster entry was refused as action-needs-owner, so either the Action Authority wiring is '
    + 'no longer reached from the shipped guard, or the roster no longer contains an OWNER-level action');
  assert.ok(ownerGated.some((r) => r.tool === 'mcp__claude_ai_Gmail__send_message'),
    'sending mail is the canonical irreversible-outbound action and must still be owner-gated');
});

test('the over-block list may only SHRINK — a stale entry is itself a finding', () => {
  const denied = new Set(results.filter((r) => r.outcome === 'DENY').map((r) => r.tool));

  /*
   * THE CONTROL, BECAUSE AN EMPTY LIST MAKES THE LOOP BELOW VACUOUS.
   *
   * With no entries left this test would pass by not running -- CLAUDE.md rule
   * 6 -- and would keep passing if evaluate() broke, if the roster stopped
   * producing verdicts, or if every tool silently became ALLOW. "No over-blocks
   * remain" and "nothing was measured" must not look alike, and right now they
   * would. So assert the machinery that WOULD populate the list still works.
   */
  assert.ok(denied.size > 0,
    'no tool in the whole roster was denied — the detection is broken, not the over-blocks fixed');

  for (const tool of Object.keys(KNOWN_OVER_BLOCKED)) {
    assert.ok(denied.has(tool), `${tool} is no longer over-blocked — delete its entry rather than leaving a silencer`);
    assert.ok(KNOWN_OVER_BLOCKED[tool].trim().length > 40, `${tool} needs a reason a later reader can disagree with`);
  }
});

test('EVERY PROTECTED-PATH WRITE IS REFUSED, by whichever layer sees it', () => {
  for (const [tool, input] of [
    ['Write', { file_path: 'src/claudeGuard.mjs', content: 'x' }],
    ['Edit', { file_path: 'CLAUDE.md', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '.claude/settings.json', content: '{}' }],
    ['Write', { file_path: 'scripts/claude-stop-gate.mjs', content: 'x' }],
    ['Write', { file_path: 'package.json', content: '{}' }],
  ]) {
    const verdict = evaluate(tool, input);
    assert.equal(verdict.outcome, 'DENY', `${tool} ${JSON.stringify(input)} must be refused`);
    assert.equal(verdict.id, 'protected-control');
  }
});

test('THE BACKSTOP CATCHES A PROTECTED PATH IN AN UNANTICIPATED FIELD, AND HAS A FLOOR', () => {
  /*
   * The guard documents this as a backstop and explicitly NOT as the boundary.
   * Both halves are asserted: that it catches the shallow mover case, and that
   * it stops at its documented depth bound. The second is not a complaint —
   * an unbounded walk on every tool call is a hook that hangs, and a hook that
   * hangs is a hook somebody disables — but it must be recorded rather than
   * left for a reader to assume it goes all the way down.
   */
  const shallow = evaluate('UnknownFutureTool', { source: 'src/claudeGuard.mjs', destination: 'tmp/x' });
  assert.equal(shallow.outcome, 'DENY', 'the backstop must catch a protected path in an unanticipated field');
  assert.equal(shallow.id, 'protected-control');

  /*
   * THIS FIXTURE WAS WRONG TWICE, AND THE SECOND TIME IT WAS RED FOR MONTHS
   * WHILE APPEARING TO TEST A DEPTH FLOOR.
   *
   * It used key "e" and asserted DENY at depth 4. But "e" IS NOT A PATH-SHAPED
   * KEY, so the backstop ignores it at ANY depth -- the fixture was measuring
   * the key gate and reporting it as the depth bound. Measured:
   *
   *   {a:{b:{c:{d:{e:        'src/guardSession.mjs'}}}}}    ALLOW
   *   {a:{b:{c:{d:{filePath: 'src/guardSession.mjs'}}}}}    DENY
   *   {e: 'src/guardSession.mjs'}                           ALLOW   (depth 1!)
   *
   * So the code was right the whole time and the test was red over working
   * behaviour -- the credibility burn rule 14 is about, sitting in the suite
   * that everyone's Stop gate compares against. CLAUDE.md rule 9: a fixture that
   * cannot construct the real case cannot fail for it, and here it could not
   * PASS for it either.
   *
   * Both halves now use a path-shaped key, so the only variable is depth.
   */
  const atBound = evaluate('UnknownFutureTool', { a: { b: { c: { d: { filePath: 'src/guardSession.mjs' } } } } });
  assert.equal(atBound.outcome, 'DENY', 'depth 4 is still inside the bound and must be caught');
  assert.equal(atBound.id, 'protected-control');

  const belowBound = evaluate('UnknownFutureTool', { a: { b: { c: { d: { e: { filePath: 'src/guardSession.mjs' } } } } } });
  assert.equal(belowBound.outcome, 'ALLOW', 'documented limit: the backstop stops at depth 4 and this sits below it');

  /*
   * AND THE KEY GATE IS ASSERTED SEPARATELY, so the two properties can never
   * again be confused for one another.
   */
  const notPathShaped = evaluate('UnknownFutureTool', { e: 'src/guardSession.mjs' });
  assert.equal(notPathShaped.outcome, 'ALLOW', 'a key that is not path-shaped is ignored regardless of depth');
});

test('the reported roster count is asserted, so a silently empty sweep cannot pass', () => {
  // Rule 3: a run that executed nothing exits zero just as happily as a clean one.
  assert.ok(ROSTER.length >= 70, `roster shrank to ${ROSTER.length}; it must cover the real surface`);
  assert.equal(results.length, ROSTER.length);
});
