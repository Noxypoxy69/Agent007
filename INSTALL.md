# Install and run

## A. Local only (no bridge, no hosting) — 2 minutes

Works immediately and is worth doing first, because it proves the probes
against your real worktrees before any hosting exists.

```bash
cd agentbridge
npm install
node bin/agentbridge.mjs init --label <machine-label>

node bin/agentbridge.mjs register --agent code-a --lane release    --worktree "C:\Users\<you>\Documents\social-sparks"
node bin/agentbridge.mjs register --agent code-b --lane onboarding --worktree "C:\Users\<you>\Documents\social-sparks-code-b"
node bin/agentbridge.mjs register --agent code-c --lane messaging  --worktree "C:\Users\<you>\Documents\social-sparks-code-c"
node bin/agentbridge.mjs register --agent code-d --lane cloner     --worktree "C:\Users\<you>\Documents\social-sparks-code-d"

node bin/agentbridge.mjs status
```

Expected shape:

```
code-c [messaging]  C:\Users\<you>\Documents\social-sparks-code-c
  branch   code-c/messaging-gates  head e2ecf40d2391
  base     49012be94d77   origin/main 49012be94d77
  unpushed 1 (no-upstream:vs-merge-base)  ahead 1 / behind 0
  files    0 staged, 1 dirty, 1 untracked
  locks    gates-can-fail(37s)
  running  verify:1465
```

Copy `lanes.example.yml` into the repo as `lanes.yml`, edit the globs, then set
`lanesFile` in `~/.agentbridge/config.json` to its absolute path. That switches
on cross-lane write detection.

## B. Hosted bridge

### 1. Database

Create a **new** Supabase project — not the We're Local one. Run
`bridge/schema.sql` in the SQL editor.

### 2. Register the machine

`init` printed a machine id and a secret. Insert them:

```sql
insert into agentbridge.machines (id, label, secret)
values ('<machine-id>', '<machine-label>', '<secret>');
```

### 3. Issue a reader token

```bash
node -e "const c=require('crypto');const t=c.randomBytes(32).toString('hex');console.log('token:',t);console.log('sha256:',c.createHash('sha256').update(t).digest('hex'))"
```

```sql
insert into agentbridge.reader_tokens (token_sha256, label) values ('<sha256>', 'chatgpt-coordinator');
```

Keep the token. Only its digest is stored, so it cannot be recovered.

### 4. Deploy the server

Any Node host. Env:

```
DATABASE_URL=postgres://...            # service_role connection string
AB_RATE_PER_MIN=30
PORT=8787
```

```bash
node bridge/server.mjs
curl https://your-bridge/v1/health     # {"ok":true,"service":"agentbridge","step":1}
```

### 5. Point the daemon at it

```bash
node bin/agentbridge.mjs init --bridge-url https://your-bridge
node bin/agentbridge.mjs heartbeat --dry-run    # inspect the payload before sending anything
node bin/agentbridge.mjs heartbeat              # publish once
node bin/agentbridge.mjs daemon start           # then leave running
```

Run `--dry-run` first and actually read the JSON. It is the complete set of
what leaves the machine.

### Keeping it running on Windows

Simplest reliable option — Task Scheduler, trigger "At log on", action:

```
Program:   C:\Program Files\nodejs\node.exe
Arguments: C:\path\to\agentbridge\bin\agentbridge.mjs daemon start
Start in:  C:\path\to\agentbridge
```

## C. Connect the coordinator

**ChatGPT** (hosted, so it needs the HTTP endpoint):

```
URL:  https://your-bridge/mcp
Auth: Bearer <reader token>
```

**Claude Code** (local, can use stdio):

```bash
claude mcp add agentbridge -- node /path/to/agentbridge/mcp/stdio.mjs
```

The stdio variant talks to Postgres directly, so it needs `DATABASE_URL` in its
environment.

### Tools exposed

`list_agents` · `get_agent_state` · `list_worktrees` · `get_git_state` ·
`list_active_processes` · `list_locks` · `get_collision_summary`

All read-only. Start with `list_agents`, then `get_collision_summary`.

## Acceptance check

With four worktrees running, ask the coordinator: *"What are all active agents
doing right now?"* The answer should include branch, HEAD, base SHA, dirty
state, locks, running verification and unpushed counts — with nothing pasted.

If it cannot, the failure is in one of three places, in this order: `status`
locally, `heartbeat --dry-run`, then the reader token.
