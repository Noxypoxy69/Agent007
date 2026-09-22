# Handoff — 2026-09-21, the night this machine was retired

Written because the operator said this PC is being retired for a new one, and
almost everything below lives in places `git clone` does not carry. If you are
the session picking this up on the new machine, read this before starting.

**Why this is in the repo and not in agent memory:** agent memory lives in
`~/.claude/projects/<project>/memory/`, and `scripts/migration-package.mjs`
deliberately carries only `~/.agentbridge` authority state. Memory is in NEITHER,
so it does not travel. Anything here that mattered was put here on purpose.

---

## 1. The execution-profile split — DONE, AUDITED, AND IT MUST NOT MERGE

Branch `b/watcher-respawn`, pushed. Commits `e2f403d` … `d3639af`.

Three profiles (`MANUAL_TRUSTED`, `AUTONOMOUS_TASK`, `REVIEW_ONLY`) behind one
resolver, `src/sessionPolicy.mjs`, with `src/sessionEvidence.mjs` gathering the
evidence and `src/claudeGuard.mjs` consulting it once and passing it down. No
scattered `if (manual)` branches. Suite green: `VERIFY_PASSED`, 3094 tests, 0
failures.

**A blind audit found 11 defects, 3 CRITICAL, and the anchor does not hold.**
Full report with reproductions: `docs/AUDIT-execution-profiles-20260921.md`.
Ledger rows: `docs/audit-ledger.jsonl`, commits `b53c7232` and `c15cea6`.

The one-line verdict, which is the reason this is not merged:

> MANUAL_TRUSTED is reachable from a contained session in one permitted Bash call
> plus a compaction — a **lower** bar than the wildcard grant it replaces.

**To finish it, in this order:**

1. **Bind only on a real start.** SessionStart is registered with `"matcher": ""`,
   which also fires on `resume`, `clear` and `compact`. Refuse the bind unless
   the hook payload's `source === "startup"`. This alone closes D2.
2. **Give the attestation a claimant.** Today it is first-come: any session
   starting within 120 s takes it, across worktrees, and the intended session is
   silently contained. Have `agent.cmd` generate a nonce (or record its PID) and
   require the binding to match it.
3. **Protect the binding, and give it an expiry.** The binding file is outside
   the repository, unprotected, and never expiry-checked — `bound_at` of
   `2020-01-01` still resolves today.
4. **Move `bin/agentbridge-claude-guard.mjs` and `scripts/claude-stop-gate.mjs`
   into `GATE_SELF_CONFIG`.** Right now that list protects `.claude/settings.json`
   but not the binary settings.json *invokes*, so the boundary is one write deep.
5. **Either give `holdsTaskLease` a real producer or delete the branch.**
   `AGENTBRIDGE_TASK_LEASE` is read in `src/sessionEvidence.mjs` and written
   nowhere. Until a producer exists, `agent code-a` → claim a task → still
   MANUAL_TRUSTED with both rails off. Do not leave a check reading a column
   nothing writes.
6. **Test the wiring, not the table.** Deleting the baseline-test profile check
   survives the entire suite. Every capability needs an assertion through
   `evaluateClaudeTool`, not through `permits`.

**Do not "fix" this by reverting to the wildcard grant.** The grant is the
problem the split exists to solve; it was renewed by hand with
`reason: "full access for code-a, code-b and fixer, directed by Danny repeatedly"`.

---

## 2. Migration state

- **Fresh package built and verified:** `~/agent007-migration-20260921`.
  7 files, 6 authority, 1.45 MB.
- **An older package at `~/agent007-migration-package` is STALE** — built 14:12
  by the first version of the tool, before ten bug fixes. Do not use it.
- `scripts/migration-verify.mjs --package <dir>` is the arrival check. **File
  presence is not resolution** — run it on the destination.

**Will NOT travel, by design. Move by hand or re-create:**

| thing | why |
|---|---|
| `~/Documents/agentbridge-secrets/` | credentials; never in an archive beside state. Holds `registration-token.txt`, which `register-session` needs. |
| `~/.agentbridge/config.json` | DPAPI-sealed at `dpapi-user` — **user AND machine scoped**. It cannot unseal elsewhere; expect re-init, not corruption. Also carries `machineId`, and two machines claiming one id is worse than none. |
| the override grant | keyed by `sha256(canonical git-common-dir)`, so a new clone path is a different key. The owner re-issues it: `node bin/agentbridge.mjs grant --paths … --hours … --granted-by … --reason …` |
| agent memory | `~/.claude/projects/<project>/memory/` — in no package and no repo. |

