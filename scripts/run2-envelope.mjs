#!/usr/bin/env node
/**
 * RUN 2 MACHINE ENVELOPE -- the driver.
 *
 *   node scripts/run2-envelope.mjs [--repo <path>]
 *
 * Runs the named queries of RUN2-ENVELOPE-SPEC.md, hands the raw results to the
 * pure classifier in src/run2Envelope.mjs, and prints the envelope as JSON on
 * stdout. Every decision about trust is made there, where the suite can watch
 * it fail; this file only fetches.
 *
 * READ-ONLY. It queries git, reads candidates/ and registrations.json, and
 * calls list_tasks and list_agents with the READER token. It repairs nothing
 * it finds wrong -- that is the contract, not an omission.
 *
 * A QUERY THAT FAILS IS AN OBSERVATION, NOT A CRASH. Each source is captured
 * as {ok:false, detail} and the classifier turns it into a non-TRUSTED field
 * with the reason. The envelope is still printed. Exit 0 means an envelope was
 * produced; it says nothing about how many fields are TRUSTED.
 *
 * Needs AGENTBRIDGE_READER_TOKEN for fields 2 and 6. Without it those fields
 * say so; nothing falls back to a local guess.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { runGit } from '../src/safeGit.mjs';
import { PROTECTED_PATHS, baselineBlockingDriftFromGit } from '../src/guardSession.mjs';
import { HOME } from '../src/config.mjs';
import { readerConfig, closeHttp, interpretHttp } from '../src/hostedRegistry.mjs';
import { compileEnvelope, serializeEnvelope } from '../src/run2Envelope.mjs';

/*
 * READ-ONLY INCLUDES .git/index. A plain `git status` that finds a stat
 * mismatch refreshes the index and WRITES it back -- measured, T-118 F2. That
 * is an optional lock, and GIT_OPTIONAL_LOCKS=0 turns it off for every git
 * child: runGit keeps the ambient environment, so this reaches the status run
 * inside baselineBlockingDriftFromGit too, which is a protected file this
 * driver cannot pass a flag to. Set before any git runs.
 */
process.env.GIT_OPTIONAL_LOCKS = '0';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString();

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/* ── field 3: git ─────────────────────────────────────────────────────── */

/*
 * EACH QUERY IS CAPTURED ON ITS OWN (AMENDMENT 1). A repository with no HEAD
 * still has an identity, and a failed status still leaves HEAD answered; one
 * try around all of them threw every answer away with the first failure. A
 * failed query leaves its value null and its reason in `details`; the
 * classifier turns each into its own component.
 */
function observeBaseline(repo) {
  const observed_at = nowIso();
  const details = {};
  const ask = (key, fn) => {
    try { return fn(); } catch (e) { details[key] = `git could not answer: ${String(e?.message ?? e).split('\n')[0]}`; return null; }
  };
  const git = (args) => runGit(args, { cwd: repo, timeout: 20000 });
  const top = ask('repo_id', () => git(['rev-parse', '--show-toplevel']).trim());
  const head = ask('head', () => git(['rev-parse', '--verify', 'HEAD^{commit}']).trim());
  const tree = ask('tree', () => git(['rev-parse', '--verify', 'HEAD^{tree}']).trim());
  const status = ask('status', () => git(['status', '--porcelain', '--untracked-files=all'])
    .split('\n').filter((l) => l.trim() !== ''));
  const index_flags = ask('index_flags', () => git(['ls-files', '-v']));
  // Returns null for "could not measure" rather than throwing.
  const drift = top ? baselineBlockingDriftFromGit(top) : null;
  if (drift === null && !details.drift) details.drift = 'baseline drift could not be measured';
  return {
    ok: true,
    repo_id: top ? path.basename(top) : null,
    head,
    tree,
    status,
    index_flags,
    drift,
    details,
    observed_at,
    source_identity: `git ${top ? path.basename(top) : repo} @ ${head ?? '(no HEAD)'}`,
  };
}

/* ── field 4: PROTECTED_PATHS + candidates/ ──────────────────────────── */

