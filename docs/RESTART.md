# Bringing the four back up — 2026-09-16 16:2xZ

All four went offline. **Nothing was lost and nothing needs cleaning up before
they restart.** Everything below was read from the Bridge and the database, not
recalled.

## 1. Nothing is at risk, and here is the proof rather than the assurance

| agent | last seen | last HEAD | where that commit lives |
| --- | --- | --- | --- |
| code-c | 12:30:46Z | `64b4180` | on agentbridge `master` |
| code-d | 12:30:51Z | `544f0e5` | `origin/feature/website-ai-cloner` |
| code-b (`…-c8` session) | 08:31:30Z | `83035b6` | on agentbridge `master` |
| b6 = B (`…-b6` session) | 08:30:56Z | `07ec32f` | `origin/d-claims-authz-b6` |

`dirtyFiles: 0` on every one. No locks held. Nothing running. Every task shows
`lease_token` null and `lease_expires_at` null, so **there is no stale lease to
reap and no lock to force** — the thing that usually has to be cleaned up after
a mass shutdown genuinely is not there this time.

**The `unpushed` field is null on all four, and null means unknown, not zero.**
That is why the table above checks each HEAD against the remote by object rather
than trusting the count. All four are present on a remote branch.

## 2. What happened while nobody was watching, and it is the big one

**The loop moved for the first time.** Measured against this morning:

| | 07:15Z | 16:20Z |
| --- | --- | --- |
| tasks | 2 | 3 |
| max attempt | **0** | **1** |
| outbox rows | **0** | **2** |
| proposals | 627 | 1170 |
| confirmed | 1 | 1 |
| **durable attempt rows** | — | **0** |

`t-loop-proof` is `returned`, attempt 1, by B at 08:02Z at `bb899fc`, with the
note *"loop proof: claim/task/renew/return driven once end to end"*. That note is
an agent's prose and is not authority — but the counters agree with it. The
attempt counter moved off zero and the outbox carried rows for the first time in
the system's history. Something really did go round.

**AND IT WENT ROUND UNRECORDED.** The attempts table has **zero rows**. The
migration is applied; nothing writes to it. The first real attempt this system
ever ran is not in the durable record, which is the exact thing the record was
built to prevent and the exact sentence that was in the order: *"must land
before, or the first real attempts are unrecorded and unrecoverable."* The
writer is wired on `work/support-modules` and that branch is unmerged.

## 3. Restart order

1. **Bring them up.** No preparation needed — see section 1.
2. **`t-loop-proof` has been waiting eight hours for a reviewer.** State
   `returned`, reviewer null. The dispatcher re-prepares a review proposal every
   minute and nothing confirms it, because confirmation is a coordinator tool
   and the coordinator is a chat session. That is the 1170-to-1 number.
   *I did not confirm it while they were down: a confirm with no live worker
   assigns review to nobody, which is the roster-lies bug in another costume.
   The moment a reviewer is live it is one call.*
3. **code-c: the deploy.** Audited and waiting at `deploy/audit-a816ae4.json`,
   verdict DEPLOYABLE, all five checks, drift none. Authorised by Danny at
   08:18Z and not run.
4. **Merge `work/support-modules`** (`c6351ca`, 1430 pass 0 fail). It carries the
   attempt-record writer that section 2 is about.

## 4. Two identity notes for whoever restarts them

- **B has two registrations** (`code-b` and `b6`) and mail splits between them.
  `d-owner-identity-b6-20260916`, in Danny's words: *"b6 is b"*.
- **One of B's sessions is registered as `social-sparks-app-c8`.** `c8` is this
  lane's id. It was created at 07:49Z, two minutes before this lane first signed
  as c8, and `t-loop-proof` — the first end-to-end loop this system ever ran —
  is stored with `returned_by: social-sparks-app-c8`, which reads as mine and is
  B's.

  **The guard is built** (`validateSessionId`, on `work/support-modules`) and
  refuses a session id whose LAST segment names a different actor. Only the last
  segment, because these ids are `<where-it-was-launched>-<which-session>` and
  `danny-win-10` legitimately begins with the owner's own id — a check that
  scanned every segment would refuse the three sessions that have worked all
  week, and a rule that refuses the working roster is one somebody switches off.
  An alias of your OWN actor passes: `social-sparks-app-b6` as `code-b` is
  correct, because b6 IS code-b.

  **Two things still need doing by hand when B comes up**, and neither is mine:
  B must restart under a session id that is not another actor's name — anything
  whose last segment is not a roster name, e.g. `agentbridge-b11` after its own
  worktree — and the guard only bites once `work/support-modules` is merged and
  deployed.

  **The historical row is NOT being rewritten.** `t-loop-proof.returned_by`
  stays as it is. It records what the system was told at the time, the
  registration correctly maps that session to `code-b` so a resolver still gets
  the right actor, and editing a returned-by field to make a log read better is
  how a record stops being evidence.
- Nine `probe-*` rows are test leftovers cluttering the roster.
