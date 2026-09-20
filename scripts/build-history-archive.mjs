#!/usr/bin/env node
/**
 * BUILD THE PROJECT HISTORY ARCHIVE, for the owner tracing provenance.
 *
 *   node scripts/build-history-archive.mjs [--out <dir>] [--part-mb 5]
 *
 * Layout is the owner's:
 *
 *   manifest/   agent007-transcripts-full-manifest.txt, chronology.csv, checksums.sha256
 *   raw/        claude/session_<id>/<date>_partNNN.jsonl   (+ empty, labelled chatgpt/ codex/ bridge/)
 *   normalized/ transcripts_NNN.jsonl
 *   indexes/    by-session.json, by-agent.json, by-date.json
 *   extracted/  (interpretation — see its README)
 *
 * ═══ THE RULES THIS FILE IS WRITTEN UNDER ═══
 *
 * NOTHING IS FILTERED OR REORDERED IN `raw/`. Bytes in, bytes out, split only
 * on line boundaries. This archive is evidence about agents, produced by an
 * agent whose own transcript is in it, so anything I edit is worthless.
 *
 * CHECKSUMS ARE OF THE ORIGINALS, computed on the first read, before any
 * splitting. A checksum of my own copy certifies my copy.
 *
 * EVERY NORMALIZED RECORD CARRIES A RAW POINTER (`raw_file`, `raw_line`), so
 * no parsed field has to be taken on trust. Normalization is lossy by nature;
 * the pointer is what makes it checkable.
 *
 * SOURCES I CANNOT REACH GET AN EMPTY DIRECTORY AND A README, never silence.
 * ChatGPT and Codex conversations are not on this disk, and a `chatgpt-work`
 * coordinator assigned real tasks in this project — so an archive that simply
 * omitted them would read as complete and be wrong.
 */
import {
  readdirSync, statSync, existsSync, mkdirSync, createReadStream, writeFileSync, appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 || i + 1 >= argv.length ? d : argv[i + 1];
};

const SRC = path.join(os.homedir(), '.claude', 'projects');
const OUT = path.resolve(flag('--out', path.join(os.homedir(), 'Documents', 'Agent007-History')));
const PART_BYTES = Math.max(1, Number(flag('--part-mb', 5))) * 1024 * 1024;

const dir = (...p) => {
  const d = path.join(OUT, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};

if (!existsSync(SRC)) { process.stderr.write(`no transcript root at ${SRC}\n`); process.exit(2); }

/* ── 1. find every raw transcript ─────────────────────────────────────── */

function scan(d, project, kind, acc) {
  let entries = [];
  try { entries = readdirSync(d, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name === 'tool-results') continue; // not transcripts; skipped deliberately
      scan(full, project, e.name === 'subagents' ? 'subagent' : kind, acc);
    } else if (e.name.endsWith('.jsonl')) {
      acc.push({ project, kind, file: full, bytes: statSync(full).size });
    }
  }
  return acc;
}

const files = [];
for (const p of readdirSync(SRC, { withFileTypes: true }).filter((x) => x.isDirectory())) {
  scan(path.join(SRC, p.name), p.name, 'session', files);
}

/* ── 2. one pass per file: hash, chronology, split into raw/ ──────────── */

const manifestDir = dir('manifest');
const chronology = [['session', 'project', 'kind', 'first_ts', 'last_ts', 'lines', 'bytes', 'sha256', 'raw_parts', 'source_file'].join(',')];
const checksums = [];
const rows = [];

const csv = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

