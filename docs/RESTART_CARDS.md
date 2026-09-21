# Getting the four back online — coordinates

Everything here is from the Bridge's registrations and worktree table, read at
16:3xZ. **Where I could not establish something I have said so rather than
guessed**, because a wrong path in a restart card costs more time than a missing
one.

## The important thing first: these are LOCAL sessions

All four register from the SAME machine — the owner's Windows box. `list_agents`
carries the machine id and is authoritative; it is not repeated here, because a
real machine id committed to a public repository identifies the box, and a copy
in a doc goes stale the moment the machine is rebuilt while `list_agents` cannot.
They are Claude Code CLI sessions, not cloud containers. Anything
that looks like a claude.ai link for them is a **remote-control view of a local
process**: the link lets you see and message the session, it does not start one.
**The process has to come back on that machine.**

## The cards

| agent | worktree folder | lane | registered session id | last HEAD |
| --- | --- | --- | --- | --- |
| **code-c** | `agentbridge` | agentbridge | `danny-win-10` | `64b4180` |
| **code-d** | `social-sparks-app` | agentbridge | `danny-win-d1` | `544f0e5` |
| **B** | `agentbridge-b11` | agentbridge | `social-sparks-app-c8` ⚠ | `83035b6` |
| **B** (older) | `agentbridge-b8` | agentbridge | `danny-win-f1` | `90f2094` |
| **b6** = B | `wt-release-verify` | claims | `social-sparks-app-b6` | `07ec32f` |

The Bridge stores worktree **names**, not absolute paths. Danny has pasted
`C:\Users\JANE DOE\Documents\agentbridge-b12` in this session, so the
convention is `C:\Users\JANE DOE\Documents\<worktree>` — treat that as very
likely and not as verified for every row.

## To restart one

Open a terminal in that worktree folder and start Claude Code there. To pick up
the previous conversation rather than a blank one, `claude --resume` inside the
folder lists that directory's past sessions to choose from; `claude --continue`
takes the most recent without asking.

## Where the transcripts are

Claude Code keeps one folder per working directory under
`%USERPROFILE%\.claude\projects\`, with a `.jsonl` per session. The folder name
is the working directory with its separators flattened — on this Linux container
`/home/<user>/social-sparks-app` becomes `-home-<user>-social-sparks-app`. **I have
not verified how Windows drive letters and the space in `JANE DOE` are
escaped**, so list that directory rather than constructing the name; there will
be one folder per worktree above.

## ⚠ B must not come back as `…-c8`

`social-sparks-app-c8` registers as agent `code-b` and `c8` is this lane's id, so
B's work is recorded under a name that reads as mine — `t-loop-proof`, the first
end-to-end loop this system ever ran, is stored `returned_by:
social-sparks-app-c8`. Bring that one up under a session id whose last segment
is not a roster name; `agentbridge-b11`, after its own worktree, is the obvious
one. The guard that refuses this is built (`validateSessionId`) and only bites
once `work/support-modules` is merged and deployed.

## One cloud session that is NOT one of them, and why it looks like it is

`session_01Tz4NBpvqNey8XQDedeqrTc` — "Signature verification nonce and body
coverage" — reports head `544f0e5` on `feature/website-ai-cloner`, which is
exactly code-d's last HEAD. **It is a different session on the same worktree**,
not code-d: it was created 2026-09-15T04:23Z and code-d's registration was
created at 11:33Z, seven hours later. The heads match because the branch has not
moved since. Resuming it would give you that older conversation, not code-d's.

## First thing each should do when up

- **code-c** — the deploy. Audited, `deploy/audit-a816ae4.json`, verdict
  DEPLOYABLE, authorised by Danny at 08:18Z, still not run. Then merge
  `work/support-modules`.
- **B** — `t-loop-proof` is `returned` and has had no reviewer for nine hours.
  Also: B drove the first real loop; the attempts table has zero rows, so it was
  not recorded.
- **code-d** — the 58-commit merge, and the four reschedule gates against the
  89/89 baseline after it, not before.
- **b6** — same actor as B. Poll both `b6` and `code-b` for mail; nineteen and
  ten messages have been split across the two names.
