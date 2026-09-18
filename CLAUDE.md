# CLAUDE.md — Agent Bridge

Guidance for Claude Code and any other agent working in this repository.

This file exists because on 2026-09-15 **thirteen hollow gates were found in a
single day** and every lesson was written into a commit message. 84 commits in,
nobody reads commit messages. Where a lesson goes, most durable first: **a check
script beats this file, which beats a code comment, which beats a commit
message.**

## What this is

The Agent Bridge: coordination state for several AI agents working the same
machine and the same repositories. A Supabase Postgres schema, a Deno edge
function exposing MCP, a CLI, and pure modules under `src/` and `bridge/`.

```bash
npm test          # node --test "test/**/*.test.mjs"
npm run bridge    # local bridge server
npm run mcp:stdio # stdio MCP shim
```

There is no build step and no lint gate yet.

---

# THE HOLLOW GATE

**A hollow gate is a check that passes while proving nothing.** It is the only
bug class this project has produced in volume, it has appeared in thirteen
distinct forms in one day, and every single one looked identical from the
outside: a green test.

Read the thirteen before writing a test. They are not variations on one mistake —
they are thirteen *different* mistakes that share one signature.

| # | What passed | What was actually true |
|---|---|---|
| 1 | A mutation test went green | The mutation never applied — duplicate key, or `sed` against text split across a `+` |
| 2 | A regression gate agreed with the code | It **reconstructed the rule** instead of reading the shipped one, so it agreed with itself through the regression |
| 3 | A reviewer-lease guard refused correctly | It read a column **nothing ever wrote** |
| 4 | Three CLI deregistration tests passed | `runCli` minted a fresh home per call, so the branch never ran, and the assertions sat behind `if (…)` |
| 5 | A reaper function was written, tested and applied | **It was never scheduled.** `cron.job` had one row. Expired work was stranded permanently |
| 6 | `confirm_proposal` was listed, documented and scope-gated | It threw `Cannot read properties of undefined` on **every call it ever received** — `toolDefs` destructures the store and it used `this` |
| 7 | "An expired lease does not block" / "the same session may re-claim" | Both fixtures built `state: 'runnable'`, a shape **a real claim never produces** |
| 8 | "reversible:true CANNOT downgrade an owner-only action" | It tried three lower-case strings. `Deploy.Production` routed to the coordinator |
| 9 | A verification harness reported RED | **No assertion had executed** — a module failed to resolve and the process exited non-zero |
| 10 | A splice-agreement test compared src against the deployed copy | Its fixture was too narrow to reach the branch that diverged — **three times, after every round** |
| 11 | A `grep` said production matched the repo | `INSTRUCTIONS` is a concatenation; the grep compared **wrapping, not content** |
| 12 | A mutation harness reported a mutation **missed** | It **counted failures**. The mutation turned one test red and another green; the total never moved, so a *caught* mutation read as uncaught |
| 13 | A coupling gate asserted the client sends `lease_token` | It matched `lease_token` inside the CLI's own **error message**, so deleting the payload field passed |

## The rules that fall out of them

**1. WATCH IT FAIL.** Point the check at the broken state and see it go red
before believing it green. Not once, per check.

**2. ASSERT THE MUTATION LANDED BEFORE TRUSTING THE RESULT.** `cmp` the file.
A green mutation is not a weak signal, it is a *wrong* one — and a mutation that
never applied is the most common way to get one. This bit twice in one day,
ten minutes apart, including immediately after being written up.

**3. A NON-ZERO EXIT IS NOT EVIDENCE THAT A TEST RAN.** It is evidence a process
was unhappy. Assert the reported test **count**. Likewise `assert.notEqual(0)`
on an exit code passes on a crash — assert the exact code.

**4. NEVER ASSERT ON A PROXY.** Exit codes proxy for refusals, presence in
`tools/list` proxies for a tool working, a 204 proxies for a row landing. A
proxy agrees with the truth until something unusual happens, which is exactly
when a guard is supposed to speak. Verify the far end: the row in the table, the
invocation, the byte that is no longer there.

