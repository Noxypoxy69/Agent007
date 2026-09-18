/**
 * THE VALUE-TAKING FLAG TABLE IS DERIVED FROM GIT, NOT REMEMBERED.
 *
 * src/shellAllowlist.mjs skips the token after a flag that takes a value, so
 * that `git commit -m test` is not read as naming test/claudeGuard.test.mjs.
 * The first version of that skip was ONE FLAT REGEX containing -m, and it blew
 * a hole straight through the named-path check: `-m` is `--message` for commit
 * but `--merge` for restore, checkout and switch, where it is a BOOLEAN. So
 * "skip the value after -m" skipped the PATHSPEC:
 *
 *   git restore -m src/claudeGuard.mjs     ALLOW   (DENY at the parent commit)
 *
 * Confirmed against git itself: append a line to the file, run that command,
 * the edit is gone. `-S` was wrong the same way -- `--staged` on restore, and
 * `--gpg-sign[=<key-id>]` on commit, whose value is OPTIONAL and so never
 * consumes the next token either.
 *
 * A remembered table drifts and nobody notices until an audit. So this test
 * rebuilds it from `git <verb> -h` on the installed git and asserts equality in
 * BOTH directions. A git upgrade that adds or removes a value-taking flag turns
 * this red instead of silently changing what the rail skips.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { GIT_FLAG_TAKES_VALUE } from '../src/shellAllowlist.mjs';

/**
 * Parse one `git <verb> -h` option line into {flags, takesValue}.
 *
 * git prints, with the description separated by two or more spaces:
 *
 *   -s, --[no-]source <tree-ish>              value: a separate token
 *   -m, --[no-]merge      perform a 3-way...  boolean
 *   -S, --[no-]gpg-sign[=<key-id>]            OPTIONAL value, glued with '=',
 *                                             so it consumes NOTHING
 *   --[no-]fixup [(amend|reword):]commit      value, and not spelled with <>
 *
 * The rule that covers all four: take the options half of the line, drop every
 * whitespace-delimited token that begins with '-' (those are the flag names,
 * including any glued [=<...>]), and if anything is LEFT OVER the flag consumes
 * the next token.
 */
function parseOptionLine(line) {
  const optPart = line.trim().split(/\s{2,}/)[0];
  if (!optPart.startsWith('-')) return null;

  const tokens = optPart.split(/\s+/).filter(Boolean);
  const flagTokens = tokens.filter((t) => t.startsWith('-'));
  const remainder = tokens.filter((t) => !t.startsWith('-'));

  const flags = [];
  for (const raw of flagTokens) {
    const t = raw.replace(/,$/, '');
    // Strip a glued optional/required value: --foo[=<bar>] or --foo=<bar>
    // Strip [no-] BEFORE the glued-value strip, or --[no-]source truncates to --
    const name = t.replace('--[no-]', '--').replace(/[[=].*$/, '');
    /*
     * A FLAG NAME, NOT WHATEVER ELSE IS ON THE LINE. git's own help is not
     * uniformly formatted -- `git add -h` has lines whose description is one
     * space away, so the options half swallows prose and yields tokens like
     * "--no-all)" and a bare "-". Those are parse noise, and admitting them
     * would put junk in a table that decides what the rail skips.
     */
    if (!/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) continue;
    flags.push(name);
  }
  return { flags, takesValue: remainder.length > 0 };
}

function gitValueFlags(verb) {
  let help;
  try {
    execFileSync('git', [verb, '-h'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    help = '';
  } catch (e) {
    // `git <verb> -h` exits non-zero by design and prints usage on stderr.
    help = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  assert.ok(help.length > 0, `git ${verb} -h produced no usage text`);

  const out = new Set();
  for (const line of help.split('\n')) {
    if (!/^\s+-/.test(line)) continue;
    const parsed = parseOptionLine(line);
    if (!parsed || !parsed.takesValue) continue;
    for (const f of parsed.flags) out.add(f);
  }
  return out;
}

test('the parser agrees with hand-read examples before it is trusted', () => {
  // RULE 5: the positive first. If parseOptionLine is wrong, every comparison
  // below is wrong in the same direction and the test still passes.
  assert.deepEqual(parseOptionLine('    -s, --[no-]source <tree-ish>'),
    { flags: ['-s', '--source'], takesValue: true });
  assert.deepEqual(parseOptionLine('    -m, --[no-]merge     perform a 3-way merge'),
    { flags: ['-m', '--merge'], takesValue: false });
  assert.deepEqual(parseOptionLine('    -S, --[no-]gpg-sign[=<key-id>]'),
    { flags: ['-S', '--gpg-sign'], takesValue: false });
  assert.deepEqual(parseOptionLine('    -b <branch>           create and checkout a new branch'),
    { flags: ['-b'], takesValue: true });
  assert.deepEqual(parseOptionLine('    --[no-]fixup [(amend|reword):]commit'),
    { flags: ['--fixup'], takesValue: true });
});

test('git says -m is a BOOLEAN for every verb that overwrites a named path', () => {
  // This is the actual defect, asserted directly rather than via the table.
  for (const verb of ['restore', 'checkout', 'switch']) {
    const v = gitValueFlags(verb);
    assert.ok(!v.has('-m'), `git ${verb}: -m must not be value-taking (it is --merge)`);
    assert.ok(!v.has('-S'), `git ${verb}: -S must not be value-taking`);
  }
  // ...and a value for commit, which is why the skip exists at all.
  assert.ok(gitValueFlags('commit').has('-m'), 'git commit: -m takes a message');
});

test('every verb table matches what the installed git reports, both directions', () => {
  for (const [verb, table] of Object.entries(GIT_FLAG_TAKES_VALUE)) {
    const fromGit = gitValueFlags(verb);
    assert.ok(fromGit.size > 0, `derived no value-taking flags for git ${verb}`);

    const missing = [...fromGit].filter((f) => !table.has(f));
    const stale = [...table].filter((f) => !fromGit.has(f));

    assert.deepEqual(missing, [],
      `git ${verb} has value-taking flags the rail does not skip — an operand after these is judged as a pathspec (over-block): ${missing.join(' ')}`);
    assert.deepEqual(stale, [],
      `the rail skips the token after these, but git ${verb} says they take no value — each one SWALLOWS A PATHSPEC: ${stale.join(' ')}`);
  }
});
