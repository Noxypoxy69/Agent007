/**
 * A CORRECT RULE WITH AN UNRECOVERABLE CONSEQUENCE, AND THE HALF THAT FIXES IT.
 *
 * The Stop gate excludes `.claude/settings.json` from BOTH reliefs -- grants and
 * committed work -- because that file decides whether the guard runs at all, so
 * "I committed it" must not be a stronger permission than an override. That
 * reasoning is right and is not being changed.
 *
 * ITS CONSEQUENCE WAS A PERMANENT DEADLOCK. A session's snapshot is minted once
 * and may never be re-minted, deliberately, because a session that re-baselines
 * a damaged tree adopts the damage. So when ANOTHER session legitimately commits
 * a settings change, every already-running session blocks on drift it did not
 * cause, against a file that matches HEAD, with no recovery but restarting.
 *
 * Measured across most of a working session on 2026-09-19: ade7ab9 ADDED two
 * poll hooks and removed nothing. The file was strictly MORE armed than the
 * snapshot. Every turn was refused anyway, for hours.
 *
 * SO THE QUESTION CHANGES FROM WHO WROTE IT TO WHETHER IT STILL ARMS ANYTHING.
 * Attribution says who; it does not say whether a control was turned off. The
 * artefact can be asked directly, and that is what `gateConfigArms` does. The
 * gate requires BOTH halves before relieving anything -- matches HEAD, and still
 * arms -- so the bypass the exclusion existed for stays closed:
 *
 *   committed but DISARMED  -> this returns false, so it still blocks
 *   armed but UNCOMMITTED   -> isCommittedWork is false, so it still blocks
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { gateConfigArms } from '../src/guardSession.mjs';

/** The real shipped configuration, as the committed file carries it. */
const ARMED = {
  hooks: {
    PreToolUse: [{
      matcher: '*',
      hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/bin/agentbridge-claude-guard.mjs"', timeout: 10 }],
    }],
    Stop: [{
      matcher: '',
      hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/claude-stop-gate.mjs"', timeout: 420 }],
    }],
    SessionStart: [{
      matcher: '',
      hooks: [
        { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/bin/agentbridge-claude-guard.mjs" --session-start', timeout: 30 },
        { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/bridge-session-poll.mjs" --session-start', timeout: 30 },
      ],
    }],
    SessionEnd: [{
      matcher: '',
      hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/bridge-session-poll.mjs" --session-end', timeout: 15 }],
    }],
  },
  disableAllHooks: false,
};

const withHooks = (mutate) => {
  const copy = JSON.parse(JSON.stringify(ARMED));
  mutate(copy);
  return JSON.stringify(copy, null, 2);
};

/* ── the positive, first ──────────────────────────────────────────────── */

test('THE POSITIVE FIRST: the real shipped configuration arms the gate', () => {
  /*
   * Rule 5, and it is the assertion that matters most here. Every refusal below
   * is satisfied by a function that returns false for everything -- which would
   * restore the permanent deadlock this whole change exists to end, while every
   * "still blocks" test passed.
   */
  const v = gateConfigArms(JSON.stringify(ARMED));
  assert.equal(v.armed, true, `the shipped config was called disarmed: ${v.missing.join('; ')}`);
  assert.deepEqual(v.missing, []);
});

test('AND ADDING A HOOK DOES NOT DISARM IT, which is the measured case', () => {
  /*
   * ade7ab9 added the SessionStart and SessionEnd poll hooks. Nothing was
   * removed. That commit is what blocked a session for hours, so it is the one
   * fixture that has to come out armed.
   */
  const text = withHooks((c) => {
    c.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/something-new.mjs"', timeout: 5 });
    c.hooks.PostToolUse = [{ matcher: '*', hooks: [{ type: 'command', command: 'node other.mjs' }] }];
  });
  assert.equal(gateConfigArms(text).armed, true, 'an ADDED hook was treated as a disarm');
});

/* ── every way to turn a control off ──────────────────────────────────── */

test('EVERY DISARM STILL FAILS, so committing one buys nothing', () => {
  /*
   * THE WHOLE POINT OF THE EXCLUSION, preserved. Each of these is a settings
   * file that could be committed -- making it attributable, diffable and
   * matching HEAD -- and each must still be refused relief, because being on
   * the record is not the same as being harmless.
   */
  const disarms = {
    'disableAllHooks flips everything off in one field': withHooks((c) => { c.disableAllHooks = true; }),
    'PreToolUse loses the guard': withHooks((c) => { c.hooks.PreToolUse = []; }),
    'PreToolUse runs something else entirely': withHooks((c) => {
      c.hooks.PreToolUse[0].hooks = [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/noop.mjs"' }];
    }),
    'Stop loses the gate': withHooks((c) => { delete c.hooks.Stop; }),
    'SessionStart stops minting a snapshot': withHooks((c) => { c.hooks.SessionStart[0].hooks.shift(); }),
    'the hooks object is gone': JSON.stringify({ disableAllHooks: false }),
  };

  for (const [why, text] of Object.entries(disarms)) {
    const v = gateConfigArms(text);
    assert.equal(v.armed, false, `NOT REFUSED: ${why}`);
    assert.ok(v.missing.length > 0, `${why} was refused without saying what is missing`);
  }
});

test('A MATCHER THAT IS NOT "*" IS A DISARM WEARING A CONFIGURATION', () => {
  /*
   * THE MEASURED 2026-09-17 INCIDENT, and the reason this check is not just
   * "is the guard mentioned". The matcher listed tool NAMES --
   * "Bash|Edit|MultiEdit|Write|NotebookEdit" -- and Windows sessions run shell
   * through a PowerShell tool that was not on the list. A real session deleted
   * src/claudeGuard.mjs and git reported the deletion with no refusal from
   * anywhere. The guard's own unit tests were green throughout, because they
   * call the module directly and the module was never the broken part.
   *
   * So a config naming the guard correctly, on an event that never reaches it
   * for half the tools, is not armed.
   */
  for (const matcher of ['Bash|Edit|MultiEdit|Write|NotebookEdit', 'Bash', '.*', 'Read']) {
    const text = withHooks((c) => { c.hooks.PreToolUse[0].matcher = matcher; });
    const v = gateConfigArms(text);
    assert.equal(v.armed, false, `matcher ${JSON.stringify(matcher)} was accepted as armed`);
    assert.match(v.missing.join('; '), /matches all tools/,
      'the refusal does not say what is wrong with the matcher');
  }
});

test('BUT "" AND OMITTED ARE MATCH-ALL, and calling them a disarm was an OVER-BLOCK', () => {
  /*
   * THIS TEST PINNED THE WRONG BEHAVIOUR UNTIL A BLIND AUDIT SAID SO. It
   * iterated ['Bash|Edit|...', 'Bash', '', undefined, '.*'] and asserted all
   * five were NOT armed. Two of those five are documented match-all spellings:
   * Claude Code's hooks reference lists `"*"`, `""` and an omitted matcher
   * together as "Match all", and THIS REPOSITORY'S OWN settings.json uses `""`
   * for Stop, SessionStart and SessionEnd.
   *
   * So a correctly armed config committed with `""` on the guard entry would
   * have been called a disarm: relief refused, every session with an older
   * snapshot Stop-blocked with no recovery but a restart, plus a false alarm
   * announcing the gate was no longer armed. That is the deadlock the whole
   * change exists to end, rebuilt on a wrong premise -- and it was pinned by an
   * assertion that read like a security assertion, so fixing the code meant
   * deleting test lines, which is exactly how a wrong belief survives.
   */
  for (const matcher of ['*', '', undefined]) {
    const text = withHooks((c) => {
      if (matcher === undefined) delete c.hooks.PreToolUse[0].matcher;
      else c.hooks.PreToolUse[0].matcher = matcher;
    });
    const v = gateConfigArms(text);
    assert.equal(v.armed, true,
      `matcher ${JSON.stringify(matcher)} is match-all and was called a disarm: ${v.missing.join('; ')}`);
  }
});

test('A DECOY MATCH-ALL ENTRY DOES NOT ARM A GUARD SCOPED TO ONE TOOL', () => {
  /*
   * The matcher and the command have to be the SAME hook entry. Checking them
   * with two independent .some() calls let this pass: a match-all entry running
   * a commented string, beside a real guard entry scoped to Read. The guard
   * then runs for Read alone -- which is the 2026-09-17 incident this check
   * exists for, where the matcher listed tool names, the PowerShell tool was
   * not among them, and a session deleted src/claudeGuard.mjs with no refusal.
   */
  const text = withHooks((c) => {
    c.hooks.PreToolUse = [
      { matcher: '*', hooks: [{ type: 'command', command: '# node bin/agentbridge-claude-guard.mjs' }] },
      { matcher: 'Read', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/bin/agentbridge-claude-guard.mjs"' }] },
    ];
  });
  assert.equal(gateConfigArms(text).armed, false,
    'a decoy match-all entry armed a guard that only runs for one tool');
});

test('THE SCRIPT MUST BE RUN, NOT MENTIONED -- rule 13 inside the disarm check', () => {
  /*
   * `command.includes(script)` read every one of these as ARMED while running
   * no control at all. Found by blind audit, in a header that defended the
   * substring as "routing on the shape". A substring is not a shape.
   */
  const neutered = {
    'commented out': '# node "$CLAUDE_PROJECT_DIR/bin/agentbridge-claude-guard.mjs"',
    'echoed': 'echo skipping bin/agentbridge-claude-guard.mjs',
    'a relocated copy': 'node "$CLAUDE_PROJECT_DIR/tmp/agentbridge-claude-guard.mjs"',
    'named in an argument': 'node other.mjs --gate bin/agentbridge-claude-guard.mjs',
  };
  for (const [why, command] of Object.entries(neutered)) {
    const text = withHooks((c) => { c.hooks.PreToolUse[0].hooks = [{ type: 'command', command }]; });
    assert.equal(gateConfigArms(text).armed, false, `ARMED by a command that is ${why}: ${command}`);
  }

  // And the real spellings still arm, or this is just a refusal of everything.
  for (const command of [
    'node "$CLAUDE_PROJECT_DIR/bin/agentbridge-claude-guard.mjs"',
    'node $CLAUDE_PROJECT_DIR/bin/agentbridge-claude-guard.mjs',
    'node.exe "C:/repo/bin/agentbridge-claude-guard.mjs" --flag',
  ]) {
    const text = withHooks((c) => { c.hooks.PreToolUse[0].hooks = [{ type: 'command', command }]; });
    assert.equal(gateConfigArms(text).armed, true, `a real invocation was refused: ${command}`);
  }
});

/* ── unreadable is not armed ──────────────────────────────────────────── */

test('AN UNREADABLE CONFIG IS NOT AN ARMED ONE', () => {
  /*
   * "Nobody knows" is not "nothing changed" -- the sentence the Stop gate
   * already applies to a missing snapshot. A settings file that cannot be
   * parsed is one Claude Code cannot load either, so the controls are not
   * running whatever the bytes were meant to say.
   */
  for (const junk of ['', '   ', '{', 'null', '[]', 'not json at all', '{"hooks":']) {
    assert.equal(gateConfigArms(junk).armed, false, `${JSON.stringify(junk)} was called armed`);
  }
  assert.equal(gateConfigArms(undefined).armed, false);
  assert.equal(gateConfigArms(null).armed, false);
});

test('THE REFUSAL SAYS WHICH CONTROL IS MISSING, because a bare no sends nobody anywhere', () => {
  const v = gateConfigArms(withHooks((c) => { delete c.hooks.Stop; c.disableAllHooks = true; }));
  assert.equal(v.armed, false);
  assert.match(v.missing.join('; '), /disableAllHooks/);
  assert.match(v.missing.join('; '), /Stop/);
});

test('THE CONTROL: this check can actually fail, and actually pass', () => {
  /*
   * Rule 1, held permanently rather than watched once. A function returning
   * `{armed:true}` satisfies every positive above; one returning
   * `{armed:false}` satisfies every negative. Both verdicts are demanded here
   * from the same function in one test, so neither constant survives.
   */
  assert.equal(gateConfigArms(JSON.stringify(ARMED)).armed, true);
  assert.equal(gateConfigArms(withHooks((c) => { c.disableAllHooks = true; })).armed, false);
});
