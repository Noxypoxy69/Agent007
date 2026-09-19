#!/usr/bin/env node
/**
 * MEASURE VERIFIED WORK PER TOKEN, EARLY vs RECENT — and persist it. The wiring
 * the token system was missing.
 *
 * THE GAP. src/tokenTelemetry.mjs + src/attemptPipeline.mjs +
 * provenanceStore.writeMeasurements(-> ~/.agentbridge/tokenMeasurements.json) are
 * built but never fed: attemptPipeline reads counts from `io.usage`, which the
 * runner never populates, and the interactive Claude Code sessions that do the real
 * work never run through attemptPipeline. So the store stayed empty.
 *
 * THE REAL DATA lives in two places that DO exist: Claude Code per-message `usage`
 * (provider-recorded, in the session .jsonl) and git (the commits produced, by
 * commit date). This joins them BY TIME PERIOD, not per session.
 *
 * WHY PERIOD, NOT PER SESSION. Per-session commit attribution was tried and is not
 * reliable: three agents share this machine with overlapping windows, and the
 * Claude-Session trailer is quoted inside many transcripts (reminders, pasted
 * CLAUDE.md, cross-references), so id-matching over-attributes wildly (measured:
 * ~999 attributions from 323 commits). A fabricated denominator is worse than a
 * coarse honest one, so this measures whole-machine tokens vs whole-machine commits
 * per period. That still answers "more verified work per token now than early?"
 *
 * WHAT IS REAL vs NULL. tokens EXACT (provider-recorded). commits EXACT (git, by
 * date), classified by touched paths. verified_fixes / findings NULL with a reason:
 * they need a per-attempt verification binding (attemptPipeline verdict+tests+
 * candidate_sha bound to the token ledger), which the live worker path does not have
 * yet -- deriving them from transcripts would be eyeballing, refused. code_commits
 * is the honest first-order proxy for "verified engineering output".
 *
 * ACCOUNTING RULE (matches src/tokenTelemetry.mjs): cached input is SEPARATE from
 * input, never summed in. noncached = input + output (billed at full rate).
 *
 * READ-ONLY without --persist. --persist REPLACES this script's own derived rows
 * (sources claude-transcript-session and period-efficiency) and preserves every
 * other row, so re-running is idempotent and always reflects current truth. These
 * are RE-DERIVED aggregates, not point-in-time events, so replacing them beats
 * accumulating stale/duplicate copies -- an earlier append-by-key scheme both
 * froze the summaries (keyed without last_ts) and duplicated growing-session rows
 * (keyed with an advancing last_ts). A blind audit caught that; this is the fix.
 *
 *   node scripts/measure-session-efficiency.mjs [transcriptDir] [--persist] [--json <out>]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGit } from '../src/safeGit.mjs';

const argv = process.argv.slice(2);
const persist = argv.includes('--persist');
const jsonAt = (() => { const i = argv.indexOf('--json'); return i === -1 ? null : argv[i + 1] ?? null; })();
const dir = argv.find((a) => !a.startsWith('--') && a !== jsonAt)
  || path.join(os.homedir(), '.claude', 'projects', 'C--Users-DANNY-GARCIA-Agent007');

// EARLY = before this instant, RECENT = on/after. Sep 16-17 vs Sep 18-19.
// COMPARE BY EPOCH, NOT BY STRING. git %cI carries a local offset (this repo's
// history mixes -07:00 and Z), so a lexicographic compare against a Z cutoff
// ignores the timezone and misfiles the local-evening band into EARLY. Date.parse
// normalises both the offset-bearing commit dates and the UTC transcript dates to
// the same instant. A blind audit caught ~21 commits misfiled by the string form.
const CUTOFF = '2026-09-18T00:00:00Z';
const CUTOFF_MS = Date.parse(CUTOFF);
const periodOf = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t >= CUTOFF_MS ? 'RECENT' : 'EARLY';
};

function readTranscript(file) {
  const text = readFileSync(file, 'utf8');
  const acc = {
    session: path.basename(file, '.jsonl'),
    input: 0, output: 0, cache_read: 0, cache_creation: 0,
    assistant_messages: 0, first_ts: null, last_ts: null, models: {},
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
  return acc;
}

function classifyCommit(files) {
  const isTest = (f) => /(^|\/)test\/.+\.test\.mjs$/.test(f);
  const isCode = (f) => /^(src|bin|scripts|supabase|bridge)\//.test(f) && !isTest(f) && !f.endsWith('.md');
  const code = files.some(isCode);
  const test = files.some(isTest);
  const doc = files.some((f) => f.endsWith('.md') || f.startsWith('docs/'));
  if (code) return 'code';
  if (test) return 'test';
  if (doc) return 'docs';
  return 'other';
}

function loadCommits(sinceISO) {
  const SEP = '';
  const REC = '';
  let raw;
  try {
    raw = runGit(['log', '--since', sinceISO, `--format=%H${SEP}%cI${REC}`], { encoding: 'utf8' });
  } catch { return []; }
  return String(raw).split(REC).map((r) => r.trim()).filter(Boolean).map((rec) => {
    const [sha, cIso] = rec.split(SEP);
    let files = [];
    try {
      /*
       * --diff-merges=first-parent: THE THIRD CALL SITE OF ONE DEFECT.
       *
       * `git show --name-only` prints no file list for a merge, so files=[]
       * and classifyCommit returns 'other'. This script's whole output is
       * "verified work per token", and its own header calls code_commits
       * "the honest first-order proxy for verified engineering output" --
       * so every merge in the history was silently subtracted from the
       * numerator.
       *
       * Found by audit after I fixed src/auditLedger.mjs, then fixed
       * scripts/audit-auto.mjs and wrote that the class was closed. It was
       * not; this was the third site. Measured on the same merge:
       *   without the flag -> []                              => 'other'
       *   with it          -> ["test/leakRegression.test.mjs"] => 'test'
       */
      files = runGit(['show', '--diff-merges=first-parent', '--name-only', '--format=', sha], { encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { /* empty */ }
    return { sha, cIso, class: classifyCommit(files) };
  });
}

