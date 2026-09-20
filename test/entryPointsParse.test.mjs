/**
 * A PROGRAM THAT DOES NOT PARSE MUST NEVER REACH A BEHAVIOURAL TEST.
 *
 * bin/agentbridge.mjs was committed with a SyntaxError and stayed broken for
 * three commits. A word quoted in backticks inside the help template literal
 * closed the literal, and the rest of the help became code:
 *
 *     node --check bin/agentbridge.mjs
 *     SyntaxError: Unexpected identifier 'observed'    line 192
 *
 * Every entry point that shells out to the CLI was dead for those three
 * commits, including `register-session`, which the SessionStart poll hook
 * spawns -- so sessions silently stopped registering and the roster emptied.
 * The symptom was read as a liveness problem for hours.
 *
 * WHY IT SURVIVED, CORRECTED. I first wrote here that the existing suites
 * stayed green because they assert on stdout and a dead process produces
 * none. A blind audit measured that and it is FALSE -- with the broken CLI
 * restored, taskChecklistCli goes 0 pass / 6 fail and cliDiscoverable 2/1.
 * They were never hollow. I reproduced it before accepting it.
 *
 * The outage survived three commits because NOBODY RAN THE SUITE, including
 * me. This gate does not fix that and must not be read as fixing it.
 *
 * TWO FIGURES I PUBLISHED WERE WRONG. b62e7fa's message reports the baseline
 * as "6 pass / 0 fail" and both mutations as "5 pass / 1 fail", then closes
 * with "7 tests in the file, 7 pass" -- contradicting itself two paragraphs
 * apart. The tree shipped seven tests; measured, the baseline is 7 pass / 0
 * fail and each mutation is 6 pass / 1 fail. The conclusions held and the
 * numbers described a six-test tree that did not exist. A second auditor
 * found it in the commit whose own section is headed "AND ONE PUBLISHED
 * FIGURE WAS WRONG".
 *
 * ONE FIGURE I PUBLISHED WAS WRONG, and an auditor could not reproduce it.
 * 64d0971's message reports the narrowed simulation as "5 pass / 1 fail".
 * That was a tree with the hooks and scripts REMOVED, which trips one
 * coverage assertion. Narrowing `executed()` itself to DEFAULT_ENTRY_POINTS
 * -- which is what "the old behaviour" actually means -- turns three tests
 * red, not one. The conclusion held; the number described a different
 * mutation from the one the sentence named.
 *
 * It is still worth having for a different and smaller reason: it is the
 * cheapest possible question, it needs no fixture, and it answers before any
 * behavioural test spends a second -- a program that cannot parse should
 * never reach one. Verified against real history: green at cba3c0d, red at
 * 1a1a35c and the two commits after, green at the fix.
 *
 * WHAT IT ASKS THAT OF, ALSO CORRECTED. The first version asked it of
 * DEFAULT_ENTRY_POINTS alone and called that "the declared list". A second
 * audit measured THAT and it was the same over-claim one layer along:
 * DEFAULT_ENTRY_POINTS is the module graph's ORPHAN-ANALYSIS roots -- "is
 * this module reachable from shipped code" -- and it is not the list of
 * things this machine executes. Four executables were outside it:
 *
 *     scripts/bridge-session-poll.mjs     SessionStart + SessionEnd hook
 *     scripts/audit-workspace.mjs         npm run audit:workspace
 *     scripts/start-agent.mjs             npm run agent:check
 *     scripts/audit-auto.mjs              npm run audit:auto
 *
 * The first of those is the file whose silent death CLAUDE.md devotes a
 * section to. A SyntaxError there reproduces this exact outage -- hooks stop
 * running, the roster empties, the symptom looks like liveness -- and the
 * gate built in response to that outage would have been green throughout.
 *
 * WIDENED AGAIN, because "everything this repo executes" was still not
 * everything. An auditor measured the version that said it was: it covered
 * 15 of the 26 .mjs files in bin/ and scripts/, and among the 11 it missed
 * were `bin/agentbridge-deploy.mjs` -- a documented executable named in
 * lanes.yml -- and `scripts/check-deployed-instructions.mjs`, the script
 * CLAUDE.md rule 12 points readers at. It also read only
 * `.claude/settings.json`, while `scripts/claude-stop-gate.mjs` itself
 * iterates BOTH `settings.json` and `settings.local.json` to find hooks,
 * and `src/auditLedger.mjs` lists the local file as a control. A hook
 * declared only in the local file was invisible to this gate.
 *
 * That is the third layer of the same over-claim: 0712792 retracted a false
 * root cause, 64d0971 corrected the list one layer along and made the same
 * shape of statement about the new list. So the sweep is now a SUPERSET of
 * anything derivable, and the claim is bounded by construction rather than
 * by my confidence in a derivation:
 *
 *     bin/*.mjs, scripts/*.mjs   the directories this repo keeps executables in
 *     .claude/settings.json      what Claude Code spawns as a hook
 *     .claude/settings.local.json  ditto, and read by the Stop gate itself
 *     package.json scripts       what a person or CI invokes by name
 *     package.json bin           what `npm link` puts on PATH
 *     DEFAULT_ENTRY_POINTS       what the module graph calls shipped
 *
 * Sweeping two directories wholesale is deliberately cruder than deriving.
 * A file in bin/ that nothing invokes today still must not contain a
 * SyntaxError, the check costs milliseconds, and a crude superset cannot
 * quietly shrink the way a clever derivation just did -- twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ENTRY_POINTS } from '../src/moduleGraph.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The pair scripts/claude-stop-gate.mjs itself reads to find hooks. */
