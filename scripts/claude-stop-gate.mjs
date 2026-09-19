#!/usr/bin/env node
/**
 * THE STOP GATE. Compares against the SESSION SNAPSHOT, never against HEAD.
 *
 * The first version audited `git diff --name-only HEAD -- <protected>`, which a
 * commit hides. Demonstrated: write the stop gate, `git commit -am wip`, and the
 * gate approved everything. Content against a pre-session snapshot cannot be
 * hidden that way, and it also catches writes that never reached PreToolUse at
 * all -- an MCP repository write, a subagent, a wrapper script. Those are NOT
 * prevented; they are detected here, which is the only claim made for them.
 *
 * FAILS CLOSED on a missing or unreadable snapshot, because "nobody knows" is
 * not "nothing changed".
 */
/*
 * NOTHING DETACHED, AND NOTHING SPAWNED BY PATH. When no result exists and none
 * is in flight the gate awaits `runVerification` from src/, which the import
 * closure can see. A detached child inherited the gate's cwd and held it open,
 * failing cleanup in every test that runs the gate against a temp fixture; a
 * child spawned by filename was invisible to the fixtures that build a repo
 * from the hooks' imports. See the START branch.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  readSnapshot, protectedDrift, baselineTestDrift, discoverTests, writeSnapshot, overrideCovers,
  isGateSelfConfig, gateConfigArms, selfConfigHeadline, settingsAddsOnly,
} from '../src/guardSession.mjs';
// git is asked whether a drifted control is committed; see isCommittedWork.
// Through safeGit, because this gate shells out inside a repository whose own
// config it is trying to judge.
import { runGit } from '../src/safeGit.mjs';

/*
 * BEING KILLED IS A SILENT ALLOW, SO THE HOOK DEADLINE IS PART OF THIS GATE'S JOB.
 *
 * Claude Code "cancels a `command`, `http`, or `mcp_tool` hook that reaches its
 * `timeout`, discarding the hook's output, so on most events a timed-out hook
 * renders no decision" (hooks reference, verbatim). The two events it names as
 * exceptions are PreModelSwitch, where a cancelled hook DOES block, and
 * PreToolUse, where it explicitly does not. Stop is neither. This gate blocks
 * only by RENDERING a decision, so a run that is killed does not refuse -- it
 * says nothing, and nothing ends the turn approved.
 *
 * Same shape as the unloadable guard at the top of
 * bin/agentbridge-claude-guard.mjs: the control fails to ABSENCE, and absence
 * reads as consent. It costs more than one hook, because three layers delegate
 * here -- src/shellAllowlist.mjs ("SO THE BOUNDARY IS NOT HERE. It is the Stop
 * gate") and src/claudeGuard.mjs twice, for every `mcp__` tool and every tool it
 * cannot classify. Silence this and all three go silent with it, and silencing
 * it needs no exploit: it needs a slow machine.
 *
 * WHAT WAS WRONG. The hook allowed 190s and the spawnSync below took up to 180s
 * of it as a CONSTANT. Nothing related the two numbers -- not a check, not a
 * comment -- so ~10s was left for node startup, hashing every protected file and
 * every baseline test, recursive discovery, and stopping the suite. Measured
 * healthy on the operator's machine: ~0.4s. The margin held by roughly twenty
 * times, by coincidence, with neither number aware of the other, and nothing
 * anywhere would have noticed either one moving.
 *
 * SO THE BUDGET IS READ FROM THE DECLARATION CLAUDE CODE KILLS BY, and the suite
 * is given the time actually LEFT rather than a constant. The gate now stops the
 * suite itself and refuses, in time for the refusal to be read.
 *
 * THE RESIDUAL, NAMED RATHER THAN IMPLIED. Everything before the spawn is
 * synchronous, so no in-process timer can interrupt it: if hashing alone ever
 * outran the whole budget, this process would still be killed mid-hash and still
 * fail open. Closing that needs a watchdog outside this process, which is a
 * different change with its own blast radius. What is closed here is the part
 * that takes minutes -- the suite -- and the part that was unbounded: a child
 * that would not die.
 */

/** Claude Code's documented default for a `command` hook that declares no timeout. */
const DEFAULT_COMMAND_HOOK_TIMEOUT_S = 600;

/*
 * Held back from the suite for stopping it and writing the refusal. Deliberately
 * generous: the run that needs this reserve is by definition on a machine too
 * slow to finish the suite, so a reserve sized for a healthy machine would be
 * spent by the one case it exists for.
 */
const OUTPUT_RESERVE_MS = 10_000;

/*
 * Below this a run cannot reach a TAP summary, so the only outcome left is a
 * refusal. Starting one anyway spends what remains of the budget and arrives at
 * the same refusal later -- possibly too late for anyone to read it.
 */
const MIN_SUITE_MS = 5_000;

/*
 * What the suite gets when NO hook deadline can be established. That is not the
 * "absent is not zero" case: an unreadable Stop entry also describes this script
 * being run by hand or from a harness, where nothing is going to kill it, and
 * refusing those would rebuild the dead end test/stopGateRecovery.test.mjs
 * exists to prevent. The loss is named instead: in that state this gate is
 * exactly as good as it was before the deadline existed, and no better.
 */
const UNDECLARED_SUITE_MS = 180_000;

/**
 * The time this process has before Claude Code kills it, read from the SAME
 * declarations Claude Code kills by.
 *
 * A constant here would be a second copy of a number owned by settings.json, and
 * two copies drifting apart IS the bug. Reading it means the hook timeout is
 * changed in one place and this gate follows; there is no second number to keep
 * in sync, and no margin held by coincidence.
 *
 * TRUSTING THIS FILE IS SAFE, AND IT IS WORTH SAYING WHY, because a control
 * reading its own limits out of an editable file usually is not. A session that
 * raised the declared timeout could make this gate believe it had hours while
 * Claude Code still killed it at 190s -- the silent allow, bought with one JSON
 * edit. It cannot: `.claude/` is a PROTECTED PREFIX, so an edit to it during the
 * session is protected-control drift, and the drift check above has already
 * blocked and exited before this function is ever consulted.
 *
 * THAT ARGUMENT WAS FALSIFIED FOR A WHILE AND IS TRUE AGAIN, WHICH IS WORTH
 * RECORDING RATHER THAN QUIETLY RESTORING. The override channel added a filter
 * that moved granted drift out of the blocking path, so a grant naming
 * .claude/settings.json let execution reach this function and read a timeout the
 * granted edit had chosen -- measured at 99999, and the gate did not block. The
 * comment above stayed true-looking and stopped being true. GATE_SELF_CONFIG now
 * excludes this gate's own configuration from override suppression, so the
 * sentence holds again. A control that reads its own limits from a file has to
 * re-check that argument every time something new can write that file.
 *
 * THE SMALLEST DECLARATION WINS, not the first one found. Claude Code merges
 * project and local settings, so this script can be registered more than once --
 * and several registrations mean several killers, of which the EARLIEST governs.
 * Taking the largest, or the first, would be borrowing time from a killer that
 * is not the one about to fire.
 *
 * RESIDUAL, NAMED: a registration in user-level or managed settings lives
 * outside this repository and is not read here. If one exists with a shorter
 * timeout, this gate is back to a margin it cannot see -- which is why the
 * refusal messages below always print the budget and where it came from, so a
 * surprise is diagnosable from the block itself rather than from a guess.
 *
 * Returns null for "no deadline could be established", which is not the same
 * claim as "no deadline exists".
 */
