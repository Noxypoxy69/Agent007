# Working notes — the copy-paste notepad

**What this is.** The commands you run twenty times a day, written out so you
paste instead of remembering. Every block below was run on this machine and
works; nothing here is illustrative.

**What it is not.** It is not state. No counts, no who-is-online, no deployed
version — those rot, and twelve documents in this repository already rotted that
way. Anything that changes lives behind a command, and the command is here.

**Paths assume this machine.** The repository is
`C:\Users\DANNY GARCIA\Documents\agentbridge\agentbridge` and the shorthand
`$AB` below means exactly that. PowerShell, not bash.

```powershell
$AB = "C:\Users\DANNY GARCIA\Documents\agentbridge\agentbridge"
$BR = "node `"$AB\bin\agentbridge.mjs`""
```

---

## 0. Every session, first thing, before anything else

**One-shot registration is not liveness.** Registering without `--watch`
succeeds and then the heartbeat never moves again — the roster called `main`
stale after 991 seconds with the process sitting right there. The watcher is a
child of your own shell, it dies with your session, and nothing restarts it.

```powershell
$env:AGENTBRIDGE_REGISTRATION_TOKEN = (Get-Content "C:\Users\DANNY GARCIA\Documents\agentbridge-secrets\registration-token.txt" -Raw).Trim()
node "$AB\bin\agentbridge.mjs" register-session --agent <you> --session <your-session> --lane <lane> --capacity idle --watch --interval 60
```

Load the token FROM THE FILE. Do not paste the value into a transcript — it is a
scoped registration token, not a database key.

Leave that running. Start a second shell for work.

---

## 1. Before you write a single line

```powershell
node "$AB\bin\agentbridge.mjs" check-first "<the thing you are about to build>" --hours 24
```

It asks the SERVER for branches and reads recent commits. **A failed lookup
reports unknown, never "nothing found"** — that inversion is the one that would
get believed.

Two duplications happened in one night without it: a CI fix rebuilt 65 minutes
after it landed on master, and a roster fix rebuilt 9 minutes behind another
agent. Both were visible to anyone who looked.

Then read your own contract rather than trusting a chat message for the detail:

```powershell
node "$AB\bin\agentbridge.mjs" delegations --for <your-session>
```

---

## 2. The loop Danny asked for: audit, merge, push, audit again

### 2a. Audit your own work against the contract, before you commit

```powershell
node "$AB\bin\agentbridge.mjs" audit-delegation --id <contract-id> --repo $AB
```

Exit 1 means you went outside the allowed paths. Fix it or renegotiate the
contract — do not widen it silently.

When it is clean, persist the verdict, because `may-integrate` reads the
RECORDED verdict and not a green run you remember:

```powershell
node "$AB\bin\agentbridge.mjs" audit-delegation --id <contract-id> --repo $AB --record
```

### 2b. Commit by exact pathspec, never by the index

The index is SHARED between sessions on this machine. One session staged three
files, spent a minute writing a message, and another session's ordinary
`git commit` took them — twice in four minutes, once to the person writing the
rule down. There is no window small enough.

```powershell
git -C $AB status --porcelain                          # what is yours, what is not
git -C $AB add -N path/to/new-file.mjs                 # NEW files need intent-to-add first
git -C $AB commit path/a.mjs path/b.mjs -m "..."       # ONLY these paths, whatever else is staged
```

**A file modified and not yours belongs to somebody who has not committed yet.**
Pick a different file or wait.

### 2c. Prove the suite before you push

```powershell
Push-Location $AB; npm test; Pop-Location
```

On node 24 the summary lines start with `ℹ`, not `#`. Grepping for `# fail` finds
nothing and reads exactly like a pass — it cost me twenty minutes tonight.