const emptyTok = () => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0, noncached: 0, sessions: 0, assistant_messages: 0 });
const emptyCommits = () => ({ total: 0, code: 0, test: 0, docs: 0, other: 0 });

const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
const sessions = files.map(readTranscript).sort((a, b) => (a.first_ts || '').localeCompare(b.first_ts || ''));
const earliest = sessions.map((s) => s.first_ts).filter(Boolean).sort()[0] || '2026-09-16T00:00:00Z';
const commits = loadCommits(earliest);

const tok = { EARLY: emptyTok(), RECENT: emptyTok() };
for (const s of sessions) {
  const p = periodOf(s.first_ts);
  tok[p].input += s.input; tok[p].output += s.output;
  tok[p].cache_read += s.cache_read; tok[p].cache_creation += s.cache_creation;
  tok[p].noncached += s.input + s.output;
  tok[p].sessions += 1; tok[p].assistant_messages += s.assistant_messages;
}
const com = { EARLY: emptyCommits(), RECENT: emptyCommits() };
for (const c of commits) {
  const p = periodOf(c.cIso);
  com[p].total += 1; com[p][c.class] += 1;
}

const per = (a, b) => (b > 0 ? Math.round(a / b) : null);
function summarize(period) {
  const t = tok[period];
  const c = com[period];
  return {
    at: new Date().toISOString(),
    task_id: null,
    source: 'period-efficiency',
    period,
    cutoff: CUTOFF,
    tokens: t,
    commits: c,
    verified_fixes: null,
    findings: null,
    not_measured_reason: 'verified_fixes/findings need a per-attempt verification binding (attemptPipeline verdict+tests+candidate_sha bound to the token ledger); absent in the live worker path. code_commits is the honest proxy.',
    metrics: {
      output_per_code_commit: per(t.output, c.code),
      cache_read_per_code_commit: per(t.cache_read, c.code),
      noncached_per_code_commit: per(t.noncached, c.code),
      code_commits_per_million_output: t.output > 0 ? Math.round((c.code / t.output) * 1e6 * 100) / 100 : null,
    },
  };
}
const summaries = [summarize('EARLY'), summarize('RECENT')];

const fmt = (n) => (n == null ? '·' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
console.log(`transcript dir: ${dir}`);
console.log(`cutoff EARLY<->RECENT: ${CUTOFF}`);
console.log(`commits scanned since ${earliest}: ${commits.length}\n`);
for (const s of summaries) {
  console.log(`── ${s.period}  (${s.tokens.sessions} sessions, ${s.tokens.assistant_messages} assistant msgs)`);
  console.log(`   output ${fmt(s.tokens.output)}  cache_read ${fmt(s.tokens.cache_read)}  cache_creation ${fmt(s.tokens.cache_creation)}  noncached ${fmt(s.tokens.noncached)}`);
  console.log(`   commits ${s.commits.total}  (code ${s.commits.code}, test ${s.commits.test}, docs ${s.commits.docs}, other ${s.commits.other})`);
  console.log(`   output/code-commit ${fmt(s.metrics.output_per_code_commit)}  cache_read/code-commit ${fmt(s.metrics.cache_read_per_code_commit)}  code-commits/M-output ${s.metrics.code_commits_per_million_output}`);
}
console.log('\nverified_fixes/findings: NOT MEASURED (needs per-attempt verification binding).');

const perSessionRows = sessions.map((s) => ({
  at: new Date().toISOString(),
  task_id: null,
  source: 'claude-transcript-session',
  session_id: s.session,
  period: periodOf(s.first_ts),
  first_ts: s.first_ts,
  last_ts: s.last_ts,
  assistant_messages: s.assistant_messages,
  models: s.models,
  tokens: { input: s.input, output: s.output, cache_read: s.cache_read, cache_creation: s.cache_creation, noncached: s.input + s.output },
  metrics: {},
}));

if (jsonAt) {
  writeFileSync(jsonAt, `${JSON.stringify({ dir, generated_at: new Date().toISOString(), cutoff: CUTOFF, commits_scanned: commits.length, periods: summaries, sessions: perSessionRows }, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${jsonAt}`);
}

if (persist) {
  const { readMeasurements, writeMeasurements } = await import('../src/provenanceStore.mjs');
  const existing = await readMeasurements();
  // Manage-replace: drop this script's own derived rows and rewrite them from the
  // current computation; preserve every other row (e.g. token-budget handoff rows).
  // Re-derived aggregates are not point-in-time events, so replacing is idempotent
  // and correct where append-by-key froze summaries and duplicated session rows.
  const MANAGED = new Set(['claude-transcript-session', 'period-efficiency']);
  const kept = existing.filter((r) => !MANAGED.has(r.source));
  const managed = [...perSessionRows, ...summaries];
  await writeMeasurements([...kept, ...managed]);
  console.log(`\npersist: wrote ${managed.length} managed row(s); preserved ${kept.length} other row(s)`);
}
