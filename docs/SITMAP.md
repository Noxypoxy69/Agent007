# Situation map — 2026-09-16 07:15Z

For the coordinator. Every number here was read from the live system or from git
at the time above, not recalled. Where I did not verify something, it says so.

---

## 1. The one sentence

**The loop has still never closed.** Everything else below is detail.

Measured: tasks 2, max attempt 0, leases ever held 0, outbox rows 0.
One proposal has ever been confirmed, by me, at 04:20Z today — the first in the
system's history after 627 prepared and none acted on.

---

## 2. Ground truth

| Thing | State |
| --- | --- |
| agentbridge `master` | `4131aa8` — **unchanged all day** |
| deployed edge function | **v20**, and it is **NOT master** |
| social-sparks-app `main` | `7543a4d` — reschedule fix merged, verify 89/89, **not deployed** |
| `work/recover-orphan-branches` | `1a97aa0`, green, +11, unmerged |
| `work/support-modules` | `8fe9694`, green, +22, unmerged |
| `code-b/lease-wiring` | `9ba9c96`, +12, unmerged |
| `code-b/fifth-hosted-path` | +14, unmerged, **nobody has mentioned this branch** |
| `b/*` (five branches) | +1 each, superseded by the recovery branch |

**Production is not running master and has not been all day.** Deployed v20
carries the lease-wiring work: `unreadable-answer`, `supabase-rpc-failed` and
`rpcRefusal` are all present in the deployed artifact and all absent from master.
Nine branches are unmerged. Nothing has landed on master today.

---

## 3. What happened today

**04:20Z** — first confirmed proposal in the system's history. Dependency unlock
proven at the scheduler level: T1 accepted made T2 runnable, the dispatcher
selected a worker unprompted, confirmation assigned it. No human in that path.

**05:07Z** — edge function v18. Verified as matching master on ten markers.

**06:29Z** — **v19 shipped broken.** `Uncaught SyntaxError: Identifier 'UUID' has
already been declared`. Every Bridge call 500'd for eleven minutes. The duplicate
existed in **no committed tree anywhere** — master 1, lease-wiring 1, my branch 1,
deployed 2. It was produced resolving a conflict by hand and deployed straight
from a working tree.

**06:40Z** — v20, recovered.

The lesson is not "be careful merging". `npm test` fails every import in seconds
on a syntax error. **Nothing stands between a working tree and production.**

---

## 4. The agents

| Agent | State | Notes |
| --- | --- | --- |
| code-c | live, working | HEAD moved 4× today; did the outage fix |
| code-d | live, idle | holds the 58-commit website-ai-cloner merge |
| b6 | live, idle | new worktree `wt-release-verify`, lane `claims` |
| code-b | **silent 17h** | heartbeat frozen `2026-09-15T13:54:52` |
| a | not registered | sends messages, has no worker row |

**code-b's registration is alive but its heartbeat is dead**, and those are
different facts. The heartbeat comes from a separate daemon process, not from the
agent. Restarting the chat session does not restore it; the daemon has to run in
that worktree. This is why the restart did not register.

---

## 5. Identity is broken, and it is measurable

98 messages carry **ten distinct identity strings for six actors**.

The coordinator alone has sent under four names: `chatgpt` (4),
`chatgpt-command-center` (13), `chatgpt-work` (31), `chatgpt-work coordinator` (5).

`code-b` has received 19 messages and sent 0. `b6` has received 10 and sent 0.
**29 messages delivered to names that have never once spoken.** `claude-work`
sent 30 and received 0, because replies went to `chatgpt-work`.

Cause: nothing validated a recipient. `resolveLiveAgent` — which distinguishes an
unknown agent from an offline one — was already in the same file and already used
for assignments. Messages never called it. Fixed on `work/support-modules`,
unwired at the call site by choice, because that call site is in the file that
caused this morning's outage.

**Action for the coordinator: pick one id and keep it.** `chatgpt-work` has the
most history. Every other spelling is a mailbox nobody reads.

---

## 6. Open defects

| Defect | Owner | State |
| --- | --- | --- |
| No gate between merge and deploy | code-c | **caused the outage**, unfixed |
| Message guard refuses ordinary prose | claude-work | fixed on branch, **not deployed** |
| Recipient never validated | claude-work | fixed on branch, call site unwired |
| Staleness 10m vs lease 15m | code-c | sent 07:11Z; reporting only, not correctness |
| `runtime.mjs` duplicates SQL | code-b | in KNOWN with reasons, needs per-function proof |
| `auditRange.mjs` has no caller | code-b | in KNOWN, recovered green and callerless |
| No reviewer runtime | code-c | `claim_review` appears **0 times** in master *and* in production |

---

## 7. The order

0. ~~Deploy `/task` and `/renew`~~ — **done**, live in v20.
1. **Merge the two green branches to master** — code-c. Nothing can call what is not on master.
2. **Wire lease → pipeline → return** — code-c.
3. **Reviewer runtime** — code-c. Nothing claims a review lease anywhere.
4. **Persist the attempt record** — b6. Must land *before* step 5 runs.
5. **T1 closes with nobody watching.**
6. **T2 unlocks from T1 and closes.**

Then: code-health metrics, `readCache` gets a consumer, cache L0–L2, reviewer
hardening, learning, **console (12)**, performance engine (13).

---

## 8. For the coordinator specifically

**Six specs arrived today; none are built, and that is correct.** They are
numbered in `BACKLOG.md`, mapped against existing code in `AMENDMENT_MATRIX.md`
and `EXPERT_WORKFORCE_MAP.md`, and inspected in `CONSOLE_UI0.md`.

**Five of the six bottom out on one missing table.** Learning needs routing
identity; the execution fabric needs environment identity; the console needs
`AttemptSummary`; the expert workforce needs `PerformanceLedger`; false-done
needs both verdicts stored separately. **No attempt is persisted anywhere** — the
pipeline computes one in memory and the command prints it. That single record is
the bottleneck for four of your six specifications.

**A large fraction of each spec already exists under another name.** The lane
registry is the capability manifest. The proposal path is `CoordinationProposal`.
`supersession.mjs` is append-only memory correction. `argv.mjs` is the command
sanitiser. `moduleGraph.mjs` is the code-health governor. `readCache.mjs` is the
file cache, built and unused. Specifying these as new modules produces duplicates
of deployed code.

**One item of your own definition of done is currently false.** "Closing all chats
does not stop the expert team." Confirmation is a coordinator and the coordinator
is a chat session. Danny ruled this morning that the dispatcher should confirm —
that ruling is **not yet in the decision ledger**, and I was blocked from writing
it on his behalf.
