# Situation map — 2026-09-16, updated 09:5xZ overnight

For the coordinator. Every number here was read from the live system or from git
at the time given, not recalled. Where I did not verify something, it says so.

> **Overnight update.** Danny went to bed at 09:19Z telling the lane to keep
> working and stop asking (`d-owner-overnight-autonomy-20260916`). What follows
> replaces the 07:15Z version where it disagrees; the biggest correction is at
> the top and it is one I made against myself.

---

## 0. The correction that matters most

**Item zero of the order was already done, and I had never looked.** I put
"deploy the edge function" at the top of the critical path on the strength of a
report, and never read production. `/task` and `/renew` have been live in v20
the whole time, with `/dispatch`, `/register`, `/return`, `/wait` and `/health`.
Nothing downstream was ever waiting on it.

A report about a deployed system ages the moment somebody deploys, and this one
aged inside four hours.

**And deploying master, when Danny asked for it at 08:18Z, would have been a
pure regression.** At that moment master was 0 ahead of production and 14
BEHIND: the deploy would have shipped nothing new and removed 232 lines serving
traffic — the single-transaction claim path, the rpc shape check, the
refusal-reason mapping — reinstating the read-decide-write race code-d found.
A fresh version number and a worse system, which is indistinguishable from a
successful deploy unless somebody reads the bytes back.

That has since inverted. B landed 59 commits and production is now an ancestor
of master.

---

## 1. The one sentence

**The loop has still never closed in production — and it now runs end to end on
a real repository in test.** That is a real distinction and not a consolation:
the pipeline has read files, edited them, run a check, staged, committed,
collected evidence, been reviewed and reached a verdict with nobody watching.
What has never happened is that sequence being driven by the scheduler against
the live database.

---

## 2. Ground truth, 09:5xZ

| Thing | State |
| --- | --- |
| agentbridge `master` | `a816ae4` — **+59 today**, contains production |
| deployed edge function | **still v20** — Danny authorised a deploy at 08:18Z; code-c has not run it |
| v20 corresponds to | `code-b/fifth-hosted-path` `bb899fc`, byte-identical in both files |
| master vs production | **45 ahead, 0 behind** — a deploy is now correct |
| `work/support-modules` | `d9dce69` — +9 tonight, 1430 pass 0 fail, unmerged |
| attempt migration | `20260916081839` **applied** — checked against the live DB |
| known orphan modules | **4**, down from 5 |

---

## 3. What was built overnight, and what each one found

Nine commits. Every one of them found a real defect rather than adding a
feature, which is the useful pattern to notice.

**The deploy gate passed the skip it warned about.** code-b's gate refuses a
dirty tree, an unpushed head and a side branch, and treats an unchecked drift
comparison as clean — while its own CLI prints "A skip is not a pass: this is
the check that catches a hand-deploy nobody recorded" and then reports
DEPLOYABLE. The null was doing two jobs: "there is no prior deployment" and
"nobody compared". One value, both meanings, unsafe by default. Now a first
deploy declares itself and absent is a refusal.

**The first real end-to-end run refused its own executor.** The `prompted`
outcome I had shipped an hour earlier could not survive the adapter — unknown
field, unknown outcome. Every unit test passed because they call an adapter
directly and never go through `execute`. The module was exercised; the path was
not.

**Nothing had ever written an attempt record.** code-b built the row and left it
uncalled on purpose, declaring that the write belongs under the lease. Resolved
by splitting: the start write happens before any work, when the claim's lease is
the newest thing in the room; the finish write goes through the store that owns
the fence. All four verdicts are stored separately, and a false done — agent
claims success, machine rejects — is a passing test now rather than an argument.

**readCache had no consumer**, so nothing had ever proved it saves anything. Its
context compiler exists now, and the digest is of what was SENT rather than of
the files — because an unchanged file travels as a reference, so identical files
can be a different prompt.

**Adding that digest to the attempt fingerprint would silently disable loop
detection**, since the sent form changes between attempts by design. Pinned with
a test that applies the improvement and goes red.

**And I wrote a hollow gate**, which is worth more than any of the above. My
length-framing test claimed a collision that could not happen, so removing the
framing left it green. A check that passed while proving nothing, in a file
whose whole subject is not trusting claims, by somebody who had just finished
saying so. The rewritten one uses a real collision — one file whose content
spells out the next file's header — and goes red.

---

## 4. What is NOT true, said plainly

- **The loop has not closed unattended in production.** Test is not production.
- **The agent permission scope has never been run against a real Claude Code or
  Codex binary.** It is derived from the guard and mutation-proved. That is not
  the same as having watched it launch one.
- **`work/support-modules` is unmerged.** Nine commits of tonight's work are on
  a branch.
- **The dispatcher-confirms ruling is still not in the decision ledger.** Danny
  said it this morning; I was refused when I tried to record it for him and I
  think that refusal was right. Until it is recorded, confirmation depends on a
  chat session and 627-to-1 stands.

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
