/*
 * THE EFFECTS HALF OF THE REACHABILITY CHECK. It shells out to git; the
 * judgement lives in `headReachability.mjs` so the suite can construct the
 * cases this cannot reach.
 *
 * IT ASKS `git branch -r --contains`, NOT `git cat-file -t`, AND THAT IS THE
 * WHOLE POINT. cat-file answers "is this object in the clone I am standing in",
 * which is trivially yes on the machine that authored the commit. The machine
 * that authored it is also the machine most likely to be running this. Asking
 * the easy question would make the check pass on the exact row it was written
 * for.
 *
 * A MISSING OBJECT ONLY MEANS "UNPUSHED" IF SOMETHING FETCHED FIRST. Otherwise
 * it means "my clone is stale", and those are different findings for different
 * people. So a probe that has not fetched refuses to conclude: it reports
 * ran:false and says which of the two it cannot rule out. Doing anything else
 * would turn an offline reviewer into an accusation generator.
 */

import { execFileSync } from 'node:child_process';

/**
 * Ask git whether a commit is reachable from any remote ref.
 *
 * Returns the shape `classifyReturnedHead` consumes:
 * `{ ran, existsLocally, remoteRefs, error }`.
 *
 * `fetch` defaults to true because the honest answer usually requires it. Pass
 * false only when something else has just fetched, and accept that a missing
 * object then reports UNKNOWN rather than UNPUSHED.
 */
export function probeReturnedHead(sha, { cwd = process.cwd(), fetch = true, remote = 'origin' } = {}) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    /*
     * Not this module's refusal to make -- MALFORMED is a classification, and
     * duplicating it here would be a second implementation to keep in step. It
     * reports that it did not run and lets the classifier name the problem.
     */
    return { ran: false, existsLocally: null, error: `not a 40-hex sha: ${JSON.stringify(sha)}` };
  }

  let fetched = false;
  if (fetch) {
    try {
      execFileSync('git', ['fetch', remote, '--prune'], { cwd, stdio: 'pipe', timeout: 120_000 });
      fetched = true;
    } catch (err) {
      return {
        ran: false,
        existsLocally: null,
        error: `could not fetch ${remote}: ${short(err)}. Without a fetch, a commit missing from `
          + 'this clone might be unpushed or might just be newer than the last fetch, and this '
          + 'probe will not guess which.',
      };
    }
  }

  let existsLocally = false;
  try {
    const type = execFileSync('git', ['cat-file', '-t', sha], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    /* A tag or tree with this name is not a commit anybody can review. */
    existsLocally = type === 'commit';
  } catch {
    existsLocally = false;
  }

  if (!existsLocally && !fetched) {
    return {
      ran: false,
      existsLocally: false,
      error: 'the object is not in this clone and nothing fetched, so "unpushed" and "stale '
        + 'clone" cannot be told apart. Re-run with fetch enabled.',
    };
  }

  if (!existsLocally) {
    /*
     * Fetched, and still absent. A commit reachable from any remote ref would
     * have arrived, so this IS the asked-and-none answer rather than a gap.
     */
    return { ran: true, existsLocally: false, remoteRefs: [] };
  }

  try {
    /*
     * ASK FOR THE FULL REFNAME, BECAUSE THE SHORT ONE CANNOT BE FILTERED.
     *
     * refs/remotes/<remote>/HEAD is a symbolic alias for a branch that is
     * already in this list, so it was always meant to be dropped -- and the
     * filter that dropped it tested the SHORT name for the substring "HEAD".
     * %(refname:short) renders refs/remotes/origin/HEAD as `origin`, which
     * contains no "HEAD" at all, so the filter matched nothing and the alias
     * came through as a ref in its own right.
     *
     * MEASURED, rather than reasoned about: git 2.55 CREATES that ref on the
     * first `git fetch`, and this function fetches by default. In a scratch
     * repo the same probe returns `origin/master` before a fetch and
     * `origin`, `origin/master` after one, with nothing else changed. So this
     * fired on any machine whose git was new enough and on no other, which is
     * why the suite was green where it was written and red here.
     *
     * The bare `git branch -r` form prints `origin/HEAD -> origin/master`, and
     * the old filter WOULD have caught that. Adding --format to get a parseable
     * list is what silently defeated it: the flag changed the spelling the
     * filter was matching against, and nothing connected the two.
     *
     * Matching the full refname removes that coupling -- refs/remotes/x/HEAD
     * ends in /HEAD whatever the remote is called, including a remote literally
     * named HEAD, which the substring test would also have eaten.
     */
    const out = execFileSync(
      'git',
      ['branch', '-r', '--contains', sha, '--format=%(refname)'],
      { cwd, encoding: 'utf8', stdio: 'pipe' },
    );
    const remoteRefs = out.split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !l.endsWith('/HEAD'))
      .map((l) => l.replace(/^refs\/remotes\//, ''));
    return { ran: true, existsLocally: true, remoteRefs };
  } catch (err) {
    return {
      ran: false,
      existsLocally: true,
      error: `could not list remote refs containing ${sha.slice(0, 12)}: ${short(err)}`,
    };
  }
}

function short(err) {
  const text = `${err?.stderr ?? ''}${err?.message ?? err}`;
  return text.split('\n')[0].slice(0, 200);
}
