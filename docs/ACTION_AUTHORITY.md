# Action authority: the layer that is missing for actions that touch no file

**Status:** proposal. Nothing is wired. `src/actionAuthority.mjs` classifies and
blocks nothing; `test/actionAuthority.test.mjs` carries one deliberately-failing
test that names the remaining half.

**Base:** written against `61bbeb2`. Intended for `design/action-authority` off
`1489931` (`integration/guard-consolidated`), which the authoring session could
not create — that object is not in its clone and `git fetch`, `git branch` and
`git checkout` are all refused by the shell rail. Graft accordingly.

---

## The gap

The guard's posture for everything it does not block at PreToolUse is stated in
`src/claudeGuard.mjs` and repeated in `src/shellAllowlist.mjs`:

> not blocked here, detected at Stop by protected-file drift

For an MCP write that lands on a repository file, that is **true** and the claim
is sound. The Stop gate hashes protected files against a pre-session snapshot, a
commit cannot hide a content change from a content hash, and a write that never
passed through PreToolUse is still caught afterwards.

**The gap is that most consequential actions never touch a repository file.**

Measured at `61bbeb2`, all `ALLOW` at PreToolUse (see `test/guardToolRoster.test.mjs`,
73 rows, both controls firing):

| tool | what it does | observable at Stop |
|---|---|---|
| `mcp__claude_ai_Supabase__apply_migration` | production SQL | no |
| `mcp__claude_ai_Supabase__deploy_edge_function` | production deploy | no |
| `mcp__claude_ai_Gmail__send_message` | irreversible outbound | no |
| `mcp__claude-in-chrome__javascript_tool` | executes JS | no |
| `mcp__claude-in-chrome__computer` | drives the desktop | no |
| `CronCreate` | schedules a future agent run | no |
| `EnterWorktree` / `ExitWorktree` | changes the working tree | no |

Stop compares file **content**. For these there is nothing to compare. So for
this class the documented fallback is **not a weaker layer — it is no layer.**

This compounds a finding already on the table: three separate layers delegate
downward to the Stop gate, each delegation individually well-reasoned. This is a
fourth, and it delegates to a gate that structurally cannot observe the action.

---

## What this is not

**Not an argument for default-deny.** That was tried. `520cee2` default-denied
every tool name it did not recognise and refused **24 of a real 54-tool roster** —
an outage. `a1d7f6c` removed it, correctly, because an outage gets the hook
switched off and switching it off loses every layer at once. CLAUDE.md rule 19:
allowing by known name leaks, denying by unknown name is an outage.

**Not a second authority model.** CLAUDE.md already says production deploys,
destructive actions, spending and anything a customer receives are Danny's, and
that no coordinator may approve them on his behalf. `src/permissionRequest.mjs`
routes it; `canDecidePermission` enforces the refusal. This proposal classifies
actions so that existing machinery can be pointed at them. It does not invent a
new notion of who may approve what.

---

## The proposal

**Scope the default-deny to a namespace instead of applying it globally.**

Within a server that can reach production, money, a person's inbox or the host,
an **unrecognised** operation is OWNER authority. Outside those servers nothing
changes — ordinary local work is untouched, which is what keeps this from
becoming the 24-of-54 outage again.

```
consequential namespace + named read operation   -> unrestricted
consequential namespace + anything else          -> gated by that namespace's consequence
outside every consequential namespace            -> unrestricted (unless explicitly named)
malformed / unnameable call                      -> owner, fail closed
```

This is CLAUDE.md rule 7 applied to authority: **generate the coverage from the
namespace rather than from the operations somebody happened to think of.** A
Supabase tool that ships next month is owner-gated the day it appears, with
nobody having to remember to add it. That property is asserted directly —
`AN UNRECOGNISED OPERATION IN A CONSEQUENTIAL NAMESPACE IS OWNER-GATED` feeds it
tool names that do not exist.

### Consequence vocabulary

| consequence | authority | why |
|---|---|---|
| `production-state` | owner | CLAUDE.md: production deploys are his |
| `spends-money` | owner | CLAUDE.md: spending is his |
| `irreversible-outbound` | owner | CLAUDE.md: anything a customer receives is his |
| `host-control` | coordinator | drives the machine, but reversible and observable |
| `future-execution` | coordinator | schedules work; the work itself is judged when it runs |
| `reversible-external` | coordinator | external but undoable |
| `none` | unrestricted | ordinary local work |

### The asymmetry that governs edits

`READ_OPERATIONS` may only grow by someone **establishing** that an operation
reads. A wrong entry there is silent and reopens the hole; a missing entry is
loud and costs one line. Same asymmetry the guard's own `READ_ONLY_TOOLS`
comment already names, and additions should be weighed on it.

---

## What is deliberately not done

**The wiring.** `src/claudeGuard.mjs` does not import this module, and
`test/actionAuthority.test.mjs` has one test that fails **because** of that. It
is expected to be red and it names what is missing.

Why it is red rather than fixed: routing a real refusal through the guard needs
its own end-to-end proof that the hook path reaches it (rule 17 — the guard's own
unit tests were green throughout the period when nothing was calling it), and a
classifier that has never refused anything in anger should not be connected to a
live control the same afternoon it was written.

**That red test was built to rule 16**, which forbids handing anyone a
deliberately-failing gate without proving the demand is reachable and proving it
stands down if its premise is removed. Both proofs sit beside it and run green:

- `REACHABILITY: the demand below can go green` runs the same matcher against
  source that genuinely imports the classifier.
- `REACHABILITY: and the matcher is not trivially true` proves a comment or a
  quoted string does **not** satisfy it (rule 13).
- `STAND-DOWN: if the classifier is deleted, the demand is moot` retires the
  demand rather than leaving it red forever if the approach is abandoned.

The first of those **caught a real defect in this very test while it was being
written**: the matcher originally blanked string literals before looking for the
import, and a module specifier *is* a string literal — so no wired file could
ever have matched. The demand was unsatisfiable. Rule 16 is the only reason that
was found before handover rather than by whoever tried to clear it.

### To clear the red test

Import `classifyAction` in `src/claudeGuard.mjs` and route on its verdict. Do not
silence it with a comment mentioning the module — the matcher is comment-blanked
and anchored to statement position, and will not accept that.

---

## Open questions, for the owner rather than for me

1. **`host-control` at coordinator is arguable.** `javascript_tool` and
   `computer` drive the operator's actual desktop. If the browser is logged into
   anything that can spend or deploy, host-control is production-state wearing a
   different name. Raising it to owner is a one-line change to `AUTHORITY_FOR`.

2. **`future-execution` judges the scheduling, not the scheduled work.**
   `CronCreate` is gated; what the cron job then does is judged when it runs —
   *if* that run passes through a guard at all. Unverified, and worth verifying.

3. **This adds a fifth orphan module.** Nothing shipped imports it by design, so
   `test/noOrphanModules.test.mjs` will report `src/actionAuthority.mjs` as
   test-only. It clears itself the moment the wiring lands, which is the correct
   way for it to clear — no `KNOWN` entry should be added for it.

4. **Nothing here is enforced.** Until the wiring lands this document and its
   classifier describe a control that does not exist. That is stated plainly so
   that no one reads the presence of the file as coverage — which is the failure
   mode this entire repository is organised around.
