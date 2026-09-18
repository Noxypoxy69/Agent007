import { sign, newNonce } from './sign.mjs';
import { scanPayload } from './payloadGuard.mjs';

/**
 * Publishes a heartbeat. One-way by design.
 *
 * SECURITY INVARIANT (Step 1): the response body is never interpreted as
 * instruction. It is parsed only far enough to log accepted/rejected. There is
 * no code path from an HTTP response to exec, eval, fs writes, or config
 * mutation. A fully hostile bridge can therefore lie to us, but cannot make
 * this machine do anything.
 *
 * SECURITY INVARIANT (Step 2): nothing about the operator leaves this machine.
 * The payload is scanned BEFORE it is serialised, signed or transmitted, and a
 * leak refuses the publish outright.
 *
 * WHY THE SCAN IS HERE AND NOT AT THE CALL SITES. payloadGuard existed and was
 * proven, and protected nothing, because no code path invoked it — a guard
 * nobody calls is the most convincing kind of decoration, green in every test
 * while the thing it guards ships unchecked. Putting it at the one place the
 * bytes actually leave means a new caller cannot forget it: `publish` is the
 * only door, so this is the only place it has to be.
 *
 * IT FAILS CLOSED, INCLUDING WHEN THE SCANNER ITSELF FAILS. A scanner that
 * throws has established nothing about the payload, and treating "the check
 * broke" as "the check passed" publishes on the strength of a test that never
 * ran. That is strictly worse than having no guard, because the operator
 * believes they were protected. So any throw refuses.
 *
 * ORDER MATTERS: THE SCAN PRECEDES THE bridgeUrl CHECK. A dirty payload is
 * reported as dirty whether or not a bridge is configured. Checking the URL
 * first would answer 'no-bridge-url' for a leaking payload, which reads as a
 * configuration problem and hides a disclosure one — and the day somebody sets
 * the URL, the leak ships with no warning ever having been printed.
 */
export async function publish(cfg, payload, { timeoutMs = 10_000, scan = scanPayload } = {}) {
  let verdict;
  try {
    verdict = scan(payload);
  } catch (e) {
    return { ok: false, reason: 'payload-scan-failed', detail: String(e?.message ?? e), leaks: [] };
  }
  /*
   * A scanner that answers anything other than a definite `ok: true` has not
   * cleared this payload. Missing, malformed or non-boolean all refuse, for the
   * same reason `data !== false` was wrong in the SMS limiter: only an explicit
   * pass is a pass.
   */
  if (!verdict || verdict.ok !== true) {
    return {
      ok: false,
      reason: 'payload-leaks',
      leaks: Array.isArray(verdict?.leaks) ? verdict.leaks : [],
    };
  }

  if (!cfg.bridgeUrl) return { ok: false, reason: 'no-bridge-url' };
  const body = JSON.stringify(payload);
  const timestamp = Date.now();
  const nonce = newNonce();
  const signature = sign({ machineId: cfg.machineId, timestamp, nonce, body, secret: cfg.secret });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(new URL('/v1/heartbeat', cfg.bridgeUrl), {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'x-ab-version': 'v1',
        'x-ab-machine': cfg.machineId,
        'x-ab-timestamp': String(timestamp),
        'x-ab-nonce': nonce,
        'x-ab-signature': signature,
      },
      body,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    // Only these two scalars are ever read. Nothing else in the response is used.
    return { ok: res.ok, status: res.status, accepted: parsed?.accepted === true,
      reason: typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 200) : null };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : String(e.message) };
  } finally { clearTimeout(timer); }
}
