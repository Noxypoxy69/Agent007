import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { readSnapshot, isBaselineTest, isProtectedRelPath, overrideCovers, canonicalGrantPath, isGateSelfConfig, repoRootOf } from './guardSession.mjs';
import { judgeShellCommand } from './shellAllowlist.mjs';
import { runGit } from './safeGit.mjs';

const SKIP_MARKER = /(?:\b(?:it|test|describe|context)\.skip\s*\(|\bx(?:it|test|describe|context)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bpytest\.skip\s*\(|@Disabled\b|@Ignore\b|\bt\.Skip(?:Now)?\s*\(|#\[ignore\]|\[Ignore\])/;

/*
 * THE PATH LIST LIVES IN guardSession.mjs AND NOWHERE ELSE.
 *
 * There were two of them and they disagreed: this layer protected
 * docs/ROADMAP.md, docs/ORDER.md and all of .claude/**, the Stop snapshot did
 * not, so a write that bypassed PreToolUse changed them undetected. Two lists of
 * one thing drift the moment somebody edits one.
 */


/*
 * shellPathTokens lived here and is deleted. It extracted path-like tokens so
 * they could be matched against protected paths -- a denylist of spellings,
 * which node -e, python3 -c, eval, find -delete and perl -e all walked through.
 * The allowlist in src/shellAllowlist.mjs replaced it, and keeping a dead
 * tokeniser around would invite somebody to reach for the losing approach again.
 */
export function normalizedCandidates(filePath, cwd = process.cwd()) {
  if (typeof filePath !== 'string' || filePath.length === 0) return [];
  const absolute = path.resolve(cwd, filePath);
  const out = [absolute.replaceAll('\\', '/')];
  /*
   * THE NATIVE RESOLVER, BECAUSE CASE IS NOT THE ONLY ALIAS WINDOWS GIVES A FILE.
   *
   * e4b1760 folded case and argued that folding is "a PROPERTY, not a lookalike
   * list". It was a property of ONE alias class. 8.3 short names are a second
   * spelling of the same inode, and realpathSync does NOT expand them -- so
   * normalizedCandidates produced the same wrong spelling twice, which is
   * verbatim the failure mode that commit said it had closed. Measured through
   * the shipped binary, every one ALLOW while its canonical spelling denied:
   *
   *   CLAUDE~1/SETTIN~1.JSO   src/CLAUDE~1.MJS   src/GUARDS~1.MJS
   *   src/SHELLA~1.MJS        bin/AGENTB~1.MJS
   *
   * Writing CLAUDE~1/SETTIN~1.JSO modifies the real file -- git reports the
   * canonical path as modified -- so one permitted write carrying
   * disableAllHooks removed PreToolUse and the Stop hook together, and
   * src/CLAUDE~1.MJS disarms the guard without naming .claude at all.
   *
   * realpathSync.native asks the operating system, which owns the alias table,
   * and expands short names as well as case. That is the difference between
   * ASKING and ENUMERATING -- the same lesson as asking git what a pathspec
   * covers instead of listing spellings, learned again one alphabet later.
   */
  try {
    out.push(realpathSync.native(absolute).replaceAll('\\', '/'));
  } catch { /* fall through: the lexical and non-native candidates still apply */ }
  try {
    out.push(realpathSync(absolute).replaceAll('\\', '/'));
  } catch {
    /*
     * A FILE THAT DOES NOT EXIST YET IS THE CASE THAT MATTERS MOST HERE.
     *
     * Both realpath calls throw for a path with no file behind it, so this
     * fallback resolves the PARENT and rejoins the basename. It used the
     * non-native realpathSync, which does not expand 8.3 aliases -- so a
     * short-named DIRECTORY plus a not-yet-existing file walked through:
     *
     *   Write CLAUDE~1/settings.json   DENY   (the file exists)
     *   Write CLAUDE~1/newhook.json    ALLOW  (it does not)
     *
     * CREATING a file under .claude is the attack the whole entry exists to
     * stop -- a hooks config where none was, or a settings.local.json. Covering
     * only files that already exist covers the wrong half. Found by blind audit.
     */
    try {
      out.push(path.join(canonicalDir(path.dirname(absolute)), path.basename(absolute)).replaceAll('\\', '/'));
    } catch {
      // A missing parent is still judged by its lexical absolute path.
    }
  }
  return [...new Set(out)];
}

/**
 * Resolve a directory the way the OS does, expanding 8.3 aliases. Falls back
 * through the non-native resolver and finally to the lexical path, because a
 * directory that cannot be resolved must still be judged rather than skipped.
 */
function canonicalDir(dir) {
  try { return realpathSync.native(dir); } catch { /* not native-resolvable */ }
  try { return realpathSync(dir); } catch { /* does not exist */ }
  return dir;
}

/*
 * THE ROOT HAS TO BE SPELLED THE SAME WAY THE CANDIDATES ARE.
 *
 * Every candidate above is passed through realpathSync.native, and the root was
 * NOT -- it was lexical. A hash is not involved here, but path.relative is just
 * as total: if cwd arrives spelled with an 8.3 alias and the candidate resolves
 * to the long form, the two have no common prefix, every rel starts with ".."
 * and the function returns FALSE FOR EVERYTHING.
 *
 *   cwd spelled with an 8.3 alias  ->  CLAUDE~1/settings.json   ALLOW
 *                                          src/CLAUDE~1.MJS         ALLOW
 *                                          bin/<guard alias>        ALLOW
 *   cwd spelled in full            ->  all four DENY
 *
 * So the shipped binary and the unit-level function disagreed purely on how cwd
 * was SPELLED, and cwd arrives from the payload or CLAUDE_PROJECT_DIR -- neither
 * of which the guard controls. That made the entire alias fix conditional on
 * something an attacker picks. Found by blind audit.
 *
 * Both spellings of the root are kept and a candidate matching EITHER is judged,
 * because more matching means more refusals, which is the direction this
 * function is allowed to be wrong in.
 */
export function isProtectedPath(filePath, cwd = process.cwd()) {
  const lexicalRoot = path.resolve(cwd);
  /*
   * THE REPOSITORY ROOT IS A ROOT, NOT JUST THE SESSION'S DIRECTORY.
   *
   * Judging only against cwd meant every control was unprotected from any
   * subdirectory: path.relative gave "../src/claudeGuard.mjs", the startsWith
   * ".." guard read that as "outside the repo, not ours", and the write was
   * permitted. Measured through the shipped binary with cwd at <repo>/projA:
   * .claude/settings.json, src/claudeGuard.mjs, CLAUDE.md and package.json all
   * ALLOW, including by absolute path and from two levels down.
   *
   * The baseline-test rail was already resolving into the repository, so the two
   * rails disagreed about the same files -- which is the evidence that this was
   * an oversight and not a decision about scope.
   *
   * Adding a root can only make MORE paths protected, never fewer, and "outside
   * the repository is not ours to judge" still holds: a file genuinely outside
   * is outside BOTH roots.
   */
  const roots = [...new Set([lexicalRoot, canonicalDir(lexicalRoot), repoRootOf(cwd)].filter(Boolean))];
  return normalizedCandidates(filePath, cwd).some((candidate) => roots.some((root) => {
    const rel = path.relative(root, candidate).split(path.sep).join('/');
    if (rel.startsWith('..')) return false;      // outside the repo is not ours to judge
    return isProtectedRelPath(rel);
  }));
}

/**
 * A test that was present when the session began.
 *
 * The previous rule made EVERY existing test immutable, which meant a test
 * written sixty seconds ago could not have a typo fixed: create, then edit, and
 * the edit was denied as `existing-test-immutable`. It would also have blocked
 * the single most important repair of this session -- inverting a test that
 * asserted a vulnerability was correct behaviour. Seven of eleven commits on
 * this branch modified an existing test.
 *
 * So the line is drawn at the SESSION BOUNDARY. Baseline tests carry the
 * evidence the session inherited and are protected; tests the session created
 * are its own work and stay editable. With no snapshot this returns false and
 * the Stop gate refuses separately -- one control failing closed, not two
 * guessing.
 */
export function isSessionBaselineTest(filePath, cwd = process.cwd(), sessionId = null) {
  /*
   * THE SESSION ID MUST ARRIVE HERE. readSnapshot became session-scoped and this
   * call site was not updated, so it looked for a snapshot under the key
   * 'no-session-id', found none, returned false, and every inherited test was
   * editable through Edit/Write. Stop would have caught it afterwards; the
   * PreToolUse protection this function exists for was simply not running.
   */
  const snapshot = readSnapshot(cwd, sessionId);
  /*
   * NO RESOLVABLE SNAPSHOT MEANS FAIL CLOSED. Returning false here said "this is
   * not a baseline test", so with a missing or unmatched session id EVERY
   * inherited test was editable. An unknown session cannot prove a file is new,
   * and "cannot prove" is not "permitted": any existing test file is treated as
   * baseline until a snapshot says otherwise.
   */
  if (!snapshot) {
    return normalizedCandidates(filePath, cwd)
      .some((c) => /(?:^|\/)test\/.+\.test\.mjs$/i.test(c) && existsSync(c));
  }
  for (const candidate of normalizedCandidates(filePath, cwd)) {
    const rel = path.relative(snapshot.repoRoot, candidate).split(path.sep).join('/');
    if (isBaselineTest(rel, snapshot)) return true;
  }
  return false;
}

function deny(id, reason) {
  return { allowed: false, id, reason };
}

/*
 * TOOLS ARE JUDGED BY THE SHAPE OF THEIR INPUT, NOT BY THEIR NAME.
 *
 * This function used to end in `return { allowed: true }` for every tool name it
 * did not recognise, and .claude/settings.json only submitted
 * "Bash|Edit|MultiEdit|Write|NotebookEdit". On Windows, Claude Code runs shell
 * commands through a PowerShell tool, which was in neither list. Measured on the
 * operator's machine 2026-09-17 (item 7): `rm src/claudeGuard.mjs` reached the
 * shell, git reported `D src/claudeGuard.mjs`, and NOTHING refused. The guard
 * failed to protect its own source file.
 *
 * Adding "PowerShell" to the two lists would have closed that one spelling and
 * left every other one open -- CLAUDE.md rule 8: fix the matcher, not the five
 * strings the prober happened to try. The shell rail below learned this already
 * ("ALLOWLIST, NOT DETECTION"); the dispatch one level above it had not.
 *
 * So the name no longer decides. A tool carrying a COMMAND is judged as a shell;
 * a tool carrying a PATH is judged as a write; a tool known to be read-only
 * passes; and anything left over is REFUSED, because a guard that cannot
 * classify an operation has not established that it is safe.
 */

/*
 * Known read-only tools, checked FIRST and deliberately generous.
 *
 * First because Read carries a file_path, and routing it through the write
 * checks would refuse `Read CLAUDE.md` as a protected control -- a guard that
 * blocks reading the rules is one people turn off, which loses every layer at
 * once. Generous because the cost of a wrong entry here is one unguarded
 * read-only call, while the cost of omitting a genuinely read-only tool is that
 * ordinary work stops and somebody disables the hook.
 */
const READ_ONLY_TOOLS = new Set([
  // read the repository
  'Read', 'NotebookRead', 'Glob', 'Grep', 'LS',
  // read the outside world
  'WebFetch', 'WebSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ToolSearch',
  // session bookkeeping that never touches a repository file
  'TodoRead', 'TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion',
  'SlashCommand', 'Skill', 'Monitor', 'ReadNotifications',
  // background-shell bookkeeping. The COMMAND was judged when it was submitted;
  // reading its output or killing it cannot write anything new.
  'BashOutput', 'KillShell', 'KillBash',
  // delegation. A subagent is not a bypass: its own tool calls arrive at this
  // same hook, so it is judged call by call rather than trusted wholesale.
  'Task', 'Agent', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'TaskStop',
  'SendMessage', 'ListAgents',
  /*
   * REPORTING OUT. Neither writes a repository file, and both were REFUSED for
   * naming one -- measured 2026-09-17, and both refusals landed on exactly the
   * work this guard is for.
   *
   * SendUserFile could not send CLAUDE.md or .claude/settings.json: the two
   * files a person most wants in front of them while debugging the guard.
   * ReportFindings was refused whenever a finding named src/claudeGuard.mjs, so
   * a security review OF THE GUARD could not be filed through the normal
   * channel. Read of the same path was allowed throughout, which is the tell:
   * the backstop was treating "names a protected path" as "writes one", the
   * same conflation this file already records for path regexes reused as
   * command regexes.
   */
  'SendUserFile', 'ReportFindings',
]);

const STRUCTURED_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/*
 * DIAGNOSTIC ONLY -- NOT THE SECURITY BOUNDARY. These names exist so that a
 * shell tool arriving without a command string gets "did not provide a command"
 * instead of the generic refusal. An unlisted shell tool is still caught, by
 * carrying a command field. Do not reintroduce dispatch on this set.
 */
const SHELL_TOOL_NAMES = new Set(['Bash', 'PowerShell', 'Shell', 'Cmd', 'Terminal', 'pwsh', 'powershell']);

/*
 * `script` NEARLY CAME OUT OF THIS LIST AND SHOULD NOT HAVE. The Workflow tool
 * carries a JavaScript workflow script under that name, so this list routed it
 * to the shell rail and refused it -- measured against a real 54-tool roster,
 * 2026-09-17. The fix is Workflow's OWN deny below -- workflow-exec-untrusted,
 * which is reached before this list is consulted -- not the removal of `script`:
 * dropping it would have let a shell tool that happens to use that field name
 * through unjudged, trading a loud false positive for a silent false negative.
 *
 * THIS COMMENT SAID "Workflow's entry in READ_ONLY_TOOLS above" AND THERE IS NO
 * SUCH ENTRY. Workflow must never be in that list; it carries executable script
 * content. The sentence described a fix that was never made, for a tool that is
 * in fact handled correctly, which is the second time in this file pair that a
 * comment has claimed a mechanism that does not exist -- shellAllowlist.mjs
 * records the same defect about sed. A comment naming the wrong control is how
 * the next reader "fixes" something that was already right.
 */
const COMMAND_FIELDS = ['command', 'script', 'cmd'];
const PATH_FIELDS = ['file_path', 'notebook_path', 'filePath', 'path'];

/**
 * EVERY matching field, not the first. firstStringField below takes one and
 * discards the rest, which is how a decoy field stole a verdict from the field
 * the real tool uses.
 */
function allStringFields(input, fields) {
  const out = [];
  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) out.push({ field, value });
  }
  return out;
}

function firstStringField(input, fields) {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) return { field, value };
  }
  return null;
}

