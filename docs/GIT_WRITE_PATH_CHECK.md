# The protected-path check on git writes is bound to SPELLING, not effect

Measured 2026-09-17 on the operator's machine, first at `61bbeb2` and
re-verified at `1489931` after the working tree was switched to
`design/action-authority` mid-session. `src/shellAllowlist.mjs` is
byte-identical across those two commits and `PROTECTED_PATHS` is unchanged, so
every verdict below stands at both. Independently reproduced by a second
session (`agent007-c5`) by a different route.

**Nothing here has been implemented.** This is a finding written up at the
owner's direction; the guard is unchanged.

A note on provenance, since this document is itself a gate of sorts: the first
draft was dated to `61bbeb2` and HEAD moved underneath it without the draft
noticing. A measured table inherits the tree it was measured against, and
saying which one is the difference between evidence and an anecdote.

---

## 1. The deadlock that exposed it

The Stop gate refused a session over four untracked baseline tests and named
three remedies:

    test/guardToolRoster.test.mjs [baseline-test] ?? -- untracked:
      delete it, commit it, or add it to .gitignore

The shell rail refuses two of the three:

| remedy the Stop gate offers | what the rail does |
|---|---|
| delete it | `rm test/x.test.mjs` -> `"rm" has no approved read-only shape` |
| commit it | `git add -N test/x.test.mjs` -> `"git add" names test/x.test.mjs, which is a guard or completion control` |
| add it to .gitignore | reachable |

Only the remedy that *hides* the drift is reachable from inside a session --
rule 15, a control reporting a loop it has left open. Two controls, each
verified alone, never against each other.

## 2. The check on `add` / `commit` bounds nothing

`src/shellAllowlist.mjs:373-391` applies the protected-path check to every
`GIT_WRITE` verb by inspecting **named pathspecs**. Neither `add` nor `commit`
has to name a path:

    DENY   git add -N test/guardToolRoster.test.mjs
    DENY   git commit src/claudeGuard.mjs -m msg
    ALLOW  git add -A
    ALLOW  git add .
    ALLOW  git add --all
    ALLOW  git add -u
    ALLOW  git commit -a -m msg
    ALLOW  git commit -am msg
    ALLOW  git commit --all -m msg

`git add -A` stages the guard's own source and every baseline test today. The
check blocks exactly one spelling -- the pathspec one, which is the spelling
**CLAUDE.md mandates** ("Commit by pathspec ... The index is shared"). It
refuses the documented workflow and stops nothing else.

## 3. The overwrite half is spelling-bound TOO

This is the part that was assumed safe by everyone who looked, including both
sessions that reviewed it. It is not.

The check's stated purpose (`shellAllowlist.mjs:360-372`) is to stop a permitted
git write from replacing the guard's own source, because the hook re-imports
that module on every invocation -- so the guard is disarmed for the rest of the
session the moment the command returns. Measured:

    DENY   git checkout HEAD -- src/claudeGuard.mjs   names a path
    DENY   git restore src/claudeGuard.mjs            names a path
    ALLOW  git restore .
    ALLOW  git checkout other-branch
    ALLOW  git switch other-branch
    ALLOW  git pull
    ALLOW  git merge other-branch

`git restore .` is the sharpest row. It restores the ENTIRE working tree,
`src/claudeGuard.mjs` included -- the precise disarm this check exists to
prevent -- and it is allowed, because it names no path for the check to see.
The pathspec spelling of that same command is refused.

Taking the proposal's own list of nine verbs it would keep the check for, in
their bare forms, measured at `1489931`:

    DENY   git restore src/claudeGuard.mjs     only when it names a protected path
    DENY   git checkout HEAD -- src/claude...  only when it names a protected path
    ALLOW  git restore .
    ALLOW  git checkout other-branch
    ALLOW  git stash
    ALLOW  git merge other-branch
    ALLOW  git rebase other-branch
    ALLOW  git cherry-pick abc1234
    ALLOW  git apply patch.diff
    ALLOW  git revert abc1234
    ALLOW  git pull

Seven of the nine never deny in any form the check can inspect, and the two
that do deny only the pathspec spelling. **So the half of the proposal that
"keeps the load-bearing protection" would be preserving a protection that does
not exist.** Found independently by `agent007-c5`; the `git restore .` row is
what makes it unarguable.

