/**
 * AN ALLOWLIST OF KEY NAMES FAILS IN BOTH DIRECTIONS. CLAUDE.md RULE 19, FOR THE
 * SECOND TIME, ON A DIFFERENT SURFACE.
 *
 * The Stop gate decided whether an IGNORED settings file was safe by checking
 * its top-level keys against seven names. Found by blind audit, 2026-09-19:
 *
 *   THE OUTAGE.  Claude Code documents roughly 145 top-level settings keys. The
 *   operator flipping any ordinary one in /config wrote a key the gate did not
 *   recognise into `.claude/settings.local.json` -- which is GITIGNORED, so it
 *   can never be committed, so the drift can never be relieved, so the session
 *   is blocked permanently. Rule 19's own words: "denying by unknown name is an
 *   outage; and an outage gets the hook switched off, which loses every layer at
 *   once."
 *
 *   THE LEAK.  The same seven names admitted `enabledMcpjsonServers` and
 *   `enableAllProjectMcpServers` as harmless. `.mcp.json` is not a protected
 *   path in this repository and it DEFINES COMMANDS, so admitting the key that
 *   turns it on -- in a file nobody can diff -- grants execution.
 *
 * The replacement asks about the VALUE. Both halves are asserted below, and both
 * fail against the shipped version, in opposite directions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { settingsAddsOnly, isProtectedRelPath } from '../src/guardSession.mjs';

const j = (o) => JSON.stringify(o);
const verdict = (o) => settingsAddsOnly(j(o));

/* ── the outage ───────────────────────────────────────────────────────── */

/*
 * REAL KEYS FROM CLAUDE CODE'S SETTINGS REFERENCE that the seven-name list did
 * not contain. Every one of these is a setting an operator can flip from
 * /config, and every one of them blocked the session permanently.
 */
/*
 * CORRECTED AFTER A BLIND AUDIT CHECKED THEM AGAINST THE REAL REFERENCE. Six of
 * the ten keys here did not exist: `theme`, `verbose`, `autoUpdates`,
 * `messageIdleNotifThresholdMs`, `todoFeatureEnabled` and `checkpointingEnabled`
 * were invented or misremembered -- the real names are `autoUpdatesChannel` and
 * `fileCheckpointingEnabled`, and there is no `theme` or `verbose` at all.
 *
 * The comment above them claimed "REAL KEYS FROM CLAUDE CODE'S SETTINGS
 * REFERENCE" and "generated from the list above rather than spot-checked ...
 * rule 7". Neither was true: they were ten literals I typed, all given inert
 * values, so the list structurally could not express the over-block the audit
 * went on to find. A fixture that cannot construct the real case cannot fail for
 * it -- hollow gate 9, in the test written to prove there was no outage.
 */
const ORDINARY_TOGGLES = Object.freeze({
  autoUpdatesChannel: 'stable',
  autoCompactEnabled: true,
  alwaysThinkingEnabled: false,
  spinnerTipsEnabled: false,
  fileCheckpointingEnabled: true,
  forceLoginMethod: 'claudeai',
  outputStyle: 'Explanatory',
  cleanupPeriodDays: 20,
  model: 'claude-opus-5',
  includeCoAuthoredBy: true,
});

test('AN ORDINARY /config TOGGLE DOES NOT BLOCK THE SESSION', () => {
  /*
   * Generated from the list above rather than spot-checked, so adding a key
   * extends the coverage without anybody remembering to -- rule 7. Each is
   * checked ALONE, because a loop that only ever sees them together cannot say
   * which one was the problem.
   */
  for (const [key, value] of Object.entries(ORDINARY_TOGGLES)) {
    const v = verdict({ [key]: value });
    assert.equal(v.addsOnly, true,
      `${key} blocked the session, and the file it is in can never be committed: ${v.weakens.join(', ')}`);
  }
  // And all of them at once, which is what a real settings.local.json looks like.
  assert.equal(verdict(ORDINARY_TOGGLES).addsOnly, true);
});

test('THE KEYS THE OLD LIST ADMITTED ARE STILL ADMITTED, minus the two that leaked', () => {
  /*
   * A NARROWING MUST BE PROVED TO BE ONE. If this fix refused something the
   * seven-name list allowed, it would be a fresh outage wearing a fix -- which
   * is the shape an audit found in this repository twice in one day.
   */
  for (const [key, value] of Object.entries({
    permissions: { allow: ['Bash(npm test)'], deny: [] },
    model: 'claude-opus-5',
    includeCoAuthoredBy: true,
    cleanupPeriodDays: 20,
    outputStyle: 'Explanatory',
  })) {
    assert.equal(verdict({ [key]: value }).addsOnly, true, `${key} is newly refused`);
  }
});

