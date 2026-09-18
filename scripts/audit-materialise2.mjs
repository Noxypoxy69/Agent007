import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const REPO = path.resolve(import.meta.dirname, '..');
const [sha, ...names] = process.argv.slice(2);
for (const n of names) {
  const dest = path.join(REPO, 'audit', n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, execFileSync('git', ['show', `${sha}:test/${n}`], { cwd: REPO, maxBuffer: 64 << 20 }));
  console.log(`wrote audit/${n}`);
}
