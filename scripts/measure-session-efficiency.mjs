#!/usr/bin/env node
/**
 * MEASURE VERIFIED WORK PER TOKEN, AND PERSIST IT — the wiring the token system
 * was missing.
 *
 * THE GAP THIS CLOSES. src/tokenTelemetry.mjs + src/attemptPipeline.mjs +
 * provenanceStore.writeMeasurements(-> ~/.agentbridge/tokenMeasurements.json) are
 * all built, but nothing feeds them: attemptPipeline reads token counts from
 * `io.usage`, which the runner never populates, and the interactive Claude Code
 * sessions that do the real work never run through attemptPipeline at all. So the
 * measurement store stayed empty and tokenMeasurements.json was never created.
 *
 * The real numbers live in two places that DO exist: Claude Code's per-message
 * `usage` (real, provider-recorded, in the session .jsonl) and git (the commits a
 * session produced, attributable by the `Claude-Session:` trailer this repo's
 * commits carry). This script joins them per session and, with --persist, writes
 * them to the measurement store the rest of the system already reads.
 *
 * WHAT IS REAL vs WHAT IS HONESTLY NULL.
 *   - tokens: EXACT (provider-recorded).
 *   - commits: EXACT only when a commit message names this session's Claude
 *     session id. Time-window attribution is deliberately NOT used: three agents
 *     share this machine with overlapping windows, so a window match is noise, and
 *     a fabricated denominator is worse than a missing one. A session with no
 *     id-matched commit reports commits_exact 0 with confidence NONE, not a guess.
 *   - verified_fixes / findings: NULL, with a reason. They need a per-attempt
 *     verification binding (attemptPipeline's verdict/tests/accepted bound to the
 *     token ledger and the candidate sha). That binding does not exist in the live
 *     worker yet, so measuring it from transcripts would be eyeballing — refused.
 *
 * ACCOUNTING RULE (matches src/tokenTelemetry.mjs): cached input is SEPARATE from
 * input and never summed into it. `noncached = input + output` is what is billed
 * at full rate; cache_read/cache_creation are reported on their own.
 *
 * READ-ONLY BY DEFAULT. Without --persist it prints and writes nothing to runtime
 * state. --persist appends observations to the measurement store, idempotent by
 * (session_id, last_ts): an unchanged session is skipped, a grown one appends a
 * new observation (append-only, never edits an existing row).
 *
 *   node scripts/measure-session-efficiency.mjs [transcriptDir] [--persist] [--json <out>]
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGit } from '../src/safeGit.mjs';

const argv = process.argv.slice(2);
const persist = argv.includes('--persist');
const jsonAt = (() => { const i = argv.indexOf('--json'); return i === -1 ? null : argv[i + 1] ?? null; })();
const dir = argv.find((a) => !a.startsWith('--') && a !== jsonAt)
  || path.join(os.homedir(), '.claude', 'projects', 'C--Users-DANNY-GARCIA-Agent007');

const CLAUDE_SESSION = /session_[A-Za-z0-9]{10,}/g;

/** Real per-message usage + the Claude session ids named inside a transcript. */
function readTranscript(file) {
  const text = readFileSync(file, 'utf8');
  const acc = {
    session: path.basename(file, '.jsonl'),
    input: 0, output: 0, cache_read: 0, cache_creation: 0,
    assistant_messages: 0, first_ts: null, last_ts: null,
    claude_session_ids: new Set(), models: {},
  };
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    const ts = obj.timestamp || obj.message?.timestamp;
    if (ts) {
      if (!acc.first_ts || ts < acc.first_ts) acc.first_ts = ts;
      if (!acc.last_ts || ts > acc.last_ts) acc.last_ts = ts;
    }
    for (const m of s.matchAll(CLAUDE_SESSION)) acc.claude_session_ids.add(m[0]);
    const u = obj.message?.usage;
    if (!u) continue;
    acc.assistant_messages += 1;
    acc.input += u.input_tokens || 0;
    acc.output += u.output_tokens || 0;
    acc.cache_read += u.cache_read_input_tokens || 0;
    acc.cache_creation += u.cache_creation_input_tokens || 0;
    const model = obj.message?.model;
    if (model) acc.models[model] = (acc.models[model] || 0) + 1;
  }
  acc.claude_session_ids = [...acc.claude_session_ids];
  return acc;
}

