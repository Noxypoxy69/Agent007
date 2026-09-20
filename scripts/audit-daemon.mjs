#!/usr/bin/env node
/**
 * THE CONSUMER. The piece that was missing, and the reason the queue starved.
 *
 *   node scripts/audit-daemon.mjs [--once] [--launch] [--by <id>]
 *
 * ═══ WHAT THIS CLOSES ═══
 *
 * The audit loop had three breaks. Two are fixed: `audit-record` was
 * unreachable dead code, and the §7.1 trigger only printed. The third is that
 * NOTHING CONSUMED THE QUEUE -- four durable demands sat in it and no process
 * owned the next transition. Same shape as the task queue: sixteen runnable
 * rows, zero leases, last dispatch three days ago.
 *
 * A git hook cannot be the consumer. Not because it cannot allocate a
 * workspace -- `src/workspaceManager.mjs` does `git worktree add --detach` and
 * a hook could call it, and I was wrong to say otherwise -- but because a
 * consumer spawned by the maker's own commit is the maker choosing and
 * launching its own reviewer. That is the exact thing §7.1 forbids. The
 * consumer has to be a process that already exists and decides for itself.
 *
 * ═══ WHAT IT DOES NOT DECIDE ═══
 *
 *   which job    the oldest PENDING one it is eligible for. Not chosen.
 *   the packet   whatever `auditJobsFor` already wrote. It does not author
 *                one, and it never reads the commit SUBJECT -- that is the
 *                maker's account of the work and §7.2 keeps it away from the
 *                reviewer.
 *   the verdict  the reviewer's. This starts it and records nothing.
 *
 * ═══ ELIGIBILITY IS REAL AND IT REFUSES ═══
 *
 * A daemon that claimed its own author's work would reproduce the defect it
 * exists to fix, so `claimJob` is asked, not second-guessed: it holds the
 * author-cannot-audit rule, the lease and the staleness window.
 *
 * ═══ --launch IS OPT-IN, DELIBERATELY ═══
 *
 * Without it this prepares the workspace and prints the exact command. With
 * it, it spawns a reviewer. The default is the safe one because this machine
 * has killed three background processes for memory today, and a daemon that
 * fires an LLM session per control commit unattended is how you find that out
 * the expensive way. Measure the volume first.
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 || i + 1 >= argv.length ? d : argv[i + 1];
};

const ONCE = has('--once');
const LAUNCH = has('--launch');
const say = (s) => process.stderr.write(`${s}\n`);

const { runGit } = await import('../src/safeGit.mjs');
const { readQueue, writeQueue } = await import('../src/auditQueueStore.mjs');
const { claimJob, JOB, REQUIRED_PROOFS } = await import('../src/auditJob.mjs');

/*
 * THE DAEMON'S IDENTITY IS ITS OWN, NOT THE SESSION'S.
 *
 * It must not inherit AGENTBRIDGE_SESSION_ID: if it did, every job it claimed
 * would be claimed by whichever agent happened to start it, and the
 * author-cannot-audit check would compare a session against itself. A distinct
 * id is the minimum honesty available while no credential exists -- and it is
 * `asserted`, which `satisfiesGate` correctly refuses to count.
 */
const BY = flag('--by', `audit-daemon@${os.hostname()}`);

function nextJob() {
  const { rows } = readQueue(REPO);
  const pending = rows
    .filter((j) => (j.state ?? JOB.PENDING) === JOB.PENDING)
    .sort((a, b) => String(a.first_seen_at ?? '').localeCompare(String(b.first_seen_at ?? '')));
  return { rows, job: pending[0] ?? null, pendingCount: pending.length };
}

/** A detached worktree at the exact candidate, via the manager's own pattern. */
function allocate(candidateSha) {
  const dir = path.join(os.tmpdir(), `audit-${String(candidateSha).slice(0, 12)}`);
  if (existsSync(dir)) return { ok: true, dir, reused: true };
  try {
    runGit(['worktree', 'add', '--detach', dir, candidateSha], { cwd: REPO });
    return { ok: true, dir, reused: false };
  } catch (e) {
    return { ok: false, why: String(e?.stderr || e?.message || e).trim() };
  }
}

