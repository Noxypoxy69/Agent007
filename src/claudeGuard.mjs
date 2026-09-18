import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { readSnapshot, isBaselineTest, isProtectedRelPath, overrideCovers } from './guardSession.mjs';
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
  try {
    out.push(realpathSync(absolute).replaceAll('\\', '/'));
  } catch {
    try {
      out.push(path.join(realpathSync(path.dirname(absolute)), path.basename(absolute)).replaceAll('\\', '/'));
    } catch {
      // A missing parent is still judged by its lexical absolute path.
    }
  }
  return [...new Set(out)];
}

export function isProtectedPath(filePath, cwd = process.cwd()) {
  const root = path.resolve(cwd);
  return normalizedCandidates(filePath, cwd).some((candidate) => {
    const rel = path.relative(root, candidate).split(path.sep).join('/');
    if (rel.startsWith('..')) return false;      // outside the repo is not ours to judge
    return isProtectedRelPath(rel);
  });
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
    const root = path.resolve(cwd);
    const rels = normalizedCandidates(filePath, cwd)
      .map((abs) => path.relative(root, abs).split(path.sep).join('/'));
    const rel = rels[0];
    const grant = rels.length > 0 && rels.every((r) => overrideCovers(cwd, r))
      ? overrideCovers(cwd, rel)
      : null;
    if (grant) {
      return {
        allowed: true,
        overridden: true,
        notice: `[agentbridge:protected-control-overridden] ${rel} is protected; an active override `
          + `permits it. Granted by ${grant.granted_by}, expires ${grant.expires_at}. Reason: ${grant.reason}`,
      };
    }
    return deny('protected-control', `${filePath} is part of the guard or completion contract`);
  }
  if (isSessionBaselineTest(filePath, cwd, sessionId)) {
    return deny('baseline-test-immutable', `${filePath} was present when the session began; baseline tests are not editable from inside it`);
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

  const verdict = judgeShellCommand(command, {
    isOverridden: (rel) => Boolean(cwd && overrideCovers(cwd, rel)),
    mayExecute,
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
function protectedMentionIn(input, cwd, depth = 0, seen = { n: 0 }) {
  if (depth > 4 || seen.n > 200) return null;
  const values = Array.isArray(input) ? input : (input && typeof input === 'object' ? Object.values(input) : []);
  for (const value of values) {
    seen.n += 1;
    if (typeof value === 'string') {
      if (value.length === 0 || value.length > 4096) continue;
      if (isProtectedPath(value, cwd)) return value;
    } else if (value && typeof value === 'object') {
      const hit = protectedMentionIn(value, cwd, depth + 1, seen);
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
