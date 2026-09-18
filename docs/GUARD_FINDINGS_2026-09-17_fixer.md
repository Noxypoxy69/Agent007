# Two shell-rail findings, audited and largely falsified — fixer, 2026-09-17

**Session** 929bee91 · **Branch** `design/action-authority` · **HEAD at write** `4ec5c89`

**READ THIS FIRST: the patch this document originally proposed is WITHDRAWN. Do not
apply it. It allows ref mutation that the shipped code denies.**

An earlier revision of this file proposed a `git branch` matcher replacement and called
a `node --eval` gap an arbitrary-code hole that "outranks everything else on the rail".
An adversarial audit re-derived both in-process and falsified most of it. This revision
is the corrected record. The original claims are kept, marked, because the errors are
more instructive than the findings.

Both concern `src/shellAllowlist.mjs`, which is in `PROTECTED_PATHS`, so `judgeWrite`
(`src/claudeGuard.mjs:200`) refuses edits unconditionally. Nothing here was applied.

Bridge messages `73f98062` and `1cb43a34` were queued to `code-a` carrying the
**uncorrected** claims; the bridge answered "do not treat this as delivered" (every agent
`capacity: offline`). A correction is queued behind them. If you are reading those
messages, read this file instead.

---

## FINDING 1 — `node --eval` walks past `tokens[1]`. Mechanism real, severity RETRACTED.

### What holds

`src/shellAllowlist.mjs:534-538` tests the eval flag at `tokens[1]` only and falls
through to `allowed: true`. Any option before it defeats the check:

| command | verdict |
|---|---|
| `node -e "x"`, `--eval`, `-p`, `--print` | deny (`NODE_EVAL`) |
| `node --input-type=module --eval "x"` | **ALLOW** |
| `node --no-warnings -e "x"` | **ALLOW** |
| `node --input-type=commonjs --print "x"` | **ALLOW** |

`judgeShellCommand`'s sole consumer is `judgeShell` (`src/claudeGuard.mjs:223`), reached
for any tool carrying `command`/`script`/`cmd` (`:298-299`), with no later filter.
`SHAPES`' `['node', /^--test$/]` at line 109 is dead code — line 534 returns first.

### What was WRONG — asserted from a proxy (CLAUDE.md rule 4)

The original claimed "arbitrary JS in-process writes, renames and deletes any path." The
evidence was a `ReferenceError` from the payload `x` — **a payload containing no call.**
Every payload that would do damage needs parentheses, and `FORBIDDEN_CHARS`
(`shellAllowlist.mjs:61`) rejects ``$ ` < > ( ) { } \``:

```
node --input-type=module --eval "import fs from 'fs'; fs.unlinkSync('src/claudeGuard.mjs')"  -> DENY
node --input-type=module --eval "require('fs').writeFileSync('a','b')"                       -> DENY
```

No direct call is expressible in an allowed payload. Rule 4 committed by the author
citing rule 19. A real route does exist — `--eval "import 'data:text/javascript,<percent-
encoded>'"` is ALLOW, the encoding hiding the parens — but the original never found it,
and a verifier re-running its two runs would have concluded the hole was *narrower* than
it is. **Not executed.**

### Three further corrections

