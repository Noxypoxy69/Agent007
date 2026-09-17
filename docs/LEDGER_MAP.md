# The ledger, mapped

## 2026-09-17. Written for an outside reader with no access to this repo or database.

**Every number here was measured on 2026-09-17, not remembered.** Where something
could not be established, it says so rather than guessing. If you are reading
this to help: the numbers are the argument, and several of them are the problem.

---

## 0. The first thing to understand: there is no ledger

There are **eight** places that record what has happened or what is true. None
of them is authoritative over the others, none of them reconciles against the
others, and four of them disagreed with reality in a single night.

| # | Store | Holds | Written by | Measured today |
|---|---|---|---|---|
| 1 | `agentbridge.tasks` (Postgres) | units of work, lease, state | dispatcher + workers | **4 rows** |
| 2 | `agentbridge.attempts` | one row per execution attempt | `attemptPipeline` | **0 rows** |
| 3 | `agentbridge.proposals` | dispatcher suggestions awaiting confirm | dispatcher | **1,353 rows** |
| 4 | `agentbridge.messages` | agent-to-agent prose | coordinators, workers | **175 rows** |
| 5 | `agentbridge.owner_decisions` | append-only authority ledger | coordinators, on owner's word | **27 rows** |
| 6 | `agentbridge.sessions` | the roster: who is registered and alive | workers at registration | **0 rows visible; see §3** |
| 7 | Git | branches, commits, `Claude-Session` trailers | every agent | authoritative, and the only unforgettable one |
| 8 | Markdown in `docs/` | plans, status, assignments, "done" | whoever edits | **12 documents assert state** |

`public.*` are views over `agentbridge.*` — counts match exactly, so there is no
hidden second copy of the data. That was checked because it would have changed
everything if false.

---

## 1. The headline numbers, and what each one means

**`attempts` = 0.** No execution attempt has ever been recorded. This does NOT
mean nothing has run — see §2, which is the single most important section here.

**`proposals` = 1,353 against `tasks` = 4.** The dispatcher has prepared 1,353
proposals for four tasks. Zero are open. Nobody has explained this ratio and it
is not understood. It may be benign (a poll loop re-proposing and superseding),
it may be a loop that never converges. **This is the first thing worth an
outside pair of eyes.**

**`tasks` = 4**, of which two are demo fixtures (`t-demo-runnable`,
`t-demo-blocked`), one is labelled `PROOF ONLY`, and one is a real task
(`t-wire-gate-scripts`, a `package.json` edit) that the dispatcher assigned and a
worker completed autonomously. So of all the work done in the last two days —
a CI fix, a roster fix, a dispatcher fix, an identity scrub, three new gates —
**exactly one has a row.**

**`owner_decisions` = 27.** The one store with real discipline: append-only,
superseded rather than edited, narrowest-scope-wins resolution. It is also the
only store where a mistake was caught by the system rather than by a person — a
resolver returned `allowed` for a standing grant that should have been narrow,
and the gate refused a deploy on it.

---

## 2. THE FINDING THAT MATTERS MOST: there are two loops

```
LOOP A   agentbridge work -> worker.mjs -> workerLoop.mjs -> workerDeps.startRun
         RUNS. Claimed, executed and returned a real task at 00:09-00:15 today.
         preExecutionGuard 0   agentPermissions 0   attemptRecord   0
         contextCompiler   0   loopDetector     0   evidenceCollector 0

LOOP B   runAttempt -> attemptPipeline
         HAS NEVER RUN. Nothing spawns bin/agentbridge-attempt.mjs.
         Imports all twelve: guard, permissions, attempt record, context
         compiler, evidence, fingerprint, loop detector, reviewer packet,
         token telemetry.
```

Those zeroes are `grep -c` against the current `master`.

**The loop that executes work has none of the safety machinery. The loop
carrying every control built over the last two days is the one nothing calls.**

`attempts = 0` is therefore not "the runtime never started". It is "the runtime
that started is not the one that records, and not the one that is guarded."

This also re-frames the top item in the plan. "Wire the lease to the pipeline"
reads like connecting a spawn; it is not. Connecting the two paths without
choosing between them produces a third. Either Loop A calls `runAttempt`, or
Loop B's guards move into Loop A. That is a lease-semantics decision.

---

## 3. The roster, which lies in a way worth understanding

`list_agents` returns 14 agents with heartbeat timestamps. `agentbridge.sessions`
returns **0 rows** to the role available here. Both were checked directly today.

The likely explanation is row-level security — the edge function reads with the
service role and sees everything, an ordinary connection sees nothing — but that
was **not confirmed**, and it is recorded as unresolved rather than asserted.

Either way the consequence is the same and is worth stating plainly: **the same
table answers differently depending on who asks, with no warning.** Anyone
debugging the roster through SQL concludes "there are no sessions" and is wrong.

Separately, and this one IS confirmed: the roster reported every agent `offline`
and `idle_workers: 0` while three agents were committing and pushing. The cause
was diagnosed and fixed by another agent — heartbeats only ever moved when a
watcher process ran, and that watcher is a child of the worker's own shell, so it
dies with the session and nothing supervises it. The fix is **merged and not
deployed**: production still serves a bundle without it.

