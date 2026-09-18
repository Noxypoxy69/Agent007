// AUDIT: copy test files out of git at a given sha into audit/ (depth 1, so
// `../src/...` still resolves). `git checkout -- test/` is refused by the rail.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [sha, ...names] = process.argv.slice(2);
const REPO = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(REPO, 'audit'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'audit', 'helpers'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'audit', 'fixtures'), { recursive: true });

for (const n of names) {
  const buf = execFileSync('git', ['show', `${sha}:test/${n}`], { cwd: REPO, maxBuffer: 64 << 20 });
  fs.writeFileSync(path.join(REPO, 'audit', n), buf);
  console.log(`wrote audit/${n}  ${buf.length} bytes`);
}
