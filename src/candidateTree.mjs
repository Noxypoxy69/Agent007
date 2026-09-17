/**
 * CANDIDATE IDENTITY, BUILT FROM A GIT TREE THE VERIFIER OWNS.
 *
 * The prototype computed identity from `git diff baselineRef --binary .`. Three
 * measured consequences, all from the same root cause -- the identity described
 * a PATCH rather than a STATE:
 *
 *   1. Untracked files are invisible to `git diff`. Adding one after
 *      verification left the candidate id unchanged, and the file was then
 *      ABSENT from the promoted output. So the bytes that were tested, the
 *      bytes that were approved and the bytes that were promoted were three
 *      different things.
 *   2. `baselineRef` was a literal string. "HEAD" means a different tree on
 *      Monday than on Tuesday, so an approval bound to it binds to nothing.
 *   3. A failed diff substituted the string "__DIFF_FAILED__", which hashes
 *      perfectly well, so an unresolvable baseline produced a valid-looking
 *      identity and an approval.
 *
 * A tree SHA has none of those properties. It covers additions, deletions,
 * modes, symlinks and object types, it is immutable, and it cannot be computed
 * at all if the inputs do not resolve.
 *
 * NOTHING HERE TRUSTS THE CANDIDATE'S INDEX. The worker's index is mutable by
 * the worker, so reading it would be asking the candidate what it contains.
 * Every call runs with GIT_INDEX_FILE pointed at a temporary index this module
 * creates and deletes, and with the candidate's hooks and fsmonitor disabled --
 * `git add` does not run hooks, but a repository-supplied core.fsmonitor or
 * core.hooksPath is executable configuration living in the candidate's own
 * .git, and the verifier must not inherit it.
 */
import { execFileSync } from 'node:child_process';
import { runGit } from './safeGit.mjs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const NUL = String.fromCharCode(0);

/* The hardening is src/safeGit.mjs now. It lived here AND in verifier.mjs,
 * byte-identical, while seven other invocations had none. */

export class IdentityError extends Error {
  constructor(stage, detail) {
    super(`candidate identity could not be established at stage "${stage}": ${detail}`);
    this.name = 'IdentityError';
    this.stage = stage;
  }
}

function git(args, { cwd, env = {}, stage }) {
  try {
    return runGit(args, { cwd, env: { ...process.env, ...env } });
  } catch (e) {
    /*
     * THROWS. It does not return a sentinel. The prototype's "__DIFF_FAILED__"
     * is the reason this class exists: a failure that produces a hashable value
     * is a failure that produces an approval.
     */
    throw new IdentityError(stage, String(e?.stderr || e?.message || e).trim().slice(0, 300));
  }
}

/**
 * Resolve a ref to the immutable pair it names. An approval binds to these, not
 * to the word the caller used.
 */
export function resolveBaseline(repoRoot, ref) {
  if (!repoRoot || !existsSync(repoRoot)) throw new IdentityError('repo', `no such repository: ${repoRoot}`);
  if (typeof ref !== 'string' || ref.trim() === '') throw new IdentityError('baseline', 'no baseline ref supplied');
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoRoot, stage: 'baseline' }).trim();
  const tree = git(['rev-parse', '--verify', `${ref}^{tree}`], { cwd: repoRoot, stage: 'baseline' }).trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit) || !/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new IdentityError('baseline', `ref ${ref} did not resolve to object ids`);
  }
  return { ref, commitSha: commit, treeSha: tree };
}

/**
 * A stable identity for the repository itself, so an approval issued for one
 * repo cannot be replayed against another that happens to share a baseline.
 */
export function repoIdentity(repoRoot) {
  const root = git(['rev-parse', '--show-toplevel'], { cwd: repoRoot, stage: 'repo' }).trim();
  let firstCommit = '';
  try {
    firstCommit = git(['rev-list', '--max-parents=0', 'HEAD'], { cwd: repoRoot, stage: 'repo' }).trim().split('\n')[0] ?? '';
  } catch {
    firstCommit = '';           // a repo with no commits still gets an identity from its path
  }
  return sha256(`${path.resolve(root)}${NUL}${firstCommit}`);
}

/**
 * Build the candidate's tree with a verifier-owned index and return its SHA.
 *
 * `git add -A --force` deliberately ignores .gitignore. The candidate writes
 * .gitignore, so honouring it would let the candidate hide a file from the tree
 * while that file still sat on disk during validation -- P0-1 again in a new
 * spelling. Everything on disk under the workspace is either in the tree or is
 * not part of the candidate at all, and validation runs from a checkout OF THE
 * TREE so the two can never disagree.
 */
