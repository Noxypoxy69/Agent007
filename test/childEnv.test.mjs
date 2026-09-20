/**
 * THE CREDENTIAL CHANNEL NOBODY WAS LOOKING AT.
 *
 * Three tests in this suite assert that a credential cannot reach a spawned
 * agent: the event carries none, and `taskBrief` cannot contain one "BY
 * CONSTRUCTION" because the lease token is not a parameter. All three are
 * true. All three guard the argv/prompt/event channel.
 *
 * `startRun` then spawned the agent with NO `env` option, so the child
 * inherited `process.env` entire -- registration token, service key,
 * coordinator credential. The narrow channel was closed with real care while
 * the wide one stayed open, and the test names made the subject read as
 * settled.
 *
 * So the assertions here are mostly about what a child must NOT receive, and
 * they are generated from a realistic parent environment rather than from a
 * list of three names somebody thought of.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { childEnv, OS_ESSENTIALS, NEVER_INHERITED } from '../src/childEnv.mjs';

/** A parent environment shaped like this daemon's actually is. */
const PARENT = Object.freeze({
  PATH: '/usr/bin:/bin',
  Path: 'C:/Windows/System32',
  SystemRoot: 'C:/Windows',
  TEMP: 'C:/Temp',
  USERPROFILE: 'C:/Users/danny',
  APPDATA: 'C:/Users/danny/AppData/Roaming',
  LANG: 'en_GB.UTF-8',

  /* Everything below is what the child used to be handed. */
  AGENTBRIDGE_REGISTRATION_TOKEN: 'g'.repeat(40),
  AGENTBRIDGE_HOME: 'C:/Users/danny/.agentbridge',
  AGENTBRIDGE_PRINCIPAL_ID: 'danny',
  AGENTBRIDGE_SESSION_ID: 'session_01ABC',
  SUPABASE_SERVICE_KEY: 'service-key-value',
  SUPABASE_URL: 'https://example.supabase.co',
  COORDINATOR_TOKEN: 'coordinator-secret',
  READER_TOKEN: 'reader-secret',
  GITHUB_TOKEN: 'ghp_something',
  NODE_OPTIONS: '--require C:/evil.js',
  OPENAI_API_KEY: 'sk-whatever',
});

test('NO VALUE FROM THE PARENT SURVIVES UNLESS IT IS AN OS ESSENTIAL', () => {
  /*
   * The property stated positively, and generated rather than spot-checked:
   * every key that is NOT on the essentials list must be gone, whatever it is
   * called. That is what makes this an allow-list rather than a list of
   * secrets somebody remembered.
   */
  const env = childEnv(PARENT);
  for (const key of Object.keys(PARENT)) {
    if (OS_ESSENTIALS.includes(key)) continue;
    assert.equal(env[key], undefined, `"${key}" was inherited by a spawned builder`);
  }
});

test('NO CREDENTIAL VALUE APPEARS ANYWHERE IN THE CHILD ENVIRONMENT', () => {
  /*
   * THE FAR END, not the key names (rule 4). A variable renamed, or a secret
   * that leaked into a second variable under another name, would pass a
   * key-based check and fail this one.
   */
  const env = childEnv(PARENT);
  const blob = JSON.stringify(env);
  for (const secret of [
    'g'.repeat(40), 'service-key-value', 'coordinator-secret', 'reader-secret',
    'ghp_something', 'sk-whatever', 'session_01ABC',
  ]) {
    assert.ok(!blob.includes(secret), `a credential value reached the child: ${secret.slice(0, 12)}…`);
  }
});

