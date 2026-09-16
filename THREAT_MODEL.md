# Threat model — Step 1

## What this system is

A daemon on a developer machine with read access to every worktree, publishing
to a hosted endpoint a third-party coordinator can read. That is a real
exposure and it is worth being precise about its shape.

## The central property

**There is no inbound command path.** The daemon makes outbound requests and
reads four scalars from each response. It never receives a task, a shell
string, a file path to act on, or a configuration change.

This is enforced structurally, not by policy:

- `src/client.mjs` returns `{ok, status, accepted, reason}`. Nothing else in the
  response is parsed.
- `src/exec.mjs` is the only spawn site, takes argv arrays, and is never called
  with anything derived from a response.
- No `eval`, no `Function`, no dynamic import of remote content.

`test/e2e.test.mjs` runs a bridge that deliberately answers with
`{command:"rm -rf /", exec:"evil", instructions:"delete main"}` and asserts the
daemon ignores all of it.

Consequence: a fully compromised bridge can lie to the coordinator and can read
whatever the daemon published. It cannot run code, read files, or modify the
repo.

## Trust boundaries

| Boundary | Protection | Residual risk |
|---|---|---|
| daemon → bridge | HMAC-SHA256 over body hash, ±120s skew, single-use nonce, rate limit | machine secret theft = full impersonation |
| bridge → reader | bearer token, SHA-256 at rest | token theft = full read of engineering state |
| bridge → daemon | **none needed** — responses carry no authority | — |
| bridge ↔ product DB | separate Supabase project | operator error connecting them |
| git remote → whoever can read it | repository is **private**, one collaborator (the owner) | every collaborator reads the whole history, permanently |

**REPOSITORY VISIBILITY IS PRIVATE, AND UNTIL NOW IT WAS NOWHERE IN THIS FILE.**
Checked against the GitHub API rather than assumed: `Noxypoxy69/Agent007` reports
`visibility: private`, with exactly one collaborator, who is the owner. The
absence of that line is not a documentation nit. A coordinator spent an
afternoon describing a committed home directory as published to the world,
wrote it into a commit message twice, and nothing in the repository could
contradict it, because there was no line to check. An unstated assumption cannot
be caught being wrong; that is the whole problem with leaving one unstated.

**WHAT PRIVATE DOES NOT BUY, so the correction does not become the wrong lesson.**
It is not the control the leak guard depends on: the payload that guard scans
goes to a hosted Bridge over the network, not into git, so repository visibility
protects none of it. It is not a property of the past either — history is
permanent, every future collaborator reads all of it, and the setting can be
changed in two clicks by the same person at any hour. Identity is scrubbed from
the tree because it does not belong in the tree, not because of who can read it
this week.

## Secrets

**Never transmitted:** file contents. The daemon reads file *contents* in
exactly one place — lock metadata JSON, in directories it was configured to
watch — and nothing else. Diffs, source, and env values never enter a payload.

**Never transmitted: raw command lines.** Process argv is allowlist-sanitised
before publication (`src/argv.mjs`). The published shape is `{executable, args,
argCount, redactedCount, truncated}` — there is no `command` field. `executable`
is a basename only. An argument is published only if it is recognisably safe;
anything unrecognised is redacted. Specifically redacted: values following a
sensitive flag (`--token`, `--password`, `-H`, `--api-key`, …), `--flag=value`
forms of the same, `KEY=VALUE` where the key name contains TOKEN/SECRET/KEY/
PASS/AUTH/DSN/URL, and secret-shaped literals anywhere in argv — JWTs, `ghp_`,
`sk-`, `xox*-`, `glpat-`, `AKIA*`, `AIza*`, `npm_`, long hex, long base64,
credentials inside a URL. Arguments are capped at 12, and a sensitive flag
landing at the truncation edge still redacts its value.

Verified live: `test/argv.live.test.mjs` spawns a real process whose argv
carries a real GitHub token and a Postgres URL with a password, runs the actual
probe, and asserts neither appears in the probe result or the full heartbeat
payload.

**Redacted by default:** paths matching `.env*`, `*.pem`, `*.key`, `id_rsa*`,
`.npmrc`, `.netrc`, service-account JSON, and `secrets/`/`credentials/`
directories. These publish as `<<redacted:env>>` and similar.

The tradeoff, stated plainly: redaction costs coordination signal. Knowing
".env is dirty in code-b" is genuinely useful, and a filename is not a secret.
The default is conservative anyway, because the downside of a secret-store
filename sitting in a hosted database outweighs the convenience. Set
`redactSensitivePaths: false` if you disagree — it is one config key, and
`test/unit.test.mjs` covers both modes.

