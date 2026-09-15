# Architecture — Step 1

## Layers

**Daemon** (`src/`, `bin/agentbridge.mjs`) — runs on the Windows machine. Reads
a local registry of `{agentId, lane, worktree}`, probes each worktree, and
publishes a signed snapshot. Zero runtime dependencies; core Node only.

**Bridge** (`bridge/`) — Node HTTP server over Postgres. Verifies signatures,
rejects replays, rate-limits, stores snapshots, derives collisions.

**Read surface** (`mcp/`) — MCP server exposing seven read-only tools. Served
over streamable HTTP at `/mcp` for hosted coordinators, and over stdio for
local ones.

## Why the daemon is dependency-free

It runs on a developer machine with access to every worktree. Each dependency is
a supply-chain path into that position. The bridge and MCP server carry `pg`,
the MCP SDK, and `zod`; the daemon carries nothing.

## Probes

| Signal | Source | Confidence |
|---|---|---|
| branch, HEAD, upstream | `git rev-parse` / `branch --show-current` | exact |
| base SHA | `git merge-base HEAD origin/main` | exact |
| unpushed | `rev-list --count <upstream>..HEAD`, else vs merge-base | exact, basis reported |
| ahead/behind | `rev-list --left-right --count origin/main...HEAD` | exact |
| staged/dirty/untracked | `status --porcelain=v1 -z` | exact |
| locks | lock-file directory listing | exact |
| processes | `/proc/<pid>/cwd` on Linux; command-line match elsewhere | **cwd exact, commandline heuristic** |

The process probe is the only heuristic, and it says so in its output. A
process matching more than one worktree by command line is marked `ambiguous`
with the other candidates listed, rather than being asserted into both. If the
probe itself fails, `processProbeOk:false` is published so an empty list is
never read as "nothing is running".

## Subprocess policy

`src/exec.mjs` is the only place this package spawns anything. It uses
`execFile` with an argv array and `shell:false`. There is no string
interpolation into a command line anywhere in the codebase, so a worktree path
containing `;`, backticks, `$()` or quotes is inert data. There is a test that
creates a worktree at a path containing exactly those characters.

`file` is always a literal in this repo. No code path reads a binary name or an
argument from the network.

## Wire protocol

```
POST /v1/heartbeat
  x-ab-machine     <uuid>
  x-ab-timestamp   <epoch ms>
  x-ab-nonce       <128-bit hex>
  x-ab-signature   HMAC-SHA256(secret, "v1\n<machine>\n<ts>\n<nonce>\n<sha256(body)>")
```

Signing the body *hash* binds the payload to the signature: altering one byte
invalidates it. The bridge checks ±120s clock skew, consumes the nonce (unique
index — a second use is a 409), then applies a fixed per-minute rate window.

The response is `{accepted:boolean}`. The daemon reads `ok`, `status`,
`accepted` and a truncated `reason`, and nothing else. There is no code path
from an HTTP response to exec, eval, filesystem writes, or config mutation — a
fully hostile bridge can lie to the coordinator but cannot act on the machine.

## Data model

`machines`, `nonces`, `rate_windows`, `lanes`, `sessions`, `heartbeats`,
`reader_tokens`. `sessions` is the denormalised latest snapshot per agent and is
what reads hit; `heartbeats` is the append-only audit trail, pruned at 48h.

Deleted registry entries are removed from `sessions` in the same transaction as
the heartbeat that omitted them, so a coordinator never sees a ghost agent.

## Collision detection

`bridge/collisions.mjs` is a pure function over session snapshots — no I/O, so
it is directly testable and runs identically server-side or locally. Every
finding carries the evidence it was derived from, so a coordinator can check
the claim rather than trust it. Findings sort critical-first.

Cross-lane write detection needs a lane map. Without one the result includes an
explicit `no-lane-map` finding rather than silently reporting "no collisions" —
absence of evidence is reported as absence of evidence.

Redacted paths are skipped by ownership matching. A redacted path cannot be
attributed to a lane, and guessing would be worse than abstaining.
