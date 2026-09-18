-- THE CLOUDFLARE CRON NEVER FIRED, SO THE SCHEDULE MOVES TO WHERE THE WORK IS.
--
-- The trigger was registered at 14:25:35 UTC on 2026-09-15 and read back from
-- the Cloudflare API as present. In the 95 minutes that followed it produced
-- ZERO invocations -- confirmed three ways: a connected `wrangler tail` that
-- captured a positive-control GET but no scheduled event, the analytics API
-- reporting 0 invocations across windows where it should have reported ~95, and
-- an empty proposals table. The Worker code, its three secrets and the
-- /dispatch endpoint were all proven good by calling /dispatch by hand, which
-- returned 200 and wrote a proposal. The fault was never on this side.
--
-- So pg_cron calls /dispatch directly. The data plane already lives in this
-- project, which makes Cloudflare a hop that bought nothing but a scheduler
-- that did not run.
--
-- THERE IS STILL EXACTLY ONE SCHEDULER. The Cloudflare trigger is removed in
-- the same change; two schedulers preparing the same proposal set would each
-- supersede the other's open rows every minute.
create extension if not exists pg_cron;
create extension if not exists pg_net;