**5. A NEGATIVE NEEDS THE POSITIVE FIRST.** "The tool is absent for a reader"
passes against a fixture that stopped being a reader. Assert the thing loaded,
then assert what it does not contain.

**6. ASSERT PRECONDITIONS, DO NOT GUARD ON THEM.** `if (/hosted/.test(out))
{ assert(…) }` is a test that passes by not running. Make the precondition an
assertion.

**7. TEST A HOSTILE PROPERTY WITH HOSTILE INPUTS.** A claim about what an
attacker *cannot* do, checked with inputs that already worked, proves nothing.
Where possible **generate** the adversarial fixtures from the real list, so
adding an entry extends the coverage without anybody remembering to.

**8. AN ADVERSARIAL PROBE BOUNDS NOTHING.** It is evidence that a specific
attack works, never evidence that the remaining ones do not. When a probe finds
a bug, fix the **matcher**, not the five strings the prober happened to try.

**9. IF A FIXTURE CANNOT CONSTRUCT THE REAL CASE, IT CANNOT FAIL FOR IT.** Check
that your fixture is a shape the system actually produces. A claim writes
`assigned`, so a post-claim fixture that says `runnable` is testing a state that
never exists.

**10. A GUARD THAT CANNOT BE IMPORTED IS A GUARD NOBODY HAS WATCHED FAIL.**
`supabase/functions/mcp/index.ts` is Deno-only and **cannot be imported by the
suite** — anything left in it is untested by construction. Put decision logic in
`src/` as a pure function, the way `canAssign`, `canAccept` and
`canDecidePermission` already are, and let the edge function call it.

**11. A NO-OP MUTATION IS NOT A MISSED CATCH — BUT FIX IT ANYWAY.** If a
protection is redundant today, its mutation legitimately goes green. That
redundancy holds only until the conditions change. Test the mechanism directly
where the mutation stops being a no-op, because *untested because currently
redundant* is how a protection quietly stops being one.

**12. GREP COMPARES WRAPPING, NOT CONTENT.** Source strings are concatenations.
Reconstruct and normalise before comparing, or you will get both false positives
and false negatives. See `scripts/check-deployed-instructions.mjs`.

**13. COMMENT-BLANK BEFORE MATCHING ANYTHING.** A check that greps for
`claim_task` matches its own explanatory comment, so renaming the call passes.
Three independent rediscoveries in one day. The same trap catches payload
assertions: a gate matching `lease_token` also matches the CLI's own *error
message* about a missing `lease_token`, so deleting the field passes.

**14. A HARNESS MUST MEASURE THE SPECIFIC ASSERTION, NOT A TOTAL.** A mutation
verdict that counts failures is wrong the moment a mutation falsifies a gate's
premise: one test goes red, another goes green, the total does not move, and a
*caught* mutation is reported as missed. Ask whether the assertion you care
about fired. This one is corrosive out of proportion to its size — a harness
that cries wolf about a working gate burns the credibility of every other row
in the table above.

**15. LET A GATE MOVE RATHER THAN CLOSE.** When half a contract lands, the gate
should go red on the *remaining* half with a message naming it, not go green.
A control that reports a closed loop while the loop is open is the failure this
whole file describes — and "the client now sends a credential it cannot
acquire" is exactly that shape.

**16. A RED TEST NOBODY HAS SHOWN CAN GO GREEN IS A COUNTDOWN, NOT A RATCHET.**
Before handing anyone a deliberately-failing gate, prove the demand is
reachable (make it pass, then restore) and prove it stands down if its premise
is removed. Otherwise it is an IOU that outlives its reason and teaches people
to ignore red.

**17. A CONTROL THAT IS NEVER CONSULTED IS NOT A CONTROL.** Every rule above is
about a check that RAN and concluded wrongly. On 2026-09-17 the guard concluded
nothing, because nothing asked it: `.claude/settings.json` submitted
"Bash|Edit|MultiEdit|Write|NotebookEdit" and Windows sessions run shell through a
PowerShell tool. A real session deleted `src/claudeGuard.mjs` and git reported
`D src/claudeGuard.mjs` with no refusal from anywhere. The guard's own unit tests
were green throughout, because they call the module directly and the module was
never the broken part. **Before trusting any guard, establish that the path
reaches it at all** — the wiring is a separate claim from the logic, and only the
logic has tests.