export function buildCandidateTree(candidateWorkspace, { excludeGitDir = true } = {}) {
  if (!candidateWorkspace || !existsSync(candidateWorkspace)) {
    throw new IdentityError('candidate', `no such workspace: ${candidateWorkspace}`);
  }
  const indexDir = mkdtempSync(path.join(tmpdir(), 'verifier-index-'));
  const indexFile = path.join(indexDir, 'index');
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    const args = ['add', '-A'];
    if (!excludeGitDir) args.push('--force');
    else args.push('--force');
    args.push('--', '.');
    git(args, { cwd: candidateWorkspace, env, stage: 'candidate' });
    const tree = git(['write-tree'], { cwd: candidateWorkspace, env, stage: 'candidate' }).trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new IdentityError('candidate', 'write-tree did not return an object id');
    return tree;
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

/**
 * The identity an approval binds to. Every component is immutable and none of
 * them is a string the caller chose.
 */
export function candidateIdentity({ repoRoot, baselineRef, candidateWorkspace, policyVersion }) {
  if (typeof policyVersion !== 'string' || policyVersion === '') {
    throw new IdentityError('policy', 'no policy version supplied');
  }
  const repo = repoIdentity(repoRoot);
  const baseline = resolveBaseline(repoRoot, baselineRef);
  const candidateTreeSha = buildCandidateTree(candidateWorkspace);
  const candidateId = sha256(
    [repo, baseline.commitSha, candidateTreeSha, policyVersion].join(NUL),
  );
  return {
    candidateId,
    repoIdentity: repo,
    baselineCommitSha: baseline.commitSha,
    baselineTreeSha: baseline.treeSha,
    candidateTreeSha,
    policyVersion,
  };
}

/**
 * List a tree's entries as { path, mode, type, oid }. Compares TREES, so mode,
 * object type and deletion are all visible -- a byte hash of two working
 * directories sees none of those.
 */
export function listTree(repoForObjects, treeSha) {
  const raw = git(['ls-tree', '-r', '-z', treeSha], { cwd: repoForObjects, stage: 'listTree' });
  const out = new Map();
  for (const rec of raw.split(String.fromCharCode(0))) {
    if (rec.trim() === '') continue;
    const m = rec.match(/^(\d{6}) (\w+) ([0-9a-f]+)\t(.*)$/s);
    if (!m) continue;
    out.set(m[4], { mode: m[1], type: m[2], oid: m[3] });
  }
  return out;
}

/** Entries that differ between two trees, by oid OR by mode. */
export function treeDrift(repoForObjects, baselineTreeSha, candidateTreeSha, predicate) {
  const base = listTree(repoForObjects, baselineTreeSha);
  const cand = listTree(repoForObjects, candidateTreeSha);
  const drift = [];
  for (const p of new Set([...base.keys(), ...cand.keys()])) {
    if (predicate && !predicate(p)) continue;
    const b = base.get(p);
    const c = cand.get(p);
    if (!b && c) drift.push({ file: p, status: 'added' });
    else if (b && !c) drift.push({ file: p, status: 'deleted' });
    else if (b.oid !== c.oid) drift.push({ file: p, status: 'modified' });
    else if (b.mode !== c.mode) drift.push({ file: p, status: 'mode-changed', from: b.mode, to: c.mode });
  }
  return drift.sort((x, y) => x.file.localeCompare(y.file));
}

/**
 * Materialise a tree into a fresh directory the verifier controls.
 *
 * Validation must run against THIS, never against the candidate's working
 * directory. Otherwise a file that is on disk but not in the tree -- gitignored,
 * or written between the tree build and the test run -- participates in the test
 * without being part of what was approved.
 */
export function materializeTree(sourceRepoForObjects, treeSha) {
  const dest = mkdtempSync(path.join(tmpdir(), 'verifier-checkout-'));
  const indexDir = mkdtempSync(path.join(tmpdir(), 'verifier-coindex-'));
  const indexFile = path.join(indexDir, 'index');
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    git(['read-tree', treeSha], { cwd: sourceRepoForObjects, env, stage: 'materialize' });
    git(['checkout-index', '-a', '-f', `--prefix=${dest}${path.sep}`], { cwd: sourceRepoForObjects, env, stage: 'materialize' });
    return dest;
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}
