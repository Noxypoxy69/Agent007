import { loadConfig, loadRegistry } from './config.mjs';
import { collect } from './collect.mjs';
import { publish } from './client.mjs';
import { HOSTED, classifyStatus } from './hostedRegistry.mjs';

const log = (...a) => console.log(new Date().toISOString(), ...a);

export async function runDaemon({ once = false } = {}) {
  const cfg = await loadConfig();
  if (!cfg) { console.error('Not initialised. Run: agentbridge init --bridge-url <url>'); process.exit(2); }

  // Fail loudly rather than publishing from a machine whose secret is
  // unsealable or whose config file is readable by others.
  if (cfg.bridgeUrl) {
    const st = cfg.secretStatus;
    if (!st.unsealed) {
      console.error(`refusing to start: machine secret unavailable (${st.reason}). Run: agentbridge doctor`);
      process.exit(3);
    }
    if (!st.permissionsOk) {
      console.error(`refusing to start: config permissions too broad (${st.permissions.scheme}). Run: agentbridge doctor`);
      process.exit(3);
    }
    if (st.weakOnWindows) {
      console.error('refusing to start: secret stored in plaintext on Windows. Run: agentbridge init');
      process.exit(3);
    }
  }

  let stop = false;
  const shutdown = () => { stop = true; log('shutdown requested'); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let backoff = 0;

  // Latched so a refused credential is stated once, not every interval.

  let refusedAnnounced = false;
  do {
    // Registry is re-read every tick, so `agentbridge register` takes effect
    // without restarting the daemon.
    const registry = await loadRegistry();
    let payload;
    try {
      payload = await collect(cfg, registry);
    } catch (e) {
      log('collect failed:', e.message);
      await sleep(5000);
      continue;
    }

    if (!cfg.bridgeUrl) {
      log(`local-only: ${payload.sessions.length} session(s); no bridgeUrl configured`);
    } else {
      const r = await publish(cfg, payload);
      if (r.ok && r.accepted) {
        backoff = 0;
        refusedAnnounced = false;
        log(`published ${payload.sessions.length} session(s)`);
      } else if (r.status && classifyStatus(r.status) === HOSTED.REJECTED) {
        /*
         * A REFUSED CREDENTIAL IS NOT A TRANSIENT FAILURE, AND BACKOFF SAID IT
         * WAS.
         *
         * Every failure used to double the delay to a two-minute ceiling and
         * retry forever. On this path a 401 means the machine signature or the
         * registration is wrong -- an operator has to fix it, and no amount of
         * waiting will. So the daemon logged the same line every two minutes
         * indefinitely while implying, by backing off, that it was waiting for
         * something to clear.
         *
         * Three things change and no more. It says so ONCE, naming the cause
         * and what fixes it. It stops escalating, because escalation is the lie.
         * And it keeps running at the base interval, so local registration
         * still works and a corrected secret recovers on its own without
         * anybody restarting anything.
         */
        backoff = 0;
        if (!refusedAnnounced) {
          refusedAnnounced = true;
          log(
            `publish REFUSED (${r.status ?? '-'}): ${r.reason ?? 'credential rejected'}. `
              + 'The machine signature or registration is wrong; this cannot succeed until '
              + 'that is fixed. Continuing local-only and will resume automatically.',
          );
        }
      } else {
        backoff = Math.min(backoff ? backoff * 2 : 5_000, 120_000);
        log(`publish failed (${r.status ?? '-'} ${r.reason ?? 'unknown'}); backoff ${backoff / 1000}s`);
      }
    }
    if (once) return payload;
    const base = Math.max(3, cfg.intervalSeconds) * 1000;
    // Jitter so parallel daemons on one machine do not sync up into a burst.
    await sleep(backoff || base + Math.floor(Math.random() * 1000));
  } while (!stop);
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