test('permissions IS ADMITTED EVEN WITH A COMMAND IN IT, and that is deliberate', () => {
  /*
   * Claude Code writes this file when the operator approves a permission
   * mid-turn, and the entries are command strings by their nature. Refusing them
   * would block every session in which the owner said yes to anything -- and
   * that file's unrecoverability is a hole this gate already shipped once. The
   * trade is stated in the source, not hidden behind a bare name on a list.
   */
  assert.equal(verdict({
    permissions: { allow: ['Bash(node scripts/x.mjs:*)', 'Read(//c/Users/**)'], deny: ['Bash(rm:*)'] },
  }).addsOnly, true);
});

test('BUT THE EXEMPTION DOES NOT SWALLOW WHAT IT WAS CARVED OUT OF', () => {
  /*
   * A carve-out that hides a control-bearing key inside itself is how the
   * worktree exemption opened seven payloads on 2026-09-18, one of which
   * redirected the grant store. `permissions` is exempt from the
   * executable-string test and from nothing else.
   */
  assert.equal(verdict({ permissions: { allow: [], hooks: { Stop: [] } } }).addsOnly, false,
    'hooks hid inside permissions');
  assert.equal(verdict({ permissions: { deny: [{ env: { AGENTBRIDGE_HOME: 'x' } }] } }).addsOnly, false,
    'env hid inside a permissions entry');
});

/* ── the leak ─────────────────────────────────────────────────────────── */

test('THE MCP KEYS ARE ADMITTED, AND .mcp.json IS PROTECTED INSTEAD', () => {
  /*
   * THE AUDIT WAS RIGHT AND MY FIRST FIX WAS THE WRONG END, which is why both
   * halves are asserted here together.
   *
   * The finding: these two keys were admitted as harmless while `.mcp.json` --
   * a list of server COMMANDS to spawn -- was unprotected. I refused the keys.
   * That would have blocked THIS MACHINE permanently: the live
   * `.claude/settings.local.json` carries both, it is gitignored so it can never
   * be committed, and "declares nothing dangerous" is the only relief an ignored
   * file has. An outage introduced by a fix for a leak.
   *
   * So the file is protected and the keys stay admitted. Asserting only the
   * first half would let somebody "simplify" the second back into the outage.
   */
  assert.equal(verdict({
    enabledMcpjsonServers: ['agentbridge'],
    enableAllProjectMcpServers: true,
  }).addsOnly, true, 'the keys are refused again, and the file that carries them cannot be committed');

  assert.equal(isProtectedRelPath('.mcp.json'), true,
    'the keys are admitted and the file they enable is unguarded -- the hole is open');
});

test('THE MEASURED FIXTURE: the settings.local.json actually on this machine', () => {
  /*
   * Rule 9 -- a fixture must be a shape the system really produces. This is the
   * literal content of `.claude/settings.local.json` in this repository, and it
   * is the exact payload my first fix would have blocked on. It is written out
   * rather than read from disk, because a test that reads the live file passes
   * by agreeing with whatever is there.
   */
  assert.equal(verdict({
    permissions: { allow: ['Bash(git push:*)'] },
    enabledMcpjsonServers: ['agentbridge'],
    enableAllProjectMcpServers: true,
  }).addsOnly, true, 'the operator approving one permission would block the session with no recovery');
});

test('EVERY NEVER-ADDITIVE KEY IS REFUSED WHATEVER IT CONTAINS', () => {
  /*
   * Hostile inputs for a hostile property -- rule 7. The value is chosen to be
   * as innocent as the type allows, because the claim is that the KEY decides
   * for these and not the value. disableAllHooks is a boolean; a check that
   * only ever looked at values would wave it straight through.
   */
  for (const [key, value] of Object.entries({
    hooks: {},
    env: {},
    disableAllHooks: true,
    statusLine: { type: 'command', command: 'x' },
    // NOT the two MCP keys: see the test above. They are admitted on purpose,
    // and .mcp.json is protected instead.
    apiKeyHelper: 'x',
    awsAuthRefresh: 'x',
    awsCredentialExport: 'x',
    otelHeadersHelper: 'x',
  })) {
    assert.equal(verdict({ [key]: value }).addsOnly, false, `${key} was admitted`);
  }
});