```powershell
Push-Location $AB
$o = npm test 2>&1 | Out-String
($o -split "`n") | Where-Object { $_ -match '^(ℹ|#) (tests|pass|fail|skipped)' }
($o -split "`n") | Where-Object { $_ -match '^(✖|not ok)' }
Pop-Location
```

### 2d. Return the work, then audit again

```powershell
node "$AB\bin\agentbridge.mjs" delegation-state --id <contract-id> --to returned --head <sha>
node "$AB\bin\agentbridge.mjs" audit-delegation --id <contract-id> --head <sha> --repo $AB --record
node "$AB\bin\agentbridge.mjs" may-integrate --id <contract-id>
```

`may-integrate` exits 1 unless the contract is **accepted AND its recorded audit
held — both, not either.** That is the second audit Danny means: the first is
against what you intended, the second is against what you actually delivered at
a named SHA.

Returning a task the Bridge assigned is a different verb, and only the session it
was assigned to may return it:

```powershell
node "$AB\bin\agentbridge.mjs" return-task --task <task_id> --session <your-session> --lease <lease_token> --notes "..."
```

---

## 3. USE THE CODE THAT EXISTS. It is the default, not the fallback.

The primary failure in this repository is **reachability and authority wiring,
not absence**. Most of what a slice needs is already written and merged, sitting
behind a caller that was never added. Building a second one is the failure mode
this whole programme exists to stop.

`docs/AGENTBRIDGE_MASTER_BUILD_MAP.md` section 2 is the full keep / connect /
consolidate inventory. Read it before writing a new module. The short version:

| You are about to write | It already exists | Do this instead |
|---|---|---|
| an attempt row writer | `src/attemptRecord.mjs` | connect it to a fenced database writer |
| an attempt lifecycle | `src/attemptPipeline.mjs` (`runAttempt`) | put it inside the production worker |
| a command veto | `src/preExecutionGuard.mjs` | make it the shared mandatory dispatch |
| launch permissions | `src/agentPermissions.mjs` | bind to an immutable role-profile snapshot |
| a secret/path scrubber | `src/payloadGuard.mjs`, `src/redact.mjs` | apply to prompts, tool output and patches |
| lease decisions | `src/leases.mjs` | keep aligned with the SQL claim/renew/return |
| readiness / dependencies | `src/schedule.mjs` | ONE shared predicate for list and claim |
| an independent reviewer | `src/reviewRunner.mjs`, `reviewDecision.mjs`, `reviewerPacket.mjs` | put a consumer in front of it |
| workspace create/destroy | `src/workspaceManager.mjs` | add a certified container mode |
| content-addressed storage | `src/cas.mjs` | use it for logs and artifacts |
| token accounting | `src/tokenTelemetry.mjs`, `tokenBudget.mjs` | wire to a hard budget governor |
| loop detection | `src/loopDetector.mjs` | extend to state-aware fingerprints |
| bounded context | `src/contextCompiler.mjs` | expand to the repair envelope |
| an executor contract | `src/executorAdapter.mjs` | expand to the lifecycle adapter |

**The donor research is also already done.** `docs/RELIABILITY_INGEST.md`
(Temporal, DBOS, Restate, NATS, pg-boss, Hatchet, Trigger.dev, LangGraph) and
`docs/SELF_CORRECTION_INGEST.md` (SWE-agent, SWE-ReX, OpenHands, Agentless,
Self-Refine, Symphony). §17 of the first is the attempt schema field by field;
§18 is the reviewer runtime. An outside review re-derived seven of seven of
these sources overnight and it cost a whole pass.

`THIRD_PARTY_CODE.md` records what may be copied and what may not. **MCP Agent
Mail is excluded** — its licence prohibits use and analysis by Anthropic and
OpenAI models, and every agent here is one. Do not clone it to "just look".

---

## 4. The two-agents-one-clone rules, which have actually bitten

```powershell
git -C <repo> status --porcelain | ForEach-Object { $_.Substring(3) }   # who holds what
```

If a check reports zero files held while `git status` plainly shows a dozen,
**the check is wrong** — verify the negative before trusting it.

When a shared file genuinely needs your hunk and somebody else has it dirty,
build your version from HEAD and stage the blob directly rather than `git add`:
their working copy stays untouched and your commit carries only your change. The
recipe is in `CLAUDE.md` under "Two agents, one clone".

**Leave a note rather than fixing their code silently.** The pattern matters more
to them than the patch.

---

## 5. What a finished slice owes

1. Both directions proven. A gate that only refuses is an outage; one that only
   permits is decoration.
2. The mutation watched. Break the thing the gate guards, confirm it goes RED,
   restore, confirm green. Three gates in this repository passed while proving
   nothing, and two written for this programme's own tooling were hollow on
   first draft and caught only by running the mutation.
3. The mutation is the REAL regression, not a thrown error. Catching
   `throw new Error("x")` proves nothing about the bug it was written for.
4. Evidence read off THIS run, not the last one. Three separate wrong numbers
   tonight came from the wrong instrument: a tar listing that counts directory
   entries, `Measure-Object -Line` against `wc -l`, and the node 24 `ℹ` prefix.
5. Nothing deploys. No unattended production workers until the execution seam
   closes. That is standing and it is not yours or mine to relax.