function hookBudget(root) {
  let best = null;
  for (const name of ['settings.json', 'settings.local.json']) {
    let settings;
    try {
      settings = JSON.parse(readFileSync(path.join(root, '.claude', name), 'utf8'));
    } catch { continue; }
    for (const group of Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        /*
         * Matched by the script this file IS, not by position. A different Stop
         * hook with a longer timeout must not be mistaken for this one.
         */
        if (typeof hook?.command !== 'string' || !hook.command.includes('claude-stop-gate')) continue;
        const declared = Number(hook.timeout);
        const found = Number.isFinite(declared) && declared > 0
          ? { ms: declared * 1000, source: `.claude/${name}, timeout ${declared}s` }
          : {
            ms: DEFAULT_COMMAND_HOOK_TIMEOUT_S * 1000,
            source: `.claude/${name} declares no timeout, so Claude Code's ${DEFAULT_COMMAND_HOOK_TIMEOUT_S}s command-hook default applies`,
          };
        if (best === null || found.ms < best.ms) best = found;
      }
    }
  }
  return best;
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try { input = JSON.parse(raw || '{}'); } catch { input = null; }

/*
 * `out` ALWAYS TERMINATES, AND A REPORT IS NOT A REFUSAL.
 *
 * The first attempt at announcing a granted change called out() with a message
 * string, which emits decision:"block" AND exits. Two things followed, both
 * measured by audit: the grant refused the turn it was meant to permit -- so
 * Blocker 1 was not fixed at this layer, only reworded -- and because out()
 * exits, a grant naming ONE path skipped the report of every OTHER drifted
 * control, skipped the baseline-test comparison, skipped test discovery and
 * skipped the entire suite run. A single narrow grant turned this gate into a
 * one-line notice that concealed arbitrary tampering. The exact inverse of the
 * property it was written to preserve.
 *
 * So a notice is carried and emitted WITH the final verdict, whatever that
 * verdict turns out to be. It never decides anything and it never short-
 * circuits the checks below it.
 */
let carriedNotice = null;
/* Set by the audit-coverage escalation; emitted after the suite, never before. */
let escalationBlock = null;
const out = (reason) => {
  const decision = reason ? { decision: 'block', reason } : {};
  /*
   * THE ESCALATION RIDES ALONG ON WHATEVER EXIT HAPPENS FIRST.
   *
   * Found by blind audit, and it is worse than the "deferred" word suggests.
   * Deferring the audit-coverage block to the end of the gate fixed one
   * outage and opened another: SIX out() calls sit between where
   * escalationBlock is assigned and where it is emitted -- zero-test-files,
   * two stop-deadline paths, test-run-failed, tap-summary-invalid and
   * tap-counts-refused. Each exits with only its own reason, and
   * auditEscalation returns notice:null when it blocks, so the rule-20
   * complaint existed in exactly one variable and that variable was dropped.
   *
   * AND IT IS NOT SEEN NEXT TURN EITHER. The retry Stop short-circuits on
   * stop_hook_active with only a systemMessage, so a turn whose suite is red
   * or over budget SKIPS the escalation entirely rather than postponing it --
   * and a red suite is precisely when somebody is most likely to push
   * unaudited work and move on.
   *
   * So it is attached here, once, rather than at six call sites: this is a
   * property of leaving the gate, not of any particular reason for leaving,
   * and patching the six would leave the seventh to whoever adds it next.
   * Skipped when the reason IS the escalation, so the final
   * out(escalationBlock) does not print itself twice.
   */
  const carry = (escalationBlock && reason !== escalationBlock)
    ? [carriedNotice, escalationBlock].filter(Boolean).join('\n')
    : carriedNotice;
  if (carry) decision.systemMessage = carry;
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  process.exit(0);
};

/*
 * ROOT AND THE ESCALATION ARE COMPUTED BEFORE THE FIRST out(), AND THAT
 * ORDERING IS THE WHOLE POINT.
 *
 * The previous commit moved the carry into out() and its message claimed
 * that closed the class structurally -- "carrying the escalation is a
 * property of LEAVING THE GATE, not of any particular reason for leaving".
 * A blind audit showed the code did not implement that sentence: out()
 * reads `escalationBlock`, and SEVEN of the thirteen out() call sites ran
 * BEFORE the line that assigns it, so they carried null.
 *
 * Two of those seven are ordinary, frequent exits, not edge cases:
 *
 *   [agentbridge:protected-control-changed]  any uncommitted edit to a
 *                                            protected file -- routine here
 *   [agentbridge:baseline-test-changed]      any edit to a baseline test
 *
 * The auditor demonstrated the same loss the previous commit quotes as the
 * defect it was fixing: a pushed unaudited rail change plus one uncommitted
 * protected-file edit produced a verdict with no audit-escaped in either
 * channel. Fixing six of thirteen while announcing the class was closed is
 * worse than the hole alone, because the next reader believes out() is the
 * single choke point and stops looking.
 *
 * So the computation moves above every exit instead. It only ASSIGNS --
 * it cannot refuse anything and has no dependency on the drift checks or
 * the suite -- so there is nothing to order it after. `root` moves up with
 * it because the escalation needs it, and because the first out() sits
 * between the two.
 *
 * THE COST IS PAID ON EVERY EXIT NOW, including fast ones: measured at
 * 0.31s for a 13-commit range against a 420s budget. That is the price of
 * the property actually holding.
 */
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/*
 * REPORT UNAUDITED CONTROL CHANGES. PRINT ONLY -- THIS CANNOT REFUSE ANYTHING.
 *
 * Rule 20 was enforced by whether the author remembered, and on 2026-09-18 the
 * author shipped twelve commits touching the guard, the rail, the grant channel
 * and this gate without one audit, during a session spent insisting on rule 20
 * to two other agents. The operator noticed; nothing in the repository did. That
 * is rule 17 pointed at rule 20 -- a control never consulted is not a control --
 * and CLAUDE.md ranks a check script above the file rule 20 lives in.
 *
 * DELIBERATELY NOT A BLOCK, and not yet. Twelve commits are outstanding as this
 * lands; refusing on them would wedge every session immediately, and a gate that
 * arrives already red teaches people to switch it off -- rule 16, a countdown
 * rather than a ratchet. It reports. Making it refuse is the owner's decision,
 * once the backlog is cleared.
 *
 * FAILS TO SILENCE, NOT TO BLOCK: any throw here is swallowed, because this
 * script has no try/catch anywhere and an uncaught error exits 1 with empty
 * stdout, which Claude Code reads as NON-BLOCKING. A reporter that could disarm
 * the gate would be worse than no reporter. Measured cost: 0.31s for a 13-commit
 * range, against a 420s budget.
 */