/**
 * The grant covering this path, or null. Returns {grant, rel}.
 *
 * THE GRANT IS MATCHED ON EVERY SPELLING THE PROTECTION USED, NOT ON THE ONE
 * THE CALLER TYPED. An earlier version compared only the LEXICAL path while
 * isProtectedPath decides over normalizedCandidates, which includes realpath --
 * so the two disagreed through a symlink and the grant won.
 *
 * Measured 2026-09-18: with a grant for `docs/notes.md`, making that path a
 * symlink to `../.claude/settings.json` and writing to it was ALLOWED, the write
 * landed on the hook configuration, and the notice named docs/notes.md. A grant
 * for any one path was a write permit for every protected path, and the
 * announcement pointed at the wrong file.
 *
 * So the grant must cover EVERY candidate this path resolves to. If the lexical
 * and resolved spellings disagree, no grant applies -- an override is a decision
 * about a named file, and a path that is two files is not the file anybody named.
 *
 * FACTORED OUT so the baseline-test branch cannot accidentally get a weaker
 * version of this. It had no grant check at all; giving it one by copying four
 * lines is how the symlink hole would have been reintroduced in a second place.
 */
function grantFor(filePath, cwd) {
  const root = path.resolve(cwd);
  const rels = normalizedCandidates(filePath, cwd)
    .map((abs) => path.relative(root, abs).split(path.sep).join('/'));
  if (rels.length === 0) return null;
  if (!rels.every((r) => overrideCovers(cwd, r))) return null;
  const grant = overrideCovers(cwd, rels[0]);
  /*
   * THE ANNOUNCEMENT NAMES THE FILE THAT GETS WRITTEN, NOT THE ONE THAT WAS
   * TYPED. rels[0] is the LEXICAL candidate -- the caller's spelling -- so a
   * grant for test/guardToolRoster.test.mjs, exercised through a symlink at
   * docs/notes.md, permitted correctly and then announced "docs/notes.md" while
   * a baseline test was rewritten. A reader auditing the transcript saw a doc
   * edit. Measured by audit; the permit half was hardened and the announcement
   * half was not, in the very commit whose comment says the hardening exists
   * because a grant "announced the wrong file".
   */
  return grant ? { grant, rel: canonicalGrantPath(cwd, filePath) } : null;
}

