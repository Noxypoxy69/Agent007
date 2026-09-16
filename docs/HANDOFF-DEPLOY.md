# HANDOFF: deploy the edge function

> **2026-09-16 21:40 — code-d was right and this file was wrong.**
> The decision `d-owner-deploy-process-20260916` records that a diverged branch
> "silently REVERTS whatever master has that it lacks", and names this branch:
> `work/reviewer-runtime` would have rolled back the b6 identity fix and the
> deployment record to its zero-sha state. Verified: master had moved thirteen
> commits ahead, `b6 IS CODE-A` was present in master and absent here, and the
> deployment record here still said liveVersion 20 against a live 23.
> `origin/master` is now merged in and both sides survive. Re-check before you
> deploy: master moves, and this file ages the same way the last one did.

> **2026-09-16 23:21 — THE DEPLOY THIS FILE WAS WRITTEN FOR HAS SHIPPED.**
> code-d deployed **version 24** from the merged master tree `d8235a0`, and
> `deploy/last-deployment.json` records it with the wrong-tree check run BEFORE
> shipping. `/review/claim` and `/review/submit` are live, so the two migrations
> applied at 18:00 are reachable from outside the database. Read this file as
> instructions for the NEXT deploy, not a pending one — and read that record
> before you start, because it carries what the last deploy learned.

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
3. *(authorised by Danny in chat 2026-09-16 — "yes, autoconfirm" — but NOT YET
   IN THE TREE, see below)* **the dispatcher confirming its own assign
   proposals.** 1,227 prepared, 2 ever confirmed; 1,225 assignments died waiting
   for a human. The change is ~40 lines in the `/dispatch` route reusing
   `confirmProposal` so `canConfirm` still re-runs against live rows. It is not
   committed because the cloud session's harness refuses to author it
   (`Security Weaken` — correctly, it removes a human approval gate) and refuses
   to write the ledger row (`Permission Grant`). Both need a permission rule or
   a human to apply them.

---

## The order of operations is Danny's, and this handoff had it wrong

`d-owner-dispatch...` no -- **`d-owner-deploy-process-20260916`**, in the owner
decision ledger:

> "audit then merge then deploy dude that eveytime right" -- Danny, 2026-09-16

That is a STANDING ORDER for every deploy, not a one-off. The first draft of
this file said to deploy straight from `work/reviewer-runtime`, which skips the
merge. Corrected: **audit, then merge, then deploy.**

The merge is ORDER item 1 and belongs to whoever holds it (code-c). Merging to
master is also an owner action in its own right. So the branch is NOT deployed
from directly unless Danny says so for this one case.

## Do this

```
# 1. AUDIT -- already done for the branch's own contents, see below.
#    What is NOT audited is the merge result. Audit that.
git fetch origin work/reviewer-runtime
git checkout <the integration branch>
git merge --no-ff origin/work/reviewer-runtime
npm test          # must be 1506+ tests, 0 failures

# 2. MERGE to wherever this ships from, per item 1.

# 3. DEPLOY from the merged tree, not from the branch.
supabase functions deploy mcp --project-ref ornbhvaijcpsbcgquzhd --no-verify-jwt
```

If Danny explicitly authorises deploying the branch directly, skipping step 2,
that is his call to make and it should be recorded as its own ledger entry --
the standing order above is what it would be overriding.

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

**THE UNAUTHENTICATED 401 CHECK THIS FILE USED TO GIVE YOU WAS WRONG.** It said
a 401 proves the route exists. It does not. Found by code-d, and the code says
why: the router has **no 404 fallback**. An unmatched path falls through to the
MCP surface at the bottom of `supabase/functions/mcp/index.ts`, which looks the
bearer up in `coordinator_tokens` then `reader_tokens` and answers 401 when it
is in neither. So a route that has never existed returns 401, and that check
passed before the deploy exactly as happily as after it.

Use an authenticated probe with a **negative control** on a path that cannot
exist. Both need a *registration* token — it is in neither token table, so the
fall-through answers 401 for it, which is what makes the control meaningful.

```
TOKEN=<a registration token>
BASE=https://ornbhvaijcpsbcgquzhd.supabase.co/functions/v1/mcp

# the real route
curl -s -o /dev/null -w 'review/claim   %{http_code}\n' -X POST "$BASE/review/claim" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"task_id":"__probe","reviewer_session":"__probe"}'

# the negative control: a path that does not and will not exist
curl -s -o /dev/null -w 'no-such-route  %{http_code}\n' -X POST "$BASE/no-such-route" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
```

- `review/claim` **409** and `no-such-route` **401** → deployed. The 409 is
  `unknown-session`: the request authenticated against `registration_tokens`,
  reached the handler, read the registry and refused a session that is not
  there. Only the deployed route can produce it.
- both **401** → **not deployed.** `review/claim` fell through to the same
  place `no-such-route` did.
- `review/claim` **401** and the control something else → stop. Your token is
  not a registration token and neither line means what this list says.

**WHICH HALF OF THIS HAS ACTUALLY BEEN RUN, because the difference matters.**
code-d ran a probe of this shape against live before version 24 and got
`/review/claim` → **400 `task_id is required`**, `/review/nope` → **401**. That
is the verified pair, recorded in `deploy/last-deployment.json`. The 409 above
is the same probe with a `task_id` in the body, so it gets past the 400 and
reaches the registry — **reasoned from `index.ts`, not run**, because the
container this was written in cannot reach the function at all. Either pair
discriminates. Prefer code-d's if you want the one with a live result behind it,
and treat the 409 as a prediction until somebody sees it.

The control is the part that matters. Without it you cannot tell "the route
answered" from "every path answers that" — which is the whole bug above.

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
