/* Copy the tracked test files from the read-only shared checkout into a
 * sibling dir at the same depth, verbatim. Read-only towards the shared tree. */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:/Users/DANNY GARCIA/Agent007/test';
const DST = path.resolve('taudit');
fs.mkdirSync(DST, { recursive: true });
const files = process.argv.slice(2);
for (const f of files) {
  const from = path.join(SRC, f);
  const buf = fs.readFileSync(from);
  fs.writeFileSync(path.join(DST, f), buf);
  console.log(`copied ${f} ${buf.length} bytes`);
}
