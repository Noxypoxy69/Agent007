# design/action-authority → master consolidation plan

**Status:** DRAFT by code-a, 2026-09-19. This is a plan, not an authorization.
Merges to master are Danny's; this document only defines the bundles, the order
and the per-bundle audit gate. The exact per-commit assignment below is a first
pass from commit subjects — before transplanting a bundle, confirm its commit set
with `git log --name-only <base>..design/action-authority` filtered to the
subsystem's files.

## Why this exists

`design/action-authority` is ~150 commits ahead of master
(`integration/guard-consolidated` = `8d71f6d`) and has become an alternate
integration trunk carrying every recent fix — including security-critical ones
that are therefore NOT on the deployable trunk:

- the owner-decision authorship closure (`created_by: label`) — `555ae82`, `f7ae118`
- Action Authority wiring (`classifyAction` in the live guard) — `6b2f135`
- the null-session fail-open fix — `c23ff2e`
- the safeGit migration (every git call hardened) — `560ba4d`..`9cdb400`

Master cannot absorb 150 commits as one trust event (Master Build Map §13,
Slice 11). So: **a fresh branch from master, one subsystem bundle at a time, each
consolidated SHA blind-audited before the next.**

## The process, per bundle (repeat for each)

1. `git switch -c consolidate/<bundle> <master-or-prior-bundle-tip>`
2. Transplant the bundle's commits **in ancestry order** (cherry-pick, or a
   squashed transplant if the intra-bundle history is noise — but keep the
   RED-on-purpose → fix pairs legible; do not squash away why a test exists).
3. Resolve conflicts against master's own guard-consolidation content.
4. **Blind-audit the exact consolidated SHA** with a fresh auditor told nothing
   of prior findings (Master Build Map §14; CLAUDE.md rules 20/21). Run the full
   suite from a clean clone via `npm run audit:workspace -- <sha>`.
5. Only on a clean audit does the bundle tip become the base for the next bundle.
6. Danny moves master only after the final bundle audits clean.

## Bundle order (dependency- and risk-ordered)

Earlier bundles are foundational and lower-risk; the guard/authority layer goes
before the surfaces that depend on it; memory goes last (Map §12: after the
runtime path is stable).

### 0. Pre-step — the 2 master-only commits
Master is 2 commits ahead of the branch's base. Rebase/replay those first so the
consolidation branch starts from true current master, or the first audit measures
against a stale base. `git log design/action-authority..8d71f6d` lists them.

### 1. git-safety  (foundational; the rest import safeGit)
safeGit + every hardened git invocation + the migration and its audit fixes.
Representative: `560ba4d`, `2fe8cfc`, `ff35297`, `f4e90a0`, `40de4d7`, `b84f58a`,
`426a114`, `8b0cc99`, `9cdb400`, `e3aa17e`, `a8ca156`, `77cd090`, plus the tests
`9eda2f7` and `99c690c`. Gate: `test/safeGit.test.mjs` scan, `KNOWN_UNROUTED` empty.

### 2. guard-controls  (the trust boundary — Map Slice 8)
claudeGuard, guardSession, shellAllowlist, the Stop gate, the hook binary,
snapshots/drift, the override/grant channel, the node/npm rail, alias/8.3/case,
worktree carve-out, rule-20 wiring. Large. Representative clusters:
- grants/override: `39c12b8`, `de4c1ab`, `95725a3`, `2b37554`, `99e6b18`,
  `1e5afa3`, `ecd2270`, `21d1e6e`, `791f1ce`, `1093c98`, `3edb65b`, `a3e84bf`
- stop-gate / snapshot / null-session: `3f49151`, `6a0cf5d`, `13995cb`, `094de84`,
  `819010a`, `af17d19`, `dcc9a98`, `c23ff2e`, `ff2c80b`, `b4f0411`
- node/npm rail: `2812d8a`, `2829c0a`, `57c50f8`, `a75fb5d`, `effc379`, `82411cf`,
  `a76cb6e`, `519eff1`, `a02f408`, `29c0957`, `c171a27`, `f2a0938`, `29a7aee`
- worktree carve-out: `9703912`, `436b927`, `4ec5c89`, `a80609f`, `efb7990`,
  `64b5283`, `599bdf4`, `6d479f4`, `4cddfa0`
- alias/8.3/case: `e4b1760`, `7fbbb11`, `afd47a8`, `ea0df13`, `46d69a3`, `aad3da1`
- rule-20 / self-cert: `c93aa10`, `0427b0d`, `6dc5750`, `3e1373b`
Gate: `test/claudeGuard.test.mjs`, `test/guardResetBypass.test.mjs`,
`test/nullSessionSnapshot.test.mjs`, `test/safeGit.test.mjs` guard portions.

