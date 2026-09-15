import test from 'node:test';
import assert from 'node:assert/strict';
import {
  negotiateProtocol, SUPPORTED_PROTOCOL_VERSIONS, PROTOCOL_VERSION,
} from '../supabase/functions/mcp/_shared.js';

/**
 * ANSWERING WITH A VERSION NOBODY ASKED FOR IS HOW A CLIENT ENDS UP ON THE
 * WRONG TRANSPORT.
 *
 * initialize replied '2024-11-05' to every client regardless of what it
 * requested. That is legal and it is the wrong answer, because 2024-11-05
 * predates Streamable HTTP: a client that asks for 2025-06-18 and is told
 * 2024-11-05 can reasonably conclude this server speaks the LEGACY HTTP+SSE
 * transport, and go looking for an SSE endpoint that deliberately does not
 * exist here -- GET /mcp answers 405 by design, which is correct for
 * Streamable HTTP and fatal for the legacy one.
 *
 * The client then connects, authorizes, and lists no tools.
 *
 * That is exactly what ChatGPT presented: OAuth completed, a live read+write
 * grant in KV, the server returning all thirteen tools to a plain POST, and
 * "No app actions available yet" on screen. Every component was healthy and
 * the handshake still sent the client somewhere this server does not answer.
 *
 * This server really does speak Streamable HTTP, so it should say so.
 */

test('a version we speak is echoed back, not overridden', () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(negotiateProtocol(v), v, `asked for ${v} and got something else`);
  }
});

test('2025-06-18 is answered with itself, which is the whole bug', () => {
  // The specific case that was failing. Named separately so a future change
  // that "simplifies" the list cannot quietly drop it.
  assert.equal(negotiateProtocol('2025-06-18'), '2025-06-18');
  assert.notEqual(negotiateProtocol('2025-06-18'), '2024-11-05');
});

test('an unknown version falls back to the NEWEST we speak, not the oldest', () => {
  /*
   * Falling back to the oldest is the same trap by a different route: it tells
   * a client we predate the transport we actually implement. The newest is
   * also what the spec asks for -- respond with a version you support and let
   * the client decide whether it can live with it.
   */
  for (const v of ['2099-01-01', 'banana', '', null, undefined, 42, {}]) {
    assert.equal(negotiateProtocol(v), PROTOCOL_VERSION, `fallback wrong for ${JSON.stringify(v)}`);
  }
  assert.equal(PROTOCOL_VERSION, '2025-06-18');
  assert.equal(PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test('the list is newest-first, because the fallback depends on it', () => {
  // PROTOCOL_VERSION is SUPPORTED[0]. Re-ordering the list silently changes
  // what every unknown client is told, so the ordering is asserted rather than
  // left as a convention somebody has to notice.
  const sorted = [...SUPPORTED_PROTOCOL_VERSIONS].sort().reverse();
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, sorted);
});

test('the legacy version is still accepted when a client genuinely asks for it', () => {
  // Old clients are not broken by this. 2024-11-05 is answered with itself --
  // the fix is about not IMPOSING it on clients that asked for better.
  assert.equal(negotiateProtocol('2024-11-05'), '2024-11-05');
});
