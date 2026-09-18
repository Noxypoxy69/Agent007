import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLanesYaml } from '../src/lanes.mjs';

test('parses the supported lanes.yml shape', () => {
  const y = `
# ownership map
messaging:
  - scripts/check-gates-*.mjs
  - src/lib/reply/**

onboarding:
  - src/lib/merchantPhone.server.ts   # claim logic
release:
  - "supabase/migrations/**"
`;
  assert.deepEqual(parseLanesYaml(y), {
    messaging: ['scripts/check-gates-*.mjs', 'src/lib/reply/**'],
    onboarding: ['src/lib/merchantPhone.server.ts'],
    release: ['supabase/migrations/**'],
  });
});

test('rejects unsupported YAML rather than half-parsing it', () => {
  assert.throws(() => parseLanesYaml('messaging: [a, b]\n'), /flow sequences/);
  assert.throws(() => parseLanesYaml('messaging: scripts/*.mjs\n'), /must be a list/);
  assert.throws(() => parseLanesYaml('  - orphan\n'), /before any lane name/);
  assert.throws(() => parseLanesYaml('messaging:\n  nested:\n    - a\n'), /unsupported syntax/);
});

test('empty input yields an empty map, not a crash', () => {
  assert.deepEqual(parseLanesYaml(''), {});
});
