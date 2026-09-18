/**
 * AUDIT SCAFFOLD. Equivalent of `npm test` (`node --test "test/**\/*.test.mjs"`)
 * but over an explicitly-named file list, because the rail refuses a glob or a
 * directory operand and `package.json` cannot be materialised here.
 *
 * Usage: node scripts/audit-run-suite.mjs <dir> [substring-filter]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'atest';
const filter = process.argv[3] ?? '';

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return walk(p);
  return e.isFile() && p.endsWith('.test.mjs') ? [p.split(path.sep).join('/')] : [];
});

const files = walk(dir).filter((f) => f.includes(filter)).sort();
console.error(`[scaffold] running ${files.length} files from ${dir}`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
