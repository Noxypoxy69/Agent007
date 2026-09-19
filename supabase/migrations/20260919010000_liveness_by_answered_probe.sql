-- Liveness by answered probe: a poll proves a process, not an agent.
--
-- THREE SIGNALS HAVE SHIPPED AND NOT ONE MEASURES THE AGENT.
--
--   the watcher      proved a DAEMON was running. It died with the shell that
--                    started it and nothing supervised it; 1d2401a's own title
--                    is "The roster described daemons, not agents".
--   touchLiveness    proves SOMEBODY HOLDING THE SHARED WORKER TOKEN spoke for
--                    a session. That commit says so itself and names per-agent
--                    tokens as what would close it.
--   the session poll proves a SUPERVISOR PROCESS is re-arming. It deliberately
--                    does not interpret what it receives, so a wedged or
--                    finished agent polls exactly like a working one.
--
-- Measured on this bridge: the roster called code-a dead 41434 seconds after it
-- sent a message, called fixer dead while it was committing, and called code-b
-- dead while it was making authenticated calls to this very function.
--
-- THE MEASUREMENT IS A ROUND TRIP THE AGENT ITSELF CLOSES. A probe is delivered
-- as an ordinary event; the agent answers by naming the probe id back through a
-- tool only it can call. Nothing below the agent can produce that id -- not the
-- supervisor, which never reads event bodies, and not another worker, because
-- an ack that does not match the OUTSTANDING probe is not an ack.
--
-- THE DECISION LOGIC IS NOT HERE AND NOT IN THE EDGE FUNCTION. It is
-- src/livenessProbe.mjs, pure and tested, spliced into _shared.js -- because
-- index.ts cannot be imported by the suite and anything left in it is untested
-- by construction. These columns are only what that logic needs to persist.

alter table agentbridge.session_registrations
  add column if not exists probe_id        text,
  add column if not exists probe_sent_at   timestamptz,
  add column if not exists last_ack_at     timestamptz,
  add column if not exists probe_attempts  integer not null default 0;

comment on column agentbridge.session_registrations.probe_id is
  'The OUTSTANDING probe this session must name back to prove it is alive. Cleared '
  'on a valid ack. An ack naming anything else is not an ack -- that check is the '
  'whole anti-proxy argument, because it is the one thing nothing below the agent '
  'can produce.';

comment on column agentbridge.session_registrations.last_ack_at is
  'When the AGENT last closed the round trip. Liveness is computed from THIS, never '
  'from heartbeat_at -- a heartbeat proves a process is running and a poll proves a '
  'supervisor is re-arming. Neither proves anybody is home.';

comment on column agentbridge.session_registrations.probe_attempts is
  'Consecutive unanswered probes. Five before a session is called silent, because '
  'one missed round trip is indistinguishable from a slow model turn -- and calling '
  'that dead is how the roster told the owner an agent had died forty-five seconds '
  'after it sent a message. Reset to 0 by any valid ack.';

-- THE VIEW MUST GROW WITH THE TABLE, AND IT WOULD NOT HAVE.
--
-- public.session_registrations is a VIEW with an explicit column list, and the
-- edge function reads and writes through PostgREST — so without this the four
-- new columns are invisible to every reader, and the first write naming one
-- fails PGRST204. That exact omission caused an outage on this project once
-- already; CLAUDE.md records it. Checked live rather than assumed: the view
-- listed the same 13 columns as the table, so it had never drifted, and adding
-- to the table alone is precisely what would have broken it.
--
-- `create or replace`, NOT drop+create. The new columns APPEND, so nothing has
-- to be reordered — and replace preserves the ACL. DROP would discard it, and
-- pg_default_acl on this project hands ALL back to anon and authenticated on
-- any newly created relation in public. The sibling migration in this range
-- learned that the expensive way, from a blind audit, one commit before this.
create or replace view public.session_registrations
with (security_invoker = true)
as select
  session_id,
  agent_id,
  machine_id,
  repo_id,
  worktree_id,
  lane_id,
  capacity,
  head_sha,
  verification_state,
  heartbeat_at,
  created_at,
  updated_at,
  registered_by,
  probe_id,
  probe_sent_at,
  last_ack_at,
  probe_attempts
from agentbridge.session_registrations;
