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
    const out = execFileSync(
      'git',
      ['branch', '-r', '--contains', sha, '--format=%(refname:short)'],
      { cwd, encoding: 'utf8', stdio: 'pipe' },
    );
    const remoteRefs = out.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !l.includes('HEAD'));
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
