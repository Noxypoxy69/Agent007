# Agent Bridge — Step 1 (v0.2.0)

Live engineering state for parallel Git worktrees, published from the developer
machine so a coordinator reads ground truth instead of pasted summaries.

**This layer is read-only.** It observes and publishes. It does not accept
instructions, assign work, or execute anything. Dispatch is Step 3 and has its
own threat model.

```
Windows machine                     hosted bridge                coordinator
┌──────────────────────┐            ┌──────────────┐            ┌──────────┐
│ daemon               │  signed    │ /v1/heartbeat│            │ ChatGPT  │
│  git plumbing        │ ─────────► │              │            │  or      │
│  process table       │  HMAC      │ Postgres     │ ◄────────  │ Claude   │
│  lock files          │  one-way   │              │  MCP read  │  Code    │
└──────────────────────┘            └──────────────┘            └──────────┘
        no inbound command path ──────────┘
```

## Why the state is trustworthy

Every field is read from `git` plumbing and the OS process table by the daemon.
Nothing is self-reported by the agents. An agent that believes it is on
`code-c/messaging-gates` cannot make the bridge say so — only the worktree can.

Fields that could not be determined are `null`. Null means unknown, never zero.

## What it answers

- Which agents are alive, on what branch, at what HEAD, forked from what base
- What is uncommitted, staged, untracked, and unpushed
- Which locks are held, by whom, for how long
- What verify/test processes are running, and with what confidence
- Derived collisions: shared worktrees, duplicate lanes, lock contention,
  cross-lane uncommitted writes, `main` divergence, stale sessions

## Quick start

```bash
npm install
node bin/agentbridge.mjs init --bridge-url https://your-bridge.example.com
node bin/agentbridge.mjs register --agent code-c --lane messaging --worktree "C:\\Users\\<you>\\Documents\\social-sparks-code-c"
node bin/agentbridge.mjs doctor          # verify secret sealing + file permissions
node bin/agentbridge.mjs status          # works with no bridge at all
node bin/agentbridge.mjs daemon start
```

See `INSTALL.md` for the hosted side, `THREAT_MODEL.md` for what this does and
does not protect against, and `docs/STEP2_STEP3.md` for what comes next.

## Tests

```bash
npm test     # 74 tests
```

Includes integration tests that build real bare repos and worktrees, and
end-to-end tests that run a live HTTP bridge and assert the daemon ignores an
instruction planted in the response.
