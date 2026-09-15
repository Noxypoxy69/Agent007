import { sign, newNonce } from './sign.mjs';

/**
 * Publishes a heartbeat. One-way by design.
 *
 * SECURITY INVARIANT (Step 1): the response body is never interpreted as
 * instruction. It is parsed only far enough to log accepted/rejected. There is
 * no code path from an HTTP response to exec, eval, fs writes, or config
 * mutation. A fully hostile bridge can therefore lie to us, but cannot make
 * this machine do anything.
 */
export async function publish(cfg, payload, { timeoutMs = 10_000 } = {}) {
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