- **It does not outrank the rail.** The same branch's fallthrough allows `node <any
  file>`; `npm run <any script>` is ALLOW. A `Write` to any non-protected path plus one
  `node` call is ACE today, deliberately (`shellAllowlist.mjs:31-38`, `225-230`).
  `--eval` saves one tool call. The original quoted the line-226 comment about repo
  scripts being "visible, reviewable, covered by Stop drift" and missed that the same is
  already false for a script written to the scratchpad.
- **Wrong layer named — rule 18, applied to a PERMIT.** `hookDecision({allowed:true})`
  returns `{}` (`claudeGuard.mjs:361`), an *abstention*. The command ran because the
  harness permission path approved it. "ALLOWED, AND IT RAN" conflated guard silence
  with system permission.
- **PreToolUse is not the boundary.** `shellAllowlist.mjs:21-25` documents it as fast
  feedback; the control is Stop content drift (`claude-stop-gate.mjs:244`, `:255`),
  indifferent to spelling. `--eval` bypasses the rail, not the boundary.

### The proposed fix was also wrong

"Scan every token for an eval flag; require the first non-flag argument to be a path that
exists." All of these are ALLOW today and **still ALLOW under that rule**:

```
node --import=data:text/javascript,<percent-encoded> scripts/<any real file>.mjs
node --require ./x.js scripts/<any real file>.mjs
node --redirect-warnings=src/claudeGuard.mjs scripts/<any real file>.mjs
node --cpu-prof --cpu-prof-dir=src --cpu-prof-name=claudeGuard.mjs scripts/<any real file>.mjs
```

`--import`/`--require`/`--experimental-loader` are not eval flags; the last two write
files with no interpreter flag at all. Enumerating eval flags is the same enumeration
mistake line 534 already makes.

### Neighbours, checked by the audit

`npm` is position-only in the same way but fails **closed** (`npm --prefix /elsewhere
test` → deny); its live gap is `npm run <any script>` → ALLOW. `sed` tests the whole raw
command and is tight. PowerShell args skip `SAFE_ARG` when quoted
(`shellAllowlist.mjs:546-555`, `573-576`) — `Get-Content "anything at all"` → ALLOW.

---

## FINDING 2 — the `git branch` matcher. Diagnosis was HALF the defect.

### What holds

`src/shellAllowlist.mjs:279` tests the raw string via `GIT_BRANCH_LIST.test(command.trim())`
while `tokens` — already quote-stripped by `tokenize()` — sits unused two lines above at
`:423-426`. So `git branch --list "worktree-agent-*"` is refused on the quotes you must
type to stop glob expansion. Only three shapes pass: `git branch`, `git branch --list`,
and `git branch --list <one-unquoted-token>`.

The original said "14 of 17 read-only forms wrongly denied". **That denominator is the
author's own hand-picked list** — a number about the list, not about git. The honest and
stronger statement: *every* `git branch` form other than those three is denied.

### What was MISSED, and it is the more serious direction

**The shipped regex also LEAKS writer flags.** Its optional tail
`(\s+[A-Za-z0-9._/@:=+,^~*-]+)?` admits one token, and `-`, `=`, `/` are all in the
class. ALLOW today:

```
git branch --list --set-upstream-to=origin/main      git branch --list --unset-upstream
git branch --list -D        git branch --list --delete        git branch --list -M
git branch --list --move    git branch --list -C              git branch --list -u
git branch --list --set-upstream    --edit-description    --create-reflog
```

Measured: `git branch --list -D` exits **129 with usage output**, proving this git build
enforces `delete + rename + copy + new_upstream + list + unset_upstream + show_current
> 1`. So git neutralises them — **the rail is saved by the tool, not by the rule.**

The original framing ("too strict, contract disagrees") is therefore one-directional and
wrong: it is too strict **and** too loose. The probe structurally could not see the loose
half, because every generated deny-case appends ` main`, giving two trailing tokens where
the regex admits exactly one.

---

## FINDING 2's PATCH — WITHDRAWN. It allows ref mutation.

The candidate `judgeGitBranch` (token-based, named read-flags, value-consuming flags,
`listing = args.includes('--list')`) was swept against this build's real option table.
~250 writer-bearing strings are allowed; most are saved only because git also eats the
token. **Three families are live:**

**Leak 1 — `--abbrev` consumes a token git does not.** `git branch` takes
`--[no-]abbrev[=<n>]`, an *optional* argument. The candidate eats the next token
unconditionally.

```
git branch --abbrev --unset-upstream     CANDIDATE: ALLOW    (shipped: deny)
```

Git sees `--abbrev` (no value taken), then `--unset-upstream`, `list=0`, exclusion sum
= 1 → **deletes `branch.<current>.remote` / `.merge` from `.git/config`**. No operand, no
usage error. Also `--abbrev --edit-description` (writes `branch.<name>.description`) and
~30 siblings.

**Leak 2 — `listing` is a raw-token test, not a parse.** `args.includes('--list')` counts
`--list` even when the candidate itself just consumed it as another flag's *value*.
`--format` takes a required argument and validates nothing:

```
git branch --format --list newref                CANDIDATE: ALLOW    (shipped: deny)
git branch --format --list newref start-point    CANDIDATE: ALLOW    (shipped: deny)
```

Git sees `format="--list"`, no listing flag, one positional → **`create_branch("newref")`**.
The patch's own comment claimed "A positional argument is only safe once `--list` has made
the invocation a query. That rule is KEPT below." **It is not kept.** This is CLAUDE.md
trap 12 — wrapping, not content — committed *by the patch that cites trap 12*. Sixteen
strings of this shape. **Not executed**; the shipped rail denies them. Confirm in a
throwaway repo before quoting.

**Leak 3 — coverage hole.** `-t`/`--track` (writes branch config) and
`--recurse-submodules` are in neither the candidate's sets nor the probe's writer list.

**Its stated contract was false.** "`-d`, `-D`, `--delete`, `-m`, `-M`, `-c`, `-C`,
`--set-upstream-to` and any flag git grows tomorrow all fail closed" — measured, all of
those plus `-u`, `--unset-upstream`, `--edit-description`, `--create-reflog`, `-t`,
`--track`, `--force` pass when preceded by any value-consuming flag.

**It also over-refuses.** `git branch --merged` gets "missing its value", but `--merged`
defaults to HEAD as the last argument. The probe **encodes that error as a requirement**
(`git branch --merged` sits in `MUST_DENY`), so patch and evidence agree with each other
about a read-only command being a writer. Also refused: `-l`, `-q`, `-av`, `--no-abbrev`,
`--no-list`, `--no-verbose`.

Attacks that did **not** work: `--` end-of-options, `=` forms (`--list=x`), case variation
(`--LIST`), abbreviated options (`--dele`), repeated flags, `--list` + writer adjacent.

### Net

The shipped regex is crude and over-refuses badly, and admits writer flags git happens to
reject — but **it denies every string above**. The candidate is strictly more permissive
and that is exactly where ref mutation lives. Applying it trades a loud false positive for
a silent false negative, the trade `shellAllowlist.mjs:253-254` tells you not to make.

### If someone still wants `git branch -a`

The safe shape is the inverse: refuse if **any** token matches a writer-flag pattern
(`-[dDmMcCtufl]` clusters; the `--delete|--move|--copy|--track|--set-upstream*|
--unset-upstream|--edit-description|--force` family) **before** any value-consumption
runs, and never let a consumed value set `listing`. Whatever lands needs cases in
`test/claudeGuard.test.mjs` generated from a single exported flag table — not a one-shot
script carrying a copy of the rule.

---

## The evidence script — DO NOT TRUST ITS PASS

`scripts/probe-git-branch-matcher.mjs` reproduces as documented (PASS/0; `FAIL(1)` on
`--mutate-positional`; `FAIL(2)` on `--mutate-readflags`). Everything else about it is
weaker than the original claimed:

1. **`candidate()` masks.** It returns the shipped verdict when the shipped judge refused
   for a non-branch reason, so **4 of 38 deny-cases never reach `judgeGitBranch`**:
   `-c main` and `--list -c main` (caught by `GIT_POISON` reading `-c` as `git -c`), and
   `-f main` / `--list -f main` (caught by `WRITE_FLAGS`, where `-f` means `--file`). Both
   are coincidences. The probe credits the candidate for them.
2. **"Generated from git's real writer surface (rule 7)" is false.** `WRITER_FLAGS` is 17
   hand-typed strings crossed with one template. Generated over one axis, derived from
   nothing. Omits `-t`, `--track`, `--recurse-submodules`, every zero-operand form, and
   every ordering where a read flag precedes a writer — where all three leaks live.
3. **Two mutations SURVIVE it:** adding `-t` to the read-flag set (making
   `git branch --list -t x` ALLOW) → probe still PASSes; dropping the `eq === -1` guard →
   probe still PASSes. Two decision paths have no case that can fail for them.
4. **It does not model the integration.** Real dispatch runs per *segment*
   (`shellAllowlist.mjs:373-388`); `candidate()` tokenizes the whole string once.
5. **The PASS is a tautology.** Candidate written first, table second, same author, no
   input the author had not already decided about.

---

## The lesson worth keeping

The two findings pull in opposite directions and the original did not notice. Finding 1's
whole argument is *"routing on a token POSITION rather than the SHAPE of the input"* —
hollow gate 19. Finding 2's patch then routes `git branch` on token position within an
argv the guard does not parse the way git does, and computes its central safety predicate
by asking whether a string appears in a list rather than whether git reads it as a flag.
**It reintroduces the exact defect class its sibling finding names, one section later, and
its evidence passed because the evidence was drawn from the same understanding as the
code.**

That is the whole file's subject matter, committed by the file. Which is why CLAUDE.md
says work that changes a guard goes to another agent — and why a self-run probe reporting
PASS is the least trustworthy artifact here.
