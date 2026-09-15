import http from 'node:http';
import { verify } from '../src/sign.mjs';
import { getMachine, consumeNonce, bumpRate, recordHeartbeat, listSessions, getLanes, checkReaderToken } from './store.mjs';
import { detectCollisions } from './collisions.mjs';
import { buildMcpServer } from '../mcp/tools.mjs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MAX_BODY = 2 * 1024 * 1024;       // 2 MB
const RATE_PER_MIN = Number(process.env.AB_RATE_PER_MIN || 30);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;

// ── ingest ──────────────────────────────────────────────────────────────────
async function handleHeartbeat(req, res) {
  const machineId = String(req.headers['x-ab-machine'] || '');
  if (!UUID.test(machineId)) return send(res, 401, { accepted: false, reason: 'bad-machine-id' });

  const machine = await getMachine(machineId);
  // Same response shape and cost whether the machine is unknown or the
  // signature is wrong, so this endpoint is not a machine-ID oracle.
  if (!machine) return send(res, 401, { accepted: false, reason: 'unauthorized' });

  let body;
  try { body = await readBody(req); }
  catch (e) { return send(res, 413, { accepted: false, reason: String(e.message) }); }

  const v = verify({
    machineId,
    timestamp: req.headers['x-ab-timestamp'],
    nonce: String(req.headers['x-ab-nonce'] || ''),
    body,
    signature: String(req.headers['x-ab-signature'] || ''),
    secret: machine.secret,
  });
  if (!v.ok) return send(res, 401, { accepted: false, reason: v.reason === 'timestamp-out-of-window' ? v.reason : 'unauthorized' });

  if (!(await consumeNonce(machineId, String(req.headers['x-ab-nonce'])))) {
    return send(res, 409, { accepted: false, reason: 'replay-detected' });
  }
  const rate = await bumpRate(machineId, RATE_PER_MIN);
  if (!rate.allowed) return send(res, 429, { accepted: false, reason: 'rate-limited' });

  let payload;
  try { payload = JSON.parse(body); } catch { return send(res, 400, { accepted: false, reason: 'bad-json' }); }
  if (payload?.schema !== 'agentbridge.heartbeat.v1') {
    return send(res, 400, { accepted: false, reason: 'unknown-schema' });
  }
  if (!Array.isArray(payload.sessions)) return send(res, 400, { accepted: false, reason: 'bad-sessions' });

  await recordHeartbeat(machineId, payload);
  // Response carries no instruction. The daemon reads `accepted` and nothing else.
  return send(res, 200, { accepted: true, sessions: payload.sessions.length });
}

// ── read API ────────────────────────────────────────────────────────────────
async function handleState(req, res) {
  const label = await checkReaderToken(bearer(req));
  if (!label) return send(res, 401, { error: 'unauthorized' });
  const [sessions, lanes] = await Promise.all([listSessions(), getLanes()]);
  return send(res, 200, { sessions, collisions: detectCollisions(sessions, { lanes }) });
}

// ── MCP over streamable HTTP (this is the endpoint ChatGPT connects to) ──────
async function handleMcp(req, res) {
  const label = await checkReaderToken(bearer(req));
  if (!label) return send(res, 401, { error: 'unauthorized' });

  let parsed;
  if (req.method === 'POST') {
    try { parsed = JSON.parse(await readBody(req)); }
    catch { return send(res, 400, { error: 'bad-json' }); }
  }
  // Stateless: a fresh server+transport per request, so concurrent readers
  // cannot observe or disturb each other's sessions.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); });
  const server = buildMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/v1/health') return send(res, 200, { ok: true, service: 'agentbridge', step: 1 });
    if (url.pathname === '/v1/heartbeat' && req.method === 'POST') return await handleHeartbeat(req, res);
    if (url.pathname === '/v1/state' && req.method === 'GET') return await handleState(req, res);
    if (url.pathname === '/mcp') return await handleMcp(req, res);
    return send(res, 404, { error: 'not-found' });
  } catch (e) {
    console.error('unhandled:', e);
    return send(res, 500, { error: 'internal' });   // never leak internals to the client
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => console.log(`agentbridge bridge listening on :${port}`));