**A resolved landmine, recorded so it is not re-created:** the package initially
failed its own arrival check because two finding stores competed for one
destination key — `findings/e09139d77b22755b.jsonl` (correct) and
`findings/e09139d77b22755.jsonl` (15 characters, written under a **truncated key
by the very defect the finding inside it describes**). The stray held exactly one
row, `F-ab4d3a870d0f`, HIGH/MEASURED/OPEN, *"a guarded session cannot revert its
own change to a protected control"*, existing nowhere else. It was merged
verbatim into the canonical store with a provenance note in its `history`, and
the registry's own reader now reports 2 findings. If you see a 15-character store
key again, something is computing `.slice(0, 15)`.

---

## 3. Loose files on that disk, in no repository

| path | verdict |
|---|---|
| `~/Documents/guard-probes/` | **KEEP** — `caseProbe.test.mjs`, `threeProbe.test.mjs`, probes characterising a guard bypass logged as still open. Deliberately outside every worktree (a red test in `test/` would be a rule-16 countdown and would contaminate other sessions' suite counts). They exist only on that disk. |
| `~/Documents/code-a-uncommitted-20260916-231329.patch` | **CHECK** — 3 KB of somebody's uncommitted work. |
| `~/Documents/agent007-transcripts-full.jsonl` | 658 MB of history, plus its manifest and `Agent007-History/`. Owner's call. |
| `~/Documents/agentbridge-backup/*.bundle` | superseded by GitHub. |
| `~/Documents/agentbridge-work/` | empty. Junk. |
| `~/Documents/agentbridge-b` … `-b12`, `-audit` | ~16 clones, mtimes 09-14 to 09-16. **Not inspected** — see below. |

**Unfinished:** whether those ~16 clones and the three `social-sparks` worktrees
hold uncommitted or unpushed work was never established. A guarded session cannot
find out: the rail refuses `cd`, `git -C` and `git worktree list`. It needs the
operator's terminal, or the MANUAL_TRUSTED profile in §1 — which is the concrete
argument for finishing that work.

The bridge reported `code-a` holding 14 commits not on the remote on branch
`d-claims-authz-b6`, head `07ec32fc`. That sha is **not an object in Agent007** —
the registered worktrees are all `social-sparks`, a different repository. Treat
it as social-sparks work at risk, not Agent007 work.

Also: `.git/worktrees` registers 50 worktrees while 31 exist on disk — 19 dead
registrations. Harmless, prunable, irrelevant to the migration.

---

## 4. Open for the owner

1. **The audit backlog.** 16 pushed control commits have no audit and block every
   Stop. They are NOT junk — verified: all are ancestors of HEAD, real sequential
   work, and they **include the migration tooling built for this very move**.
   Nobody live can audit them, and per `src/trustGenesis.mjs` pre-genesis commits
   cannot become `enforced` by auditing them harder. The real clear is an
   owner-authorised trust genesis naming one exact tree sha. The interim is an
   owner waiver labelled `OWNER WAIVER (Danny) -- NOT AN AUDIT`, `owner_waiver: true`
   — **never** an audit stamp. Before waiving anything, check no real audit
   already exists for it: a newer waiver outranks an older genuine audit and has
   already once buried one carrying a HIGH finding.
2. **The true backlog size is ~137 commits** since the master merge-base (204 over
   full history). The "20" in earlier briefs was an artifact of a `HEAD~50`
   default window.

---

## 5. Two harness facts worth carrying

Neither is Agent007's guard, and both cost time before being identified. Ours
prefix refusals with `[agentbridge:`; these do not.

- The Claude Code auto-mode classifier refuses running tests while guard source
  is modified (`[Self-Modification]`), which **blocks mutation-testing the guard
  from inside a session**. That verification has to happen in an auditor's own
  clone. It also refuses some reads of the audit ledger as
  `[Logging/Audit Tampering]` — but it did *not* refuse
  `node scripts/check-audit-coverage.mjs` this time, so re-test a refusal rather
  than trusting a note about it.
- Importing a name a module does not export **bricks the whole session**: the
  hook fails closed, every tool call is denied, including the edit that would fix
  it. Add the export first, verify it exists, then import. Recovery needs the
  operator to run `git checkout HEAD -- <file>` from a terminal.
