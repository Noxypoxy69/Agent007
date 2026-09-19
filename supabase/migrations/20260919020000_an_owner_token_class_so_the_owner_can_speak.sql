-- A fifth token class, so the owner can record a decision as himself.
--
-- THE PROBLEM, measured 2026-09-18. f7ae118 anchored owner decisions: owner_id
-- must name the ACTUAL owner rather than merely equal created_by, because
-- comparing two self-declared fields to each other establishes only that the
-- writer was consistent. index.ts binds created_by to the authenticated token
-- label. And the whole coordinator_tokens table is one row:
--
--   coordinator   "chatgpt-work coordinator"
--   registration  "danny-win-10 workers"
--
-- No credential carries an owner spelling. So once the anchor deploys,
-- record_owner_decision refuses EVERYONE, Danny included, and
-- settleOpenRequestsAgainstPolicy goes with it -- the only mechanism that
-- closes owner-routed permission requests. That is rule 15's shape exactly: a
-- client sending a credential it cannot acquire.
--
-- WHY NOT JUST RELABEL THE COORDINATOR TOKEN, which is the obvious one-line
-- answer and is wrong for a concrete reason rather than a theoretical one.
-- CLAUDE.md: the OAuth consent page hands out THE COORDINATOR TOKEN for a write
-- grant. Relabelling it to "danny" would make every write-scoped remote
-- connector -- Cowork, a claude.ai custom connector, ChatGPT -- able to record
-- rulings AS THE OWNER. The reason two secrets exist is precisely that
-- "this client may direct my agents" must not be grantable with the credential
-- that only ever meant "this client may look".
--
-- AND THAT COORDINATOR LABEL IS ITSELF A REVOKED PARTY. d-owner-team-order-20260916
-- is active and says "ChatGPT is OUT", revoking task.assign.nonproduction,
-- message.send and lane.coordinate. The token still authenticates, which is how
-- sixteen tasks got created on 2026-09-18 stamped with a party Danny removed.
-- Handing that same credential OWNER authority would compound it.
--
-- FOUR CLASSES IN FOUR TABLES, NEVER ONE TABLE WITH A SCOPE COLUMN -- CLAUDE.md,
-- because that is one typo away from promoting a reader to a coordinator, and a
-- promotion by typo is one nobody reviews. This is the fifth table, same shape,
-- same reasoning.
--
-- THIS GRANTS NOBODY ANYTHING TODAY. The table is created EMPTY. An empty token
-- table authenticates no one, so applying this migration changes no behaviour
-- whatsoever; it creates the slot the owner can choose to fill. That is why it
-- was safe to write without waiting: the authority arrives when Danny mints a
-- row, and not before.

create table if not exists agentbridge.owner_tokens (
  token_sha256  text primary key,
  label         text not null,
  disabled      boolean not null default false,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

comment on table agentbridge.owner_tokens is
  'The OWNER speaking as himself. Separate from coordinator_tokens because the OAuth '
  'write consent hands out a coordinator token, and "this client may direct my agents" '
  'must never be the same credential as "this client may decide for me". Read only by '
  'record_owner_decision. Expected to hold exactly one row, labelled with an owner '
  'spelling the ACTORS roster recognises -- danny, or its alias owner.';

comment on column agentbridge.owner_tokens.label is
  'Must be an owner spelling, or validateDecision refuses every decision written with '
  'it -- created_by is bound to THIS value and the anchor checks it against the roster. '
  'A label of anything else is a token that authenticates and can do nothing, which is '
  'a confusing failure rather than a dangerous one.';

-- RLS ON, AND NO POLICY, exactly like the sibling token tables: the service role
-- bypasses RLS and every other role is refused by default. A token table that
-- anon can read is the whole system.
alter table agentbridge.owner_tokens enable row level security;

revoke all on agentbridge.owner_tokens from anon, authenticated;
grant select, update on agentbridge.owner_tokens to service_role;

-- NO public VIEW, DELIBERATELY. Every other token table is reachable only
-- through the edge function's service-role client, and a public view over a
-- credential table is the one thing that could turn a PostgREST misconfiguration
-- into a full compromise. The other four have none; neither does this.