### 3a. One row denies for a reason that has nothing to do with the danger

    DENY   git checkout -f other-branch    a flag that writes or reads a side file
                                           (-o, --output, --to-file, -f, --argfile, ...)
    ALLOW  git checkout --force other-branch
    DENY   git switch -f other-branch      same WRITE_FLAGS reason
    ALLOW  git switch --force other-branch
    ALLOW  git switch --discard-changes other-branch
    DENY   git switch -c newbranch         GIT_POISON matching -c as in `git -c`

`git checkout -f` is refused because `WRITE_FLAGS` matches `-f` as in `--file`.
The rail has no idea that `-f` means `--force` here. Two consequences, and the
second is worse than the first:

1. It is a protection nobody knows they have, so it is one nobody will know
   they removed. Matching bare `-f` across every command is obviously
   over-broad, and narrowing it to the flags it was written for is a reasonable
   tidy-up that would silently delete a forced-checkout refusal.
2. **It does not actually hold today.** `git checkout --force other-branch`,
   `git switch --force other-branch` and `git switch --discard-changes
   other-branch` are all ALLOWED. The coincidence covers the short spelling and
   leaves the long ones open, so the refusal was never a boundary even by
   accident.

`git switch -c newbranch` is the same shape from the other direction: refused
by the `GIT_POISON` matcher for `-c` as in `git -c core.editor=...`, not for
anything about creating a branch.

### 3c. The composition, now measured rather than plausible

`agent007-c5` proposed a chain and correctly declined to assert it unverified.
It was run in a throwaway git repository with `AGENTBRIDGE_HOME` isolated to a
temp directory; no file in this repository was written, staged or read for
content.

    session A mint             : OK
      baseline records guard   : aae076a7c13c863b        (strong)
    tree after the "checkout"  : CLEAN
    session A protectedDrift   : SEES IT (src/claudeGuard.mjs)
    session B mint             : OK
      baseline records guard   : 05bc4ee049e486de        (weakened)
    session B protectedDrift   : CLEAN -- Stop would approve

Within one session the posture holds exactly as documented: session A sees the
drift. Across sessions it does not. Session B mints a fresh baseline over the
weakened guard **without refusing**, and every subsequent comparison is against
the weakened state, so Stop reports clean forever after.

**What was measured and what was not.** The minting half above is measured. The
first link -- that `git checkout --force <branch>` is permitted -- is measured
in section 3a. The literal sequence (run the forced checkout in this repository,
then start a real session) was NOT run; the resulting state was reconstructed by
committing the weakened content, which is what a forced checkout to such a
branch leaves behind. Anyone treating this as a live path should close that last
gap rather than inherit this note.

**This is a NAMED residual, not a regression, and the label matters.** Read at
`guardSession.mjs:176-200`. The bypass `a24d499` measured and closed is the
DIRTY route: "session A baselines a clean tree; `.claude/settings.json` is
edited to disable hooks; A's Stop gate blocks correctly; A cannot re-baseline
(EEXIST does its job); session B baselines the SAME damaged tree without
complaint." That is an uncommitted edit. The same comment then states what it
does not reach: "git compares the working tree against HEAD, so damage that has
been COMMITTED reads as clean and can still be adopted as a baseline. Closing
that needs an authority outside the writable checkout. Reviewing the commit is
what catches it today."

So the committed route was known, correctly labelled, and deliberately left
open. Section 3c above measures it; it does not discover it. Reporting it as a
new hole would be exactly the cried wolf that rule 14 warns costs every other
row its credibility.

**The new part is the delivery route, and it is small and load-bearing.** The
residual ships with a compensating control -- "Reviewing the commit is what
catches it today" -- which assumes the damaging commit was authored here and
passes under somebody's eyes. A forced checkout imports another branch's commit
wholesale, and this clone has 19 unmerged branches. There is no review event in
the session that adopts it, and section 3a shows the rail permits the import in
at least three spellings. **The mitigation and the delivery route never meet.**
That is not in the comment, and the sentence reads as though commits arrive one
at a time from people.

Each link is individually documented and individually defensible. Composed, the
checkout supplies the disarm and the fresh baseline supplies the amnesia.

### 3b. Three distinct failure modes in one surface