**18. WHEN SOMETHING REFUSES YOU, ESTABLISH *WHICH* THING REFUSED.** Three
successive runs scored that same guard as working because probes came back
BLOCKED. The refusals were from the Claude Code auto-mode classifier — a
different mechanism in a different layer — and are indistinguishable from a hook
refusal unless you read the text. A fourth run where the classifier happened to
stay silent is the only reason the deletion was ever observed. **A refusal from
the wrong layer is a hollow gate wearing a pass**, and it is worse than a green
test because it feels like evidence. Name the mechanism: ours prefix their
refusals with `[agentbridge:`.

**19. A LIST OF NAMES FAILS IN BOTH DIRECTIONS.** The fix for 17 was to stop
dispatching on tool names. The first attempt default-DENIED every name it did not
recognise, which refused 25 of a real 54-tool roster — `Artifact`, `CronList`,
`ListSkills` and twenty-two others that cannot touch a file. Allowing by known
name leaks; denying by unknown name is an outage; and an outage gets the hook
switched off, which loses every layer at once. **Route on the SHAPE of the input**
— does it carry a command, does it carry a path — because that is a property of
the operation rather than of the vocabulary. And measure against the REAL roster:
both failures came from guessing which tool names exist on a machine that was not
the one under test.

**20. NOBODY CERTIFIES THEIR OWN WORK. FINISHING MEANS HANDING IT TO AN AUDITOR
THAT DID NOT WRITE IT.** This is a STEP, not a courtesy, and work is not done
until it has run. The party that derived a finding cannot be the party that
confirms it, and the party that wrote a fix cannot be the party that clears it —
not because anyone is dishonest, but because the confident commit message and the
green run are produced by the same reasoning that produced the bug.

Measured 2026-09-18, on this repository, by an audit the author did not perform:
a rail change whose message said it "closes the sweep class" had closed four
enumerated spellings, and eight more members of that same class were still
allowed — including `git add ./`, one character from the spelling it denied, and
`git restore src`, one token from the spelling its own message called "the
sharpest of them". The author had checked for over-blocks and generalised from a
single benign case, so `git commit -m "handle --force flag"` was refused. The
author's suite counts did not reproduce at all. Every one of those was found in
one pass by a reader with no stake in the answer.

WHAT THE STEP IS, CONCRETELY:

- The auditor is a SEPARATE agent. Not a second pass by the author, not the agent
  that reported the finding, not a peer that already holds a position on it.
- It works in ITS OWN CLONE, and the shared worktree is READ-ONLY to it. This is
  not politeness: suite counts measured in a worktree carrying other sessions'
  untracked files are contaminated, and that is exactly how a wrong baseline got
  reported three times in one session. `AGENTBRIDGE_HOME` goes to a temp dir, or
  the audit writes fixtures into the operator's live store.
- It may not push, merge, deploy, or apply a migration. Read-only outward.
- It is told to BREAK the work, not to check it. A confident commit message is
  grounds for suspicion, not comfort. It re-measures every claim, and it
  establishes the pre-existing baseline ITSELF before attributing any failure.
- It reports defects ranked by severity WITH the command that demonstrates each,
  and separately lists the claims it checked and found TRUE — otherwise the
  reader cannot tell what was covered from what was skipped.

WHEN IT RUNS: before a migration, a deploy, or a merge to a shared branch, and
whenever work is handed back as complete. An audit that runs on half-finished
work is spent, so finish the class first — see 19 — and audit once.

THE SECOND LAP IS A NEW AUDIT, NOT A CHECKLIST WALK, AND IT NEEDS A NEW
AUDITOR. When an audit finds defects and the author fixes them, do not send the
fixes back to the auditor that found them. Two reasons, and the first is the one
that actually bites:

