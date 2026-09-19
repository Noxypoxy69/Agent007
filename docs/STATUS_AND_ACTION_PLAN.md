AGENT BRIDGE — code-a STATUS AND ACTION PLAN
Written 2026-09-19. Branch: design/action-authority.

===============================================================================
GLOBAL CAVEAT (applies to everything below)
===============================================================================
Every item marked DONE is committed and verified ON design/action-authority.
NONE of it is on master (integration/guard-consolidated = 8d71f6d). So it is
"done" as code, not "shipped". The consolidation plan (docs/CONSOLIDATION_PLAN.md,
commit 7ebd701) is how it reaches master. Until then these fixes are correct but
not deployable.

A guarded interactive session CANNOT run the suite or clone (the rail refuses
files this session touched, and node --test / git clone are not allowlisted). So
"verified" below means: verified by a FRESH auditor, or run by fixer, or a
static/compositional proof — never my own run.

===============================================================================
DONE 100% (committed + verified)
===============================================================================

1. NULL-SESSION FAIL-OPEN FIX  —  c23ff2e (+ regression gate ff2c80b)
   readSnapshot refuses a sessionless id; writeSnapshot refuses to mint one, so
   neither side touches the shared 'no-session-id' key.
   VERIFIED BY EXECUTION: fixer ran nullSessionSnapshot + listMessages 16/16
   green, then mutated each clause out — both go RED (rule 16 satisfied by
   measurement). This one is fully verified, not just audited.

