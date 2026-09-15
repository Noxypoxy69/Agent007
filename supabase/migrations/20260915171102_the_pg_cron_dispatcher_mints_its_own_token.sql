-- THE TOKEN IS GENERATED WHERE IT IS USED, AND NEVER TRAVELS.
--
-- The obvious move was to copy the existing dispatcher token from the secrets
-- folder into the vault. That requires the plaintext to pass through an agent's
-- tool call and therefore through a transcript, which is precisely what the
-- rule in agentbridge-secrets/README.txt forbids: "Agents read these files by
-- PIPING them into a command, never by printing them." There is no pipe into a
-- SQL tool call.
--
-- So the database mints its own. The plaintext is written straight into the
-- vault, its SHA-256 into dispatcher_tokens, and the value is returned to
-- NOBODY -- not to the migration output, not to an agent, not to a file. The
-- only reader is dispatch_tick(), which decrypts it at call time.
--
-- The existing 'bridge dispatcher cron' token is deliberately LEFT ENABLED: its
-- plaintext is in agentbridge-secrets/dispatcher-token.txt and it remains the
-- way a person triggers /dispatch by hand. Two tokens with identical, narrow
-- authority is a smaller cost than having no manual path.
do $mint$
declare
  tok text;
begin
  -- 32 bytes of CSPRNG, base64url so it survives a header without escaping.
  tok := 'abd_' || translate(
    encode(extensions.gen_random_bytes(32), 'base64'),
    '+/=', '-_'
  );

  -- The hash is what the data plane compares. The plaintext is never stored
  -- here, so a dump of this table yields nothing usable.
  insert into public.dispatcher_tokens (token_sha256, label, disabled)
  values (encode(extensions.digest(tok, 'sha256'), 'hex'), 'supabase pg_cron dispatcher', false)
  on conflict (token_sha256) do nothing;

  perform vault.create_secret(
    tok,
    'bridge_dispatcher_token',
    'Minted in-database 2026-09-15 for pg_cron. Opens only POST /functions/v1/mcp/dispatch.'
  );

  -- tok goes out of scope here and was never selected, raised or returned.
end;
$mint$;

-- The one-shot setter is no longer needed and must not outlive its purpose.
drop function if exists public.__set_dispatcher_token(text);