try {
  const { auditCoverage, auditEscalation, defaultAuditRange } = await import('../src/auditLedger.mjs');
  let ledgerText = '';
  try { ledgerText = readFileSync(path.join(root, 'docs', 'audit-ledger.jsonl'), 'utf8'); } catch { ledgerText = ''; }
  const coverage = auditCoverage({ repoRoot: root, range: defaultAuditRange(root), ledgerText });

  /*
   * UNAUDITED CONTROL WORK THAT HAS BEEN PUSHED BLOCKS; LOCAL WORK REPORTS.
   *
   * This used to append the coverage report to carriedNotice unconditionally,
   * which made it a systemMessage -- read by whoever happened to look. Rule 20
   * was therefore enforced by attention. See auditEscalation() for the full
   * account; the short version is that on the night this changed, 101 commits
   * were pushed with 13 audited and this gate had already said so in a line
   * nobody read.
   *
   * `unpushed` is null rather than empty when the question cannot be answered,
   * because an empty list would mean "everything has been pushed" and block a
   * fresh clone entirely. auditEscalation treats null as UNKNOWN and declines
   * to block on it.
   */
  let unpushed = null;
  try {
    const listed = runGit(['rev-list', '@{u}..HEAD'], { cwd: root, encoding: 'utf8' });
    unpushed = String(listed).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { unpushed = null; }

  const { block, notice } = auditEscalation(coverage, unpushed);
  if (notice) carriedNotice = carriedNotice ? `${carriedNotice}\n${notice}` : notice;

  /*
   * ═══ §7.1: THE AUDIT IS QUEUED BY THE COMMIT, NOT BY SOMEBODY REMEMBERING ═══
   *
   * "This is mandatory. The worker must not remember to request it."
   *
   * Everything else in Layer 0 records what an audit FOUND -- the finding
   * registry, the repair binding, the repair record, the regression injection --
   * and none of it makes an audit happen. scripts/check-audit-coverage.mjs
   * --jobs builds the blind packets correctly and has to be RUN, which is the
   * remembering. This hook is the only thing that fires on its own, which makes
   * it the only place the trigger can live (rule 17: a control nobody consults
   * is not a control).
   *
   * A NOTICE, NOT A BLOCK, AND DELIBERATELY. The escalation above already blocks
   * on unaudited work that has been PUSHED, which is the boundary worth stopping
   * at. Blocking again on merely COMMITTED work would fire on the turn that
   * writes a control -- every guard turn -- before an audit could exist, and a
   * gate that makes ordinary work impossible gets switched off, taking the drift
   * check with it (rule 16).
   *
   * BOUNDED. auditJobsFor asks for a tree sha ONE per UNAUDITED commit, and the
   * coverage pass above has already filtered to commits that touched a control.
   * On this repository that is 2 rev-parse calls, measured at ~0.06s against a
   * 420s budget. An audited commit costs nothing, so the steady state is zero.
   */
  const { auditJobsFor, formatAuditJobs } = await import('../src/auditJob.mjs');
  const treeShaFor = (candidate) => {
    try {
      return String(runGit(['-C', root, 'rev-parse', `${candidate}^{tree}`], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })).trim();
    } catch {
      return null;   // unreadable is reported by auditJobsFor, never dropped
    }
  };
  const queued = formatAuditJobs(auditJobsFor(coverage, {
    treeShaFor, now: new Date().toISOString(),
  }));
  if (queued) carriedNotice = carriedNotice ? `${carriedNotice}\n${queued}` : queued;
  /*
   * DEFERRED, NOT IMMEDIATE -- BLOCKING HERE SUPPRESSED THE WHOLE GATE.
   *
   * Found by blind audit. out() calls process.exit(0), and this line sits
   * ABOVE discoverTests and the suite spawn. So on any turn the escalation
   * fired, the drift verdict and the entire test run never executed -- and on
   * the retry Stop, stop_hook_active short-circuits with only a systemMessage.
   * An audit-coverage complaint was therefore silencing the checks it is
   * supposed to sit beside.
   *
   * That is the exact failure this commit's own message warned about -- a
   * gate that makes ordinary work impossible taking the other layers down
   * with it -- arriving through a door I did not check. The reason is carried
   * to the end instead, so the suite still runs and the operator gets both
   * verdicts.
   */
  escalationBlock = block;
} catch { /* a reporter must never take the gate down */ }

if (!input) out('[agentbridge:stop-input-invalid] Stop hook input was not valid JSON.');

/*
 * Claude Code sets stop_hook_active=true when this turn is already continuing
 * because a Stop hook blocked once. Blocking again here creates an autonomous
 * verification loop. Ending the turn is NOT approval: the message explicitly
 * records that the previous Stop refusal remains unresolved and requires a new
 * owner/user turn before more work continues.
 */
if (input.stop_hook_active === true) {
  /*
   * THE ESCALATION RIDES ALONG HERE TOO, AND THIS IS THE EXIT THAT MADE
   * "DEFERRED" A LIE.
   *
   * This path writes to stdout directly and never calls out(), so the carry
   * added to out() does not reach it. That matters more than the other
   * twelve put together: the argument for deferring the audit escalation to
   * the end of the gate was that a turn which blocked for some other reason
   * would surface it NEXT turn. This is next turn -- and it short-circuits
   * with only its own message, so the escalation was not deferred, it was
   * dropped for the whole exchange.
   */
  const loopBreak = '[agentbridge:stop-loop-break] A Stop hook already blocked this turn. Ending the turn unapproved instead of re-entering the same autonomous verification loop. Resolve the prior guard refusal in a fresh turn.';
  process.stdout.write(`${JSON.stringify({
    systemMessage: [loopBreak, carriedNotice, escalationBlock].filter(Boolean).join('\n'),
  })}\n`);
  process.exit(0);
}

/*
 * The session id comes from the Stop payload, so this reads the baseline THIS
 * session created. Keyed by repository alone, two concurrent sessions shared and
 * overwrote one file.
 */
const sessionId = input.session_id ?? null;
let snapshot = readSnapshot(root, sessionId);
if (!snapshot) {
  /*
   * A MISSING BASELINE USED TO BE A DEAD END, AND IT BRICKED REAL SESSIONS.
   *
   * Refusing on an absent snapshot is right -- absent is not clean -- but there
   * was no way back. A session whose SessionStart never ran (begun before the
   * hook was wired, or outside the repo) cannot write its own baseline, because
   * only --session-start does, and it cannot run that either: `node` is
   * allowlisted only with --test. So it blocked, retried and blocked again,
   * forever. Observed on the operator's machine 2026-09-17, on every terminal at
   * once. A control with no recovery path is an outage, and an outage is how a
   * guard gets switched off entirely.
   *
   * So the gate now asks git, which does not need a snapshot to have an opinion,
   * and mints a baseline ONLY from a tree git calls clean. It still blocks this
   * turn either way -- nothing here approves anything -- but a recoverable state
   * becomes recoverable on the next one.
   */
  /*
   * THE REFUSAL ITSELF NOW LIVES IN writeSnapshot, NOT HERE, AND THIS USED TO BE
   * THE ONLY PLACE THAT ENFORCED IT -- which was the hole.
   *
   * This path performed the cleanliness check and then minted. Every OTHER
   * caller of writeSnapshot had none, notably --session-start, which mints
   * nearly every baseline: so a new session could baseline a damaged tree and
   * its Stop gate would then report no drift. Duplicating the check into the
   * second caller would have been the same mistake with a longer fuse, so the
   * control belongs to the act of minting and every caller inherits it.
   *
   * What survives here is the MESSAGE. The per-status advice below is more
   * useful than the one-line reason writeSnapshot can return, and a refusal a
   * person cannot act on is an outage waiting to happen. Presentation, not a
   * second control.
   */
  const minted = writeSnapshot(root, sessionId);
  if (!minted.ok) {
    const who = `No readable snapshot for session ${sessionId ?? '(none supplied)'}`;
    if (minted.cause === 'unmeasurable') {
      out(`[agentbridge:no-session-snapshot] ${who}, and git could not be consulted to check the protected files independently. Refusing: unknown is not clean.`);
    }
    if (minted.cause === 'dirty') {
      /*
       * The advice is per status code because "commit or restore these" is
       * useless for an untracked file, and `.claude/` is a PREFIX entry -- so a
       * stray untracked file under it blocks minting forever, which is its own
       * outage. An untracked file there is still refused rather than waved
       * through: local settings can switch hooks off, so a file this session
       * could have created is not something it gets to certify as normal.
       */
      const advise = (code) => (code.startsWith('?')
        ? 'untracked: delete it, commit it, or add it to .gitignore'
        : 'modified or deleted: commit it or restore it with git');
      out(`[agentbridge:no-session-snapshot] ${who}, and ${minted.reason}:\n${minted.drift.map((d) => `  ${d.file} [${d.kind}] ${d.now} -- ${advise(d.now)}`).join('\n')}\nResolve these, or start a fresh session so SessionStart records a baseline properly.`);
    }
    out(`[agentbridge:no-session-snapshot] ${who}, and one could not be created: ${minted.reason}`);
  }
  out(`[agentbridge:baseline-created] This session had no baseline, so THIS TURN COULD NOT BE VERIFIED and is not approved. git reports the protected files and baseline tests match the repository, so a baseline has now been recorded at ${minted.file}. The next turn will be checked against it normally.`);
}