### 3. action-authority  (depends on guard-controls)
`6b2f135` (wire classifyAction + protect guard-imported files), `6f5e6c1`
(authority paragraph derived from the tool list). HOST_CONTROL→OWNER landed in
`6b2f135`; owner decision `d-owner-action-authority-gating-20260918` records it.
Gate: `test/actionAuthority.test.mjs` (green once wired).

### 4. owner-decisions / authorship  (grants-permissions; the CRITICAL fix)
The authorship anchor and its audit fixes. `555ae82`, `f7ae118`, `62b3158`,
`d8f6d2b`, `ed666cd`, `14085d3`, `4c2c046`, `ede70b3`, `793fa0b`, `b53581b`.
**Handle the RED-on-purpose pairs:** `54071ff`(RED)→`d8f6d2b`(fix) and
`065ee23`(RED)→`62b3158`(fix) — transplant each pair together so the tree is
never left red. Gate: `test/ownerDecisionAuthorship.test.mjs`,
`test/ownerIdentityAnchored.test.mjs`.

### 5. bridge-messaging / roster / liveness  (Map Slice 4 surface)
listMessages query + recipient refusal, roster/liveness, cursors, session-poll
hooks, toolDefs parity, envelope/eventsFor. Representative: `d586a76`, `909656f`,
`2c875ad`, `27f4908`, `e780716`, `e30d0b8`, `b0f2cad`, `1d7a291`, `e736efc`,
`40c482d`, `c43079a`, `e59a431`, `1b6b3d2`, `4ffb5a6`, `cc22374`, `ea4fde7`,
`14a2e75`, `b5851bc`, `9852e16`, `d4787d0`, `66065c7`, `ade7ab9`, `c0bedcf`,
`e38687f`, `10fcb31`, `c811ef1`, `3151c87`, `cb21c97`, `647c66c`, `8f45bd4`,
`16b4f3c`, `d81be65`, `b00d96e`, `48e2632`.
**Collapse the revert pairs — do NOT transplant a commit and its revert:**
`6e409ab`↔`45a63c9`, `277b4f8`↔`f3eaa6b`, `1efb89c`↔`a7b52d0`. Take the net
(usually neither), or the later corrected version only.

### 6. task / dispatcher (create_task, validator, assignment)
`380c701`, `dab13ad`, `7d1ad92`, `161d801`, `759badf`, `1309ca2`, `99539dc`,
`a591d28`, `ea62dfb`, `f1c33d6`, `c4440a6`, `bf5d2a0`, `202c5b6`, `0a94bcb`.
Gate: `test/taskRecordSplice.test.mjs` and the create-route tests.

### 7. process-tooling
audit-workspace runner + observe-sha CLI + launcher. `dcc9a98`, `d0e3f88`,
`1ea0e5e`. (observe-sha's git/npm fixes ride in bundle 1.) Gate:
`test/auditWorkspaceUsesNpmCli.test.mjs`.

### 8. token-file / registration / CLAUDE.md hygiene  (low-risk, last)
`d1430a7`, `52ead4f`, `70f9cfc`, `1e5afa3`, plus the reverts `671d5c7`↔`d8eb230`
(register-hosted path — collapse the pair). CLAUDE.md doc updates ride along.

### (deferred) Verified Code Memory — src/memory/*
Map §12: integrate only AFTER the runtime path is stable, and never by weakening
the orphan/dead-export gates. Not in this consolidation.

## Standing hazards to carry into every bundle

- **Reverts:** at least four revert pairs exist (`6e409ab`/`45a63c9`,
  `277b4f8`/`f3eaa6b`, `1efb89c`/`a7b52d0`, `d8eb230`/`671d5c7`). Transplanting
  both members re-introduces then re-removes a defect and pollutes history; take
  the net.
- **RED-on-purpose commits** (`54071ff`, `065ee23`) must never be a bundle tip —
  pair them with their fix.
- **Duplicate authority path:** `integrate/reviewer-runtime` (`b5a7d69`) AND
  `work/reviewer-runtime` (`c7ec92d`) are two reviewer-runtime implementations
  (Map §1 forbids parallel authority paths). Pick one, retire the other, before
  reviewer consolidation.
- **Stranded Slice 4b/5 branches** — `work/reviewer-consumer` (`a6b2328`),
  `work/completion-seam` (`5771a56`), `work/accept-fence-main` (`a947c37`),
  `work/slice2-churn-c` (`ff84007`) — are ~40 behind master and are NOT part of
  design/action-authority. They are a separate consolidation, done the same way,
  and `src/integration` (Map §2.3/§3.4) still does not exist and must be built for
  Slice 5, not transplanted.
- **verified_on / can't-run:** a guarded interactive session cannot run the suite
  or clone; every bundle's audit must be a fresh session or `npm run
  audit:workspace`, never the author's assertion.

## What code-a can and cannot do here

Can: draft this plan, produce the exact per-commit set per bundle from
`git log --name-only`, and run/brief the blind audit of each consolidated SHA.
Cannot: cherry-pick onto and move master, retire branches, or deploy — those are
owner actions.