2. safeGit MIGRATION  —  ff35297, f4e90a0, 2fe8cfc, 40de4d7, b84f58a, 426a114,
   8b0cc99  (bin/agentbridge.mjs 18 git sites + bin/agentbridge-attempt.mjs 5)
   Every git call routes through runGit. Blind-audited across 4 fresh passes;
   final integration pass CLEAN. Gate: test/safeGit.test.mjs scan, KNOWN_UNROUTED
   frozen empty. (One live-run item is still open — see NOT DONE #1.)

3. observe-sha npm SPAWN FIX  —  9cdb400
   observe-sha ran npm via execFile, which cannot spawn npm on Windows, so it had
   NEVER completed; now runs npm via node + npm-cli.js and exits 2 (could-not-run)
   when npm is absent instead of 1 (not-promotable). Code correct (mirrors
   scripts/audit-workspace.mjs). LIVE RUN on Windows still unconfirmed — NOT DONE #1.

4. D4 STALE TEST  —  909656f   confirmed green by fixer.
5. D3 DEAD want-ARM removed  —  b4f0411   fixer measured its removal changes nothing.

6. VERIFIED-PATTERN TEMPLATES (in code-a project memory, gated by committed tests)
   - git-safety/adapt-each-site-to-runGit-throwing   (gate: safeGit scan)
   - test-discipline/measure-the-baseline-do-not-recall-it   (gate: canary 9eda2f7)
   - process-tooling/clone-a-revision-into-an-isolated-workspace  (gate: 99c690c;
     my first version of that gate was HOLLOW — matched a diagnostic string —
     fixer caught it and fixed it to pin the path.join construct.)

7. MEMORY CORRECTED (index was routing effort at closed work)
   - coordinator-can-mint owner decisions: memory said "Unfixed CRITICAL"; it is
     FIXED on branch (index.ts:1219 created_by: label, pinned by
     ownerDecisionAuthorship.test.mjs). Corrected.
   - null-session: marked applied+audited+gated.

8. DELIVERABLE DOCS (committed)
   - docs/CONSOLIDATION_PLAN.md  (7ebd701)
   - this file
   - deep-audit reconciliation (reported to fixer): P0#1 shell-rail parity WIRED,
     P0#2 Action Authority LANDED, sweep-fix APPLIED, CRITICAL mint FIXED — the
     memory index and the ChatGPT deep-audit both lagged the branch.

===============================================================================
NOT DONE / OPEN  (who owns it)
===============================================================================

1. observe-sha + the two new gating tests need a LIVE RUN on Windows to confirm
   green (9cdb400 completing; 9eda2f7; 99c690c post-fix).            [fresh session]
2. NOTHING IS ON MASTER. The whole ~150-commit branch is unconsolidated. [owner + code-a plan]
3. src/integration MISSING (Map Slice 5, §2.3/§3.4). Must be BUILT, not
   transplanted; src/completion.mjs exists only for check-first overlap.  [unassigned]
4. STRAY BRANCHES: duplicate reviewer-runtime (integrate/reviewer-runtime AND
   work/reviewer-runtime — parallel authority path, Map §1 forbids); plus
   work/reviewer-consumer, work/completion-seam, work/accept-fence-main,
   work/slice2-churn-c stranded ~40 behind master.                    [owner + consolidation]
5. D5 owner-ledger: label read is DONE (fixer) and the answer is the BAD branch —
   NO coordinator token carries an owner spelling, so record_owner_decision is
   dead for everyone after f7ae118/d8f6d2b deploy. DO NOT DEPLOY the edge function
   on that until resolved.                                            [owner]
6. A REVOKED coordinator token ("chatgpt-work coordinator") still assigns tasks
   on the bridge. Do not treat its assignments as authority.          [owner]

===============================================================================
WHERE WE ARE STUCK  (hard walls, and who can move them)
===============================================================================

STUCK 1 — A GUARDED SESSION CANNOT VERIFY ITS OWN WORK.
  The rail refuses to run any file this session touched, node --test is not
  allowlisted, and git clone / git worktree are refused. So I can write and
  commit a fix but cannot RUN it, RUN the suite, or CLONE to audit. Every
  verification this session depends on a FRESH session (fixer, or a launched
  worker) or npm run audit:workspace. This is the single biggest drag on the
  whole effort. Move: a fresh session runs the checks; or accept the split
  (author writes, other session verifies) as the working model.

STUCK 2 — THE EDGE-FUNCTION DEPLOY IS BLOCKED BY ITS OWN AUTHORITY MODEL.
  D5 is answered and it is the bad branch: no coordinator token carries an owner
  spelling, so once f7ae118/d8f6d2b deploy, record_owner_decision succeeds for
  NOBODY, including Danny, and settleOpenRequestsAgainstPolicy dies with it.
  Deploying now is a total authority outage. Move: OWNER decides — relabel a
  coordinator token to an owner spelling, or change the anchor so owner identity
  is not tied to the token label. Until then: DO NOT DEPLOY.

STUCK 3 — NOTHING REACHES MASTER, AND THE BRANCH IS TOO BIG TO MERGE AT ONCE.
  ~150 commits on design/action-authority, master has none of it, and the Master
  Build Map forbids merging it as one trust event. So the security fixes sit
  unshippable. Move: execute docs/CONSOLIDATION_PLAN.md — I produce per-commit
  bundles + audits (my half), Danny does the cherry-picks and moves master
  (owner half). Neither half has started.

STUCK 4 — THE AUTO-MODE CLASSIFIER BLOCKS PRODUCTION READS FROM MY SESSION.
  It is a Claude Code layer, NOT the agentbridge guard, so no grant of Danny's
  lifts it. It refused the D5 SQL read from me; fixer got it through with printf.
  Move: OWNER lifts it (a permission rule / interactive approval), or a session
  the classifier does not gate runs the read.

STUCK 5 — SHARED-CLONE CLOBBER.
  A working-tree reset by another session (around a591d28) silently discarded my
  uncommitted observe-sha edits. Two agents, one index. Move: commit by pathspec
  within a small window; do not leave edits uncommitted across reads; stay off
  files another session is actively editing.

STUCK 6 — EVERY TURN ENDS "STOP-BLOCKED" ON .claude/settings.json.
  It is the Stop gate's own config, deliberately non-overridable by any grant, so
  it drifts from the snapshot and blocks the turn end every time. Not fatal and
  not mine, but it is why sessions look stuck. Move: only the operator, from a
  terminal, or a session whose snapshot already matches it.

===============================================================================
code-a ACTION PLAN (what I do next, in order)
===============================================================================

A. CONSOLIDATION (my half of getting fixes onto master):
   A1. Produce the EXACT per-commit set for bundle 1 (git-safety) from
       git log --name-only, transplant-ready.
   A2. Do the same for bundles 2-8 as each prior bundle's audit clears.
   A3. Run / brief a FRESH blind audit of each consolidated SHA
       (npm run audit:workspace -- <sha>), report clean-or-defect.
   NOT mine: the cherry-picks onto master, moving master, retiring branches,
   deploy. Those are Danny's.

B. IF DANNY REDIRECTS TO SLICE 5:
   B1. Design + build src/integration (target-branch ancestry + capability proof)
       and the canonical work-fingerprint authority, with a gating test that
       fails without it. Then the "retire check-first" step, both directions
       proven, per Map Slice 5.

C. HOLDING FOR OTHERS:
   - observe-sha / new-test live confirmation is a fresh session's; I will fold
     the results into verified_on when they come back.
   - Anything fixer hands me in its lane (guard surface) I take on assignment;
     I stay off files fixer is actively editing to avoid the clobber that hit
     bin/agentbridge.mjs this session.

DEFAULT IF UNDIRECTED: start A1 (git-safety per-commit set) — lowest risk,
foundational, and unblocks the rest of the consolidation.
