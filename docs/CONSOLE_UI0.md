# Operator console — UI-0

The console spec's own implementation order puts UI-0 first: inspect what exists
before building. This is that inspection, against `work/support-modules`.

## The finding that changes the plan

**The read API in section 23 largely exists already, as the MCP surface.**

Not as a sketch — as something being called in production today. Mission
Control, Tasks, Workers and Approvals are four of the five UI-1 pages, and every
one of them has a working read behind it right now:

| Console page needs | Already served by |
| --- | --- |
| Mission Control KPIs, health strip, needs-attention | `get_supervisory_report` — counts, stale workers, ready-to-assign, would-refuse, blocked, idle |
| Tasks list and row expansion | `list_tasks` — state, lane, repo, base, path contract, dependencies, assignment, lease, attempt, reviewer |
| Worker fleet | `list_agents`, `get_agent_state`, `list_worktrees`, `list_locks`, `list_active_processes` |
| Approvals | `get_owner_decisions`, `list_proposals`, `confirm_proposal` |
| Graph / collision view | `get_collision_summary`, `get_git_state` |
| Activity feed | `list_messages` with `since` |

So UI-1 is not "build a read API". It is "put a surface on the read API that
exists", which is a materially smaller and much less risky piece of work. Any
plan that starts by writing `GET /ui/tasks` is writing a second answer to a
question `list_tasks` already answers, and section 4 of the spec forbids exactly
that.

What genuinely does not exist as HTTP: `bridge/server.mjs` is 178 lines with four
routes — health, heartbeat, state and the MCP endpoint. There is no `ui/`
directory of any kind.

## The cursor model is built

Section 18 wants snapshot, then cursor, then resume-after-cursor. `src/events.mjs`
already has `eventsFor({ ..., since })` and `nextCursor`, and the outbox exists
in SQL. The resume half of the realtime design is a reuse, not an invention.

## The gap that blocks everything past UI-1

**No attempt is persisted anywhere.** The pipeline computes an attempt in memory
and the CLI prints it to stdout. Nothing writes it down.

Section 24's `AttemptSummary` asks for `attempt_id`, `worker_slot_id`,
`session_id`, `engine`, `model`, `role_profile`, `base_sha`, `result_sha`,
`lease_id`, `fence`, `verification_state`, `review_state`,
`result_envelope_digest`, `token_usage`, `cost`, `tool_calls`, `cache_hits`.

Of those, the envelope currently produces the base and result commits, the exit
code, the test counts, the files changed, the duration and the token totals.
**Everything identifying WHO ran it — engine, model, role profile, worker slot,
lease, fence — is produced by nothing**, and it is the half that cannot be
reconstructed after the fact.

That single missing record is the blocker for the Attempt Inspector (section 8),
Incidents (11), Learning (12), Optimization (13), Cache (14) and Lineage (16).
Six of the fourteen pages.

## Four specs, one missing table

This is the third time the same gap has surfaced from an unrelated direction,
which is worth stating plainly rather than noting again:

- the learning package needed the trajectory record, carrying routing identity,
  because those fields are unrecoverable;
- the execution fabric needed environment and workload identity, or its benchmark
  identity is incomplete and section C becomes unbuildable without a migration;
- the console needs `AttemptSummary`, which is the same fields again;
- and `false_done` needs the machine verdict and the reviewer decision stored
  separately, which no current record does.

Four specifications, arrived at independently, bottoming out on one table. That
is about as strong a signal as sequencing ever gives.

## Where the spec confirms findings already made here

Section 28's do-not-build list contains two conclusions this lane reached
independently, which is a useful cross-check rather than a coincidence:
warm-workspace affinity that weakens fresh-worktree isolation, and a semantic
cache presented as proof. Both are already recorded in `BACKLOG.md` and
`AMENDMENT_MATRIX.md` as hard rules.

## Control actions

Section 22 says the UI calls the existing command path and never writes state.
That path exists and is proven: the dispatcher prepares a proposal and something
else confirms it. It was exercised today, and the first confirmed assignment in
the system's history went through it.

One property of it belongs in the UI design rather than being discovered later:
**the dispatcher supersedes its own proposal every minute.** A proposal read at
one moment is stale seconds later, so an approve button bound to a proposal id
will fail more often than it succeeds. The console must confirm against a
freshly fetched proposal, or the control surface will feel broken while behaving
exactly as designed.

## Recommended order, adjusted

- **UI-0** — this document.
- **UI-1** — a surface over the existing read tools. No new read API. Mission
  Control, Tasks, Workers, Approvals, activity feed on the existing cursor.
- **UI-1.5, and it is the real prerequisite** — persist the attempt record with
  routing identity. Not a UI task, and the thing four specs are waiting on.
- **UI-2 onward** — unblocked by 1.5, in the spec's own order.

## Authority, unchanged

The console is a read model. It never owns a lease, a fence, task state, review
acceptance or policy, and no optimistic update may imply authority the server has
not confirmed.
