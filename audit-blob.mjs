/* Materialise a tracked blob at a given commit into taudit/, verbatim. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [sha, ...paths] = process.argv.slice(2);
fs.mkdirSync('taudit', { recursive: true });
for (const p of paths) {
  const buf = execFileSync('git', ['show', `${sha}:${p}`], { maxBuffer: 64 * 1024 * 1024 });
  const out = path.join('taudit', path.basename(p));
  fs.writeFileSync(out, buf);
  console.log(`${sha}:${p} -> ${out} (${buf.length} bytes)`);
}
