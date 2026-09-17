/**
 * HAS SOMEBODY ALREADY DONE THIS? ASKED BEFORE STARTING, NOT AFTER.
 *
 * 2026-09-16, one session, twice:
 *
 *   code-a fixed the CI failure and pushed it to master at 19:59Z.
 *   I diagnosed the same failure and pushed a second fix at 21:04Z.
 *   Sixty-five minutes. It was on master the whole time.
 *
 *   code-b committed the roster liveness fix at 00:15Z.
 *   I committed a different answer to the same question at 00:24Z.
 *   Nine minutes.
 *
 * NEITHER WAS CAUGHT BY ANYTHING, AND THE MACHINERY TO CATCH THEM IS ALL
 * PRESENT. collisionGuard compares PATHS, and b touched index.ts while I
 * touched bin/ and src/ -- zero overlap, two answers to one question. The
 * delegation ledger records work that was HANDED OVER, and neither of us was
 * handed anything. The tasks table is the ledger of what is being worked on and
 * it holds four rows, two of them demo fixtures and one labelled PROOF ONLY.
 * Nothing records work an agent starts on its own initiative, which is nearly
 * all of it.
 *
 * SO THIS DOES NOT ADD A FIFTH PLACE TO FORGET. It declares nothing and stores
 * nothing. It reads what is already unforgettable -- branches that exist on the
 * server, and commits that are already written -- and answers one question
 * against them.
 *
 * ASK THE SERVER, NEVER THE REMOTE-TRACKING REFS. This clone's fetch refspec is
 * `+refs/heads/main:refs/remotes/origin/main`, so `origin/master` is frozen at
 * whatever it was when someone last pushed through it, and `git log --all`
 * inherits the lie. That is not a footnote: it is WHY the 65-minute duplication
 * happened. `git ls-remote` asks the server and cannot be stale.
 *
 * A FAILED LOOKUP IS NOT AN ABSENCE OF PRIOR WORK. For this tool specifically
 * that inversion is the worst possible outcome -- "nothing found" is exactly
 * what somebody wants to hear before starting, so an error that renders as an
 * empty result gets believed and acted on. `ok` is separate from `matches`, and
 * a caller that ignores it is making a claim the data does not support.
 */

/** A topic matches loosely: agents name the same thing differently. */
function tokens(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function scoreOne(text, toks) {
  const low = String(text ?? '').toLowerCase();
  let hits = 0;
  for (const t of toks) if (low.includes(t)) hits += 1;
  return hits;
}

/**
 * Rank candidates against a topic.
 *
 * @param {{kind:string,name:string,subject:string,at:string,session:string|null}[]} candidates
 * @param {string} query
 */
export function rank(candidates, query) {
  const toks = tokens(query);
  if (!toks.length) return [];
  return (candidates ?? [])
    .map((c) => ({ ...c, score: scoreOne(`${c.name} ${c.subject}`, toks) }))
    .filter((c) => c.score > 0)
    // PRECEDENCE, and the first draft got it wrong: `x || y ? 1 : -1` parses as
    // `(x || y) ? 1 : -1`, so the score difference was swallowed by the ternary
    // and ordering was effectively arbitrary. Parenthesised, and asserted below.
    .sort((a, b) => (b.score - a.score) || (String(b.at).localeCompare(String(a.at))));
}

/**
 * The whole answer, with the honesty bit kept separate from the finding.
 *
 * `ok:false` means the lookup did not complete. `matches:[]` alongside it means
 * NOTHING WAS LEARNED, not that the ground is clear.
 */
export function priorWork({ branches, commits, query, ok = true, errors = [] } = {}) {
  const candidates = [
    ...(branches ?? []).map((b) => ({ kind: 'branch', name: b.name, subject: b.subject ?? '', at: b.at ?? '', session: b.session ?? null, merged: b.merged === true })),
    ...(commits ?? []).map((c) => ({ kind: 'commit', name: c.sha ?? '', subject: c.subject ?? '', at: c.at ?? '', session: c.session ?? null, merged: true })),
  ];
  const matches = query ? rank(candidates, query) : [];
  return {
    ok: ok === true,
    errors: [...errors],
    openFronts: candidates.filter((c) => c.kind === 'branch' && !c.merged),
    matches,
    verdict: ok !== true ? 'unknown' : matches.length ? 'prior-work-found' : 'nothing-found',
  };
}