/** Commits since the earliest transcript, each with message body and touched files. */
function loadCommits(sinceISO) {
  const SEP = '';
  const REC = '';
  let raw;
  try {
    raw = runGit(['log', '--since', sinceISO, `--format=%H${SEP}%cI${SEP}%B${REC}`], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return String(raw).split(REC).map((r) => r.trim()).filter(Boolean).map((rec) => {
    const [sha, cIso, body = ''] = rec.split(SEP);
    let files = [];
    try {
      files = runGit(['show', '--name-only', '--format=', sha], { encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { /* leave empty */ }
    return { sha, cIso, body, files };
  });
}

/** code | test | docs | mixed | other — from the paths a commit touched. */
function classifyCommit(files) {
  const isTest = (f) => /(^|\/)test\/.+\.test\.mjs$/.test(f);
  const isDoc = (f) => f.endsWith('.md') || f.startsWith('docs/');
  const isCode = (f) => /^(src|bin|scripts|supabase|bridge)\//.test(f) && !isTest(f) && !f.endsWith('.md');
  const code = files.some(isCode);
  const test = files.some(isTest);
  const doc = files.some(isDoc);
  if (code && (test || doc)) return 'mixed';
  if (code) return 'code';
  if (test) return 'test';
  if (doc) return 'docs';
  return 'other';
}

const num = (n) => (n == null ? null : n);
const perK = (a, b) => (b > 0 ? Math.round(a / b) : null);

const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
const sessions = files.map(readTranscript).sort((a, b) => (a.first_ts || '').localeCompare(b.first_ts || ''));
const earliest = sessions.map((s) => s.first_ts).filter(Boolean).sort()[0] || '2026-09-16T00:00:00Z';
const commits = loadCommits(earliest);

const rows = sessions.map((s) => {
  const ids = new Set(s.claude_session_ids);
  const mine = commits.filter((c) => [...ids].some((id) => c.body.includes(id)));
  const byClass = { code: 0, test: 0, docs: 0, mixed: 0, other: 0 };
  for (const c of mine) byClass[classifyCommit(c.files)] += 1;
  const codeCommits = byClass.code + byClass.mixed;
  return {
    source: 'claude-transcript',
    session_id: s.session,
    first_ts: s.first_ts,
    last_ts: s.last_ts,
    assistant_messages: s.assistant_messages,
    models: s.models,
    tokens: {
      input: s.input, output: s.output,
      cache_read: s.cache_read, cache_creation: s.cache_creation,
      noncached: s.input + s.output,
    },
    commits_exact: mine.length,
    commit_attribution: mine.length ? 'EXACT (Claude-Session trailer)' : 'NONE (no id-matched commit)',
    commit_classes: byClass,
    code_commits: codeCommits,
    verified_fixes: null,
    findings: null,
    not_measured_reason: 'verified_fixes/findings need a per-attempt verification binding (attemptPipeline verdict+tests+candidate_sha bound to the token ledger); absent in the live worker path, so not derivable from transcripts without eyeballing',
    metrics: {
      output_per_code_commit: perK(s.output, codeCommits),
      cache_read_per_code_commit: perK(s.cache_read, codeCommits),
      code_commits_per_million_output: s.output > 0 ? Math.round((codeCommits / s.output) * 1e6 * 100) / 100 : null,
    },
  };
});

// ---- print
const fmt = (n) => (n == null ? '·' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
console.log(`transcript dir: ${dir}`);
console.log(`commits scanned since ${earliest}: ${commits.length}\n`);
console.log(['session', 'first_ts', 'msgs', 'output', 'cache_read', 'commits', 'code', 'out/code'].join('\t'));
for (const r of rows) {
  console.log([
    r.session_id.slice(0, 8), r.first_ts || '?', r.assistant_messages,
    fmt(r.tokens.output), fmt(r.tokens.cache_read),
    r.commits_exact, r.code_commits, fmt(r.metrics.output_per_code_commit),
  ].join('\t'));
}
const idMatched = rows.filter((r) => r.commits_exact > 0).length;
console.log(`\nsessions with EXACT commit attribution: ${idMatched}/${rows.length}`);
console.log('verified_fixes/findings: NOT MEASURED (needs per-attempt verification binding — see row.not_measured_reason)');

if (jsonAt) {
  writeFileSync(jsonAt, `${JSON.stringify({ dir, generated_at: new Date().toISOString(), commits_scanned: commits.length, rows }, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${jsonAt}`);
}

// ---- persist to the measurement store the rest of the system reads
if (persist) {
  const { readMeasurements, writeMeasurements } = await import('../src/provenanceStore.mjs');
  const existing = await readMeasurements();
  const seen = new Set(existing
    .filter((r) => r.source === 'claude-transcript')
    .map((r) => `${r.session_id}@${r.last_ts}`));
  const additions = rows
    .filter((r) => !seen.has(`${r.session_id}@${r.last_ts}`))
    .map((r) => ({ at: new Date().toISOString(), task_id: null, ...r }));
  if (additions.length === 0) {
    console.log('\npersist: nothing new (every session already recorded at its current last_ts)');
  } else {
    await writeMeasurements([...existing, ...additions]);
    console.log(`\npersist: appended ${additions.length} observation(s) to the measurement store`);
  }
}
