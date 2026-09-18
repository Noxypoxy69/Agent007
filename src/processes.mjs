import { run } from './exec.mjs';
import { platform } from 'node:os';
import { readlink } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeCommand } from './argv.mjs';

/**
 * Best-effort association of running processes to a worktree.
 *
 * Honest about its limits:
 *  - Linux: /proc/<pid>/cwd gives true working directory -> high confidence.
 *  - Windows and macOS: no cheap cwd lookup, so association is by command-line
 *    substring match -> reported as confidence "commandline", which can miss a
 *    process launched with a relative path.
 * A miss is reported as a miss. This module never claims "no verify running"
 * as fact; callers get `probeOk:false` if the probe itself failed.
 */

const CLASSIFIERS = [
  { re: /\bnpm\b.*\brun\b.*\bverify\b|\bnpm\b\s+verify\b/i, kind: 'verify' },
  { re: /check-gates-can-fail/i, kind: 'gates-can-fail' },
  { re: /\bvitest\b|\bjest\b|node\s+--test\b|\bnpm\b.*\btest\b/i, kind: 'test' },
  { re: /\beslint\b|\bnpm\b.*\blint\b/i, kind: 'lint' },
  { re: /\btsc\b|typecheck/i, kind: 'typecheck' },
  { re: /\bnext\b\s+(dev|build)|\bvite\b/i, kind: 'build' },
  { re: /\bclaude\b|\bcodex\b/i, kind: 'agent' },
  { re: /\bgit\b\s/i, kind: 'git' },
];

export function classifyCommand(cmd) {
  for (const { re, kind } of CLASSIFIERS) if (re.test(cmd)) return kind;
  return null;
}

/** Parse `ps -eo pid=,ppid=,args=` output. */
export function parsePs(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return out;
}

/** Parse the JSON emitted by our fixed Get-CimInstance probe. */
export function parseWinJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(data)) data = [data];
  return data
    .filter((p) => p && p.ProcessId != null)
    .map((p) => ({
      pid: Number(p.ProcessId),
      ppid: Number(p.ParentProcessId ?? 0),
      command: String(p.CommandLine ?? ''),
    }));
}

async function listAll() {
  if (platform() === 'win32') {
    // Fixed script literal. No interpolation of any kind.
    const r = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress -Depth 2',
    ]);
    return { probeOk: r.ok, procs: r.ok ? parseWinJson(r.stdout) : [], error: r.error };
  }
  const r = await run('ps', ['-eo', 'pid=,ppid=,args=']);
  return { probeOk: r.ok, procs: r.ok ? parsePs(r.stdout) : [], error: r.error };
}

async function cwdOf(pid) {
  if (platform() !== 'linux') return null;
  try { return await readlink(`/proc/${pid}/cwd`); } catch { return null; }
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b) || norm(a).startsWith(norm(b) + path.sep.toLowerCase());
}

export async function probeProcesses(worktrees) {
  const { probeOk, procs, error } = await listAll();
  if (!probeOk) return { probeOk: false, error, byWorktree: {} };

  const byWorktree = Object.fromEntries(worktrees.map((w) => [w, []]));
  const self = process.pid;

  for (const p of procs) {
    if (p.pid === self) continue;
    const kind = classifyCommand(p.command);
    if (!kind) continue;
    const cwd = await cwdOf(p.pid);

    // Gather every worktree this process could belong to, then decide once.
    let matches = [];
    for (const w of worktrees) {
      if (cwd && samePath(cwd, w)) matches.push({ w, confidence: 'cwd' });
      else if (p.command.toLowerCase().includes(w.toLowerCase())) matches.push({ w, confidence: 'commandline' });
    }
    if (!matches.length) continue;

    // An exact cwd match beats any substring match: a shell whose command line
    // happens to mention two worktrees is not running in both of them.
    const exact = matches.filter((m) => m.confidence === 'cwd');
    if (exact.length) matches = exact;

    // Still multiple candidates => substring matching cannot tell them apart.
    // Say so rather than asserting the process belongs to every one of them.
    const ambiguous = matches.length > 1;

    for (const m of matches) {
      byWorktree[m.w].push({
        pid: p.pid, ppid: p.ppid, kind, confidence: m.confidence, ambiguous,
        ...(ambiguous ? { alsoMatched: matches.filter((x) => x.w !== m.w).map((x) => x.w) } : {}),
        // Raw argv is never published. See src/argv.mjs.
        ...sanitizeCommand(p.command),
      });
    }
  }
  return { probeOk: true, error: null, byWorktree };
}