for (const f of files) {
  const hash = createHash('sha256');
  let lines = 0;
  let firstTs = null;
  let lastTs = null;
  let sessionId = null;

  /* Session id and dates come from the CONTENT, not the filename, because a
   * filename is a fact about how something was saved. Falls back to the
   * basename only when no record carries one. */
  const parts = [];
  let partIdx = 0;
  let partBytes = 0;
  let partPath = null;

  const rl = createInterface({ input: createReadStream(f.file), crlfDelay: Infinity });
  // eslint-disable-next-line no-restricted-syntax
  for await (const line of rl) {
    hash.update(line); hash.update('\n');
    lines += 1;
    let rec = null;
    try { rec = JSON.parse(line); } catch { /* keep the bytes regardless */ }
    if (rec) {
      sessionId ??= rec.sessionId ?? null;
      const ts = rec.timestamp ?? null;
      if (typeof ts === 'string') { firstTs ??= ts; lastTs = ts; }
    }
    if (partPath === null || partBytes >= PART_BYTES) {
      partIdx += 1; partBytes = 0;
      const sid = sessionId ?? path.basename(f.file, '.jsonl');
      const day = (firstTs ?? new Date(statSync(f.file).mtime).toISOString()).slice(0, 10);
      const holder = f.kind === 'subagent' ? `subagent_${path.basename(f.file, '.jsonl')}` : `session_${sid}`;
      partPath = path.join(dir('raw', 'claude', f.project, holder), `${day}_part${String(partIdx).padStart(3, '0')}.jsonl`);
      writeFileSync(partPath, '');
      parts.push(partPath);
    }
    appendFileSync(partPath, `${line}\n`);
    partBytes += Buffer.byteLength(line) + 1;
  }

  const sha = hash.digest('hex');
  const sid = sessionId ?? path.basename(f.file, '.jsonl');
  rows.push({ ...f, sessionId: sid, firstTs, lastTs, lines, sha, parts });
  chronology.push([sid, f.project, f.kind, firstTs ?? '', lastTs ?? '', lines, f.bytes, sha, parts.length, f.file].map(csv).join(','));
  checksums.push(`${sha}  ${f.file}`);
}

/* Chronological, because the archive's job is to show order. */
const body = chronology.slice(1).sort();
writeFileSync(path.join(manifestDir, 'chronology.csv'), `${[chronology[0], ...body].join('\n')}\n`);
writeFileSync(path.join(manifestDir, 'checksums.sha256'), `${checksums.join('\n')}\n`);

const total = files.reduce((n, x) => n + x.bytes, 0);
writeFileSync(path.join(manifestDir, 'agent007-transcripts-full-manifest.txt'), [
  '# AGENT007 HISTORY ARCHIVE',
  `# generated ${new Date().toISOString()} from ${SRC}`,
  `# ${files.length} raw transcript(s), ${(total / 1024 / 1024).toFixed(1)} MB`,
  '#',
  '# COMPLETE FOR: Claude Code sessions and subagents on THIS machine, all projects.',
  '# NOT PRESENT, and not obtainable from this machine:',
  '#   ChatGPT conversations  - not on this disk. A "chatgpt-work" coordinator',
  '#                            assigned real tasks in this project, so this is a',
  '#                            genuine gap, not an empty category.',
  '#   Codex / other tools    - not on this disk.',
  '#   claude.ai web sessions - server side.',
  '#   any agent on another machine; anything already deleted or rotated.',
  '#',
  '# raw/ is unedited: split only on line boundaries, never reordered.',
  '# checksums.sha256 is over the ORIGINAL files, taken before any processing.',
  '# WARNING: transcripts contain tool output verbatim, including auth material',
  '# (e.g. "atis-latch" records). Safe on this machine; review before sharing.',
  '',
].join('\n'));

/* ── 3. label the sources that are missing rather than omitting them ──── */

for (const [name, why] of [
  ['chatgpt', 'ChatGPT conversations are not stored on this machine. A "chatgpt-work" coordinator\nassigned tasks in this project, so this directory is EMPTY BUT NOT EMPTY OF HISTORY.\nOnly the owner can export these from the ChatGPT web app.'],
  ['codex', 'No Codex transcripts exist on this machine.'],
  ['bridge', 'Bridge state (tasks, messages, roster, owner decisions, audit ledger) lives in\nSupabase, not on disk. It is authoritative where transcripts are self-reported,\nso it is worth exporting separately via the agentbridge MCP tools.'],
]) {
  writeFileSync(path.join(dir('raw', name), 'README-MISSING.txt'),
    `${why}\n\nThis directory exists so the gap is visible. An archive that omitted it\nwould read as complete and be wrong.\n`);
}

/* ── 4. normalized/, every record pointing back at its raw line ───────── */

const textOf = (msg) => {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
};
const toolsOf = (msg) => {
  const c = msg?.content;
  if (!Array.isArray(c)) return [];
  return c.filter((b) => b?.type === 'tool_use' && typeof b.name === 'string').map((b) => b.name);
};

const normDir = dir('normalized');
let outIdx = 1;
let outLines = 0;
let outPath = path.join(normDir, `transcripts_${String(outIdx).padStart(3, '0')}.jsonl`);
writeFileSync(outPath, '');

const bySession = {};
const byAgent = {};
const byDate = {};