const SETTINGS_FILES = ['settings.json', 'settings.local.json'];

/**
 * Where this repository keeps things meant to be run.
 *
 * bridge/ AND mcp/ WERE ADDED AFTER AN AUDIT MEASURED WHAT bin/ + scripts/
 * MISSED. `wrangler.toml` line 2 is `main = "bridge/oauthWorker.mjs"` and
 * that file's own header calls it "THE PUBLIC FRONT DOOR" -- a SyntaxError in
 * the worker `wrangler deploy` ships passed a gate whose test is named
 * EVERYTHING THIS REPO EXECUTES PARSES. Six more were outside it:
 * bridge/collisions.mjs, bridge/httpStore.mjs, bridge/oauth.mjs,
 * bridge/store.mjs, mcp/toolDefs.mjs, mcp/tools.mjs.
 *
 * Fourth layer of one over-claim: 0712792 retracted a false root cause,
 * 64d0971 corrected the list, b62e7fa widened it to two directories and said
 * "everything", and the deployed worker was in neither.
 */
const EXECUTABLE_DIRS = ['bin', 'scripts', 'bridge', 'mcp'];

/**
 * Deploy manifests that name an entry point, read rather than assumed.
 *
 * The directory sweep already covers bridge/oauthWorker.mjs today. This is
 * here for the day `main` points somewhere else: a deploy entry is executed
 * by definition, and the manifest is the only place that says which file it
 * is. Sweeping a directory and reading the manifest fail in different
 * directions, which is the point of having both.
 */
const DEPLOY_MANIFESTS = [['wrangler.toml', /^\s*main\s*=\s*["']([^"']+)["']/m]];

/**
 * `node --check` on one file: parses, or the reason it does not.
 *
 * THE WHOLE STDERR IS KEPT, and the first version of this truncated it to
 * three lines -- which is where node echoes the offending SOURCE, not the
 * diagnosis. The assertion looking for "SyntaxError" therefore failed on a
 * fixture that had failed to parse exactly as intended. Truncation belongs
 * at the point of display, never at the point of measurement.
 */
