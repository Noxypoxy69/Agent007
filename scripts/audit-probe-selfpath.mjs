// AUDIT PROBE: does process.argv[1] canonicalise the same way import.meta.url does?
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const SELF = fileURLToPath(import.meta.url);
console.log(JSON.stringify({
  argv1: process.argv[1],
  resolved: path.resolve(process.argv[1] ?? ''),
  SELF,
  RUN_DIRECTLY: !!process.argv[1] && path.resolve(process.argv[1]) === SELF,
}, null, 2));