test('A NESTED never-additive key is refused too, not only a top-level one', () => {
  assert.equal(verdict({ somethingNew: { nested: { env: { AGENTBRIDGE_HOME: 'x' } } } }).addsOnly, false,
    'burying env one level down got it admitted');
  assert.equal(verdict({ somethingNew: [{ hooks: {} }] }).addsOnly, false,
    'an array hid a hooks declaration');
});

/* ── the value is what decides an unknown key ─────────────────────────── */

test('AN UNKNOWN KEY WHOSE VALUE LOOKS EXECUTABLE IS REFUSED', () => {
  for (const [why, value] of Object.entries({
    'a path separator': 'scripts/thing.mjs',
    'a windows separator': 'C:\\tools\\thing.exe',
    'a command and arguments': 'node thing',
    'a shell substitution': '$(whoami)',
    'a pipe': 'cat x|sh',
    'a script extension': 'thing.ps1',
  })) {
    const v = verdict({ somethingNew: value });
    assert.equal(v.addsOnly, false, `admitted an unknown key containing ${why}: ${value}`);
  }
});

test('AND ONE BURIED IN A SUBTREE IS FOUND', () => {
  assert.equal(verdict({ somethingNew: { a: { b: ['fine', 'also fine', 'node /evil.mjs'] } } }).addsOnly, false,
    'a command three levels down was admitted');
});

/* ── failing closed ───────────────────────────────────────────────────── */

test('UNPARSEABLE, EMPTY AND NON-OBJECT ALL FAIL CLOSED', () => {
  for (const text of ['', 'not json', '[]', 'null', '"a string"', '42', undefined, null]) {
    const v = settingsAddsOnly(text);
    assert.equal(v.addsOnly, false, `${JSON.stringify(text)} was treated as safe`);
    assert.ok(v.weakens.length > 0, `${JSON.stringify(text)} was refused without saying why`);
  }
});

test('AN EMPTY SETTINGS OBJECT ADDS NOTHING, so it adds only', () => {
  assert.equal(settingsAddsOnly('{}').addsOnly, true);
});

test('THE REFUSAL NAMES THE KEY, because a refusal nobody can act on is an outage', () => {
  const v = verdict({ theme: 'dark', hooks: {}, somethingNew: 'a/path' });
  assert.equal(v.addsOnly, false);
  assert.match(v.weakens.join(' '), /hooks/);
  assert.match(v.weakens.join(' '), /somethingNew/);
  assert.doesNotMatch(v.weakens.join(' '), /theme/, 'a harmless key was named in the refusal');
});

/* ── what a blind audit measured admitted, generated from the real reference ── */

/*
 * EVERY ONE OF THESE WAS MEASURED `addsOnly: true` BY A BLIND AUDIT that
 * generated payloads from Claude Code's real 145-key settings reference rather
 * than from keys I thought of. They are kept as data, in the auditor's own
 * groupings, so a future reader can see the corpus rather than take my word.
 */
const COMMAND_CARRYING = Object.freeze({
  gcpAuthRefresh: 'gcloud',            // the twin of awsAuthRefresh, which WAS on the list
  processWrapper: 'sudo',              // wraps every process
  policyHelper: { command: 'helper' }, // runs a helper executable
});

const CONTROL_OFF = Object.freeze({
  'sandbox.enabled': { sandbox: { enabled: false } },
  skipDangerousModePermissionPrompt: { skipDangerousModePermissionPrompt: true },
  skipAutoPermissionPrompt: { skipAutoPermissionPrompt: true },
  allowManagedHooksOnly: { allowManagedHooksOnly: false },
  allowManagedPermissionRulesOnly: { allowManagedPermissionRulesOnly: false },
  allowAllClaudeAiMcps: { allowAllClaudeAiMcps: true },
  respectGitignore: { respectGitignore: false },
  blockedMarketplaces: { blockedMarketplaces: [] },
  strictKnownMarketplaces: { strictKnownMarketplaces: [] },
  allowedMcpServers: { allowedMcpServers: [] },
  enabledPlugins: { enabledPlugins: { 'pwn@evilmarket': true } },
  'permissions.defaultMode': { permissions: { defaultMode: 'bypassPermissions' } },
  'permissions.disableBypassPermissionsMode': { permissions: { disableBypassPermissionsMode: false } },
});