function parses(abs) {
  const r = spawnSync(process.execPath, ['--check', abs],
    { encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, err: String(r.stderr ?? '').trim() };
}

/** One line of it, for a message a person has to read. */
const brief = (err) => err.split('\n').find((l) => /Error/.test(l))?.trim()
  ?? err.split('\n')[0]?.trim() ?? '(no stderr)';

/**
 * Every `.mjs` a shell command names, as a repo-relative path.
 *
 * The hook commands are written `node "$CLAUDE_PROJECT_DIR/scripts/x.mjs"`,
 * so a leading variable reference is STRIPPED rather than matched, and NO
 * LIST OF DIRECTORY NAMES IS TYPED HERE. A gate that recognises `scripts/`
 * and `bin/` stops covering a hook the day someone adds `hooks/`, and stops
 * silently, which is the failure mode this whole file exists to refuse.
 */
function mjsTokens(command) {
  return [...String(command).matchAll(/[^\s"';|&]*\.mjs/g)]
    .map((m) => m[0]
      .replace(/\\/g, '/')
      .replace(/^\$\{[^}]+\}\//, '')                // ${CLAUDE_PROJECT_DIR}/x
      .replace(/^\$[A-Za-z_][A-Za-z0-9_]*\//, '')   // $CLAUDE_PROJECT_DIR/x
      .replace(/^\.\//, ''))
    .filter(Boolean);
}

/** Every `command` string anywhere in a hooks config, at any nesting. */
function hookCommands(settings) {
  const out = [];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'command' && typeof v === 'string') out.push(v);
      else walk(v);
    }
  }(settings));
  return out;
}

/**
 * What `root` executes, and which source said so.
 *
 * Returns { checked, findings }. A command that mentions a `.mjs` but yields
 * no usable path is itself a finding: that is how this derivation would go
 * quiet if a path were written in a shape the extractor does not know, and a
 * coverage gate that can shrink in silence is worth less than none.
 */
function executed(root, declared) {
  const checked = new Map();          // rel -> Set of sources
  const findings = [];

  const add = (rel, source, origin) => {
    if (/[*?]/.test(rel)) return;     // a glob: the runner expands it, not us
    if (!checked.has(rel)) checked.set(rel, new Set());
    checked.get(rel).add(source);
    if (!existsSync(path.join(root, rel))) {
      findings.push(`${rel}: named by ${origin} but does not exist`);
    }
  };

  const fromCommand = (cmd, source, origin) => {
    const tokens = mjsTokens(cmd);
    if (!tokens.length && /\.mjs/.test(cmd)) {
      findings.push(`${origin}: names a .mjs this gate could not extract -- ${cmd}`);
      return;
    }
    for (const t of tokens) add(t, source, origin);
  };

  for (const rel of declared) {
    add(String(rel).replace(/\\/g, '/'), 'module graph', 'DEFAULT_ENTRY_POINTS');
  }

  /*
   * BOTH SETTINGS FILES. claude-stop-gate.mjs iterates exactly this pair to
   * find its own hook declarations; reading one of them was the gap.
   */
  for (const file of SETTINGS_FILES) {
    const abs = path.join(root, '.claude', file);
    if (!existsSync(abs)) continue;
    let parsed;
    try { parsed = JSON.parse(readFileSync(abs, 'utf8')); } catch {
      findings.push(`.claude/${file}: is not parseable JSON, so its hooks cannot be checked`);
      continue;
    }
    for (const cmd of hookCommands(parsed)) fromCommand(cmd, 'claude hook', `.claude/${file}`);
  }

  const pkgPath = path.join(root, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
      fromCommand(cmd, 'npm script', `package.json scripts.${name}`);
    }
    /* What `npm link` puts on PATH is executed by definition. */
    for (const [name, target] of Object.entries(pkg.bin ?? {})) {
      for (const t of mjsTokens(String(target))) add(t, 'package.json bin', `package.json bin.${name}`);
    }
  }

  /*
   * AND THE DIRECTORIES THEMSELVES, wholesale. This is the crude part and
   * it is crude on purpose: it cannot shrink when somebody rewrites a
   * derivation, and every .mjs sitting in bin/ or scripts/ is there to be
   * run by something even when no config names it today.
   */
  for (const [file, pattern] of DEPLOY_MANIFESTS) {
    const abs = path.join(root, file);
    if (!existsSync(abs)) continue;
    const named = pattern.exec(readFileSync(abs, 'utf8'))?.[1];
    if (named === undefined) continue;
    if (!/\.mjs$/.test(named)) continue;       // a .ts worker is not ours to parse
    add(named.replace(/\\/g, '/').replace(/^\.\//, ''), 'deploy manifest', file);
  }

  for (const dir of EXECUTABLE_DIRS) {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (f.endsWith('.mjs')) add(`${dir}/${f}`, 'executable directory', dir);
    }
  }

  return { checked, findings };
}

test('EVERYTHING THIS REPO EXECUTES PARSES', () => {
  const { checked, findings } = executed(REPO, DEFAULT_ENTRY_POINTS);

  const broken = [...findings];
  for (const [rel, sources] of checked) {
    const abs = path.join(REPO, rel);
    if (!existsSync(abs)) continue;            // already reported by executed()
    const r = parses(abs);
    if (!r.ok) broken.push(`${rel} (${[...sources].join(', ')}): ${brief(r.err)}`);
  }

  assert.deepEqual(broken, [],
    `something this repo runs does not parse, so nothing it provides works:\n  ${broken.join('\n  ')}`);
});

test('THE HOOKS AND THE NPM SCRIPTS ARE ACTUALLY IN THE SET', () => {
  /*
   * The defect this replaces was not a wrong answer, it was a gate quietly
   * covering less than its name claimed. So the coverage itself is asserted,
   * against the two sources DEFAULT_ENTRY_POINTS does not contain, read from
   * those files rather than listed here (rule 7) -- and in both directions
   * (rule 19): every hook and script path must be present, and the set must
   * be strictly larger than the module-graph roots.
   */
  const { checked } = executed(REPO, DEFAULT_ENTRY_POINTS);

  const wanted = new Map();
  const settings = JSON.parse(readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
  for (const cmd of hookCommands(settings)) {
    for (const t of mjsTokens(cmd)) wanted.set(t, '.claude/settings.json');
  }
  const scripts = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts ?? {};
  for (const [name, cmd] of Object.entries(scripts)) {
    for (const t of mjsTokens(cmd)) if (!/[*?]/.test(t)) wanted.set(t, `scripts.${name}`);
  }

  assert.ok(wanted.size > 0,
    'no hook or npm-script entry point was found at all -- the extractor is broken, not the repo');

  const missing = [...wanted].filter(([rel]) => !checked.has(rel)).map(([rel, why]) => `${rel} (${why})`);
  assert.deepEqual(missing, [],
    `these are executed but not checked:\n  ${missing.join('\n  ')}`);

  const declared = new Set(DEFAULT_ENTRY_POINTS.map((r) => String(r).replace(/\\/g, '/')));
  const beyond = [...checked.keys()].filter((rel) => !declared.has(rel));
  assert.ok(beyond.length > 0,
    'the checked set equals DEFAULT_ENTRY_POINTS exactly, which is the defect this test exists to catch');

  /* Named, because the audit that found this deserves a permanent tripwire. */
  assert.ok(checked.has('scripts/bridge-session-poll.mjs'),
    'the SessionStart/SessionEnd hook is not covered -- a SyntaxError there empties the roster silently');

  /*
   * EVERY EXECUTABLE ON DISK, counted against the directory rather than a
   * list. The version before this covered 15 of 26 and said "everything".
   */
  const onDisk = [];
  for (const dir of EXECUTABLE_DIRS) {
    for (const f of readdirSync(path.join(REPO, dir))) if (f.endsWith('.mjs')) onDisk.push(`${dir}/${f}`);
  }
  assert.ok(onDisk.length >= 20,
    `only ${onDisk.length} executables found on disk -- the sweep is looking in the wrong place`);
  const unswept = onDisk.filter((f) => !checked.has(f));
  assert.deepEqual(unswept, [],
    `these sit in an executable directory and are not checked:\n  ${unswept.join('\n  ')}`);

  /* The two named by the audit, so the regression has a face. */
  /*
   * THE DEPLOYED WORKER, named because an audit had to find it. wrangler.toml
   * says main = bridge/oauthWorker.mjs; a SyntaxError there ships.
   */
  const wrangler = readFileSync(path.join(REPO, 'wrangler.toml'), 'utf8');
  const deployMain = /^\s*main\s*=\s*["']([^"']+)["']/m.exec(wrangler)?.[1];
  assert.ok(deployMain, 'wrangler.toml declares no main -- if that is deliberate this note is stale');
  if (/\.mjs$/.test(deployMain)) {
    assert.ok(checked.has(deployMain.replace(/^\.\//, '')),
      `wrangler deploy ships ${deployMain} and this gate does not check it`);
  }

  for (const named of ['bin/agentbridge-deploy.mjs', 'scripts/check-deployed-instructions.mjs',
    'bridge/oauthWorker.mjs', 'mcp/tools.mjs']) {
    assert.ok(checked.has(named), `${named} is executed and documented, and is not covered`);
  }

  /* package.json bin: what npm link puts on PATH. */
  const binMap = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).bin ?? {};
  for (const [name, target] of Object.entries(binMap)) {
    for (const t of mjsTokens(String(target))) {
      assert.ok(checked.has(t), `package.json bin.${name} -> ${t} is not covered`);
    }
  }
});

test('A HOOK DECLARED ONLY IN settings.local.json IS STILL A HOOK', (t) => {
  /*
   * scripts/claude-stop-gate.mjs iterates BOTH settings files to find its
   * own hook declarations, and src/auditLedger.mjs lists the local one as a
   * control. This gate read only settings.json, so a hook declared in the
   * local file -- which exists in this worktree, untracked and gitignored --
   * was invisible to it.
   *
   * The fixture puts the broken hook in a directory that is NEITHER swept
   * directory, so it can only be found through the local settings file. If
   * the sweep were doing the work here, this would pass for the wrong
   * reason.
   */
  const root = mkdtempSync(path.join(tmpdir(), 'entrylocal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(path.join(root, '.claude'), { recursive: true });
  mkdirSync(path.join(root, 'hooks'), { recursive: true });
  writeFileSync(path.join(root, 'hooks', 'local-only.mjs'), 'const H = `x `y` z`;\n');
  writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/hooks/local-only.mjs"' }] }],
    },
  }));

  const { checked } = executed(root, []);
  assert.equal(checked.has('hooks/local-only.mjs'), true,
    'a hook declared only in settings.local.json was not picked up');
  assert.equal(parses(path.join(root, 'hooks', 'local-only.mjs')).ok, false,
    'the fixture hook must be broken, or this proves nothing');
});

test('the check can FAIL, so a green result means something (rule 1)', (t) => {
  /*
   * Without this, a `parses()` that always returned ok would satisfy the test
   * above forever. The fixture reproduces the real defect rather than an
   * arbitrary one: a backtick closing a template literal early.
   */
  const dir = mkdtempSync(path.join(tmpdir(), 'entrycheck-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const good = path.join(dir, 'good.mjs');
  writeFileSync(good, 'const HELP = `usage: thing --flag`;\nexport default HELP;\n');
  assert.equal(parses(good).ok, true, 'the control file must parse');

  const bad = path.join(dir, 'bad.mjs');
  writeFileSync(bad, 'const HELP = `usage:\n  the record is `observed` and cannot pass\n`;\nexport default HELP;\n');
  const r = parses(bad);
  assert.equal(r.ok, false, 'a backtick inside a template literal must be caught');
  assert.match(r.err, /SyntaxError/, brief(r.err));
});

test('THE DERIVATION REACHES HOOKS AND SCRIPTS, and carries a failure out of both (rule 1)', (t) => {
  /*
   * Asserting that the set CONTAINS the hook proves the plumbing exists; this
   * proves the plumbing carries a defect. A whole repo is built whose only
   * broken file is reachable exclusively through a hook, with the
   * module-graph list EMPTY -- exactly the blind spot that shipped.
   */
  const root = mkdtempSync(path.join(tmpdir(), 'entryderive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(path.join(root, '.claude'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });

  writeFileSync(path.join(root, 'scripts', 'poll.mjs'),
    'const HELP = `usage:\n  the record is `observed` and cannot pass\n`;\n');
  writeFileSync(path.join(root, 'scripts', 'fine.mjs'), 'export const ok = true;\n');

  writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      SessionStart: [{
        hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/poll.mjs" --session-start' }],
      }],
    },
  }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { check: 'node scripts/fine.mjs', test: 'node --test "test/**/*.test.mjs"' },
  }));

  const { checked, findings } = executed(root, []);
  assert.deepEqual(findings, [],
    'nothing is missing in this fixture, so nothing should be reported missing');
  assert.equal(checked.has('scripts/poll.mjs'), true,
    'the hook path was not extracted from its $CLAUDE_PROJECT_DIR form');
  assert.equal(checked.has('scripts/fine.mjs'), true, 'the npm-script path was not extracted');
  assert.equal(checked.has('test/**/*.test.mjs'), false, 'the glob must not be treated as a file');

  /* And the defect is real, so a green run of the gate above means something. */
  assert.equal(parses(path.join(root, 'scripts', 'poll.mjs')).ok, false,
    'the fixture hook is supposed to be broken -- if it parses, this test proves nothing');
  assert.equal(parses(path.join(root, 'scripts', 'fine.mjs')).ok, true,
    'the fixture script must parse, or a failure above would be indistinguishable from noise');
});

test('A MISSING EXECUTABLE IS A FINDING, NOT A SKIP', (t) => {
  /*
   * Silently passing over a file that is not there is how a
   * declared-but-deleted executable stops being checked by anything. The
   * original version handled this for DEFAULT_ENTRY_POINTS; it has to hold
   * for a hook path too, which is the likelier one to be renamed.
   */
  const root = mkdtempSync(path.join(tmpdir(), 'entrygone-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(path.join(root, '.claude'), { recursive: true });
  writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/renamed-away.mjs"' }] }],
    },
  }));

  const { findings } = executed(root, []);
  assert.equal(findings.length, 1, `expected exactly one finding, got: ${JSON.stringify(findings)}`);
  assert.match(findings[0], /renamed-away\.mjs: named by \.claude\/settings\.json but does not exist/);
});

test('THE REAL REGRESSION: the shipped CLI parses, and its help is a template literal', () => {
  /*
   * The specific file, named, because a list-driven test says "one of
   * thirteen is wrong" and the next reader deserves the name. This is also
   * the positive control for the fix: the help text still IS a template
   * literal, so the hazard is live and the gate is load-bearing rather than
   * guarding a shape that no longer exists.
   */
  const cli = path.join(REPO, 'bin', 'agentbridge.mjs');
  const r = parses(cli);
  assert.equal(r.ok, true, `bin/agentbridge.mjs does not parse: ${brief(r.err)}`);

  const src = readFileSync(cli, 'utf8');
  assert.match(src, /const HELP = `/,
    'the help is no longer a template literal -- if that is deliberate, this note is stale');
});
