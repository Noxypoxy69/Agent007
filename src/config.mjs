import { homedir, hostname, platform } from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { protectSecret, unprotectSecret, verifyPermissions, hardenPermissions, isWindows } from './secretstore.mjs';

export const VERSION = '0.2.0';
export const HOME = process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge');
export const CONFIG_FILE = path.join(HOME, 'config.json');
export const REGISTRY_FILE = path.join(HOME, 'registry.json');

const DEFAULTS = {
  bridgeUrl: null,
  intervalSeconds: 10,
  mainRef: 'origin/main',
  redactSensitivePaths: true,
  // Strip the operator's home directory from transmitted paths. Identity, not
  // secrets -- see redactHome() in redact.mjs.
  redactHomePaths: true,
  lockDirs: ['.agentbridge/locks', '.locks'],
  lanesFile: null,
};

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, data, secret = false) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  // chmod is a no-op on Windows. Documented in THREAT_MODEL.md: on Windows the
  // secret is protected by the user profile ACL, not by file mode.
  if (secret) {
    try { await chmod(file, 0o600); } catch {}     // real on POSIX, no-op on Windows
    if (isWindows()) await hardenPermissions(file); // the real protection on Windows
  }
}

/**
 * Loads config and unseals the machine secret.
 * Returns the config with `secret` (plaintext, in memory only) plus
 * `secretStatus` describing how it was stored and whether the file
 * permissions actually protect it.
 */
export async function loadConfig({ requireSecret = false } = {}) {
  const raw = await readJson(CONFIG_FILE, null);
  if (!raw) return null;
  const cfg = { ...DEFAULTS, ...raw };

  const stored = cfg.secretStore ?? cfg.secret ?? null;
  const un = await unprotectSecret(stored);
  const perms = await verifyPermissions(CONFIG_FILE);

  cfg.secret = un.ok ? un.secret : null;
  cfg.secretStatus = {
    scheme: un.scheme ?? null,
    unsealed: un.ok,
    reason: un.reason ?? null,
    permissionsOk: perms.ok,
    permissions: perms,
    // A plaintext secret on Windows is the exact gap this release closes.
    weakOnWindows: isWindows() && un.scheme === 'plaintext',
  };
  delete cfg.secretStore;

  if (requireSecret && !un.ok) {
    throw new Error(`machine secret unavailable: ${un.reason}. Re-run: agentbridge init`);
  }
  return cfg;
}

export async function initConfig({ bridgeUrl, secret, label } = {}) {
  const existing = await readJson(CONFIG_FILE, null);

  // Reuse an existing secret rather than silently rotating it and breaking
  // the machine's registration on the bridge.
  let plaintext = secret;
  if (!plaintext && existing) {
    const prev = await unprotectSecret(existing.secretStore ?? existing.secret ?? null);
    if (prev.ok) plaintext = prev.secret;
  }
  plaintext ??= randomBytes(32).toString('hex');

  const sealed = await protectSecret(plaintext);
  const cfg = {
    ...DEFAULTS,
    ...(existing || {}),
    machineId: existing?.machineId || randomUUID(),
    machineLabel: label || existing?.machineLabel || hostname(),
    bridgeUrl: bridgeUrl ?? existing?.bridgeUrl ?? null,
    secretStore: sealed,
  };
  delete cfg.secret;                                  // never persist plaintext under this key
  await writeJson(CONFIG_FILE, cfg, true);

  const perms = await verifyPermissions(CONFIG_FILE);
  return { ...cfg, secret: plaintext, sealScheme: sealed.scheme,
    degraded: sealed.degraded ?? false, degradedReason: sealed.degradedReason ?? null,
    permissions: perms };
}

export async function loadRegistry() {
  return readJson(REGISTRY_FILE, { agents: [] });
}

export async function saveRegistry(reg) { await writeJson(REGISTRY_FILE, reg); }

export async function registerAgent({ agentId, lane, worktree }) {
  const reg = await loadRegistry();
  const abs = path.resolve(worktree);
  const idx = reg.agents.findIndex((a) => a.agentId === agentId);
  const rec = { agentId, lane, worktree: abs, registeredAt: new Date().toISOString() };
  if (idx >= 0) reg.agents[idx] = { ...reg.agents[idx], ...rec };
  else reg.agents.push(rec);
  await saveRegistry(reg);
  return rec;
}

export async function unregisterAgent(agentId) {
  const reg = await loadRegistry();
  reg.agents = reg.agents.filter((a) => a.agentId !== agentId);
  await saveRegistry(reg);
}

/**
 * A stable, opaque name for this machine.
 *
 * Derived from the machineId, which is already a random uuid generated at init
 * and never transmitted in full. Stable across restarts because it is a pure
 * function of that id, so a reader watching the bridge sees one continuous
 * machine rather than a new one each boot -- which a random-per-run name would
 * produce, quietly breaking every "is this the same box" comparison.
 *
 * Six hex characters. Enough to distinguish the machines one person runs;
 * short enough to read aloud. It is not a secret and is not required to be
 * unguessable -- it just must not be a person.
 */
export function opaqueMachineName(machineId) {
  const hex = String(machineId ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return `machine-${(hex || '000000').slice(0, 6)}`;
}

/**
 * What identifies this machine TO THE BRIDGE.
 *
 * `hostname` and the operator's chosen label are deliberately absent. Both
 * carried a person: the label was "danny-win" and the hostname
 * "DESKTOP-VPIUDEF", and neither earns anything for coordination that
 * `machine-7f3c2a` does not. The friendly label still exists in config and is
 * shown in LOCAL output -- an operator should see their own machine named the
 * way they named it. It simply does not leave the box.
 *
 * This is the third identity leak in the same payload, after the home path in
 * two spellings. They keep arriving as side effects of reporting something
 * else, which is why the test asserts on the SHAPE of the payload rather than
 * on the three fields known to have been wrong.
 */
export function machineInfo(cfg) {
  return {
    id: cfg.machineId,
    name: opaqueMachineName(cfg.machineId),
    platform: platform(),
    agentbridgeVersion: VERSION,
  };
}

/** Local-only view: the friendly name the operator chose, for their own eyes. */
export function localMachineLabel(cfg) {
  return cfg.machineLabel || hostname();
}