An auditor that has published findings verified a list of claims TRUE, and on a
second pass it walks its own defect list and does not re-check what it already
blessed. But a FIX IS NEW CODE, and new code breaks what was previously fine.
Measured here: `a0bdbf9` correctly closed the sweep spellings AND refused
`git commit -m "handle --force flag"`, which worked at its parent. An auditor
asking "are my defects closed?" gets a yes for each one and never sees the one
the fix created. Second: an agent that has stated a position defends it, so the
re-audit becomes an argument about the old findings instead of a measurement of
the new code.

SO THE ORDER IS FIXED. A fresh auditor audits the new commits FROM SCRATCH,
told nothing about the previous findings — that pass is what catches the
regression the fix introduced. Only AFTERWARDS is it handed the old defect list
to confirm closure. Give it the list first and you have bought a checklist walk,
which is the thing the whole rule exists to avoid.

AND AUDITS COST. The first one here ran 158k tokens and twenty-three minutes.
Batch the fixes and audit once; one audit per patch spends the budget that the
next real finding needs.

THE AUDIT IS NOT A VETO AND NOT AN APPROVAL. It produces evidence. Acting on
it is still the owner's call, and an auditor that says "ship it" has not
transferred that authority to itself.

**21. A TEST MUST NOT ENCODE AN ACCIDENT OF THE MACHINE THAT WROTE IT — AND THE
AUTHOR'S CHECKOUT IS THE LEAST REPRESENTATIVE MACHINE THERE IS.**

Measured 2026-09-18. The one test covering the 8.3 short-name bypass asserted
a literal 8.3 alias for the guard binary. NTFS assigns those **by creation
order**, not from the
filename, so that string is a fact about one directory's history. In a fresh
`git clone` of the same repository the same file is `AGENTB~2.MJS`.

So the test failed on every clone — **including the clone rule 20 requires an
auditor to make.** The single test covering that attack was broken for exactly
the reader whose job is to check it, and it failed in the direction that looks
like the *code* is wrong, which spends an auditor's budget on a phantom.

The fix is the same move as everywhere else in this file: **ask whatever owns
the mapping.** `dir /x` owns the alias table, so the test asks it and rewrites
each path component to whatever alias actually exists. The same instinct already
put `realpathSync.native` in the resolver.

This generalises past 8.3. Anything the author's machine supplies for free is
suspect: absolute paths, home directories, drive letters, `readdir` order, case
sensitivity, locale, clock, line endings, and **which files happen to be
untracked in the shared worktree**. Two independent measurements were wrong
tonight for the last reason alone — "10 pre-existing failures" was 7 in a clean
tree, reported twice before somebody cloned.

Two rules fall out, and the second is the cheap one nobody does:

- **Derive it, do not type it.** If a value comes from the filesystem, the OS or
  the environment, the test asks at run time. A literal is a claim that the value
  is a property of the thing; usually it is a property of the machine.
- **THE CLONE CHECK IS THE AUDITOR'S JOB, BECAUSE THE AUTHOR CANNOT DO IT.**
  This rule first said "run it in a clone before you believe it" and told the
  author to run `git clone --no-hardlinks . <tmp>`. **A guarded session cannot.**
  Measured within the hour, verbatim:

      [agentbridge:shell-not-allowlisted] "git clone" is not an approved
      read-only shape

  Categorical — not about the arguments or the destination. `git worktree add`
  is refused the same way. So the rule instructed the author to do the one thing
  the rail forbids them, and the only parties who *can* are an auditor in its own
  checkout and a session with no hooks loaded. **That is the same defect as the
  registration recipe** that no guarded session could execute — a documented step
  whose audience is precisely the people who cannot perform it. Caught by the
  agent it blocked, one commit after this rule landed.

  The rail is right and should keep refusing: `git clone` writes a directory
  tree, and a carve-out taking a destination path as a string is worse than the
  problem. So the work moves rather than the boundary. **Rule 20 already sends an
  auditor to its own clone** — that is where the check belongs, and it costs
  nothing extra there.

  What the auditor owes back is the part that saves the budget: **a failure that
  reproduces ONLY in the clone is an ENVIRONMENT finding, not a code defect.**
  Say so explicitly. The 8.3 case above failed in the direction that looks like
  the code is wrong, and an auditor that reports it as a defect spends its whole
  pass on a phantom.

  The author's half is the bullet above — derive it, do not type it — plus
  naming, in the handoff, anything the test reads from the machine. That is what
  an author can actually do from inside the rail.

