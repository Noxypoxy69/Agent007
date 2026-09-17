import { run } from './exec.mjs';
import { isLocalRemote } from './releaseRisk.mjs';

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
 * Resolve a commit-ish to a full 40-character SHA, or refuse.
 *
 * WHY THIS EXISTS. On 2026-09-15 a delegation was recorded against
 * "e38ebd9d0e7a4cf7cc0e3c46c43e7ac8be9d9b0e". No such object has ever existed:
 * the agent knew the short form, padded it to forty characters, and
 * validateDelegation accepted it because the SHA rule is a SHAPE check --
 * /^[0-9a-f]{7,40}$/i -- and a fabricated string is the right shape. The
 * contract stored cleanly and pointed nowhere. A delegate checking it out
 * would have got "fatal: could not get object info" and no way to tell a typo
 * from a branch they had not fetched.
 *
 * A SHA is machine-verifiable, so no agent should ever type one from memory.
 * The rule now: the Bridge resolves it, and a base that does not resolve is
 * not a contract.
 *
 * `^{commit}` is doing real work -- it rejects a tree or blob whose hex is
 * perfectly valid but which no one can check out, and it canonicalises a short
 * SHA or a branch name to the full object id, so what is stored is unambiguous
 * forever rather than only until another object shares the prefix.
 */
export async function resolveCommit(cwd, rev) {
  const target = typeof rev === 'string' && rev.trim().length ? rev.trim() : 'HEAD';
  const toplevel = line(await git(cwd, ['rev-parse', '--show-toplevel']));
  if (!toplevel) return { ok: false, reason: 'not-a-git-worktree', cwd };

  const sha = line(await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${target}^{commit}`]));
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    return { ok: false, reason: 'unresolvable', rev: target, cwd };
  }
  return { ok: true, sha: sha.toLowerCase(), rev: target, worktree: toplevel };
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

  /*
   * The CLASSIFICATION, which is all any rule actually needs.
   *
   * upstreamUrl was added to answer one question -- does this remote reach
   * another machine -- and then published the answer along with the account
   * name and the private repository name:
   *
   *   "upstreamUrl": "https://github.com/<account>/<private-repo>.git"
   *
   * That is the fourth identity leak found in this payload, after the home path
   * in two spellings and the machine label, and it is the first one that
   * discloses somebody's private inventory rather than their name. It arrived
   * the same way as the others: as a side effect of collecting something else.
   *
   * `upstreamKind` carries the entire coordination value in one word. Rules
   * consume this; the URL stays local for evidence and for the operator's own
   * output, and collect.mjs strips it from anything transmitted.
   */
  const upstreamKind = upstream
    ? (upstreamUrl ? (isLocalRemote(upstreamUrl) ? 'local' : 'network') : 'unknown')
    : null;

  let baseSha = null;
  if (mainSha) baseSha = line(await git(cwd, ['merge-base', 'HEAD', mainRef]));

  /*
   * UNPUSHED MEANS "ON NO REMOTE", NOT "AHEAD OF UPSTREAM".
   *
   * This counted `upstream..HEAD`, which is a different question, and the two
   * diverge exactly where it matters: a feature branch whose upstream is
   * origin/main is ahead of main by its whole length while being pushed in full
   * to its OWN remote ref. On 2026-09-17 that reported `unpushed 14` for
   * d-claims-authz-b6 whose origin ref was byte-identical to local HEAD. Zero
   * commits existed only on that disk. The number was read by two agents as
   * stranded work and acted on, which is the cost of a field that answers a
   * question nobody asked.
   *
   * `--not --remotes` asks the real question: commits reachable from HEAD and
   * from no remote-tracking ref at all. That is the set nobody else can fetch,
   * which is what every consumer of this field actually means -- the deploy gate
   * above refuses an unpushed HEAD precisely because "nobody else can check out
   * what shipped".
   *
   * The ahead/behind counts below still report divergence from main, which is a
   * real and separate thing. They were never the problem; the label was.
   */
  let unpushed = null, unpushedReason = null;
  {
    const c = line(await git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes']));
    if (c != null) {
      unpushed = Number(c);
      unpushedReason = 'not-on-any-remote';
    } else if (upstream) {
      /* Fall back only when the real question could not be asked, and SAY which
       * question was answered instead -- a count whose meaning is unknown is
       * worse than no count. */
      const u = line(await git(cwd, ['rev-list', '--count', `${upstream}..HEAD`]));
      unpushed = u == null ? null : Number(u);
      unpushedReason = 'fallback:vs-upstream';
    } else if (baseSha) {
      const b = line(await git(cwd, ['rev-list', '--count', `${baseSha}..HEAD`]));
      unpushed = b == null ? null : Number(b);
      unpushedReason = 'fallback:no-upstream:vs-merge-base';
    }
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
    upstreamKind,
    unpushed,
    unpushedReason,
    aheadOfMain,
    behindMain,
    staged: entries.filter((e) => e.staged).map((e) => ({ path: e.path, code: e.x + e.y })),
    dirty: entries.filter((e) => e.dirty && !e.untracked).map((e) => ({ path: e.path, code: e.x + e.y })),
    untracked: entries.filter((e) => e.untracked).map((e) => ({ path: e.path, code: '??' })),
  };
}