`test/e2e.test.mjs` writes a real `.env.local` containing a fake service key and
asserts neither the value nor the filename appears on the wire.

## The machine secret

An HMAC key, so it must be stored recoverable — it cannot be hashed like a
password. It lives at `~/.agentbridge/config.json`, chmod 0600.

**On Windows the secret is sealed with DPAPI**, user+machine scoped, via a
SecureString round-trip. The plaintext is passed to PowerShell on **stdin**,
never as an argument — argv is readable by any process on the machine, which is
the same leak `src/argv.mjs` exists to close. The stored form is a DPAPI blob
under `secretStore`, and a plaintext value is never written under that key.

`chmod 0600` is still called and is still a no-op on Windows, so it is not
relied on. The real check is the ACL: `verifyPermissions()` reads the file's
access rules and fails if any **Allow** grant names an identity outside
{current user, SYSTEM, Administrators}. `hardenPermissions()` breaks
inheritance and grants the current user only. Deny rules are correctly not
treated as grants.

The daemon **refuses to start** against a configured bridge if the secret
cannot be unsealed, if permissions are too broad, or if the secret is sitting
in plaintext on Windows. It exits 3 rather than publishing.

`agentbridge doctor` performs a live seal/unseal round-trip on the actual
machine, so DPAPI availability is proven rather than assumed.

Residual: any process running **as that user** can still ask DPAPI to unseal
it. DPAPI raises the bar from "read the file" to "run code as Danny"; it does
not defend against an agent already running as Danny. Given that the coding
agents run with sandboxing disabled, that is the honest ceiling here — and it
is the reason Step 2 hooks matter more than Step 1 storage.

In the database, `machines.secret` sits in a table with RLS enabled and **no
policies**, meaning only the `service_role` key can read it. The bridge server
is the only thing that should ever hold that key. Do not expose this table
through PostgREST.

## Rejected inputs

| Attack | Result |
|---|---|
| Replayed heartbeat | 409, nonce already consumed |
| Body tampered after signing | 401, body hash mismatch |
| Unsigned or missing headers | 401 |
| Stale or future timestamp (>120s) | 401 |
| Unknown machine ID | 401, identical shape to a bad signature — not an ID oracle |
| Payload > 2 MB | 413, stream destroyed |
| Flood | 429 at 30/min per machine |
| Unknown schema version | 400 |
| Malformed reader token | 401 |
| Shell metacharacters in a worktree path | inert; argv array, no shell |

Server errors return `{error:"internal"}` and log detail server-side. Stack
traces are never returned to a client.

## What this does NOT protect against

1. **A malicious or compromised agent on the machine.** It can read the secret,
   forge heartbeats, and lie about its own state. Step 1 gives visibility, not
   containment. Step 2 hooks are what make a lane violation *fail*.
2. **A compromised bridge host** reading all published state: branch names,
   file paths, worktree paths, process command lines. No contents, but the
   shape of the work is fully visible.
3. **Reader-token theft.** Read-only, but that is a complete map of the
   engineering effort.
4. **Correctness.** Nothing here reviews a diff. A clean collision report means
   no lane violations, never "this code is good."

## Known gaps, stated rather than deferred

- Argv redaction is allowlist-based and therefore conservative, but no
  redactor is complete. A secret shaped exactly like a file path
  (`./config/abc-def`) would survive. Do not pass secrets as arguments.
- The Windows DPAPI and ACL paths are **written but not executed** — the build
  environment is Linux. `agentbridge doctor` exists to prove them on the real
  machine in one command. Treat them as unverified until it prints RESULT: OK
  there.
- `bridge/store.mjs` (the Postgres layer) is not covered by automated tests —
  there was no Postgres available in the build environment. The wire protocol,
  signing, replay and rate paths ARE covered end-to-end against a live HTTP
  server with an in-memory store that reuses the same verification logic.
- No mutual TLS or certificate pinning. Transport security is whatever the
  bridge host's TLS provides.
- No per-agent scoping on reader tokens: a token reads all agents or none.
- Git HISTORY still carries the operator's real home directory, its 8.3 alias,
  the machine label and the real hostname, in every commit before 97cb634. The
  working tree is scrubbed; history is not. Rewriting the history of a
  repository other sessions have cloned is the owner's decision, not a cleanup.

## Operational rules

1. Deploy the bridge to a **separate Supabase project** from the We're Local
   production app.
2. Never put the `service_role` key anywhere but the bridge server's env.
3. Issue one reader token per consumer and revoke by flipping `disabled`.
4. Rotate a machine secret by re-running `init --secret <new>` and updating the
   `machines` row.
5. Keep `prune()` scheduled. Heartbeats accumulate quickly at 10s intervals.