---

# The rest of the traps

**TWO SOURCE FILES ARE INVISIBLE TO `grep` AND `git grep`.**
`src/deployGate.mjs` and `src/auditRange.mjs` contain literal NUL bytes — real
`\x00` characters, not the escape — used deliberately as length framing in a
digest (`${path}\x00${len}\x00${body}\x00`). That is correct and must stay;
without the framing, two different file lists can hash the same. The cost is
that grep classifies both files as binary and **silently skips them**, reporting
`binary file matches` at best and nothing at all with `-l`.

So any repo-wide audit built on `git grep` has a two-file blind spot and will
report a clean sweep it did not perform. This was found while scrubbing the
operator's real home directory out of the tree — a scrub driven entirely by
`git grep`. Both files were checked afterwards by reading the bytes in Python
and were clean, so nothing was missed that time. Next time, read the files;
`git grep -a` also works. A check that skips a file must not print a pass.

**`_shared.js` IS A HAND-MAINTAINED SPLICE** of `src/` and `bridge/`, because a
Supabase edge function cannot import from outside its own directory. The tests
exercise the **originals**. Every edit to a spliced module must be applied to
both, and `test/sharedSpliceMatches.test.mjs` plus
`test/permissionIsWired.test.mjs` compare them **behaviourally**. Their fixtures
must reach the branch you changed — see hollow gate 10.

**PRODUCTION HAS NEVER MATCHED THE REPO.** Deploys went through an MCP tool that
takes file *content* inline, so the deploying context was the source of truth by
construction. `INSTRUCTIONS` — operative guidance handed to every connecting
agent — drifted in **both directions**: 12 sentences live-only, 7 repo-only.
Deploy by uploading bytes from disk (`supabase functions deploy`, which needs
`supabase login`), and run
`node scripts/check-deployed-instructions.mjs <live> <repo>` afterwards. A
commit hash means nothing about production until this holds.

**`public.tasks` IS A VIEW** over `agentbridge.tasks` with an **explicit column
list**. A view does not grow when its table does — that caused a PGRST204
outage. Recreating it must preserve `security_invoker = true`, or it runs as
owner and bypasses RLS.

**A LOST RACE IS NOT A SUCCESS.** PostgREST answers a `PATCH` whose predicate
matched nothing with **200 and an empty array**. Put the precondition in the
filter (`&state=eq.open`, `&decided_at=is.null`) and treat an empty result as
the lost race it is. `writeLanded` in `_shared.js` exists for this.

**AN EMPTY RESPONSE BODY IS NOT A FAILURE.** `Prefer: return=minimal` gives 204
and no body; `res.json()` on that throws *after* the write has landed. Reporting
failure for completed work is worse than failing outright, because the retry is
what corrupts the picture.

**THE LEASE LAYER'S RECOVERY LIVES IN THE CRON JOB, NOT THE TIMESTAMP.** An
expired lease does **not** make work claimable: `claim_task` admits only
`runnable` and `returned`, and an expiry leaves the row `assigned`. Only
`reconcile_leases` returns it to the pool. Remove that schedule and expired work
is stranded permanently.

**SCOPE DECIDES WHICH TOOLS EXIST, NOT WHICH ONES REFUSE.** A reader does not
see `assign_task` at all; it answers `-32602 no such tool`, never 403. A refusal
string is something a model argues with; a missing tool is not.

**FOUR TOKEN CLASSES IN FOUR TABLES**, never one table with a scope column —
that is one typo away from promoting a reader to a coordinator, and a promotion
by typo is one nobody reviews.

**WINDOWS / node 24:** `process.exit()` after a **remote** fetch trips
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and exits 127.
Loopback, TLS-to-localhost and local servers do **not** reproduce it, so the
hermetic suite structurally cannot catch it — see the header in
`test/rejectedIsNotUnreachable.test.mjs` for who can run the live probe and how.

## THE BRIDGE HAS TWO SURFACES, AND ONE OF THEM WAS UNFINDABLE