function observeProtected() {
  const observed_at = nowIso();
  const dir = path.join(HOME, 'preserved', 'candidates');
  const source_identity = `PROTECTED_PATHS + ${dir}`;
  let manifest_text = null;
  let manifest_sha256 = null;
  try {
    const buf = readFileSync(path.join(dir, 'MANIFEST.txt'));
    manifest_text = buf.toString('utf8');
    manifest_sha256 = sha256(buf);
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      return { ok: false, detail: `MANIFEST.txt unreadable: ${e?.code ?? e?.message}`, observed_at, source_identity };
    }
  }
  /*
   * An unlistable candidates/ -- including one that does not exist -- is
   * patches:null, NOT []. The classifier decides what that means: with no
   * manifest it is ABSENT, with a manifest it is UNTRUSTWORTHY. An empty list
   * here would be the driver asserting "no candidates" it never observed.
   *
   * NAMED, UNMEASURED LIMIT (T-127 D03). The case "candidates/ cannot be
   * listed but MANIFEST.txt inside it can be read" is NOT exercised end to
   * end: no portable fixture makes a directory unlistable while a file in it
   * stays readable (on Windows it needs an ACL edit; as a file, the manifest
   * path stops resolving). The classifier's half -- a manifest plus
   * patches:null is UNTRUSTWORTHY -- is tested; this mapping is not.
   */
  let patches = null;
  try {
    patches = readdirSync(dir).filter((f) => f.endsWith('.patch')).sort().map((file) => {
      const buf = readFileSync(path.join(dir, file));
      return { file, sha256: sha256(buf), bytes: statSync(path.join(dir, file)).size };
    });
  } catch { /* patches stays null */ }
  return { ok: true, protected_paths: [...PROTECTED_PATHS], manifest_text, manifest_sha256, patches, observed_at, source_identity };
}

/* ── fields 2 and 6: the hosted reader surface ───────────────────────── */

/**
 * One tools/call with the READER token. The raw rows are returned untouched:
 * fromToolResult in hostedRegistry.mjs defaults a missing capacity to 'idle',
 * and a defaulted liveness field is exactly what field 6 must not be fed.
 */
async function callReaderTool(name) {
  const observed_at = nowIso();
  const cfg = readerConfig(process.env);
  const source_identity = cfg ? `${name} @ ${cfg.url}` : name;
  if (!cfg) return { ok: false, detail: 'AGENTBRIDGE_READER_TOKEN is not set', observed_at, source_identity };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      signal: ac.signal,
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
    });
    const refused = await interpretHttp(res, { credential: 'reader token' });
    if (refused) return { ok: false, detail: `${refused.state}${refused.detail ? `: ${refused.detail}` : ''}`, observed_at, source_identity };
    const body = await res.json();
    const text = body?.result?.content?.[0]?.text;
    let rows = null;
    try { rows = JSON.parse(text); } catch { /* reported below */ }
    if (!Array.isArray(rows)) return { ok: false, detail: `${name} did not return a list`, observed_at, source_identity };
    return { ok: true, rows, observed_at, source_identity };
  } catch (e) {
    return { ok: false, detail: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e), observed_at, source_identity };
  } finally {
    clearTimeout(timer);
  }
}

/* ── field 6's independent side: who is heartbeating on this machine ─── */

function observeRuntime() {
  const observed_at = nowIso();
  const file = path.join(HOME, 'registrations.json');
  try {
    const buf = readFileSync(file);
    const rows = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(rows)) return { ok: false, detail: 'registrations.json is not a JSON array', observed_at, source_identity: file };
    return { ok: true, rows, observed_at, source_identity: `${file} sha256:${sha256(buf)}` };
  } catch (e) {
    // A MISSING SOURCE IS NOT AN EMPTY OBSERVATION (T-118 F1). rows:[] here
    // would let an empty roster promote field 6 against a file nobody read.
    if (e?.code === 'ENOENT') return { ok: false, detail: 'registrations.json does not exist', observed_at, source_identity: file };
    return { ok: false, detail: String(e?.message ?? e), observed_at, source_identity: file };
  }
}

async function main() {
  const repo = argValue('--repo') ?? process.cwd();
  const baseline = observeBaseline(repo);
  const protectedObs = observeProtected();
  const runtime = observeRuntime();
  const [tasks, roster] = await Promise.all([callReaderTool('list_tasks'), callReaderTool('list_agents')]);
  const envelope = compileEnvelope({
    generated_at: nowIso(),
    tasks,
    baseline,
    protected: protectedObs,
    roster,
    runtime,
  });
  process.stdout.write(serializeEnvelope(envelope));
}

// exitCode, never process.exit(): exiting after a remote fetch on Windows
// trips the libuv assertion documented in src/hostedRegistry.mjs closeHttp().
main()
  .catch((e) => { console.error(`run2-envelope: ${e?.stack ?? e}`); process.exitCode = 1; })
  .finally(closeHttp);