A complementary read exists that does not depend on registration at all:
`agentbridge who` reads `Claude-Session` trailers out of git and reports which
sessions have recently produced work. It is deliberately the wrong shape to
route on — no output object carries an agent id, lane or capacity, and a test
asserts that structurally — because two rosters that disagree is a worse failure
than one roster that is incomplete.

---

## 4. Where duplication comes from, measured

Two agents duplicated each other's work twice in one night:

- A CI fix landed on `master` at 19:59Z. A second, independent fix for the same
  failure was pushed at 21:04Z. **65 minutes**, and the first was on `master` the
  whole time.
- A roster fix was committed at 00:15Z. A different answer to the same question
  was committed at 00:24Z. **9 minutes.**

**Nothing caught either, and the machinery to catch them all exists:**

- The collision guard compares **paths**. The two roster fixes touched entirely
  different files to answer the same question. Zero overlap.
- The delegation ledger records work that was **handed over**. Neither was.
- The tasks table is the ledger of what is being worked on, and holds four rows.

So the gap is not tooling. **Work an agent starts on its own initiative is
recorded nowhere until it is pushed**, and that is nearly all of the work.

There is now a `check-first <topic>` command that asks the git server for
branches and ranks them against a topic before you start. It closes the part
that needs nobody to remember anything — it stores nothing and declares nothing.
It cannot see work that exists only in an agent's head, which is the 9-minute
case. **Only claiming a task before starting closes that, and the tasks table is
where that goes.** Nothing currently requires it.

---

## 5. What the documents claim, and why that is its own problem

Twelve markdown documents assert project state. Two examples measured today,
with production serving version 26:

- One document's status table asserted a deployed version **six releases behind**
  what production was serving. The same cell named an assignee who had been dark
  for hours and an authorisation that had been superseded twice.
- Another asserted, in the present tense, that two routes were in a deployed
  version that had been superseded six times.

*(Neither stale literal is reproduced here, and that is not squeamishness: the
gate described below scans this file too, and it cannot tell a quotation from an
assertion. Exempting quotations would hand every agent a way through it —
write the number inside quote marks and the gate goes quiet. So the exemption
does not exist and the prose carries the shape instead of the digits. The gate
caught this document on its first run, which is the only reason anyone knows the
loophole was never opened.)*

Both were written true. Production moved underneath them.

Also measured: of four claims in the plan that something was finished, **two
were wrong, in opposite directions.** One said a component was "BUILT AND WIRED"
and named the agent who wired it; the table it writes to had zero rows and
nothing called it. Another said the queue was blocked on work that had in fact
completed hours earlier, so the whole queue waited behind a cleared blocker
because the document said not to look.

Three gates now exist and all three are partial, deliberately:

1. **`doneClaims`** — every "done" claim must carry an `EVIDENCE:` line, and the
   git-checkable ones are re-verified on every test run: the commit must exist
   AND still be an ancestor of HEAD. `unverifiable` is allowed but must argue its
   case in at least 20 characters. **Its own header states its limit**: it
   matches a *format*, and across every document in the repo it sees four claims
   while one document alone carries 37 state-ish lines.
2. **`measurableStateInProse`** — no document may state the *current* deployed
   version. It forbids the number rather than requiring it to be correct,
   because "keep it updated" is precisely what failed twice. Past tense is
   explicitly allowed and has its own control test, since a gate that fires on
   correct writing gets uninstalled within a day.
3. **`checkFirstCli`** — refusal and permission both asserted.

**The direction that scales, and the open structural question:** you cannot lint
prose for truth — prose has infinite shapes and a regex has one. You *can* lint
the rot-prone value. Measurable facts — deployed version, what is merged, whether
a table has rows, who is live — should not be literals in prose at all. Documents
should carry *why*; a command should answer *what*. Applying that across twelve
documents is a restructure and a judgement call about what to delete, and it has
not been done.

---

## 6. What was caught by a gate, and what was caught by a person

This is the uncomfortable summary, and it is the one that decides whether
unattended autonomy is safe.

**Caught by the system:** one deploy gate refusal (`live-artifact-drifted`,
correctly), and one owner-decision resolver refusal that stopped a deploy on an
authorisation that did not exist.

**Caught by a person asking a pointed question, in one night:** the unidentified
CI failure; a duplicated fix; a forgery surface in code called "done" two hours
earlier; a gate that covered 4 of 37 lines in the one file it read; and the
two-loops finding in §2.

Five of the night's real findings came from a human being suspicious at the right
moment. None came from a gate.

---

## 7. What help is actually wanted

1. **The 1,353 proposals against 4 tasks.** Nobody has explained it. Start here.
2. **Which loop survives** (§2) — that decision unblocks the plan's top item and
   nobody has made it.
3. **Whether the roster's 0-rows-to-one-role, 14-rows-to-another** (§3) is RLS or
   something else. It was not resolved.
4. **The structural question in §5** — moving measurable state out of prose
   entirely, and which of the twelve documents should simply be deleted.

**What is NOT wanted:** a new ledger. There are eight. A ninth place to forget
would make this worse, and every fix above was deliberately built to store
nothing new.