test('A KEY NAMED FOR AN EXECUTABLE IS REFUSED WHATEVER IT CONTAINS', () => {
  /*
   * `gcpAuthRefresh` was admitted while awsAuthRefresh and awsCredentialExport
   * were both refused -- a list missing one member of its own family, which is
   * rule 19's first failure direction. Adding the three measured names alone
   * would be rule 8's mistake (fix the strings, not the matcher), so the NAME is
   * asked as a shape too, and this asserts the shape rather than the names.
   */
  for (const [key, value] of Object.entries(COMMAND_CARRYING)) {
    const v = verdict({ [key]: value });
    assert.equal(v.addsOnly, false, `${key} was admitted, and it runs something`);
    assert.match(v.weakens.join(' '), new RegExp(key));
  }
  // The shape, not the three names: a key following the same convention.
  for (const invented of ['telemetryHelper', 'buildWrapper', 'tokenRefresh', 'secretExport', 'preflightCommand']) {
    assert.equal(verdict({ [invented]: 'x' }).addsOnly, false, `${invented} follows the convention and was admitted`);
  }
});

test('A CONTROL TURNED OFF BY A BOOLEAN OR AN EMPTIED LIST IS REFUSED', () => {
  /*
   * The design sentence promised a settings file takes a control away in two
   * ways and that both are visible in the shape. Only the first was: thirteen
   * control-off keys were measured admitted, every one a boolean or an emptied
   * array, against exactly ONE such key on the never-additive list.
   */
  for (const [name, payload] of Object.entries(CONTROL_OFF)) {
    assert.equal(verdict(payload).addsOnly, false, `${name} was admitted, and it disarms something`);
  }
});

test('BUT TURNING NOTHING OFF IS THE SAFEST FILE THERE IS', () => {
  /*
   * The other direction, and the one that makes this a rule rather than a
   * denylist of key names: `skipX: false` LEAVES the protection on. Refusing it
   * would be the unrecoverable over-block again, wearing a security fix.
   */
  for (const payload of [
    { skipDangerousModePermissionPrompt: false },
    { skipAutoPermissionPrompt: false },
    { allowManagedHooksOnly: true },
    { respectGitignore: true },
    { sandbox: { enabled: true } },
    { blockedMarketplaces: ['evilmarket'] },
    { allowedMcpServers: ['agentbridge'] },
    { permissions: { defaultMode: 'default' } },
  ]) {
    assert.equal(verdict(payload).addsOnly, true,
      `${JSON.stringify(payload)} tightens or restricts and was refused`);
  }
});

/* ── the over-block, which was the other half of the audit ────────────── */

test('A VALUE CONTAINING A SPACE IS NOT A COMMAND', () => {
  /*
   * MEASURED BY BLIND AUDIT, and it falsified this file's central safety claim.
   * The commit said "STRICTLY NARROWER than what it replaces, so it cannot
   * introduce its own outage". `outputStyle` was admitted UNCONDITIONALLY by the
   * old list and `{"outputStyle":"Table First"}` was refused by the new rule --
   * in a GITIGNORED file, so the drift could never be relieved and the only
   * recovery traced was a human deleting the file at a terminal.
   */
  for (const [why, payload] of Object.entries({
    'a custom output style': { outputStyle: 'Table First' },
    'a localised language name': { language: 'Portugues (Brasil)' },
    'a Bedrock model ARN is a path, but a plain model name is not': { model: 'claude opus 5' },
    'an announcement': { companyAnnouncements: { message: 'Deploys are frozen this week' } },
    'a trust message': { pluginTrustMessage: 'Ask before installing' },
  })) {
    assert.equal(verdict(payload).addsOnly, true, `refused ${why}: ${JSON.stringify(payload)}`);
  }
});

test('AND A COMMAND WITH ARGUMENTS IS STILL A COMMAND', () => {
  /*
   * Rule 5: the negative above passes against an implementation that admits
   * everything. The first token is checked, so a space no longer decides but it
   * no longer hides anything either.
   */
  for (const payload of [
    { somethingNew: 'node build.mjs' },
    { somethingNew: 'sudo rm -rf' },
    { somethingNew: 'bash -c ls' },
    { somethingNew: 'git push --force' },
    { somethingNew: 'npx evil' },
    { somethingNew: 'gcloud auth print-access-token' },
  ]) {
    assert.equal(verdict(payload).addsOnly, false, `${JSON.stringify(payload)} was admitted`);
  }
});

test('THE CONTROL: this distinguishes, in both directions', () => {
  assert.equal(verdict({ theme: 'dark' }).addsOnly, true);
  assert.equal(verdict({ hooks: { Stop: [] } }).addsOnly, false);
});