test('THE POSITIVE CONTROL: the child can still actually run', () => {
  /*
   * RULE 19, AND IT IS THE REASON THIS IS AN ALLOW-LIST OF ESSENTIALS RATHER
   * THAN AN EMPTY OBJECT. Strip PATH and every spawn fails; strip APPDATA on
   * Windows and node tooling breaks in ways that look like the agent is
   * broken, not like the guard is wrong. An over-block here gets reverted
   * wholesale, and then the credentials flow again.
   */
  const env = childEnv(PARENT);
  assert.equal(env.PATH, '/usr/bin:/bin', 'PATH was stripped; nothing will start');
  assert.equal(env.Path, 'C:/Windows/System32', 'the Windows spelling of PATH was stripped');
  assert.equal(env.SystemRoot, 'C:/Windows');
  assert.equal(env.TEMP, 'C:/Temp', 'the child has nowhere to write scratch');
  assert.equal(env.USERPROFILE, 'C:/Users/danny');
  assert.equal(env.APPDATA, 'C:/Users/danny/AppData/Roaming', 'node and npm caches break without this');
  assert.equal(env.LANG, 'en_GB.UTF-8');
});

test('NODE_OPTIONS IS NEVER INHERITED, even though it is not a credential', () => {
  /*
   * It is worse than a credential: it carries --require and --import, so
   * inheriting it hands the child arbitrary module execution chosen by
   * whoever set it. The shell rail refuses those exact flags on a node command
   * line; letting them through an inherited variable is the same execution by
   * another route.
   */
  assert.equal(childEnv(PARENT).NODE_OPTIONS, undefined, 'NODE_OPTIONS was inherited: arbitrary --require');
  assert.ok(NEVER_INHERITED.includes('NODE_OPTIONS'));

  /* And it cannot be re-admitted through the caller's allow-list by accident. */
  const forced = childEnv(PARENT, { allow: ['NODE_OPTIONS'] });
  assert.equal(forced.NODE_OPTIONS, undefined,
    'allow re-admitted NODE_OPTIONS; the never-list must outrank a caller asking for it');
});

test('A CALLER MAY PASS ONE THROUGH EXPLICITLY, and only what it named', () => {
  /*
   * The escape hatch is per-call and visible in the diff, so the decision has
   * an author. Asking for one variable must not bring its neighbours.
   */
  const env = childEnv(PARENT, { allow: ['SUPABASE_URL'] });
  assert.equal(env.SUPABASE_URL, 'https://example.supabase.co');
  assert.equal(env.SUPABASE_SERVICE_KEY, undefined, 'allowing the URL also admitted the key');
  assert.equal(env.AGENTBRIDGE_REGISTRATION_TOKEN, undefined);
});

test('`add` SETS A VALUE THE PARENT NEVER HAD, and is not filtered', () => {
  const env = childEnv(PARENT, { add: { AGENTBRIDGE_TASK_ID: 't-42' } });
  assert.equal(env.AGENTBRIDGE_TASK_ID, 't-42');
  /* Still nothing inherited alongside it. */
  assert.equal(env.AGENTBRIDGE_REGISTRATION_TOKEN, undefined);
});

test('JUNK IN DOES NOT THROW, and does not become a passthrough', () => {
  for (const junk of [null, undefined, 'PATH=x', 42, []]) {
    const env = childEnv(junk);
    assert.equal(typeof env, 'object');
    assert.equal(Object.keys(env).length, 0, `${JSON.stringify(junk)} produced inherited values`);
  }
  /* A non-string value is dropped rather than coerced into the child. */
  assert.equal(childEnv({ PATH: 7 }).PATH, undefined);
  assert.equal(childEnv(PARENT, { allow: 'SUPABASE_URL' }).SUPABASE_URL, undefined,
    'a non-array allow was treated as a list');
});

test('THE CONTROL: this distinguishes, in both directions', () => {
  /*
   * Rule 5. Every assertion above is a refusal, and a childEnv that returned
   * {} would satisfy all of them while being a total outage.
   */
  const env = childEnv(PARENT);
  assert.ok(Object.keys(env).length > 0, 'nothing survived at all');
  assert.ok(Object.keys(env).length < Object.keys(PARENT).length, 'everything survived; nothing was filtered');
});
