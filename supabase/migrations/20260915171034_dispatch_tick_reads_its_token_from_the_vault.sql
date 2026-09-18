-- THE TICK, AND WHY THE TOKEN IS NOT IN THE JOB COMMAND.
--
-- cron.job.command is stored as PLAINTEXT and is readable by anyone who can
-- select from cron.job. Scheduling `select net.http_post(..., 'Bearer abc123')`
-- would publish the dispatcher credential into a table, which is the same class
-- of mistake as committing it. So the schedule calls this function, and the
-- function reads the secret from the vault at call time.
--
-- WHAT THIS CREDENTIAL CAN DO, SO THE RISK IS STATED RATHER THAN IMPLIED: a
-- dispatcher token opens exactly one endpoint, POST /dispatch. It is in neither
-- coordinator_tokens nor reader_tokens, so every MCP tool answers it 401. It
-- cannot assign work, accept work, send a message or read the coordination log.
-- It prepares proposals, and a proposal is re-verified against live state by
-- confirm_proposal before it does anything. That is the owner's "prepare, do
-- not decide" ruling enforced by capability.
create or replace function public.dispatch_tick()
returns bigint
language plpgsql
security definer
set search_path = public, net, vault, extensions
as $fn$
declare
  tok text;
  req bigint;
begin
  select decrypted_secret into tok
    from vault.decrypted_secrets
   where name = 'bridge_dispatcher_token';

  -- REFUSE RATHER THAN CALL UNAUTHENTICATED. An unauthenticated POST would get
  -- a 401 that looks, in the response table, exactly like a revoked token --
  -- and the cause would be a missing secret nobody was told about.
  if tok is null or length(trim(tok)) = 0 then
    raise exception 'bridge_dispatcher_token is not in the vault; refusing to call /dispatch without it';
  end if;

  select net.http_post(
    url := 'https://ornbhvaijcpsbcgquzhd.supabase.co/functions/v1/mcp/dispatch',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'authorization', 'Bearer ' || tok,
      'content-type', 'application/json'
    ),
    timeout_milliseconds := 20000
  ) into req;

  return req;
end;
$fn$;

revoke execute on function public.dispatch_tick() from public, anon, authenticated;

-- A ONE-SHOT SETTER, DROPPED IN THE NEXT MIGRATION.
--
-- It existed so the token could be posted over PostgREST straight from the file
-- it already lived in, rather than being pasted through a chat transcript. It
-- was granted to service_role alone. In the event it was never used: the local
-- service-role file turned out to hold a 57-character placeholder, so the next
-- migration mints a token in-database instead and drops this.
create or replace function public.__set_dispatcher_token(tok text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $fn$
declare
  existing uuid;
begin
  if tok is null or length(trim(tok)) < 16 then
    raise exception 'refusing to store a token shorter than 16 characters';
  end if;

  select id into existing from vault.secrets where name = 'bridge_dispatcher_token';

  if existing is null then
    perform vault.create_secret(
      trim(tok),
      'bridge_dispatcher_token',
      'Opens only POST /functions/v1/mcp/dispatch. Cannot assign, accept, message or read.'
    );
    return 'created';
  end if;

  perform vault.update_secret(existing, trim(tok));
  return 'updated';
end;
$fn$;

revoke execute on function public.__set_dispatcher_token(text) from public, anon, authenticated;
grant execute on function public.__set_dispatcher_token(text) to service_role;