for (const r of rows) {
  let ln = 0;
  const rl = createInterface({ input: createReadStream(r.file), crlfDelay: Infinity });
  // eslint-disable-next-line no-restricted-syntax
  for await (const line of rl) {
    ln += 1;
    let rec = null;
    try { rec = JSON.parse(line); } catch { continue; }

    const out = {
      ts: rec.timestamp ?? null,
      source: 'claude-code',
      project: r.project,
      kind: r.kind,
      session: rec.sessionId ?? r.sessionId,
      type: rec.type ?? null,
      role: rec.message?.role ?? null,
      text: textOf(rec.message),
      tools: toolsOf(rec.message),
      cwd: rec.cwd ?? null,
      branch: rec.gitBranch ?? null,
      uuid: rec.uuid ?? null,
      parent: rec.parentUuid ?? null,
      raw_file: r.file,
      raw_line: ln,
    };

    if (outLines >= 20000) {
      outIdx += 1; outLines = 0;
      outPath = path.join(normDir, `transcripts_${String(outIdx).padStart(3, '0')}.jsonl`);
      writeFileSync(outPath, '');
    }
    appendFileSync(outPath, `${JSON.stringify(out)}\n`);
    outLines += 1;

    const s = out.session ?? 'unknown';
    bySession[s] ??= { session: s, project: r.project, kind: r.kind, records: 0, first_ts: null, last_ts: null, raw_files: new Set() };
    bySession[s].records += 1;
    bySession[s].raw_files.add(r.file);
    if (out.ts) { bySession[s].first_ts ??= out.ts; bySession[s].last_ts = out.ts; }

    /* "Agent" is the working directory's project plus the branch: the only
     * agent identity a transcript actually carries. Deliberately NOT inferred
     * from prose, which is self-reported. */
    const a = `${r.project}::${out.branch ?? 'no-branch'}`;
    byAgent[a] ??= { agent: a, records: 0, sessions: new Set() };
    byAgent[a].records += 1;
    byAgent[a].sessions.add(s);

    if (out.ts) {
      const d = out.ts.slice(0, 10);
      byDate[d] ??= { date: d, records: 0, sessions: new Set() };
      byDate[d].records += 1;
      byDate[d].sessions.add(s);
    }
  }
}

const idx = dir('indexes');
const deSet = (o, keys) => Object.values(o).map((v) => {
  const c = { ...v };
  for (const k of keys) c[k] = [...(v[k] ?? [])];
  return c;
});
writeFileSync(path.join(idx, 'by-session.json'), `${JSON.stringify(deSet(bySession, ['raw_files']), null, 2)}\n`);
writeFileSync(path.join(idx, 'by-agent.json'), `${JSON.stringify(deSet(byAgent, ['sessions']), null, 2)}\n`);
writeFileSync(path.join(idx, 'by-date.json'), `${JSON.stringify(deSet(byDate, ['sessions']), null, 2)}\n`);

writeFileSync(path.join(idx, 'README.txt'),
  'by-session / by-agent / by-date are MECHANICAL: counted from record fields, nothing inferred.\n\n'
  + '"agent" is project + git branch, which is the only agent identity a transcript\n'
  + 'actually carries. It is NOT parsed from prose, because an agent naming itself\n'
  + 'in text is self-reported and this project has already been bitten by treating\n'
  + 'a self-written trailer as authority.\n\n'
  + 'by-topic.json is NOT generated. A topic index requires judgement about what a\n'
  + 'passage is about, which makes it interpretation and belongs under extracted/.\n');

writeFileSync(path.join(dir('extracted'), 'README.txt'),
  'EXTRACTED/ IS INTERPRETATION, NOT DATA.\n\n'
  + 'failures, repairs, policies, wins-losses-struggles are judgements about what\n'
  + 'happened. Everything above this directory is mechanical and checkable; this is\n'
  + 'not, and it must not be read as though it were.\n\n'
  + 'Rules it will be built under:\n'
  + '  1. Every entry cites raw_file + raw_line. A claim you cannot check is a claim.\n'
  + '  2. Every entry is tagged SELF-REPORTED or INDEPENDENTLY-MEASURED. An agent\n'
  + '     summarising its own history is the thing rule 20 exists to prevent.\n'
  + '  3. Where a later session falsified an earlier claim, BOTH are kept, with the\n'
  + '     correction pointing at the original. Nothing is quietly rewritten.\n\n'
  + 'Not yet generated: it needs the owner to say whether an agent may extract its\n'
  + 'own record at all, or whether that pass belongs to an independent reader.\n');

process.stderr.write(`archive: ${OUT}\n`);
process.stderr.write(`${files.length} raw file(s), ${(total / 1024 / 1024).toFixed(1)} MB, ${outIdx} normalized part(s)\n`);