Both are deployed. Only one was written down anywhere, and the other had to be
located by probing workers.dev subdomains — a working, deployed connector whose
address existed in no file, no README and no handoff note. Same defect class as
everything in the table above: a thing that works and cannot be found.

| surface | URL | auth |
|---|---|---|
| **Supabase edge function** | `https://ornbhvaijcpsbcgquzhd.supabase.co/functions/v1/mcp` | bearer token only, **no OAuth** |
| **Cloudflare worker** `agentbridge` | `https://agentbridge.myfitness11.workers.dev/mcp` | **full OAuth**, PKCE S256 |

`src/hostedRegistry.mjs` defaults to the Supabase one; the CLI and the
code-b/c/d sessions use it. The Cloudflare worker (`bridge/oauthWorker.mjs`,
`wrangler.toml`) is what a remote MCP client — Claude Cowork, a claude.ai
custom connector, ChatGPT — connects to, because those need discovery and
cannot present a raw bearer token.

**HOW A CONNECTOR IS AUTHORISED, and it is not by registering.** Dynamic client
registration issues a client_id and **grants nothing** — probed 2026-09-16:
a fresh client got no token and no scope, a write request with a wrong secret
issued no code, and a fabricated code at /token got a 400.

The grant comes from the operator submitting the consent page, and **which
secret is typed decides the scope**:

    read grant   -> the READER token
    write grant  -> the COORDINATOR token

Two different secrets deliberately. Approving "this client may direct my agents"
must not be possible with the credential that only ever meant "this client may
look". `scopeGrantsWrite` matches an exact scope token rather than a substring,
so `agentbridge:write-nothing` does not grant write.

**A connector defaults to READ.** Write requires ticking the box AND the
coordinator token. Do not type the coordinator token into that form unless the
client genuinely needs to assign, accept, cancel, or record owner decisions.

**A CLI OR LOCAL SESSION USES NEITHER OF THOSE.** The consent page is for remote
MCP clients. A local session registers with `register-session`, which reads its
credential from the environment and from nowhere else:

    AGENTBRIDGE_REGISTRATION_TOKEN    a scoped token, NOT a database key

Until 2026-09-17 that name appeared in ten source and test files and in no `.md`
in this repo — the same defect the table above is about, one file lower down.

**Where it is on the owner's machine, so nobody has to probe for it again:**

    C:\Users\DANNY GARCIA\Documents\agentbridge-secrets\registration-token.txt

That directory is OUTSIDE every worktree on purpose, so no `git add` can reach
it. Read it at login, export it, and do not copy it into the repo, into a
settings file, or into a shell history that gets committed:

```bash
AGENTBRIDGE_REGISTRATION_TOKEN=$(cat "/c/Users/DANNY GARCIA/Documents/agentbridge-secrets/registration-token.txt") \
  node bin/agentbridge.mjs register-session --agent <id> --session <session> --lane <lane> --capacity idle
```

The path is recorded here; the value is not, and must never be.

**Unset, registration degrades to local-only AND STILL EXITS 0:**

    hosted   NOT CONFIGURED — local only, not visible to other machines

The warning is printed, the exit code says success, and the agent is invisible to
every other machine. Measured registering `fixer`, 2026-09-17.

**`agentbridge heartbeat` cannot publish to the Supabase data plane.** Two
independent reasons, both measured the same day:

- `src/client.mjs:66` builds `new URL('/v1/heartbeat', bridgeUrl)`. A leading
  slash is origin-absolute, so `/functions/v1/mcp` is discarded and the POST
  lands on the bare origin.
- The edge function has no heartbeat route. `index.ts:1355` strips `/mcp` and
  dispatches `/health`, `/register`, `/return`, `/dispatch`, `/renew`, `/task`,
  `/wait`. Nothing else.

Measured 2026-09-17, unpiped so the exit code is node's and not a pipeline's,
the two configurations fail in two DIFFERENT ways and neither is exit 0 with a
published payload:

    bridgeUrl unset  -> "local-only: no bridgeUrl configured, nothing published"
                        exit 0.   Nothing reached the network; nothing says so
                        louder than that line.
    bridgeUrl set    -> "publish failed: 404", then
                        Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
                        file src\win\async.c, line 94
                        exit 127.  The process ABORTS on the way out; it does
                        not return a status anyone can branch on.