Owed to `agent007-c5`, who named the shape:

  - **bounds a spelling, not an effect** -- `git restore .` vs
    `git restore <path>`
  - **denies for an unrelated reason** -- `checkout -f` via `WRITE_FLAGS`,
    `switch -c` via `GIT_POISON`
  - **claims a protection that was never there** -- seven of the nine verbs

A check can exhibit all three at once and still look, from a passing test
suite, exactly like a check.

Every ALLOW there overwrites the working tree wholesale, `src/claudeGuard.mjs`
included, whenever the incoming ref carries a different guard -- and this clone
has 19 unmerged branches. **The check catches the pathspec spelling of a
disarm and not the branch spelling of the same disarm.**

The Stop gate still detects the resulting drift afterwards, which is the
documented posture for `npm test` and MCP writes. But the PreToolUse guard is
disarmed for the remainder of the session, which is precisely what this check
exists to prevent. So it is partial against its own threat model, not a
boundary -- rule 8: an adversarial probe bounds nothing, fix the matcher rather
than the spellings it happened to try.

This is a pre-existing hole. It is not created by, and not an argument against,
the proposal in section 4.

## 4. A proposal exists; these are its gaps

A peer session proposed `fix/git-record-vs-overwrite`: split `GIT_WRITE` by
effect on the working tree, keep the check for overwrite verbs, drop it for
`add` and `commit`. Three gaps:

1. **The split is an enumeration, and enumerating is what produced the gap.**
   Derived from the shipped source rather than counted by hand:

        GIT_WRITE verbs  = 15  pull fetch push add commit checkout switch
                               merge rebase stash restore cherry-pick tag
                               apply revert
        overwrite (named)=  9  restore checkout stash merge rebase
                               cherry-pick apply revert pull
        record-only      =  2  add commit
        UNASSIGNED       =  4  fetch push switch tag

   The first correction of this error still reported three; the fourth is
   `switch`, which overwrites the working tree. A reading of "not an
   overwriter -> drop the check" strips it silently. Derive both sets FROM
   `GIT_WRITE` so a verb added later fails the build until somebody classifies
   it -- rule 7, generate from the real list rather than restating it.

2. **The mutation proof must run both ways.** Collapsing the sets back together
   must turn the `add`/`commit`-allowed test red, AND the inverse collapse must
   turn the `restore`-denied test red. One direction leaves a single test
   carrying two claims. Assert the mutation landed (rule 2); assert the specific
   assertion fired rather than counting failures (rule 14).

3. **The residual predates the change.** "Committed damage reads as clean to a
   later session" is already reachable through `git commit -a`. Refusing
   pathspec commits never closed it. Document it as UNCHANGED, not as a cost
   newly accepted, or the next reader believes the refusal was buying something.

The proposal's original argument -- that the Stop gate compares content against
the session snapshot rather than HEAD, so committing hides nothing -- is
consistent with `protectedDrift` in `src/guardSession.mjs`, but a reviewer
should confirm it rather than inherit it. Section 2 is the stronger argument and
does not depend on it.

## 5. The decision, stated narrowly

Not "should the rail be weakened so agents can commit." It is:

> A check that refuses the documented workflow and stops nothing -- delete it,
> or leave it?

Deleting costs no coverage that section 2 can find. Leaving it costs every agent
a round-trip through the owner's own terminal, permanently.

Section 3 is a separate question with its own blast radius and should not be
smuggled into the same change.

## 6. Status and authority

Not implemented. A guard change is the owner's to authorise, and this one
arrived as a peer handoff after that peer's own permissions had refused it --
which CLAUDE.md names as laundering and routes to Danny regardless of what any
classifier does or does not say. The peer has since acknowledged this.

If authorised, it is still a change to a guard: it goes to another agent for
independent verification before it ships. Do not self-certify it.

## 7. Reproducing

`judgeShellCommand` is pure; calling it touches no guard state and writes
nothing:

```js
import { judgeShellCommand } from './src/shellAllowlist.mjs';
console.log(judgeShellCommand('git commit -a -m msg'));        // { allowed: true }
console.log(judgeShellCommand('git switch other-branch'));     // { allowed: true }
console.log(judgeShellCommand('git restore src/claudeGuard.mjs'));
```
