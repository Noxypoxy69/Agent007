#!/usr/bin/env node
/**
 * WHICH EXPORTS ARE TEST-ONLY, ALL OF THEM, WITH NO CAP.
 *
 * `test/deadExports.test.mjs` prints the first twelve when it fails, sorted by
 * file. That is right for a gate message -- a wall of names is a wall nobody
 * reads -- but it means a ratchet that rises by one tells you the COUNT moved
 * and not WHAT moved, and the twelve shown are the same twelve every time.
 *
 * Measured need: the floor went 80 -> 81 while three sessions were committing
 * to one branch. Every export of the module I had just added had a production
 * caller, so the new orphan was somebody else's -- but proving that from a
 * truncated list sorted before `src/v*` is not possible, and guessing at whose
 * debt it is, is how a baseline gets raised to fit whoever noticed last.
 *
 * READ-ONLY. It classifies and prints. It changes no constant and no code.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyExports } from '../src/moduleGraph.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const want = process.argv[2] ?? 'test-only';

const rows = classifyExports(root).filter((d) => d.category === want);

const byFile = new Map();
for (const d of rows) {
  if (!byFile.has(d.file)) byFile.set(d.file, []);
  byFile.get(d.file).push(d.name);
}

console.log(`${want}: ${rows.length} export(s) across ${byFile.size} file(s)\n`);
for (const file of [...byFile.keys()].sort()) {
  console.log(`${file}`);
  for (const name of byFile.get(file).sort()) console.log(`    ${name}`);
}

/*
 * Exit 0 always. This is a probe, not a gate -- deadExports is the gate, and a
 * second thing exiting non-zero on the same condition is two answers to one
 * question.
 */
process.exit(0);