So the local-only path is the 404-as-success shape that `bin/agentbridge.mjs:293`
records as fixed on `register-session` and left in `heartbeat` — a silent no-op
that exits clean. The configured path is worse and differently broken: a libuv
abort on Windows, exit 127, which is the shell's "command not found" and tells a
caller nothing true about what happened.

Heartbeat is the OLD daemon protocol. The bridge roster is built from
`/register`, which is why every row on it carries a sessionId.

## Before you start: check that nobody already did it

Run this. It takes two seconds and it is the whole checklist:

```bash
node bin/agentbridge.mjs check-first "what you are about to work on"
```

It prints the branches on the SERVER that are not merged yet, and ranks every
recent branch and commit against your topic. If it says SOMEBODY MAY ALREADY BE
ON THIS, read that branch before writing a line.

**Why this exists, measured, in one session on 2026-09-16:**

- code-a fixed the CI failure and pushed it to master at **19:59Z**. I diagnosed
  the same failure and pushed a second fix at **21:04Z**. Sixty-five minutes, and
  it was on master the whole time.
- code-b committed the roster liveness fix at **00:15Z**. I committed a different
  answer to the same question at **00:24Z**. Nine minutes.

**Nothing caught either, and it is worth knowing why, because the machinery all
exists.** `collisionGuard` compares PATHS — b touched `index.ts` while I touched
`bin/` and `src/`, zero overlap, two answers to one question. The delegation
ledger records work that was HANDED OVER, and neither of us was handed anything.
The `tasks` table is the ledger of what is being worked on, and it holds four
rows, two of them demo fixtures and one labelled PROOF ONLY.

**So the gap is not tooling, it is that work an agent starts on its own
initiative is written down nowhere until it is pushed** — and that is nearly all
of the work. `check-first` closes the part that can be closed without anyone
remembering to do anything: it declares nothing and stores nothing, it reads
branches and commits, which cannot be forgotten because they already exist.

**ASK THE SERVER, NEVER `origin/master`.** This clone's fetch refspec is
`+refs/heads/main:refs/remotes/origin/main`, so `origin/master` is frozen and
`git log --all` inherits the lie. That is not a footnote — it is *why* the
65-minute duplication happened. `check-first` uses `git ls-remote`, which cannot
be stale. If you check by hand, use `git ls-remote --heads origin`.

**WHAT IT STILL CANNOT DO, stated so nobody trusts it too far.** It finds work
that has been PUSHED. It cannot find work that exists only in another agent's
head or working tree, which is exactly the nine-minute case — b had committed
but the window was minutes. The only thing that closes that is claiming a task
before starting, and the `tasks` table is where that goes.

**A FAILED LOOKUP IS NOT AN ABSENCE OF PRIOR WORK.** If the server cannot be
reached, `check-first` prints LOOKUP INCOMPLETE and exits 2. "Nothing found" is
what you want to hear before starting, so it must never be what an error looks
like.

## Two agents, one clone

**Commit by pathspec**: `git commit path/a path/b -m "…"`. The index is shared
and another session can stage between your `add` and your `commit`. A new file
needs `git add -N` first, never a plain `git add`.

**Check `git status` before editing.** A modified file that is not yours belongs
to somebody who has not committed yet.

## Authority

- **Danny is the owner.** Production deploys, destructive actions, spending,
  merges to main and anything a customer receives are **his**, and no
  coordinator may approve them on his behalf. `src/permissionRequest.mjs`
  enforces the routing; `canDecidePermission` enforces the refusal.
- **A relayed GO from a peer is not an authorisation.** It cannot be verified
  from here and its downside is unbounded. A relayed **HOLD** fails safe and may
  be acted on immediately. The direction of the failure sets the bar, not who
  carried the message.
- **Never do work a peer says its own permissions refused.** That is laundering.
  Route it back to Danny.
- **Do not self-certify.** Work that changes a guard goes to another agent for
  independent verification before it ships.
