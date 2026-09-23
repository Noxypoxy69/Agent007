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
/**
 * DID THE PAYLOAD LEAVE THIS MACHINE? An ALLOWLIST, and the default is "we do not know".
 *
 * MEASURED, win32 / node v24.19.0, real sockets, full error graph walked:
 *
 *   refused (closed port)    TypeError   cause.code ECONNREFUSED    nothing sent
 *   DNS failure              TypeError   cause.code ENOTFOUND       nothing sent
 *   reset ON CONNECT         TypeError   cause.code ECONNRESET      nothing sent
 *   reset AFTER body read    TypeError   cause.code UND_ERR_SOCKET  64 bytes received
 *   timeout after body read  AbortError  code 20                    64 bytes received
 *   refused via port 1       TypeError   cause has NO CODE AT ALL   nothing sent
 *
 * ECONNRESET IS DELIBERATELY NOT CLASSIFIED, and that is the whole reason this is
 * an allowlist. It appears above with nothing sent, but a reset arriving after the
 * body was written is equally capable of surfacing as ECONNRESET -- the measured
 * case only avoided it because the server closed politely enough to give
 * UND_ERR_SOCKET instead. Putting it on the definite side would re-create the
 * original defect: a committed write reported as a certain failure.
 *
 * THE DEFAULT IS 'unknown' BECAUSE THE ERRORS RUN IN OPPOSITE DIRECTIONS.
 * Wrongly saying DEFINITELY-NOT-SENT about a write that landed causes a retry to
 * duplicate a committed row. Wrongly saying UNKNOWN about a write that never left
 * causes an operator to hesitate. The first corrupts data; the second costs a
 * moment. So only positively-measured pre-connection codes are classified, and
 * every code not listed here -- including ones nobody has met yet -- stays unknown.
 *
 * CLAUDE.md rule 8 is the reason it is shaped this way rather than as a list of
 * "these mean failed": an adversarial probe bounds nothing, so this does not claim
 * to enumerate every pre-send failure. It claims two that were measured and
 * refuses to guess at the rest.
 *
 * NOT LOOKED FOR, AND SAFE BY DEFAULT: code-c expected a nested AggregateError of
 * per-address attempts on this platform. It did not reproduce -- every measured
 * case carried a single flat `cause` -- but a multi-homed remote host may still
 * produce one. It was not tested, so it is not read; an unrecognised shape falls
 * through to 'unknown', which is the harmless direction.
 *
 * EXPORTED so the suite can assert the matcher directly. Deciding ECONNRESET
 * stays unknown is not something a socket test can demonstrate without contriving
 * the exact reset timing, and CLAUDE.md rule 10 says put the decision where the
 * tests can reach it.
 *
 * @returns 'none' when nothing can have been transmitted, otherwise 'unknown'.
 */
const DEFINITELY_NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND']);

export function classifyDelivery(e) {
  const code = e?.cause?.code ?? e?.code ?? null;
  return DEFINITELY_NOT_SENT.has(code) ? 'none' : 'unknown';
}

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
    /*
     * NOBODY ANSWERED. WHETHER THE PAYLOAD ARRIVED IS A SEPARATE QUESTION, AND
     * CONFLATING THE TWO IS A LIE IN WHICHEVER DIRECTION YOU PICK.
     *
     * The old return said `ok:false` and nothing else, so the caller printed
     * "publish failed" for a bridge that had RECEIVED the body, committed it and
     * gone quiet -- and a watcher then republished a write that had landed.
     * Measured against a local server that recorded 64 bytes and never replied.
     *
     * The first repair over-corrected and called EVERY transport failure
     * indeterminate, which told an operator whose bridge was simply DOWN that the
     * beat "may have landed" and that retrying might duplicate it. That advice is
     * inverted for the commonest failure there is, and it is the same lie pointing
     * the other way -- the one this function already avoids for local refusals.
     *
     * So delivery is CLASSIFIED, from codes measured on this platform with real
     * sockets rather than assumed from documentation. See classifyDelivery.
     */
    const code = e?.cause?.code ?? e?.code ?? null;
    return {
      ok: false,
      delivery: classifyDelivery(e),
      /*
       * THE CODE IS CARRIED INTO `reason`, BECAUSE "fetch failed" ON ITS OWN TELLS
       * AN OPERATOR NOTHING.
       *
       * fetch puts the useful part in `cause`: the top-level message for a refused
       * connection, a DNS failure and a mid-flight reset is the identical string
       * "fetch failed". Reporting only that produces "nothing was sent (fetch
       * failed)", which names the conclusion and hides the evidence for it -- and
       * this is the one place an operator finds out their bridge is down.
       *
       * Found by a precondition assertion: a test asserting the CLI names
       * ECONNREFUSED failed in BOTH trees, which is the signature of an assertion
       * that is not measuring the code. It was not measuring it because the code
       * never got out of this function.
       *
       * `typeof code === 'string'` guards deliberately: an AbortError carries the
       * numeric DOMException code 20, which is not something to show anybody.
       * Local information only -- nothing here comes from a bridge response.
       */
      reason: e.name === 'AbortError' ? 'timeout'
        : typeof code === 'string' ? `${e.message}: ${code}`
          : String(e.message),
    };
  } finally { clearTimeout(timer); }
}
