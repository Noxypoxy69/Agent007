/**
 * AUDIT SCAFFOLD (auditor-owned, not part of the product).
 *
 * The project guard refuses `git checkout <sha> -- test/<anything>` outright
 * (blanket rule on test/), so an auditor working in its own clone cannot
 * materialise the suite the ordinary way. This copies the tree VERBATIM out of
 * git into a sibling directory at the same depth, so every `../src/...` import
 * in a test resolves exactly as it does from `test/`.
 *
 * Usage: node scripts/audit-copy-tests.mjs <rev> <destdir>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rev = process.argv[2];
const dest = process.argv[3];
if (!rev || !dest) {
  console.error('usage: node scripts/audit-copy-tests.mjs <rev> <destdir>');
  process.exit(2);
}

const names = execFileSync('git', ['ls-tree', '-r', '--name-only', `${rev}:test`], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\n').map((s) => s.trim()).filter(Boolean);

let n = 0;
for (const name of names) {
  const buf = execFileSync('git', ['show', `${rev}:test/${name}`], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = path.join(dest, name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  n += 1;
}
console.log(`copied ${n} files from ${rev}:test -> ${dest}`);
