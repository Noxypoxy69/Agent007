import { run } from './exec.mjs';

const GIT = 'git';

/** Fixed probe set. Nothing here is constructed from remote input. */
async function git(cwd, args) {
  return run(GIT, args, { cwd });
}
const line = (r) => (r.ok ? r.stdout.trim() : null);

/**
 * Parse `git status --porcelain=v1 -z`.
 * Entries are NUL-separated: "XY <path>". Rename/copy entries (X in R,C)
 * are followed by an extra NUL-separated original path, which must be
 * consumed or every subsequent entry misparses.
 */
export function parseStatusZ(buf) {
  const out = [];
  const toks = buf.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.length < 4) continue;
    const x = t[0], y = t[1];
    const path = t.slice(3);
    let from = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      from = toks[++i] ?? null;
    }
    out.push({
      x, y, path, from,
      staged: x !== ' ' && x !== '?',
      dirty: y !== ' ' && y !== '?',
      untracked: x === '?' && y === '?',
    });
  }
  return out;
}

/** Parse `git worktree list --porcelain` into {path, head, branch, detached, locked}. */
export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw === '') { if (cur) { out.push(cur); cur = null; } continue; }
    const sp = raw.indexOf(' ');
    const key = sp === -1 ? raw : raw.slice(0, sp);
    const val = sp === -1 ? '' : raw.slice(sp + 1);
    if (key === 'worktree') cur = { path: val, head: null, branch: null, detached: false, locked: false };
    else if (!cur) continue;
    else if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'locked') cur.locked = true;
  }
  if (cur) out.push(cur);
  return out;
}

export async function listWorktrees(cwd) {
  const r = await git(cwd, ['worktree', 'list', '--porcelain']);
  return r.ok ? parseWorktreeList(r.stdout) : [];
}

/**
 * Full git snapshot for one worktree. Every field is observed, never inferred:
 * a field we could not determine is null, not a guess.
 */
export async function gitState(cwd, { mainRef = 'origin/main' } = {}) {
  const toplevel = line(await git(cwd, ['rev-parse', '--show-toplevel']));
  if (!toplevel) return { ok: false, reason: 'not-a-git-worktree', worktree: cwd };

  const [branchR, headR, mainR, upstreamR, statusR] = await Promise.all([
    git(cwd, ['branch', '--show-current']),
    git(cwd, ['rev-parse', 'HEAD']),
    git(cwd, ['rev-parse', mainRef]),
    git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
  ]);

  const branch = line(branchR) || null;        // null => detached HEAD
  const head = line(headR);
  const mainSha = line(mainR);                  // null => no origin/main locally
  const upstream = upstreamR.ok ? upstreamR.stdout.trim() : null;

  /*
   * WHERE the upstream actually lives, not just that it has a name.
   *
   * Captured because "has an upstream" is not the same claim as "exists
   * somewhere other than this disk", and the difference is a shortcut somebody
   * will reach for. Agent Bridge itself had no remote; the quick fix is
   * `git init --bare ../mirror && git remote add origin ../mirror`, after which
   * NO_UPSTREAM stops firing and the work is still on exactly one machine.
   *
   * A guard that can be satisfied without fixing the thing it guards is worse
   * than no guard, so the URL is collected and releaseRisk judges it.
   */
  let upstreamUrl = null;
  if (upstream) {
    const remoteName = upstream.includes('/') ? upstream.slice(0, upstream.indexOf('/')) : upstream;
    const urlR = await git(cwd, ['remote', 'get-url', remoteName]);
    upstreamUrl = urlR.ok ? (line(urlR) || null) : null;
  }

  let baseSha = null;
  if (mainSha) baseSha = line(await git(cwd, ['merge-base', 'HEAD', mainRef]));

  // Unpushed: prefer the real upstream. With no upstream the branch has never
  // been pushed, so everything since merge-base is unpushed.
  let unpushed = null, unpushedReason = null;
  if (upstream) {
    const c = line(await git(cwd, ['rev-list', '--count', `${upstream}..HEAD`]));
    unpushed = c == null ? null : Number(c);
    unpushedReason = 'vs-upstream';
  } else if (baseSha) {
    const c = line(await git(cwd, ['rev-list', '--count', `${baseSha}..HEAD`]));
    unpushed = c == null ? null : Number(c);
    unpushedReason = 'no-upstream:vs-merge-base';
  }

  // Divergence from origin/main, reported as observed counts.
  let aheadOfMain = null, behindMain = null;
  if (mainSha) {
    const lr = line(await git(cwd, ['rev-list', '--left-right', '--count', `${mainRef}...HEAD`]));
    if (lr) {
      const [behind, ahead] = lr.split(/\s+/).map(Number);
      behindMain = behind; aheadOfMain = ahead;
    }
  }

  const entries = statusR.ok ? parseStatusZ(statusR.stdout) : [];

  return {
    ok: true,
    worktree: toplevel,
    branch,
    detached: branch === null,
    head,
    baseSha,
    mainRef,
    mainSha,
    upstream,
    upstreamUrl,
    unpushed,
    unpushedReason,
    aheadOfMain,
    behindMain,
    staged: entries.filter((e) => e.staged).map((e) => ({ path: e.path, code: e.x + e.y })),
    dirty: entries.filter((e) => e.dirty && !e.untracked).map((e) => ({ path: e.path, code: e.x + e.y })),
    untracked: entries.filter((e) => e.untracked).map((e) => ({ path: e.path, code: '??' })),
  };
}