/**
 * The brief. THE COMMIT SUBJECT IS NOT IN IT, and that is the whole point of
 * §7.2: a reviewer who reads the maker's account starts by agreeing with it.
 */
function brief(job, dir) {
  return [
    'You are an INDEPENDENT AUDITOR. You did not write this. Your job is to BREAK it, not confirm it.',
    '',
    `WORK ONLY IN: ${dir}`,
    'It is a detached worktree at the exact candidate. Do not touch any other checkout.',
    'Do not commit, push, merge, deploy or migrate.',
    '',
    `CANDIDATE: ${job.candidate_sha}`,
    `TREE:      ${job.candidate_tree_sha}`,
    `TOUCHED:   ${(job.touched ?? []).join(', ')}`,
    '',
    'You are deliberately NOT being told what this change claims to do. That account is the',
    'maker\'s own and reading it means starting from agreement. Derive intent from the diff.',
    '',
    'PROOF OBLIGATIONS:',
    ...(job.required_proofs ?? REQUIRED_PROOFS ?? []).map((p, i) => `  ${i + 1}. ${p}`),
    '',
    'Assert the reported TEST COUNT, never the exit code. Prove any mutation landed with git diff',
    'before trusting the result, and restore it afterwards.',
    '',
    'REPORT: defects ranked by severity, each with the command that demonstrates it; SEPARATELY the',
    'claims you checked and found TRUE; and what you could not check and why.',
  ].join('\n');
}

async function tick() {
  const { rows, job, pendingCount } = nextJob();
  if (!job) { say(`[audit-daemon] queue empty (${rows.length} row(s)); nothing to consume`); return false; }

  const claim = claimJob(job, { by: BY, bySource: 'asserted', now: Date.now() });
  if (!claim.ok) {
    say(`[audit-daemon] cannot claim ${job.audit_id}: ${claim.why}`);
    return false;
  }

  const ws = allocate(job.candidate_sha);
  if (!ws.ok) {
    /* NOT CLAIMED IF NOT WORKABLE. Leaving a claim on a job nobody can start
     * strands it until the lease lapses, which is starvation wearing a claim. */
    say(`[audit-daemon] could not allocate a workspace for ${job.audit_id}: ${ws.why}. Leaving it PENDING.`);
    return false;
  }

  writeQueue(REPO, rows.map((r) => (r.audit_id === job.audit_id ? claim.job : r)));

  const briefDir = path.join(ws.dir, '.audit');
  mkdirSync(briefDir, { recursive: true });
  const briefPath = path.join(briefDir, 'BRIEF.txt');
  writeFileSync(briefPath, `${brief(job, ws.dir)}\n`);

  say(`[audit-daemon] claimed ${job.audit_id} (${pendingCount} pending)`);
  say(`[audit-daemon] workspace ${ws.dir}${ws.reused ? ' (reused)' : ''}`);
  say(`[audit-daemon] brief     ${briefPath}`);

  if (!LAUNCH) {
    say('[audit-daemon] PREPARED ONLY. To review it, run a fresh agent in that worktree with that brief.');
    say('               --launch spawns one; it is opt-in because an unattended LLM per control commit');
    say('               is how a memory-starved machine falls over.');
    return true;
  }

  const child = spawn('claude', ['-p', `Read ${briefPath} and carry it out.`], {
    cwd: ws.dir, stdio: 'inherit', shell: false,
  });
  await new Promise((r) => child.on('close', r));
  say(`[audit-daemon] reviewer exited for ${job.audit_id}. Record with: agentbridge audit-record --id ${job.audit_id} --verdict <PASS|FAIL>`);
  return true;
}

const did = await tick();
if (!ONCE && did) say('[audit-daemon] --once not given, but this build consumes one job per invocation by design.');
process.exit(0);
