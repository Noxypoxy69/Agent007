-- ONE SCHEDULER, EVERY MINUTE.
--
-- The command names a function and nothing else, so no credential is stored in
-- cron.job.command. The Cloudflare trigger is removed in the same change; two
-- schedulers would each supersede the other's open proposals every minute, and
-- the open set would flap between two views of the same world.
--
-- A FAILED TICK IS HARMLESS AND DELIBERATELY NOT RETRIED. It writes proposals
-- and nothing else, so there is no partial state to repair, and the next tick
-- is sixty seconds away. A stale open set is refused by confirm_proposal as
-- stale anyway -- the guard re-runs against live rows and ignores what the
-- dispatcher recorded.
select cron.unschedule('agentbridge-dispatch')
where exists (select 1 from cron.job where jobname = 'agentbridge-dispatch');

select cron.schedule(
  'agentbridge-dispatch',
  '* * * * *',
  $job$select public.dispatch_tick()$job$
);
