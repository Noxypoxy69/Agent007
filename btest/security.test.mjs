import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCommand, tokenize, looksSecret, REDACTED } from '../src/argv.mjs';
import { evaluateAcl } from '../src/secretstore.mjs';
import { protectSecret, unprotectSecret, verifyPermissions } from '../src/secretstore.mjs';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── argv redaction ──────────────────────────────────────────────────────────

const REAL_SECRETS = [
  ['--token', 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
  ['--api-key', 'sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
  ['--password', 'hunter2butlongerandopaque123456789'],
  ['--secret', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'],
  ['-H', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc'],
];

for (const [flag, value] of REAL_SECRETS) {
  test(`argv: value after ${flag} never crosses the wire`, () => {
    const out = sanitizeCommand(`node script.mjs ${flag} ${JSON.stringify(value)}`);
    const wire = JSON.stringify(out);
    assert.equal(wire.includes(value), false, `leaked value for ${flag}`);
    assert.ok(out.redactedCount >= 1);
  });
}

test('argv: --flag=value form is redacted', () => {
  const v = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
  const out = sanitizeCommand(`node x.mjs --token=${v}`);
  assert.equal(JSON.stringify(out).includes(v), false);
  assert.ok(out.args.includes(`--token=${REDACTED}`));
});

test('argv: KEY=VALUE env-style assignments are redacted by key name', () => {
  const v = 'super-secret-service-role-value-000';
  const out = sanitizeCommand(`node x.mjs SUPABASE_SERVICE_KEY=${v} NODE_ENV=production`);
  assert.equal(JSON.stringify(out).includes(v), false);
  assert.ok(out.args.some((a) => a.startsWith('SUPABASE_SERVICE_KEY=')));
  assert.ok(out.args.includes('NODE_ENV=production'), 'benign env vars survive');
});

test('argv: bare secret-shaped tokens are redacted wherever they appear', () => {
  const cases = [
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig',
    'xoxb-1234567890-abcdefghijkl',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyD-1234567890abcdefghijklmnopqrstuv',
    'glpat-ABCdefGHIjklMNOpqrST',
    'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  ];
  for (const c of cases) {
    assert.ok(looksSecret(c), `not detected: ${c}`);
    const out = sanitizeCommand(`node x.mjs ${c}`);
    assert.equal(JSON.stringify(out).includes(c), false, `leaked: ${c}`);
  }
});

test('argv: credentials inside a URL are redacted', () => {
  const url = 'postgres://user:p4ssw0rd@db.example.com:5432/app';
  const out = sanitizeCommand(`node migrate.mjs ${url}`);
  assert.equal(JSON.stringify(out).includes('p4ssw0rd'), false);
});

test('argv: ordinary commands stay readable (quoted windows path)', () => {
  const out = sanitizeCommand('"C:\\Program Files\\nodejs\\node.exe" scripts/check-gates-can-fail.mjs --verbose');
  assert.equal(out.executable, 'node.exe');
  assert.deepEqual(out.args, ['scripts/check-gates-can-fail.mjs', '--verbose']);
  assert.equal(out.redactedCount, 0);
});

test('argv: unquoted windows path with spaces is not split into wrong args', () => {
  // Win32_Process frequently returns the executable path unquoted.
  const out = sanitizeCommand('C:\\Program Files\\nodejs\\node.exe scripts/check-gates-can-fail.mjs --verbose');
  assert.equal(out.executable, 'node.exe');
  assert.deepEqual(out.args, ['scripts/check-gates-can-fail.mjs', '--verbose']);
});

test('argv: npm run verify stays readable', () => {
  const out = sanitizeCommand('npm run verify');
  assert.equal(out.executable, 'npm');
  assert.deepEqual(out.args, ['run', 'verify']);
});

test('argv: full path is reduced to a basename', () => {
  assert.equal(sanitizeCommand('/usr/local/bin/node a.mjs').executable, 'node');
});

test('argv: a sensitive flag at the truncation edge still redacts its value', () => {
  const v = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
  const filler = Array.from({ length: 11 }, (_, i) => `--f${i}`).join(' ');
  const out = sanitizeCommand(`node x.mjs ${filler} --token ${v}`);
  assert.equal(JSON.stringify(out).includes(v), false, 'value leaked past the arg window');
});

test('argv: long unrecognised tokens are dropped rather than published', () => {
  const blob = 'Z'.repeat(200);
  const out = sanitizeCommand(`node x.mjs ${blob}`);
  assert.equal(JSON.stringify(out).includes(blob), false);
});

test('argv: quoted arguments tokenize correctly', () => {
  assert.deepEqual(tokenize('node "C:\\Users\\Test User\\x.mjs" --flag'),
    ['node', 'C:\\Users\\Test User\\x.mjs', '--flag']);
});

test('argv: no raw command field survives sanitisation', () => {
  const out = sanitizeCommand('node x.mjs --token abc123');
  assert.equal('command' in out, false, 'raw command must not be published');
  assert.deepEqual(Object.keys(out).sort(),
    ['argCount', 'args', 'executable', 'redactedCount', 'truncated']);
});

// ── secret storage ──────────────────────────────────────────────────────────

test('secret seals and unseals on this platform', async () => {
  const sealed = await protectSecret('top-secret-value');
  const back = await unprotectSecret(sealed);
  assert.equal(back.ok, true);
  assert.equal(back.secret, 'top-secret-value');
});

test('POSIX permission check rejects group/other access', async (t) => {
  // POSIX SEMANTICS ONLY. verifyPermissions() branches on platform: on Windows
  // it takes the windows-acl path and never looks at a mode, so these
  // assertions describe behaviour that cannot happen there. chmod() is also
  // close to inert on Windows, so 0o644 does not produce the state under test.
  //
  // Unguarded, this failed on the first Windows machine the package ran on
  // (2026-09-14) and was the sole red in an otherwise green suite -- the kind
  // of permanent, ignorable failure that teaches people to skim past reds.
  //
  // The Windows half of verifyPermissions is not left uncovered: the ACL branch
  // is exercised by test/psmodulepath.test.mjs, and evaluateAcl has its own
  // platform-independent unit tests below.
  if (process.platform === 'win32') return t.skip('posix-only: windows uses the ACL branch');
  const dir = await mkdtemp(path.join(tmpdir(), 'ab-perm-'));
  const f = path.join(dir, 'config.json');
  await writeFile(f, '{}');
  await chmod(f, 0o600);
  assert.equal((await verifyPermissions(f)).ok, true);
  await chmod(f, 0o644);
  const bad = await verifyPermissions(f);
  assert.equal(bad.ok, false);
  assert.match(bad.detail.problem, /group or other/);
});

test('Windows ACL evaluation accepts user/SYSTEM/Administrators and rejects others', () => {
  const base = { Owner: 'DESKTOP\\danny', User: 'DESKTOP\\danny' };
  assert.equal(evaluateAcl({ ...base, Rules: [
    { Identity: 'DESKTOP\\danny', Rights: 'FullControl', Type: 'Allow', Inherited: false },
    { Identity: 'NT AUTHORITY\\SYSTEM', Rights: 'FullControl', Type: 'Allow', Inherited: true },
    { Identity: 'BUILTIN\\Administrators', Rights: 'FullControl', Type: 'Allow', Inherited: true },
  ] }).ok, true);

  const bad = evaluateAcl({ ...base, Rules: [
    { Identity: 'DESKTOP\\danny', Rights: 'FullControl', Type: 'Allow', Inherited: false },
    { Identity: 'BUILTIN\\Users', Rights: 'Read', Type: 'Allow', Inherited: true },
  ] });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].identity, 'BUILTIN\\Users');
});

test('Windows ACL: Deny rules are not treated as grants', () => {
  assert.equal(evaluateAcl({ Owner: 'D\\u', User: 'D\\u', Rules: [
    { Identity: 'D\\u', Rights: 'FullControl', Type: 'Allow', Inherited: false },
    { Identity: 'Everyone', Rights: 'FullControl', Type: 'Deny', Inherited: false },
  ] }).ok, true);
});

test('a DPAPI blob cannot be unsealed on a non-Windows host', async (t) => {
  if (process.platform === 'win32') return t.skip('windows');
  const r = await unprotectSecret({ scheme: 'dpapi-user', value: 'deadbeef' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'dpapi-blob-on-non-windows');
});

test('legacy plaintext string secrets still load', async () => {
  const r = await unprotectSecret('legacy-plain-secret');
  assert.equal(r.ok, true);
  assert.equal(r.secret, 'legacy-plain-secret');
});