function judgeWrite(filePath, input, cwd, sessionId) {
  if (isProtectedPath(filePath, cwd)) {
    /*
     * THE ONE WAY THROUGH, AND IT IS NARROW, EXPIRING AND LOUD.
     *
     * Before this, EVERY guarded session was refused on src/guardSession.mjs and
     * src/shellAllowlist.mjs, so the guard could only be repaired by the
     * operator's terminal or by a session where the hook had never loaded --
     * and the second is a BUG being spent as a permission. Measured 2026-09-18:
     * four guard commits landed that way in one night because nothing was
     * watching the session that made them. A control that can only be fixed by
     * evading it trains everybody to evade it, and that loses every layer.
     *
     * A grant names EXACT paths, carries a reason and an expiry, and lives
     * outside the checkout beside the snapshots. It is not a trust boundary --
     * see the note on readOverride -- it is a narrow, recorded, self-closing
     * door in place of a wall people were already walking around.
     *
     * The permit is ANNOUNCED, never silent. A reader of the transcript sees
     * which path, on whose authority and until when, so an override nobody
     * granted is a question somebody can ask rather than a clean-looking run.
     */
    /*
     * THE GRANT IS MATCHED ON EVERY SPELLING THE PROTECTION USED, NOT ON THE
     * ONE THE CALLER TYPED. This compared only the LEXICAL path while
     * isProtectedPath decides over normalizedCandidates, which includes
     * realpathSync -- so the two disagreed through a symlink and the grant won.
     *
     * Measured 2026-09-18: with a grant for `docs/notes.md`, making that path a
     * symlink to `../.claude/settings.json` and writing to it was ALLOWED, the
     * write landed on the hook configuration, and the notice named docs/notes.md.
     * A grant for any one path was a write permit for every protected path, and
     * the announcement pointed at the wrong file.
     *
     * So: the grant must cover EVERY candidate this path resolves to. If the
     * lexical and resolved spellings disagree, no grant applies -- an override
     * is a decision about a named file, and a path that is two files is not the
     * file anybody named.
     */
    /*
     * THE GATE-SELF CHECK RUNS BEFORE THE GRANT, OR IT NEVER RUNS AT ALL.
     *
     * It was placed after the grant branch, so it was only reachable when there
     * was NO grant -- which is never the case D3 was about. The whole sequence
     * it was written to stop reproduced byte-identically after the "fix":
     * PreToolUse permitted under the grant, the write landed, and Stop blocked
     * the turn on the change it had just authorised. Found by the next audit,
     * which also noted the accompanying test wrote no grant and so could not
     * fail for the real reason.
     *
     * Ordering IS the fix. The Stop gate refuses a grant for these two paths
     * unconditionally, so PreToolUse must refuse one unconditionally too, or the
     * layers disagree and the operator spends a permission that cannot be spent.
     */
    const canonicalSelf = canonicalGrantPath(cwd, filePath);
    if (isGateSelfConfig(canonicalSelf)) {
      return deny('protected-control', `${filePath} configures the Stop gate itself. An override cannot cover it: the Stop gate refuses one for this path, so permitting the write here would spend a grant and still lose the turn. Change it from outside the session`);
    }

    const covered = grantFor(filePath, cwd);
    if (covered) {
      const { grant, rel } = covered;
      return {
        allowed: true,
        overridden: true,
        notice: `[agentbridge:protected-control-overridden] ${rel} is protected; an active override `
          + `permits it. Granted by ${grant.granted_by}, expires ${grant.expires_at}. Reason: ${grant.reason}`,
      };
    }
    /*
     * DO NOT ADVISE AN OVERRIDE THE STOP GATE WILL NOT HONOUR.
     *
     * For the gate's own hook configuration a grant is deliberately ignored at
     * Stop. Advising one here produced the worst possible sequence, measured end
     * to end by audit: PreToolUse permits, the write lands, and Stop blocks the
     * turn on the change it just authorised. The operator spends a grant, edits
     * a control, and gets refused anyway.
     *
     * That is the class f34aa51 exists to remove -- a refusal must not advise
     * something the same refusal would reject -- arriving one commit later
     * through a path that crosses two layers instead of one.
     */
    return deny('protected-control', `${filePath} is part of the guard or completion contract. An override must name it as ${canonicalSelf}`);
  }
  if (isSessionBaselineTest(filePath, cwd, sessionId)) {
    /*
     * A BASELINE TEST WAS THE ONE CONTROL WITH NO DOOR AT ALL, AND THAT IS AN
     * OVERSIGHT RATHER THAN A DECISION.
     *
     * The paragraph above argues that a control repairable only from the
     * operator's terminal or from a session whose hook never loaded is a BUG
     * being spent as a permission, and that this trains everybody to evade the
     * guard. That reasoning was applied to protected paths and not here.
     *
     * Measured 2026-09-18, exactly as predicted: the over-block ratchet in
     * test/guardToolRoster.test.mjs went red DEMANDING the deletion of two stale
     * entries, and no guarded session could perform it -- refused at PreToolUse
     * by this branch and re-refused at Stop by baselineTestDrift, with a grant
     * making no difference at either layer. A guarded agent diagnosed it exactly
     * and hit the wall. It was cleared by the one session whose hooks had never
     * loaded, which is the bug-as-permission this comment is about, happening in
     * front of us.
     *
     * The same narrow door, and it costs nothing the protected branch has not
     * already paid: exact paths, an expiry, a reason, a named grantor, and an
     * announcement on every permit. The grant resolution is SHARED with the
     * branch above rather than copied, so the symlink hardening cannot drift
     * apart between the two.
     *
     * WHAT THIS DELIBERATELY DOES NOT DO: there is no equivalent of
     * GATE_SELF_CONFIG here. That list exists because a grant must not let a
     * repaired file decide how long the Stop gate may look -- a grant scoped to
     * the check rather than to a file. A test does not set the gate's budget, so
     * the announcement carries the whole mitigation: a weakened baseline test is
     * permitted only while it is NAMED, by somebody, with an expiry, and it says
     * so in the transcript every time.
     */
    const covered = grantFor(filePath, cwd);
    if (covered) {
      const { grant, rel } = covered;
      return {
        allowed: true,
        overridden: true,
        notice: `[agentbridge:baseline-test-overridden] ${rel} was present when the session began; `
          + `an active override permits editing it. Granted by ${grant.granted_by}, `
          + `expires ${grant.expires_at}. Reason: ${grant.reason}`,
      };
    }
    /*
     * The refusal now names a route that WORKS. It previously named none, which
     * is the defect class this repository met three times in one day: guidance
     * whose audience cannot follow it.
     */
    /*
     * QUOTE THE SPELLING THAT ACTUALLY MATCHES. This said "naming this exact
     * path" and echoed filePath as typed -- but grant.paths is compared
     * literally against the CANONICAL form, so an operator who copied the quoted
     * spelling (TEST/GUARDTOOLROSTER.TEST.MJS, or a ./ prefix) wrote a grant that
     * did nothing at all. Advice that cannot be followed, in the commit that
     * added this message to stop doing exactly that.
     */
    return deny('baseline-test-immutable', `${filePath} was present when the session began; baseline tests are not editable from inside it. Ask the owner for an override naming ${canonicalGrantPath(cwd, filePath)}`);
  }
  const content = String(input.content ?? input.new_string ?? '');
  SKIP_MARKER.lastIndex = 0;
  if (/\.test\.mjs$/i.test(filePath) && SKIP_MARKER.test(content)) {
    return deny('test-disabled', `Refusing to create disabled test ${filePath}`);
  }
  return { allowed: true };
}

