#!/usr/bin/env node
/**
 * COLLECT EVERY CLAUDE TRANSCRIPT ON THIS MACHINE, UNEDITED.
 *
 *   node scripts/collect-transcripts.mjs [--out <file>] [--manifest-only]
 *
 * Written for the owner tracing the provenance of this project: which agent
 * did what, when, and in what order. It concatenates raw `.jsonl` session and
 * subagent logs with a delimiter naming each source, and writes a manifest
 * alongside.
 *
 * NOTHING IS FILTERED, REDACTED, SUMMARISED OR REORDERED. Bytes in, bytes out.
 * A provenance record that has been edited by one of the parties under
 * investigation is not a provenance record, and this file is run BY an agent
 * whose own transcript is in the set.
 *
 * ═══ WHAT THIS CAN AND CANNOT SEE ═══
 *
 * IT SEES: Claude Code sessions on this machine, for every project directory
 * under ~/.claude/projects, plus the per-session `subagents/` logs — which is
 * where the blind auditors' full working transcripts live.
 *
 * IT CANNOT SEE, and no tool on this machine can:
 *   - ChatGPT conversations. They are not on this disk.
 *   - claude.ai web sessions (the Cloudflare-worker connector path).
 *   - any agent that ran on another machine.
 *   - anything already deleted or rotated away.
 *
 * So the output is COMPLETE FOR CLAUDE CODE ON THIS BOX and is not "every AI
 * that touched the project". The manifest says so in its own header, because
 * a set that looks exhaustive and is not is worse than one that admits a gap.
 */
import { readdirSync, statSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
};

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const OUT = path.resolve(flag('--out', path.join(os.homedir(), 'Documents', 'agent007-transcripts-full.jsonl')));
const MANIFEST = `${OUT.replace(/\.jsonl$/, '')}-manifest.txt`;
const manifestOnly = argv.includes('--manifest-only');

if (!existsSync(ROOT)) {
  process.stderr.write(`no transcript root at ${ROOT}\n`);
  process.exit(2);
}

/** Every .jsonl under the tree, with where it came from. */
function collect(dir, project, kind, acc) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      /* `subagents/` holds the spawned auditors; `tool-results/` is not a
       * transcript and is skipped deliberately rather than silently. */
      if (e.name === 'tool-results') continue;
      collect(full, project, e.name === 'subagents' ? 'subagent' : kind, acc);
    } else if (e.name.endsWith('.jsonl')) {
      const st = statSync(full);
      acc.push({ project, kind, file: full, bytes: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return acc;
}

const projects = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
const files = [];
for (const p of projects) collect(path.join(ROOT, p.name), p.name, 'session', files);

/* Oldest first, so the file reads as the project's history in order. */
files.sort((a, b) => a.mtime.localeCompare(b.mtime));

const total = files.reduce((n, f) => n + f.bytes, 0);
const header = [
  '# CLAUDE TRANSCRIPT MANIFEST',
  `# generated ${new Date().toISOString()} from ${ROOT}`,
  `# ${files.length} file(s), ${(total / 1024 / 1024).toFixed(1)} MB total`,
  '#',
  '# COMPLETE FOR: Claude Code sessions and subagents on this machine.',
  '# NOT INCLUDED, and not obtainable from this machine: ChatGPT conversations,',
  '# claude.ai web sessions, any agent that ran elsewhere, anything already deleted.',
  '# Nothing below is filtered, redacted or reordered beyond sorting by mtime.',
  '#',
  '# mtime\tbytes\tkind\tproject\tfile',
  ...files.map((f) => `${f.mtime}\t${f.bytes}\t${f.kind}\t${f.project}\t${f.file}`),
  '',
].join('\n');

writeFileSync(MANIFEST, header);
process.stderr.write(`manifest: ${MANIFEST}\n`);
process.stderr.write(`${files.length} file(s), ${(total / 1024 / 1024).toFixed(1)} MB\n`);

if (manifestOnly) process.exit(0);

/*
 * STREAMED, NEVER READ WHOLE. One session here is 49 MB and the set is
 * hundreds; buffering would fail on the machine this is meant to run on.
 */
const out = createWriteStream(OUT);
out.write(`${header}\n`);
for (const f of files) {
  out.write(`\n===== BEGIN ${f.kind} ${f.project} ${f.file} (${f.bytes} bytes, ${f.mtime}) =====\n`);
  // eslint-disable-next-line no-await-in-loop
  await pipeline(createReadStream(f.file), out, { end: false });
  out.write(`\n===== END ${f.file} =====\n`);
}
out.end();
await new Promise((r) => out.on('close', r));

process.stderr.write(`wrote: ${OUT}\n`);
