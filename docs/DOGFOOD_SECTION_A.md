# Dogfood pass — section A, on the real machine

This has to run on the Windows box. It cannot be run from a chat runtime:
there is no access to `C:\Users\<you>\` from there.

## Commands

```powershell
cd <wherever agentbridge landed>
npm install

node bin\agentbridge.mjs init --label <machine-label>
node bin\agentbridge.mjs doctor

node bin\agentbridge.mjs register --agent code-a --lane release    --worktree "C:\Users\<you>\Documents\social-sparks"
node bin\agentbridge.mjs register --agent code-b --lane onboarding --worktree "C:\Users\<you>\Documents\social-sparks-code-b"
node bin\agentbridge.mjs register --agent code-c --lane messaging  --worktree "C:\Users\<you>\Documents\social-sparks-code-c"
node bin\agentbridge.mjs register --agent code-d --lane cloner     --worktree "C:\Users\<you>\Documents\social-sparks-code-d"

node bin\agentbridge.mjs status
node bin\agentbridge.mjs status --json > status.json
```

Paste back: the `doctor` output and the `status` output. `status.json` is the
full payload if anything needs digging into.

`doctor` must print `RESULT: OK` before anything is pointed at a bridge. It is
the only proof that DPAPI actually works on that machine — that path was
written on Linux and has never executed on Windows.

## Acceptance checklist

Check each against what you know to be true, not against what the tool says.
The tool being self-consistent is not the same as it being right.

| # | Check | How to confirm independently |
|---|---|---|
| 1 | every active worktree maps to the correct lane | compare to how you actually assigned them |
| 2 | branch / HEAD / origin-main correct | `git -C <wt> rev-parse HEAD` and `origin/main` |
| 3 | unpushed commits correct | `git -C <wt> log --oneline @{u}..HEAD` |
| 4 | dirty files correct | `git -C <wt> status --short` |
| 5 | processes attributed to the right worktree | is verify actually running there? |
| 6 | ambiguous processes marked `?`, never guessed | any `?` suffix in the running line |
| 7 | locks correct | check the lock directory yourself |
| 8 | no secret values or secret filenames anywhere | `findstr` on status.json, below |

### Check 8, concretely

```powershell
findstr /i /c:".env" status.json
findstr /i /c:"ghp_" /c:"sk-" /c:"xox" /c:"eyJ" /c:"AKIA" status.json
findstr /i /c:"password" /c:"service_role" status.json
```

Expect no hits other than `<<redacted:...>>` markers. A hit is a bug — send the
line, not the file.

## Where it breaks, in order

1. `doctor` fails → secret sealing or file ACL. Nothing else matters yet.
2. `status` shows a wrong branch or SHA → the probe layer. Send the mismatch
   plus the matching raw `git` output.
3. `status` is right but a process is attributed oddly → expected on Windows:
   there is no cheap cwd lookup, so attribution falls back to command-line
   matching and is marked `confidence: "commandline"`. Multiple candidates are
   marked `ambiguous` with the alternatives listed.

## Not in this pass

No dispatch. No remote execution. No hosted bridge. `bridgeUrl` stays unset,
so nothing leaves the machine — `status` reads local state and prints it.
