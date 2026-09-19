#!/usr/bin/env node
/**
 * READ-ONLY forensic aggregator for Claude Code session transcripts.
 *
 * WHY THIS EXISTS. AgentBridge's own token accounting (src/tokenTelemetry.mjs,
 * src/attemptPipeline.mjs, provenanceStore.writeMeasurements ->
 * ~/.agentbridge/tokenMeasurements.json) is built but NOT wired into the live
 * worker path -- the attempts ledger has 0 rows, so tokenMeasurements.json was
 * never created. The only real, provider-recorded token numbers on this machine
 * are the per-message `usage` objects inside Claude Code's session .jsonl.
 *
 * This sums those per session. It is NOT per-task -- a session spans many tasks
 * -- so treat the output as per-session cost, the closest real proxy until the
 * accounting code is wired to bind usage to task_id/attempt/candidate_sha.
 *
 * ACCOUNTING RULE (matches the repo's semantics): cached input is SEPARATE from
 * input. cache_read and cache_creation are reported on their own and never added
 * into input_tokens. `noncached = input + output`. `context_read` groups the
 * tokens the model actually ingested (input + cache_read + cache_creation) for a
 * throughput view; it is labelled, not conflated with billed input.
 *
 * Nothing is written back to any transcript or runtime file. Output goes to
 * stdout and to the path given as argv[3] if present.
 *
 * Usage:
 *   node scripts/aggregate-transcript-tokens.mjs [transcriptDir] [outJsonPath]
 * Defaults: the Agent007 project transcript dir under the user home.
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_DIR = path.join(
  os.homedir(), '.claude', 'projects', 'C--Users-DANNY-GARCIA-Agent007',
);
const dir = process.argv[2] || DEFAULT_DIR;
const outPath = process.argv[3] || null;

function aggregateFile(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const acc = {
    session: path.basename(file, '.jsonl'),
    bytes: statSync(file).size,
    lines: 0,
    assistant_messages: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    models: {},
    first_ts: null,
    last_ts: null,
  };
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    acc.lines += 1;
    const ts = obj.timestamp || obj.message?.timestamp;
    if (ts) {
      if (!acc.first_ts || ts < acc.first_ts) acc.first_ts = ts;
      if (!acc.last_ts || ts > acc.last_ts) acc.last_ts = ts;
    }
    const u = obj.message?.usage;
    if (!u) continue;
    acc.assistant_messages += 1;
    acc.input_tokens += u.input_tokens || 0;
    acc.output_tokens += u.output_tokens || 0;
    acc.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    acc.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    const m = obj.message?.model;
    if (m) acc.models[m] = (acc.models[m] || 0) + 1;
  }
  acc.noncached_tokens = acc.input_tokens + acc.output_tokens;
  acc.context_read_tokens = acc.input_tokens
    + acc.cache_read_input_tokens + acc.cache_creation_input_tokens;
  acc.duration_minutes = (acc.first_ts && acc.last_ts)
    ? Math.round((new Date(acc.last_ts) - new Date(acc.first_ts)) / 60000)
    : null;
  return acc;
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => path.join(dir, f));

const rows = files.map(aggregateFile).sort((a, b) => (a.first_ts || '').localeCompare(b.first_ts || ''));

const totals = rows.reduce((t, r) => {
  t.input_tokens += r.input_tokens;
  t.output_tokens += r.output_tokens;
  t.cache_read_input_tokens += r.cache_read_input_tokens;
  t.cache_creation_input_tokens += r.cache_creation_input_tokens;
  t.noncached_tokens += r.noncached_tokens;
  t.context_read_tokens += r.context_read_tokens;
  return t;
}, {
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0, noncached_tokens: 0, context_read_tokens: 0,
});

const fmt = (n) => (n == null ? '?' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const short = (s) => s.slice(0, 8);

console.log(`transcript dir: ${dir}`);
console.log(`files: ${rows.length}\n`);
console.log(['session', 'first_ts', 'dur_min', 'msgs', 'input', 'output', 'cache_read', 'cache_create', 'noncached'].join('\t'));
for (const r of rows) {
  console.log([
    short(r.session), r.first_ts || '?', r.duration_minutes ?? '?', r.assistant_messages,
    fmt(r.input_tokens), fmt(r.output_tokens), fmt(r.cache_read_input_tokens),
    fmt(r.cache_creation_input_tokens), fmt(r.noncached_tokens),
  ].join('\t'));
}
console.log('\nTOTALS');
console.log(`  input:          ${fmt(totals.input_tokens)}`);
console.log(`  output:         ${fmt(totals.output_tokens)}`);
console.log(`  cache_read:     ${fmt(totals.cache_read_input_tokens)}`);
console.log(`  cache_creation: ${fmt(totals.cache_creation_input_tokens)}`);
console.log(`  noncached (in+out): ${fmt(totals.noncached_tokens)}`);
console.log(`  context_read (in+cache_read+cache_creation): ${fmt(totals.context_read_tokens)}`);

if (outPath) {
  writeFileSync(outPath, `${JSON.stringify({ dir, generated_at: new Date().toISOString(), rows, totals }, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${outPath}`);
}