/*
 * A GRANTED CHANGE IS REPORTED, NOT REFUSED -- AND REPORTED EITHER WAY.
 *
 * PreToolUse consulted the override and this gate did not, so an operator could
 * approve a repair, watch the edit land, and then have the turn blocked by the
 * same protection that had just permitted it. The change was already made by
 * then, so refusing here prevented nothing; it only stopped the session being
 * able to say so. That is the deadlock the override channel was built to end
 * and ended only one layer of.
 *
 * THE GRANT SUPPRESSES THE REFUSAL, NEVER THE RECORD. An overridden file is
 * still named on its own line, with who granted it, why, and until when. The
 * channel's whole safety argument is that a forged grant does not disappear
 * into a clean run -- staying silent here is exactly how it would.
 */
/*
 * THIS GATE'S OWN CONFIGURATION IS NOT OVERRIDABLE, WHATEVER THE GRANT SAYS.
 *
 * hookBudget below reads this gate's kill deadline out of .claude/settings.json,
 * and its stated reason for trusting that file is that `.claude/` is a protected
 * prefix, so any edit is drift and the check here has already blocked and exited
 * before the budget is consulted. That argument was true when it was written and
 * the override channel falsified it: a grant naming .claude/settings.json moved
 * the drift into `granted`, which records and continues, so execution reached
 * hookBudget and read a number the edit had chosen. Measured by audit -- with
 * such a grant and the timeout rewritten to 99999 the gate did not block.
 *
 * An override is a decision to permit a REPAIR. It cannot also be a decision to
 * let the repaired file dictate how long this gate is allowed to look, because
 * then the grant is not scoped to a file, it is scoped to the check itself.
 * These paths stay drift no matter what is granted; a genuine repair to them is
 * visible in the refusal and lands on the next session's clean baseline.
 */
// Imported, not redeclared: PreToolUse must refuse to ADVISE an override for
// exactly the paths this gate refuses to honour one for.
const allDrift = protectedDrift(root, snapshot);
// Partitioned from ONE read per entry, for the reason given at the test filter
// below: two passes leave a window where an appearing grant puts an entry in
// neither list, which is silent acceptance. Pre-existing here; closed with it.
/*
 * ── A TEAMMATE'S LANDED COMMIT IS NOT THIS SESSION TAMPERING ────────────────
 *
 * The snapshot is minted once, at SessionStart, and never refreshed. In a
 * SHARED worktree with three agents that is fatal: every control another agent
 * legitimately commits drifts you, permanently, for the life of your session.
 *
 * Measured 2026-09-18. code-b was refused on every single turn with eleven
 * lines, eight of them caused by MY commits landing after its snapshot was
 * taken. It could not clear them: committing does not help (this gate says so
 * in its own headline), and the gate re-mints only at SessionStart and only
 * from a tree git calls clean. So it was blocked from ENDING A TURN, not from
 * doing work, and every turn cost the operator a manual unblock. Danny, on the
 * whole class: "they cant finish their work dude its a mess so many
 * restrictions that its eating time".
 *
 * WHAT THIS GATE IS ACTUALLY FOR: stopping THIS session from quietly mutating a
 * control and then reporting success. A change that is COMMITTED is not quiet.
 * It is in git history -- attributable, diffable, revertible, and visible to
 * every audit -- which is exactly the auditability property CLAUDE.md already
 * credits the execution gate with: "It requires that code to be in git history
 * first... That is an AUDITABILITY property, and it is worth having."
 *
 * So drift whose working file MATCHES HEAD is landed work. It is reported --
 * loudly, every turn, naming each file -- and it does not block. Drift that is
 * uncommitted still blocks, because that is the case this gate was built for:
 * a live modification nobody has recorded.
 *
 * ASKED OF GIT, NOT OF THE FILESYSTEM. Comparing bytes against `git show
 * HEAD:path` reports every file as drifted on a checkout with core.autocrlf
 * true, which is the operator's -- the same trap baselineBlockingDriftFromGit
 * documents. `git status --porcelain` applies the repository's own eol and
 * attribute rules, so it answers the question actually being asked. If git
 * cannot answer, the entry stays BLOCKING: unknown is not clean.
 */
/**
 * Is this path ignored by git -- so it can NEVER be committed?
 *
 * Asked of git rather than by reading .gitignore, because git owns the pattern
 * grammar and precedence. Unknown is NOT ignored: a throw keeps the caller on
 * the strict path.
 */