function judgeShell(command, cwd) {
  /*
   * ALLOWLIST, NOT DETECTION. Mutation used to be detected by extracting path
   * tokens, which closed the spellings it knew and nothing else: node -e,
   * python3 -c, eval, find -delete and perl -e were all allowed, measured
   * against the shipped guard. An interpreter builds paths at runtime and a
   * denylist of a programming language cannot win. So the question is now what
   * is KNOWN read-only, and everything else is refused.
   */
  /*
   * "INHERITED" IS ANSWERED BY GIT, BECAUSE THE SNAPSHOT CANNOT ANSWER IT.
   *
   * The session snapshot records PROTECTED files and baseline TESTS, not the
   * whole tree, so it cannot say whether `helper.mjs` existed at session start.
   * Tracked-in-HEAD is the available proxy and it separates the two cases that
   * matter: bin/agentbridge.mjs is committed, a script the session wrote one
   * tool call ago is not.
   *
   * FAILS CLOSED, consistent with the rest of this guard -- a tree git cannot
   * describe does not get a baseline either. If git cannot answer, the answer is
   * no, and `node <file>` is refused rather than assumed safe.
   */
  const mayExecute = (target) => {
    if (!cwd) return 'untracked-file';
    let rel;
    try {
      rel = path.relative(path.resolve(cwd), path.resolve(cwd, target)).split(path.sep).join('/');
    } catch {
      return 'untracked-file';
    }
    if (rel === '' || rel.startsWith('..')) return 'untracked-file';  // outside the repo is not inherited from it
    try {
      /*
       * A TREE IS NOT A FILE, AND cat-file -e CANNOT TELL YOU THAT.
       *
       * `-e` succeeds for a directory because a tree is an object, and
       * `git diff --quiet HEAD -- <dir>` says nothing about UNTRACKED files
       * inside it. So every tracked directory answered "inherited" no matter
       * what the session had just dropped into it, and node resolves a
       * directory operand to its main -- reopening the two-call disarm by
       * spelling the program as its parent:
       *
       *   Write src/index.js  <payload>   allowed (not protected, not a test)
       *   node src                        ALLOWED, and the payload executed
       *
       * Measured end to end. The statSync guard below, whose comment says "A
       * directory is not runnable either", was unreachable because this branch
       * returned first. a75fb5d was the commit titled "write node's grammar
       * down instead of guessing it" and `node <dir>` is part of that grammar;
       * the grammar was right and the oracle underneath it was not.
       *
       * Asking for the TYPE costs one more git call and answers it exactly.
       */
      const type = String(runGit(['cat-file', '-t', `HEAD:${rel}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
      if (type !== 'blob') return 'not-a-file';
      runGit(['cat-file', '-e', `HEAD:${rel}`], { cwd, stdio: 'ignore' });
      /*
       * THE NAME BEING IN HEAD IS NOT THE POINT. THE BYTES ARE.
       *
       * The first version asked only whether a blob existed at that path in
       * HEAD, which made every tracked, unprotected .mjs a free execution slot:
       *
       *   Write scripts/probe-git-branch-matcher.mjs  {"content":"evil"}   allowed
       *   node  scripts/probe-git-branch-matcher.mjs                       ALLOWED
       *
       * Two calls, no --test, no commit, and the commit message claiming the
       * residual was "three calls and a commit a reader can see" was wrong by
       * one call and one commit. Measured by audit at 2812d8a.
       *
       * So a path counts as inherited only while its working-tree content still
       * MATCHES what the repository shipped. Modify it and it becomes code this
       * session wrote, under a name the session did not choose. Committing it
       * first restores the property and leaves the trace, which is the residual
       * as it was always meant to read.
       */
      runGit(['diff', '--quiet', 'HEAD', '--', rel], { cwd, stdio: 'ignore' });
      return 'inherited';
    } catch { /* absent from HEAD, or present and modified: ask the disk */ }
    /*
     * NOT IN HEAD IS NOT THE SAME AS NOT A FILE. `status` is a subcommand and
     * `helper.mjs` is a payload, and treating both as untracked refused the
     * repository's own CLI. Only a real file on disk is a smuggling risk; a
     * token that is not a file cannot be executed by node at all.
     *
     * A directory is not runnable either, and existsSync alone would call one a
     * file. Anything that cannot be stat'd is treated as a file, because unknown
     * is not clean.
     */
    try {
      const abs = path.resolve(cwd, target);
      return statSync(abs).isFile() ? 'untracked-file' : 'not-a-file';
    } catch {
      return 'not-a-file';
    }
  };

  /*
   * WHAT A GIT PATHSPEC ACTUALLY COVERS, ANSWERED BY GIT.
   *
   * The rail cannot know: a pathspec is recursive and has magic prefixes,
   * negation and globs, so "src", ":/", "./", "*" and ":!nothing" all reach the
   * guard's own source without naming it. Enumerating those spellings is the
   * mistake this repository has now lost six times, so the grammar's owner is
   * asked instead.
   *
   * Only PROTECTED hits are returned -- this is not a file listing, it is the
   * question "does this operand reach a control". A pathspec git cannot parse,
   * or a repository it cannot read, yields nothing here and the caller falls
   * back to the literal check; that direction is the lenient one, and it is the
   * same posture as before this existed rather than a new hole.
   */
  /*
   * A GIT-BASH ABSOLUTE PATH IS A REAL PATH THAT git.exe CANNOT PARSE.
   *
   * Git Bash rewrites /c/Users/... to C:/Users/... before git.exe is executed,
   * but THIS guard runs git directly, so the rewrite never happens and git is
   * handed a pathspec it resolves to nothing. Nothing matched means no protected
   * hit, which means ALLOW -- while the shell the operator is actually typing
   * into runs the command against the real file:
   *
   *   git restore /c/Users/.../src/claudeGuard.mjs    ALLOW, and git reverts it
   *   git restore C:/Users/.../src/claudeGuard.mjs    correctly DENY
   *
   * Confirmed against real git: exit 0, the edit gone, porcelain empty. The
   * Windows spelling was already caught, so this was one spelling of one path
   * being invisible -- the same shape as the 8.3 aliases and the case variants,
   * for the third time. Translate it before asking, so git is asked about the
   * path the shell will actually use.
   */
  const MSYS_ABSOLUTE = /^\/\/?([A-Za-z])\/(.*)$/;
  const asWindowsPath = (operand) => {
    const m = MSYS_ABSOLUTE.exec(operand);
    return m ? `${m[1]}:/${m[2]}` : operand;
  };

  const pathspecCovers = (operand) => {
    if (!cwd || typeof operand !== 'string' || operand === '') return [];
    /*
     * --full-name IS LOAD-BEARING, NOT TIDINESS. git ls-files prints paths
     * relative to the CURRENT DIRECTORY, and these results are filtered with
     * isProtectedRelPath, which expects them relative to the REPOSITORY ROOT.
     * From any subdirectory the two disagree and every protected file became
     * invisible:
     *
     *   cwd=<repo>/test   git restore ../src/claudeGuard.mjs        ALLOW
     *   cwd=<repo>/test   git restore ../.claude/settings.json      ALLOW
     *
     * Confirmed against real git from <repo>/test: exit 0, the edit gone. The
     * guard was asking the right question and then measuring the answer against
     * the wrong origin. --full-name makes git answer in repo-root terms, which
     * is the only frame isProtectedRelPath has ever been written for.
     */
    try {
      const out = runGit(['ls-files', '-z', '--full-name', '--', asWindowsPath(operand)], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return String(out)
        .split(String.fromCharCode(0))
        .filter((f) => f !== '')
        .map((f) => f.split(String.fromCharCode(92)).join('/'))
        .filter((f) => isProtectedRelPath(f));
    } catch {
      return [];
    }
  };

  const verdict = judgeShellCommand(command, {
    isOverridden: (rel) => Boolean(cwd && overrideCovers(cwd, rel)),
    mayExecute,
    pathspecCovers,
  });
  /*
   * ANNOUNCE THE SHELL PERMIT TOO. The Edit announced itself and the commit that
   * recorded it did not, which is the same silence in a different layer -- and
   * the commit is the half that ends up in history.
   */
  if (verdict.allowed && verdict.overriddenPaths?.length && cwd) {
    /*
     * EVERY granted path is named. The first version announced only
     * verdict.overriddenPath while the rail had already collected the full list,
     * so a command exercising two protected paths under one grant reported one
     * of them and the data for the other was collected and thrown away.
     */
    const grants = verdict.overriddenPaths
      .map((rel) => [rel, overrideCovers(cwd, rel)])
      .filter(([, g]) => g);
    if (grants.length === verdict.overriddenPaths.length && grants.length > 0) {
      return {
        allowed: true,
        overridden: true,
        notice: `[agentbridge:protected-control-overridden] this command names ${grants.length} protected `
          + `path(s), all permitted by an active override: `
          + grants.map(([rel, g]) => `${rel} (granted by ${g.granted_by}, expires ${g.expires_at}, reason: ${g.reason})`).join('; '),
      };
    }
  }
  if (!verdict.allowed) {
    return deny('shell-not-allowlisted',
      `${verdict.reason}. Repository writes go through the structured edit tools, where the path is a field rather than a string to be parsed`);
  }

  /*
   * NO SECOND PATH CHECK. One was here and it refused `sed -n '1,20p' CLAUDE.md`
   * -- a READ of a protected file. The allowlist already guarantees the command
   * cannot write, so naming a protected path is not a reason to refuse.
   *
   * TWO RESIDUAL HOLES, NAMED RATHER THAN IMPLIED. `npm test` and `node --test`
   * execute JavaScript from the repository, and a test file the session created
   * is editable by design -- so a new test can call fs.unlinkSync. `npm run`
   * executes package.json scripts, which are protected from edits but were
   * whatever they were at session start. Neither is PREVENTED here. Both are
   * detected at Stop, by protected-file drift and baseline-test drift, which is
   * the same posture as an MCP write: caught afterwards, not blocked.
   */
  return { allowed: true };
}

export function evaluateClaudeTool({ tool_name: toolName, tool_input: input = {}, cwd = process.cwd(), session_id: sessionId = null } = {}) {
  if (typeof toolName !== 'string' || !input || typeof input !== 'object') {
    return deny('malformed-hook-input', 'Hook input is missing a tool name or tool input object');
  }

  /*
   * CHECKED BEFORE THE COMMAND AND PATH ROUTING, AND THAT ORDER IS THE WEAK
   * POINT OF THIS DESIGN. Read carries a file_path, so checking paths first
   * would refuse `Read CLAUDE.md`; SlashCommand carries a field literally named
   * `command` holding a slash-command name, so judging commands first would
   * refuse `/help` as an un-allowlisted shell command. Both are the kind of
   * refusal that gets a guard switched off.
   *
   * The cost is that this set now decides, and it is an ALLOW list: omitting a
   * tool blocks work LOUDLY and is fixed in one line, while wrongly adding a
   * tool that can execute or write is silent and reopens exactly the hole this
   * dispatch was rewritten to close. Nothing that can run a command or touch a
   * file belongs in it. Weigh an addition on that, not on convenience.
   */
  if (READ_ONLY_TOOLS.has(toolName)) return { allowed: true };

  /*
   * Workflow carries executable JavaScript in `script`. Treating it as read-only
   * bypassed both command and path routing merely because of the tool name. Until
   * Workflow execution is sandboxed independently, executable workflow payloads
   * are not a read operation and may not bypass the guard.
   */
  if (toolName === 'Workflow') {
    return deny('workflow-exec-untrusted', 'Workflow carries executable script content and is not a read-only tool');
  }

  /*
   * MCP tools keep the posture they already had: not blocked here, and detected
   * at Stop by protected-file drift ONLY WHEN THEY TOUCH A REPOSITORY FILE.
   *
   * FOR EVERYTHING ELSE THERE IS NO SECOND LAYER, AND SAYING "detected at Stop"
   * WITHOUT THIS SENTENCE WAS AN OVERCLAIM. A production migration, a deploy, a
   * sent email, a scheduled run: none of them writes a file in this repository,
   * so protected-file drift has nothing to compare and reports nothing. The
   * fallback named here is not a weaker layer for that class of action, it is no
   * layer at all.
   *
   * That is a fourth delegation to the Stop gate, after shellAllowlist's and the
   * two below -- and the only one where the destination structurally cannot see
   * what it is being asked to catch. Closing it needs a control that judges the
   * ACTION rather than the file it leaves behind, which is not this file's shape
   * and is not attempted here. Named so that nobody reads the posture above as
   * coverage it does not provide. (Found by an independent audit of 61bbeb2.) Blocking them at PreToolUse is a separate
   * decision with its own blast radius, and smuggling it into this repair would
   * make a security change nobody reviewed for that.
   */
  if (toolName.startsWith('mcp__')) return { allowed: true };

  /*
   * A TOOL CARRYING BOTH SHAPES IS JUDGED ON BOTH, AND THIS RETURNED ON THE
   * FIRST ONE IT FOUND.
   *
   * The comment above says tools are routed by the SHAPE of their input, and it
   * never considered an input carrying two shapes at once. Because the command
   * branch returned unconditionally, a decoy command field skipped the write
   * judgment entirely:
   *
   *   {"tool_name":"Write","tool_input":{"command":"ls",
   *                                      "file_path":"src/claudeGuard.mjs","content":"x"}}
   *     -> allowed, where the same call without the decoy is deny protected-control
   *
   * Found by audit. Whether a harness forwards unmodelled fields is not
   * something this layer should be betting on -- it is the layer that exists
   * because such bets were lost before. Both shapes are now judged and the
   * first refusal wins; a call that is somehow both a shell command and a write
   * has to satisfy the rules for both.
   */
  /*
   * EVERY FIELD OF EVERY SHAPE IS JUDGED, AND THE LEFTOVERS GO TO THE BACKSTOP.
   *
   * The previous repair judged a command AND a path, and then bet on field
   * ORDERING one line lower -- firstStringField takes the first match and throws
   * the rest away. PATH_FIELDS is scanned file_path, notebook_path, filePath,
   * path, and NotebookEdit's real parameter is notebook_path, so a decoy
   * file_path stole the verdict:
   *
   *   {"tool_name":"NotebookEdit","tool_input":{
   *      "file_path":"scratch.txt",
   *      "notebook_path":".claude/settings.json",
   *      "new_source":"{\"disableAllHooks\":true}"}}      -> ALLOWED
   *   the same call without the decoy                        -> deny protected-control
   *
   * That write removes the Stop hook as well, so prevention and detection went
   * together in one permitted call. I had written "whether a harness forwards
   * unmodelled fields is not something this layer should be betting on" in the
   * commit that made the bet.
   *
   * AND THE BACKSTOP WAS UNREACHABLE BEHIND THE RETURNS. Its own comment offers
   * "a hypothetical mover with source and destination" as the case it exists
   * for, and adding one benign field switched it off:
   *
   *   {"source":"a.txt","destination":".claude/settings.json"}              -> deny
   *   {"command":"ls","source":"a.txt","destination":".claude/settings.json"} -> ALLOWED
   *
   * So: judge every command field, judge every path field, then run the backstop
   * over WHAT NOBODY JUDGED. Scanning the whole input instead would refuse
   * `cat CLAUDE.md`, because a judged field legitimately names protected paths;
   * the backstop is for fields this guard has no model of, which is exactly the
   * set left over.
   */
  const commands = allStringFields(input, COMMAND_FIELDS);
  const targets = allStringFields(input, PATH_FIELDS);

  const notices = [];
  for (const c of commands) {
    const verdict = judgeShell(c.value, cwd);
    if (!verdict.allowed) return verdict;
    if (verdict.notice) notices.push(verdict.notice);
  }
  for (const t of targets) {
    const verdict = judgeWrite(t.value, input, cwd, sessionId);
    if (!verdict.allowed) return verdict;
    if (verdict.notice) notices.push(verdict.notice);
  }

  if (commands.length === 0 && SHELL_TOOL_NAMES.has(toolName)) {
    return deny('missing-command', `${toolName} did not provide a command string`);
  }

  /*
   * THE LEFTOVERS. Fields this guard has no model of still get the cheap last
   * look, whether or not a modelled field was present alongside them.
   */
  const judged = new Set([...commands, ...targets].map((f) => f.field));
  /*
   * ONLY FIELDS THAT NAME A PATH, NOT FIELDS THAT CONTAIN ONE.
   *
   * Scanning every unjudged field refused ordinary work within an hour of
   * shipping. `content`, `old_string`, `new_string`, `new_source`, `description`
   * and the strings inside `edits` legitimately CONTAIN protected path names --
   * they are the text being written, not the file being written to. Measured
   * against the parent, all newly refused:
   *
   *   Edit  {file_path:"docs/notes.md", old_string:"CLAUDE.md", new_string:"README.md"}
   *   Write {file_path:"docs/n.md", content:"CLAUDE.md"}
   *   Bash  {command:"ls", description:"CLAUDE.md"}
   *
   * With seventeen protected entries including package.json, CLAUDE.md and five
   * src module paths, that is every import-path rename and every doc edit that
   * mentions the rules. The commit that introduced it justified the design by
   * saying a whole-input scan "would refuse cat CLAUDE.md" -- and then
   * reintroduced exactly that class for the unjudged half. Its own test only
   * exercised content:'x', so it stayed green while the regression shipped.
   *
   * The backstop's stated purpose is "a protected path appearing in some field
   * name nobody anticipated -- a hypothetical mover with source and
   * destination". Both of those NAME a path, and so does any spelling of the
   * same idea. So the filter is on the KEY, by shape rather than by a list of
   * known-bad field names: a key that reads like a location is scanned, a key
   * that reads like payload is not.
   *
   * This is a backstop and is documented as not a boundary, so a path hidden in
   * a field called `arg1` is missed. That is the direction this check is
   * allowed to fail in; refusing a doc edit is not.
   */
  const unmodelled = Object.fromEntries(
    Object.entries(input).filter(([k]) => !judged.has(k)),
  );
  const mention = protectedMentionIn(unmodelled, cwd);
  if (mention) {
    return deny('protected-control',
      `${toolName} names ${mention}, which is part of the guard or completion contract`);
  }

  if (commands.length > 0 || targets.length > 0) {
    /*
     * EVERY granted path is announced. Returning one verdict discarded the
     * other's notice, so a write to a protected file could be permitted while
     * the message named a different file -- the misdirection this file already
     * records twice.
     */
    return notices.length
      ? { allowed: true, overridden: true, notice: notices.join(' | ') }
      : { allowed: true };
  }

  if (STRUCTURED_EDIT_TOOLS.has(toolName)) {
    return deny('missing-write-path', `${toolName} did not provide a path`);
  }

  /*
   * DEFAULT DENY WAS HERE AND COST TOO MUCH. Refusing every tool this guard
   * could not classify refused 24 of a real 54-tool roster -- Artifact, CronList,
   * ListSkills, SendUserFile, PushNotification and eighteen others, none of which
   * can touch a repository file. That is not a guard, it is an outage, and an
   * outage gets the hook switched off, which loses every layer at once.
   *
   * Denying by unknown NAME was the same enumeration mistake as allowing by
   * known name, failing in the other direction. A tool with no command and no
   * path field cannot address a repository file through anything this guard can
   * see, so the honest verdict is the one the MCP tools already get: not blocked
   * here, detected at Stop by protected-file drift.
   *
   * THE BACKSTOP IS NOT A BOUNDARY. It is a cheap last look for a protected path
   * appearing in some field name nobody anticipated -- a hypothetical mover with
   * `source` and `destination`. Detection loses in general, which is why it sits
   * UNDER the shape routing rather than in place of it.
   *
   * It now runs above, over the fields no shape claimed, so a benign `command`
   * or `path` alongside them no longer switches it off.
   */
  return { allowed: true };
}

/*
 * Every string anywhere in the tool input, including nested objects and arrays.
 * Depth- and count-bounded because this runs on every tool call and a hook that
 * hangs is a hook somebody disables.
 */
/*
 * THE KEY DECIDES, AT EVERY DEPTH, AND A FIRST ATTEMPT AT THIS FILTERED ONLY THE
 * TOP LEVEL.
 *
 * A string is tested only when the key holding it reads like a LOCATION. That is
 * what separates a mover's `destination` from an editor's `old_string`: one
 * names a file, the other is the text being written. Scanning every string
 * refused ordinary work -- an Edit whose replacement mentions CLAUDE.md, a Write
 * whose content does, a Bash whose description does.
 *
 * Filtering the input before recursing was wrong in the other direction: a
 * path-shaped key can be NESTED under a container whose own name is not, and
 * `{ops:[{to:"docs/ORDER.md"}]}` was then skipped wholesale. Containers are
 * always traversed; only leaf strings are gated, by their own key.
 *
 * An array's elements inherit the key of the array that holds them, so
 * `{paths:["CLAUDE.md"]}` is tested and `{edits:[{old_string:"CLAUDE.md"}]}` is
 * not.
 *
 * Still a backstop and still not a boundary: a path under a key called `arg1` is
 * missed. That is the direction this is allowed to fail in.
 */
/*
 * A KEY READS LIKE A LOCATION -- AND THE FIRST VERSION COULD NOT SEE camelCase.
 *
 * The alternatives were delimited by underscore or a string boundary, so
 * `filename`, `filePath`, `outputPath`, `targetFile`, `destPath`, `newPath` and
 * `dst` never matched. That REOPENED keys the previous commit had closed -- it
 * missed the most common path key in existence, while this file's own
 * PATH_FIELDS already lists camelCase `filePath`, so the codebase models a
 * convention its backstop could not express.
 *
 * SUBSTRING FOR THE UNAMBIGUOUS STEMS, WORD MATCH FOR THE SHORT ONES, and the
 * split is not tidiness. `source` as a substring matches `new_source`, which is
 * NotebookEdit's CONTENT field -- so a loose list here walks straight back into
 * the over-block that refused ordinary edits an hour ago. `to` as a substring
 * matches `prototype` and `history`. Those go in the word list, matched only as
 * whole words after splitting on camelCase and punctuation.
 *
 * TWO THINGS HERE WERE WRONG AND ARE FIXED, BOTH FOUND BY BLIND AUDIT ON THE
 * COMMIT THAT INTRODUCED THEM (2026-09-18).
 *
 * ONE: the splitter could not see an ALL-CAPS key. `(?=[A-Z])` splits before
 * EVERY capital, so 'SRC' became ['','S','R','C'] and matched no word. These all
 * went DENY -> ALLOW, a straight regression from the regex this replaced:
 *
 *   {"SRC":"src/claudeGuard.mjs","DST":"tmp/x"}   {"TO":"CLAUDE.md"}
 *   {"FROM":"src/guardSession.mjs"}
 *
 * The old `(^|_)` regex caught them because it matched whole tokens without
 * caring about case. Splitting on camelCase without handling acronym runs is
 * "one alias class, not the property" -- the exact mistake the commit was
 * written to correct, repeated on identifier case inside the correction.
 *
 * TWO: `source` was put in NEITHER list, on the reasoning that "a mover carrying
 * `source` also carries `destination`, which is caught". That reasoning is
 * simply wrong. The check fires on the VALUE, not the key: a mover's
 * destination VALUE is some scratch path, so nothing is caught and
 * {"source":"src/claudeGuard.mjs"} sailed through.
 *
 * The real constraint was never `source`. It was `new_source`, NotebookEdit's
 * CONTENT field, which must not be read as a path or every notebook edit is
 * refused. That is one exact key, so it is excluded as one exact key rather than
 * by dropping the whole word -- a carve-out the size of the actual exception.
 */
const PATH_STEM = /(path|file|dir|folder|dest|target|location|url|uri)/i;
const PATH_WORD = new Set(['to', 'from', 'dst', 'src', 'source']);

/*
 * Keys whose value is CONTENT, not a location. Matched on the whole key, lower
 * cased, so `source` can stay in PATH_WORD above.
 */
const CONTENT_KEY = new Set(['new_source', 'old_source']);

/*
 * Split an identifier into lower-cased words, handling acronym runs:
 *   'SRC' -> ['src']          'filePath'   -> ['file','path']
 *   'TO'  -> ['to']           'HTTPSource' -> ['http','source']
 *   'new_source' -> ['new','source']
 */
const identifierWords = (key) => key
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((w) => w.toLowerCase());

/*
 * A PLURAL IS THE SAME WORD. `sources` is the natural name for a mover's input
 * list and it is the sharpest miss here, given that the reasoning which removed
 * `source` from this list in the first place was explicitly about movers. Also
 * measured walking through: srcs, SRCS, froms, tos, and the array form
 * {"sources":["src/claudeGuard.mjs"]}, which inherits its key from the parent.
 *
 * Handled as a PROPERTY of the word rather than by adding five more strings,
 * which is the mistake this file has now made in three different places.
 *
 * DELIBERATELY NOT ADDED, and the restraint is the point: origin, input, output,
 * name, entry, module, template, asset. Each was measured walking through, and
 * each is a word whose value is USUALLY NOT A PATH -- `name` especially. This is
 * a BACKSTOP for fields nobody anticipated, not the boundary; PATH_FIELDS and the
 * shell rail are the boundary. Widening it until it matches every key that could
 * ever hold a path converts it into a general refusal of unknown tools, which is
 * failure mode 19 (a list of names fails in BOTH directions) arriving from the
 * permissive side. If one of those words turns up carrying a control in a real
 * payload, add it then, with the payload in the commit message.
 */
const isPathShapedKey = (key) => {
  if (typeof key !== 'string' || key === '') return false;
  if (CONTENT_KEY.has(key.toLowerCase())) return false;
  if (PATH_STEM.test(key)) return true;
  return identifierWords(key).some(
    (w) => PATH_WORD.has(w) || (w.endsWith('s') && PATH_WORD.has(w.slice(0, -1))),
  );
};

function protectedMentionIn(input, cwd, depth = 0, seen = { n: 0 }, inheritedKey = null) {
  if (depth > 4 || seen.n > 200) return null;
  const entries = Array.isArray(input)
    ? input.map((v) => [inheritedKey, v])
    : (input && typeof input === 'object' ? Object.entries(input) : []);
  for (const [key, value] of entries) {
    seen.n += 1;
    if (typeof value === 'string') {
      if (value.length === 0 || value.length > 4096) continue;
      if (!isPathShapedKey(key)) continue;
      if (isProtectedPath(value, cwd)) return value;
    } else if (value && typeof value === 'object') {
      const hit = protectedMentionIn(value, cwd, depth + 1, seen, key);
      if (hit) return hit;
    }
  }
  return null;
}

export function hookDecision(result) {
  /*
   * AN OVERRIDDEN PERMIT MUST LOOK DIFFERENT FROM AN ORDINARY ONE, AND IT DID
   * NOT. This returned a bare `{}` for every allow, so the notice built in
   * judgeWrite was discarded here and the override was byte-identical to a
   * normal approval on stdout. The commit that introduced the channel claimed
   * "it ANNOUNCES itself with the path, the grantor, the expiry and the reason"
   * and the source said "The permit is ANNOUNCED, never silent"; both were false
   * as shipped. The unit test asserted the notice on evaluateClaudeTool's return
   * value and never called this function, which is why nothing caught it.
   *
   * That mattered more than a missing log line. The channel's whole safety
   * argument is that a forged grant "does not vanish into a clean run" -- and a
   * silent permit is exactly a clean run. Found by audit, 2026-09-18.
   */
  if (result?.allowed === true && result?.overridden === true && result?.notice) {
    return { systemMessage: result.notice };
  }
  if (result?.allowed === true) return {};
  const id = result?.id ?? 'guard-error';
  const reason = result?.reason ?? 'Guard could not establish that this operation is safe';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[agentbridge:${id}] ${reason}. This guard fails closed; ask the owner for an intentional override.`,
    },
  };
}
