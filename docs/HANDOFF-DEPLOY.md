# HANDOFF: deploy the edge function

**For:** anyone with a terminal that can reach `api.supabase.com`.
**Why you and not an agent:** the cloud session's network policy does not
allowlist that host. `git push` works, `api.supabase.com` returns HTTP 000.
Every other route was tried and is recorded at the bottom.

**Time:** about two minutes. **Risk:** low, and the rollback is one command.

---

## What is riding on this one deploy

Three changes, all already committed and tested, none of them live:

1. **The reviewer runtime's two routes** — `/review/claim` and `/review/submit`.
   Both migrations are ALREADY APPLIED, so the database can record a review and
   nothing outside can reach it. ORDER item 4 is finished except for this.
2. **The stale-recipient warning on `send_message`** — and the fix that its only
   caller never passed the roster, so the unknown-recipient check has never run
   in production at all.
3. *(pending Danny's go-ahead, not yet in the tree)* **the dispatcher confirming
   its own assign proposals** — 1,227 prepared, 2 ever confirmed.

---

## Do this

```
git fetch origin work/reviewer-runtime
git checkout work/reviewer-runtime
supabase functions deploy mcp --project-ref ornbhvaijcpsbcgquzhd --no-verify-jwt
```

### `--no-verify-jwt` is not optional

The function runs with JWT verification **off** on purpose: it authenticates by
looking the bearer token up in its own token tables. A deploy that lets that
default back to ON refuses every registration-token call at once, and the
failure reads as a credential problem rather than as a deploy.

### Check the tree first, because this already went wrong once

```
supabase functions download mcp --project-ref ornbhvaijcpsbcgquzhd
node scripts/check-edge-deploy.mjs <downloaded-dir> supabase/functions/mcp
```

- `index.ts: +N -0` with N in the hundreds → right tree, go.
- `NOTHING WOULD CHANGE` → **wrong tree.** You are not on the branch. This is
  exactly what happened at 19:37 on 2026-09-16: a clean, successful deploy,
  version 22 to 23, byte-identical bundles, nothing shipped. From outside it is
  indistinguishable from a deploy that worked.
- `REFUSED ... REMOVES n line(s)` → read the removals it prints. If you meant
  them, pass `--expect-removed n`. If you did not, you were about to revert
  somebody's fix.

---

## Verify it actually worked

Do not trust the deploy's own success. It reported success for the no-op above.

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://ornbhvaijcpsbcgquzhd.supabase.co/functions/v1/mcp/review/claim \
  -H 'content-type: application/json' -d '{}'
```

- **401** → deployed. The route exists and refuses an unauthenticated caller.
- **404** → not deployed. The routes are not there; check the branch.

Then confirm the version moved and JWT verification is still off:

```
supabase functions list --project-ref ornbhvaijcpsbcgquzhd
```

`verify_jwt` must read **false**.

---

## If it goes wrong

Nothing here touches the database, so a bad deploy is recoverable by deploying
the previous bundle. Before you start:

```
supabase functions download mcp --project-ref ornbhvaijcpsbcgquzhd
cp -r <downloaded-dir> /tmp/mcp-rollback
```

To roll back, deploy that directory with the same `--no-verify-jwt`.

The migrations are already applied and are NOT part of this. They are additive:
new columns, one new function, a view that grew, and one function that gained a
refusal. Nothing in this deploy depends on rolling them back.

---

## What was tried, so nobody repeats it

| route | result |
|---|---|
| `supabase functions deploy` from the cloud session | `403 request blocked: no rule or allowlist entry allows host "api.supabase.com"` |
| `deploy_edge_function` over MCP | works network-wise, but takes file contents INLINE and the bundle is 205,272 bytes — it does not fit in one call |
| `apply_migration` over MCP | **works**, runs server-side. This is how both migrations landed. |

**The permanent fix is one of two things**, and either ends this handoff
existing at all:

- allowlist `api.supabase.com` for the cloud environment, or
- connect the repo to Supabase's GitHub integration so a push to the branch
  deploys the function. GitHub IS reachable from the cloud session, so this also
  removes the credential-in-a-container problem and the wrong-tree problem in
  one move.

---

## One trap worth knowing before you diff anything

The deployed bundle comes back **CRLF**; the repo is **LF**. An unnormalised
comparison reports every single line of `index.ts` as changed — all 1,813 of
them — which reads as "production was rewritten from scratch" and means nothing.
`scripts/check-edge-deploy.mjs` normalises before comparing. Anything you do by
hand should too.