function isIgnored(rel) {
  try {
    const out = runGit(['ls-files', '--ignored', '--exclude-standard', '--others', '--', rel],
      { cwd: root, encoding: 'utf8' });
    return String(out).trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Does this settings file only ADD, declaring nothing that could weaken a
 * control? See the note at the `landed` predicate for why this is the right
 * question for an ignored file and `gateConfigArms` is not.
 *
 * THE DECISION IS IN src/, NOT HERE. This script does its work at import, so
 * nothing defined in it can be exercised by the suite -- rule 10. It reads the
 * file and `settingsAddsOnly` judges the contents, which is where the seven-name
 * allowlist that used to live here was replaced after a blind audit found it
 * blocked the session on any unrecognised /config toggle. The reasoning is
 * written up there.
 */
function gateConfigAddsOnly(rel) {
  let text;
  try {
    text = readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return false;   // unreadable is not safe
  }

  const { addsOnly, weakens } = settingsAddsOnly(text);
  if (!addsOnly) {
    selfConfigAlarm.push({
      kind: 'unattributable',
      line: `  ${rel}: declares ${weakens.join(', ')} -- a file that is not in git `
        + 'may not carry hooks, env or anything else that can take a control away',
    });
    return false;
  }
  return true;
}

function isCommittedWork(rel) {
  try {
    /*
     * TRACKED FIRST, AND THE VERSION WITHOUT THIS CLAUSE WAS A CRITICAL HOLE I
     * SHIPPED.
     *
     * `git status --porcelain` reports nothing for a file it does not track --
     * and it does not track an IGNORED one even with --untracked-files=all. So
     * for any ignored path this returned CLEAN, meaning "committed", for a file
     * git has never contained. Measured in this repository:
     *
     *     git ls-files .claude/                     -> .claude/settings.json only
     *     ls .claude/                               -> settings.local.json is THERE
     *     git status --porcelain -uall -- .claude/settings.local.json
     *                                               -> empty, so this said true
     *
     * `.gitignore` names `.claude/settings.local.json`, and that file is a
     * SETTINGS FILE FOR THIS GATE. Once 803aba3 let GATE_SELF_CONFIG reach the
     * `landed` branch, a hostile settings.local.json was relieved and announced
     * with the words "a committed change is attributable and diffable" -- every
     * one of which is false for a file that is not in history, cannot be
     * diffed, cannot be reverted and is invisible to every audit. Found by
     * blind audit; I reproduced both halves before believing it.
     *
     * The premise of the whole branch is that the change is IN GIT HISTORY. So
     * ask that directly instead of inferring it from silence. This closes the
     * hole for every ignored path, not just the two settings files, and an
     * untracked-and-visible file is unaffected because git reports it as `??`.
     *
     * UNKNOWN IS NOT CLEAN, in both calls: a throw from either keeps blocking.
     */
    const tracked = runGit(['ls-files', '--', rel], { cwd: root, encoding: 'utf8' });
    if (String(tracked).trim() === '') return false;

    const out = runGit(['status', '--porcelain', '--untracked-files=all', '--', rel],
      { cwd: root, encoding: 'utf8' });
    return String(out).trim() === '';
  } catch {
    return false; // could not measure; keep blocking
  }
}

/**
 * Read the settings file on disk and ask whether it still arms every control.
 *
 * FAILS CLOSED on anything it cannot read: an unreadable config is not an armed
 * one, and "nobody knows" is not "nothing changed" -- the same sentence this
 * file's header already applies to a missing snapshot.
 *
 * The verdict is announced when it REFUSES relief, because a settings file that
 * matches HEAD and still fails this check means the committed configuration has
 * disarmed something, which is worth saying out loud rather than surfacing as a
 * bare drift line.
 */
const selfConfigAlarm = [];
function gateConfigStillArms(rel) {
  let verdict;
  try {
    verdict = gateConfigArms(readFileSync(path.join(root, rel), 'utf8'));
  } catch {
    return false;
  }
  if (!verdict.armed) {
    selfConfigAlarm.push({ kind: 'disarmed', line: `  ${rel}: ${verdict.missing.join('; ')}` });
  }
  return verdict.armed;
}

const driftDecisions = allDrift.map((d) => {
  const granted = !isGateSelfConfig(d.file) && Boolean(overrideCovers(root, d.file));
  return {
    entry: d,
    granted,
    /*
     * THE GATE'S OWN CONFIGURATION IS EXCLUDED HERE TOO, and leaving it out was
     * a hole this file's own test caught on the first run. isGateSelfConfig
     * guarded only the GRANT branch, so "commit it" would have become a way to
     * do what no override may: .claude/settings.json decides whether the guard
     * runs at all, and a commit is not a stronger permission than a grant.
     *
     * DELETION IS EXCLUDED FOR A DIFFERENT REASON. A committed edit leaves
     * something to read and revert; a committed DELETION of a control is the
     * incident this repository was built around -- a real session deleted
     * src/claudeGuard.mjs and nothing refused. Committing that must not buy
     * silence.
     */
    /*
     * AN IGNORED SELF-CONFIG CAN NEVER BE COMMITTED, SO DEMANDING IT WAS AN
     * UNRECOVERABLE BLOCK -- the same failure as the one above, from the fix
     * for the one above.
     *
     * `.claude/settings.local.json` is named in .gitignore and `.claude/` is a
     * protected PREFIX, so it is drift-tracked. After the ignored-path fix it
     * could never be `landed`: not committable (gitignored, and a git write
     * naming a `.claude/` path is refused anyway) and the snapshot re-mints
     * only at SessionStart. Every turn blocked, no route to clear it.
     *
     * AND CLAUDE CODE WRITES THAT FILE ITSELF when the operator approves a
     * permission mid-turn, so this would fire on an ordinary approval and
     * strand the session. Found by blind audit, one commit after I introduced
     * it while closing the opposite hole.
     *
     * SO THE TEST IS THE STRONGEST PROPERTY THE FILE CAN ACTUALLY HAVE. A
     * tracked config offers committed AND armed, and both are demanded. An
     * ignored one can only ever offer armed, so armed is what is asked -- and
     * the announcement for it must not borrow the committed wording, because
     * "attributable and diffable" is false for a file in no history. That is
     * the sentence the previous audit caught; it is not being re-used here.
     */
    landed: !granted
      && d.now !== 'deleted'
      && (isCommittedWork(d.file) || (isGateSelfConfig(d.file) && isIgnored(d.file)))
      /*
       * THE GATE'S OWN CONFIG IS RELIEVED ONLY WHEN IT STILL ARMS THE GATE, and
       * that is a different question from who committed it.
       *
       * The exclusion here was right and its consequence was unrecoverable. A
       * session's snapshot mints once and may never be re-minted, so when
       * ANOTHER session legitimately commits a settings change, every running
       * session blocks forever on a file that matches HEAD, with no escape but
       * restarting. Measured across most of a working session: ade7ab9 ADDED
       * two poll hooks and removed nothing -- strictly more armed than the
       * snapshot -- and every turn was refused regardless.
       *
       * So the relief needs BOTH halves, and neither alone would do:
       *   isCommittedWork  -- it matches HEAD, so it is attributable, diffable,
       *                       and it carries HEAD's Stop timeout rather than
       *                       one a local edit chose (the measured 99999 case).
       *   gateConfigArms   -- the controls are STILL THERE, read out of the
       *                       file. A committed DISARM fails this, so "commit
       *                       it" is still not a permission.
       *
       * A deletion is still never relieved, above, for the reason already
       * recorded: a committed deletion of a control is the founding incident.
       */
      /*
       * A TRACKED SELF-CONFIG MUST ARM. AN IGNORED ONE MUST MERELY NOT WEAKEN,
       * AND ASKING IT TO ARM WAS WHY THE PREVIOUS FIX FIXED NOTHING.
       *
       * gateConfigArms demands that THE FILE ITSELF declare the guard hook, the
       * Stop hook and the SessionStart hook. `.claude/settings.json` does.
       * `.claude/settings.local.json` never did -- on this machine it is 163
       * bytes of permissions and MCP server names, no `hooks` key at all. So it
       * failed the arming test, stayed in `drift`, and blocked exactly as
       * before: the availability fix did not reach the file it was written for,
       * and it printed "THE GATE'S OWN CONFIGURATION NO LONGER ARMS IT" naming
       * three hooks that file never carried. A cry-wolf alarm on top of the
       * block. Found by blind audit.
       *
       * The right question for a file that ADDS to a merged configuration is
       * not "does it arm" but "does it take anything away". These are the keys
       * by which it could:
       *
       *   hooks             -- can replace or drop a control's declaration
       *   disableAllHooks   -- turns every hook off in one field
       *   env               -- AGENTBRIDGE_HOME points at the override GRANT
       *                        STORE (src/config.mjs), so redirecting it is an
       *                        unlimited forged-grant channel. This repository's
       *                        own worktree test calls that payload "the
       *                        sharpest of the seven" and says in as many words
       *                        that "hooks being armed says nothing about where
       *                        the grant store points" -- which is precisely the
       *                        proposition an arming test rests on.
       *
       * So an ignored self-config is relieved only when it declares NONE of
       * them. That admits the real file and the permission approvals Claude
       * Code writes into it, and refuses every payload that could weaken
       * anything. Anything richer than that blocks, and blocking is survivable
       * because the operator can delete the file.
       */
      && (!isGateSelfConfig(d.file)
        || (isIgnored(d.file) ? gateConfigAddsOnly(d.file) : gateConfigStillArms(d.file))),
  };
});
const granted = driftDecisions.filter((x) => x.granted).map((x) => x.entry);
const landed = driftDecisions.filter((x) => x.landed).map((x) => x.entry);
const drift = driftDecisions.filter((x) => !x.granted && !x.landed).map((x) => x.entry);

if (landed.length) {
  /*
   * REPORTED, NEVER SILENT. The whole argument for not blocking is that the
   * change is on the record, so this line IS the record from the gate's side.
   * Recorded rather than returned, like the grant notice below it.
   */
  /*
   * TWO GROUPS, BECAUSE THEY ARE RELIEVED ON DIFFERENT GROUNDS AND ONE OF THEM
   * IS NOT IN GIT AT ALL.
   *
   * A committed control is attributable and diffable, and that is the whole
   * argument for not blocking it. An IGNORED self-config is relieved on a
   * weaker property -- it still arms the gate -- and printing it under the
   * committed wording would assert three things that are false for it: in
   * history, diffable, revertible. That exact sentence, applied to a gitignored
   * file, is what the previous audit called CRITICAL. It is not reused here.
   */
  const committed = landed.filter((d) => !(isGateSelfConfig(d.file) && isIgnored(d.file)));
  const ignoredSelf = landed.filter((d) => isGateSelfConfig(d.file) && isIgnored(d.file));
  const parts = [];

  if (committed.length) {
    parts.push('[agentbridge:protected-control-committed] Protected controls differ from this session\'s '
      + 'snapshot because they were COMMITTED -- by this session or another agent sharing the '
      + 'worktree. Not blocking: a committed change is attributable and diffable, which is what the '
      + `snapshot exists to guarantee. Recorded:\n${committed.map((d) => `  ${d.file}: ${d.now}`).join('\n')}`);
  }
  if (ignoredSelf.length) {
    parts.push('[agentbridge:gate-config-ignored-but-armed] This gate\'s own configuration changed and '
      + 'is GITIGNORED, so it is not in history, not diffable and not revertible -- the committed '
      + 'relief does not apply and is not being claimed. It is not blocking only because it still '
      + 'arms every control: the guard on all tools, this gate, and the session-start snapshot. '
      + 'Claude Code writes this file when a permission is approved, which is why a block here has '
      + `no recovery. Read it if you did not expect a change:\n${ignoredSelf.map((d) => `  ${d.file}: ${d.now}`).join('\n')}`);
  }
  carriedNotice = [carriedNotice, ...parts].filter(Boolean).join('\n');
}
/**
 * Announce granted drift, GROUPED BY GRANT rather than repeated per file.
 *
 * ONE WILDCARD GRANT PRINTED ITS OWN TERMS FOURTEEN TIMES. Every covered path
 * carried the full tail -- grantor, expiry and the whole reason sentence -- so a
 * `paths: ["*"]` grant, which is the shape the owner actually issues, produced
 * fourteen identical copies of "granted by danny, expires ..., reason: full
 * access for code-a, code-b and fixer, directed by Danny repeatedly" with the
 * filenames buried between them.
 *
 * THAT IS NOT A COSMETIC COMPLAINT. This notice exists so a reader can see what
 * a grant permitted, and the announcement is the only place it surfaces. A
 * reader who scrolls past it because it is fourteen-sixteenths boilerplate is a
 * reader the control did not reach -- rule 16's failure mode in a different
 * costume: not a gate that cannot go green, but a report nobody finishes.
 *
 * WHAT IS KEPT, deliberately, because the terms are the point: every distinct
 * grant still prints its grantor, expiry and reason IN FULL, once. Files are
 * listed under the grant that permitted them. A file whose grant has become
 * unreadable since the drift was recorded gets its own group and says so --
 * that degradation is load-bearing (see the note below) and must not be folded
 * in with the others.
 */
function announceGranted(marker, headline, entries) {
  const groups = new Map();
  for (const d of entries) {
    /*
     * RE-READ PER ENTRY, AND MAY BE GONE BY NOW (expiry, deletion), so a
     * missing grant degrades to naming the file rather than dereferencing
     * null: 95725a3 added three unguarded overrideCovers calls to a script
     * that has no try/catch anywhere, and an uncaught throw here exits 1 with
     * empty stdout, which Claude Code reads as non-blocking.
     */
    const g = overrideCovers(root, d.file);
    const key = g
      ? `granted by ${g.granted_by}, expires ${g.expires_at}, reason: ${g.reason}`
      : 'the grant that permitted this is no longer readable';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(`      ${d.file}: ${d.now}`);
  }

  const body = [...groups].map(([terms, files]) => `  ${terms}\n${files.join('\n')}`).join('\n');
  return `[agentbridge:${marker}] ${headline}\n${body}`;
}

if (granted.length) {
  /*
   * RECORDED, NOT RETURNED. This must not call out() -- see its definition.
   *
   * AND IT APPENDS, BECAUSE ASSIGNING HERE DESTROYED THE OTHER NOTICE. This was
   * a bare `carriedNotice = ...`, six lines above a sibling block whose comment
   * says exactly why that is wrong: "assigning over it would silently drop one
   * of two announcements." The landed notice is set FIRST, so with both present
   * the committed-control line was built and then overwritten, every time.
   *
   * NOT A RARE INTERLEAVING -- it is the default shape on this machine. A file
   * is either granted or landed, never both, and GATE_SELF_CONFIG excludes the
   * two settings files from `granted`. So under the wildcard grant the owner
   * actually issues, everything else lands in `granted` and the ONLY thing that
   * can be in `landed` is a settings file -- which is to say the single line
   * this gate most needs to print was the one reliably destroyed. Found by
   * blind audit, in a function I had rewritten without noticing the assignment.
   */
  const note = announceGranted(
    'protected-control-overridden',
    'Protected controls changed under an active override. Permitted, and recorded anyway:',
    granted,
  );
  carriedNotice = carriedNotice ? `${carriedNotice}\n${note}` : note;
}
if (drift.length) {
  /*
   * THE DISARM CASE IS NAMED, not left to look like ordinary drift. If a
   * settings file matches HEAD and STILL fails the arming check, the committed
   * configuration has turned a control off -- which is a different and much
   * louder fact than "this differs from your snapshot", and it is the one case
   * where "commit it" was trying to buy silence.
   */
  const why = selfConfigHeadline(selfConfigAlarm);
  out(`[agentbridge:protected-control-changed] Protected controls differ from the session snapshot (committing does not hide this):\n${drift.map((d) => `  ${d.file}: ${d.now}`).join('\n')}${why}`);
}

/*
 * BASELINE TESTS ARE COMPARED, NOT MERELY RECORDED. snapshot.tests was collected
 * and never checked, so a weakened inherited test would be RUN by the block
 * below and pass -- the suite grading itself against rules the session had just
 * relaxed. Measured: a weakened baseline test produced zero drift.
 */
/*
 * AND THE GRANT REACHES THIS COMPARISON TOO, OR IT REACHES NOTHING.
 *
 * PreToolUse now permits editing a granted baseline test. If this gate still
 * refused the result, the grant would buy the write and then block the turn --
 * a permission that cannot be spent, which is worse than no permission because
 * it looks like one. Both layers or neither.
 *
 * Filtered exactly like protectedDrift above, including the re-read per entry:
 * a grant may have expired between the write and the Stop, and a missing grant
 * degrades to naming the file rather than dereferencing null. This script has no
 * try/catch anywhere, and an uncaught throw here exits 1 with empty stdout,
 * which Claude Code reads as NON-BLOCKING -- a disarm, not a refusal.
 *
 * NO GATE_SELF_CONFIG EQUIVALENT, deliberately: that list stops a grant deciding
 * how long this gate may look. A test does not set the budget, so the notice
 * carries the mitigation -- the change is permitted only while it is named, and
 * it is recorded every time rather than passing silently.
 */
/*
 * DECIDED ONCE PER ENTRY, NOT TWICE.
 *
 * Filtering the same list with the predicate and then with its negation reads
 * the grant file twice per entry. If a grant APPEARS between the two passes, the
 * entry is in neither list: no block and no announcement -- silent acceptance,
 * which is the one outcome this whole path is supposed to make impossible.
 * Expiry between the passes fails safe (the entry lands in both), so only the
 * appearing-grant direction is dangerous, and partitioning from a single read
 * removes the window rather than narrowing it.
 *
 * Raised by audit as a code-level observation it could not construct
 * deterministically. It is cheaper to close than to argue about.
 */
const allTestDrift = baselineTestDrift(root, snapshot);
const testDecisions = allTestDrift.map((d) => ({ entry: d, granted: Boolean(overrideCovers(root, d.file)) }));
const grantedTests = testDecisions.filter((x) => x.granted).map((x) => x.entry);
const testDrift = testDecisions.filter((x) => !x.granted).map((x) => x.entry);
if (grantedTests.length) {
  const note = announceGranted(
    'baseline-test-overridden',
    'Baseline tests changed under an active override. Permitted, and recorded anyway:',
    grantedTests,
  );
  // APPEND. carriedNotice may already hold the protected-control notice, and
  // assigning over it would silently drop one of two announcements.
  carriedNotice = carriedNotice ? `${carriedNotice}\n${note}` : note;
}
if (testDrift.length) {
  out(`[agentbridge:baseline-test-changed] Tests present at session start differ from the snapshot:\n${testDrift.map((d) => `  ${d.file}: ${d.now}`).join('\n')}`);
}

/* RECURSIVE, matching `npm test`'s test/** glob. A flat readdir runs a different
 * suite from the one the project declares, and would approve a run that silently
 * skipped every nested test. */
const tests = discoverTests(root);
if (tests.length === 0) out('[agentbridge:zero-test-files] No test files were discovered.');

/*
 * THE SUITE GETS WHAT IS LEFT, NOT A CONSTANT. performance.now() is milliseconds
 * since this process started, so node startup, module load, hashing every
 * protected file and every baseline test, and recursive discovery are all
 * CHARGED against the budget rather than assumed free.
 */
const budget = hookBudget(root);
const spentMs = Math.round(performance.now());
const suiteMs = budget === null ? UNDECLARED_SUITE_MS : budget.ms - spentMs - OUTPUT_RESERVE_MS;

if (budget !== null && suiteMs < MIN_SUITE_MS) {
  out(`[agentbridge:stop-deadline] The work before the suite spent ${spentMs}ms of a ${budget.ms}ms hook budget (${budget.source}), leaving ${suiteMs}ms -- less than the ${MIN_SUITE_MS}ms a run needs to reach a TAP summary. NOTHING WAS VERIFIED, so this turn is not approved. Starting a run that cannot finish would spend the rest of the budget and produce this same refusal too late to be read.`);
}

/*
 * ═══ THIS GATE NO LONGER RUNS THE SUITE. IT CONSUMES A RESULT. ═══
 *
 * WHAT IT USED TO DO, AND WHY THAT COULD NOT WORK. It spawned the whole suite
 * at every turn end. A session that also ran the suite -- which is the normal
 * way to check your own work -- put two full copies on one machine, and a
 * second AGENT made it three. Measured here: a solo run is ~185s, a pair is
 * ~400-430s, and the budget is 420s. So the gate killed its own suite and
 * reported NOTHING WAS VERIFIED six times in one session. Every single one was
 * a duplicate of work already running, and the duplicate never learned anything
 * the original would not have.
 *
 * Raising the budget to 900s moves the wall. Two copies of a growing suite find
 * 900 the way they found 420.
 *
 * THE FIX IS SINGLE-FLIGHT, and the shape is borrowed: node-core-utils refuses
 * to launch CI for a commit that already has a run in flight, and agent-studio
 * caches baseline verification keyed by repo, sha, command and toolchain.
 * Danny pointed at both.
 *
 *   a completed result for this exact tree  -> consume it
 *   one already running for this tree       -> report it, start nothing
 *   nothing                                 -> start ONE, detached, and refuse
 *                                              this turn as unverified
 *
 * THE IDENTITY IS THE SAFETY ARGUMENT. `src/verifyCache.mjs` keys on the
 * WORKING TREE with file contents -- not HEAD -- plus the command, the
 * toolchain and the environment. An uncommitted edit produces a different key,
 * so a PASS can never be reused across a change. Reusing a result for a tree
 * nobody tested would be a forged verification, and every other control in this
 * repository sits behind the suite.
 *
 * A RUN IN FLIGHT IS NOT A PASS. `admitVerification` is deliberately separate
 * from the decision about whether to start one, because collapsing them would
 * approve a turn on the strength of somebody else's work in progress.
 *
 * STARTING IS DETACHED AND UNAWAITED, so this hook still answers in
 * milliseconds. The turn is refused -- nothing has been verified yet -- but the
 * NEXT turn consumes the result instead of starting a seventh duplicate.
 */
/*
 * ═══ EVERY THROW IN THIS SECTION BECOMES A REFUSAL, NEVER A SILENT EXIT ═══
 *
 * THIS SCRIPT HAS NO try/catch ANYWHERE, ON PURPOSE, and its own header says
 * why: an uncaught throw exits 1 with EMPTY STDOUT, which Claude Code reads as
 * NON-BLOCKING. That is a disarm, not an error.
 *
 * I then added two dynamic imports and a runner to the hottest path in the
 * file. MEASURED: `test/stopGateDeadline.test.mjs` went from refusing to
 * `{"blocked":false,"reason":""}` in 399ms -- the gate ALLOWED a turn it should
 * have refused, because a module failed to resolve in that fixture and the
 * throw walked straight out of the process. A verification layer whose absence
 * silently approves everything is worse than no verification layer, and it is
 * the exact shape rule 17 is about: the wiring is a separate claim from the
 * logic, and only the logic had tests.
 *
 * So the whole section is wrapped, and the catch REFUSES. Failing closed here
 * costs a blocked turn and a legible reason; failing open costs the gate.
 */
let verifyBlock = null;
try {
  const { verifyKey, decideVerify, admitVerification, VERIFY, ACTION } = await import('../src/verifyCache.mjs');
  const { verificationIdentity, verifyRecordPath } = await import('../src/verifyIdentity.mjs');

  const ident = verificationIdentity(root, process.env);
  const keyed = verifyKey(ident);

  if (!keyed.ok) {
  /*
   * NO IDENTITY MEANS NO TRUSTWORTHY RESULT. Refuse rather than fall back to
   * running the suite here -- falling back is how the duplicate returns.
   */
  out(`[agentbridge:verify-identity-unknown] Could not form a verification identity for this tree, so no result could be trusted: ${keyed.errors.join('; ')}`);
}

let record = null;
try { record = JSON.parse(readFileSync(verifyRecordPath(keyed.key), 'utf8')); } catch { record = null; }

const decision = decideVerify(record, { now: Date.now(), key: keyed.key });
let admitted = admitVerification(record, { now: Date.now(), key: keyed.key });

if (decision.action === ACTION.START) {
  /*
   * ═══ THIS GATE STARTS NOTHING. NOT EVEN DETACHED. ═══
   *
   * The first version spawned a detached verifier here so verification would be
   * automatic. Two things were wrong with it, and the second is the one that
   * matters.
   *
   * MEASURED: `test/auditEscalationWiring.test.mjs` began failing EPERM on
   * `rmSync`. The gate runs against a temp fixture in those tests, the detached
   * child inherited `cwd: <fixture>`, and a live process holding a directory
   * open cannot be removed on Windows. So the gate acquired a side effect that
   * outlived it and leaked into every caller's workspace -- in a test it is a
   * failed cleanup, in a throwaway worktree it is a full suite running in a
   * directory somebody is about to delete.
   *
   * AND THE PRINCIPLE, WHICH I HAD ALREADY WRITTEN AND THEN CONTRADICTED. The
   * whole argument for this change is that the gate should stop being a test
   * runner and become a result CONSUMER. Spawning a runner is still being a
   * test runner; making it asynchronous hides the coupling rather than removing
   * it. A hook that judges a turn should not also start work.
   *
   * SO IT REFUSES AND SAYS WHAT TO RUN. That is an honest outage-shaped default
   * -- a turn cannot be approved until somebody produces a result -- and it is
   * the direction rule 19 warns about, so the remedy is one command and it is
   * printed. Making production automatic belongs to the launcher or a watcher,
   * which can own a process without owning a verdict.
   */
  /*
   * ═══ NOTHING IS RUNNING AND NOTHING IS CACHED, SO THIS GATE RUNS IT ═══
   *
   * I got the diagnosis one step too wide and a test caught it. The bug was
   * never "the gate runs the suite" -- it was "the gate runs a SECOND one".
   * Refusing to run at all made every turn block until somebody ran the
   * verifier by hand, and `AN ORDINARY DOCS COMMIT MUST NOT STOP THE TURN`
   * went red immediately. That is rule 19's outage, introduced by the fix for
   * a collision, which is the pairing this repository keeps producing.
   *
   * So the single-flight decision above does the actual work: when a run is
   * already in flight we ATTACH and start nothing, and when one has finished
   * for this exact tree we REUSE it. Only when there is neither does the gate
   * run a suite -- which is the status quo, and the status quo was survivable
   * at ~185s. The 420s failures were every time TWO copies were running.
   *
   * IT RUNS THE VERIFIER, NOT `node --test` DIRECTLY, so the result is written
   * to the store and the NEXT turn reuses it instead of running a third. That
   * is the other half of the saving: without it, a turn that blocks for any
   * other reason throws away a perfectly good suite run.
   */
  const left = budget === null ? UNDECLARED_SUITE_MS : budget.ms - Math.round(performance.now()) - OUTPUT_RESERVE_MS;
  if (left < MIN_SUITE_MS) {
    out(`[agentbridge:stop-deadline] The work before verification spent ${Math.round(performance.now())}ms of a `
      + `${budget === null ? UNDECLARED_SUITE_MS : budget.ms}ms budget, leaving ${left}ms -- less than the `
      + `${MIN_SUITE_MS}ms a run needs. NOTHING WAS VERIFIED, so this turn is not approved. Produce a result `
      + 'out of band with: npm run verify');
  }

  /*
   * IMPORTED, NOT SPAWNED BY PATH. The first version ran
   * `scripts/verify-run.mjs` as a child, which made the dependency a string no
   * static analysis could follow -- and three test fixtures that build a repo
   * by walking the hooks' IMPORT CLOSURE produced one without the verifier in
   * it. An invisible dependency is what `noOrphanModules` and
   * `guardDependenciesProtected` exist to prevent; a spawn by filename is
   * outside both.
   */
  const { runVerification } = await import('../src/verifyRunner.mjs');

  /*
   * A DEADLINE HERE IS A REFUSAL, NOT A PASS. The run is awaited against the
   * remaining budget; whichever settles first decides, and a timeout leaves the
   * RUNNING record behind with a heartbeat that goes stale, so the next turn
   * treats it as dead and starts fresh rather than waiting on a corpse.
   */
  const timedOut = Symbol('timed-out');
  let produced = null;
  try {
    produced = await Promise.race([
      runVerification({ root, key: keyed.key, identity: ident }),
      new Promise((resolve) => { setTimeout(() => resolve(timedOut), left).unref?.(); }),
    ]);
  } catch (e) {
    out(`[agentbridge:verify-threw] Verification could not be produced (${e?.message ?? e}). NOTHING WAS VERIFIED.`);
  }

  if (produced === timedOut) {
    out(`[agentbridge:stop-deadline] Verification was still running after ${left}ms and this gate answered so its `
      + 'verdict is not discarded. NOTHING WAS VERIFIED, so this turn is not approved. A healthy run finishes far '
      + 'inside this; one that does not is a machine to fix, not a reason to approve unverified work.');
  }

  /*
   * RE-READ THE RECORD RATHER THAN TRUST THE RETURN VALUE. The record is the
   * evidence every other reader will consult, and a return value that
   * disagreed with it would be a proxy -- rule 4, which agrees with the truth
   * right up until something unusual happens.
   */
  try { record = JSON.parse(readFileSync(verifyRecordPath(keyed.key), 'utf8')); } catch { record = null; }
  admitted = admitVerification(record, { now: Date.now(), key: keyed.key });

  if (!record) {
    out('[agentbridge:verify-absent] Verification produced no record for this tree, so NOTHING WAS VERIFIED '
      + 'and this turn is not approved.');
  }
}

if (decision.action === ACTION.ATTACH) {
  out(`[agentbridge:verify-in-flight] ${decision.why}. THIS TURN IS NOT APPROVED: a run in flight is not a result. `
    + 'No second suite was started -- that duplication is what made every run miss the deadline.');
}

  if (admitted.state === VERIFY.FAILED || admitted.state === VERIFY.PARTIAL || admitted.state === VERIFY.TIMED_OUT) {
    const r = record ?? {};
    verifyBlock = `[agentbridge:verify-failed] ${admitted.state} for this exact tree: ${r.why ?? admitted.why}. `
      + `${r.tests ?? '?'} test(s), ${r.fail ?? '?'} failing. Read the detail with: npm run verify -- --status --json`;
  }
} catch (e) {
  /*
   * A THROW HERE REFUSES. See the header above this block: this script has no
   * other try/catch because an uncaught throw exits 1 with empty stdout, which
   * Claude Code reads as NON-BLOCKING -- so the one thing a broken verification
   * layer must never do is let the turn through. Measured: a module that failed
   * to resolve in a test fixture produced `{"blocked":false,"reason":""}`.
   */
  verifyBlock = `[agentbridge:verify-unavailable] The verification layer could not run (${e?.message ?? e}). `
    + 'NOTHING WAS VERIFIED, so this turn is not approved. This refuses rather than passing, because a '
    + 'verification layer whose absence approves everything is worse than none.';
}

if (verifyBlock) out(verifyBlock);
if (escalationBlock) out(escalationBlock);

out(null);
