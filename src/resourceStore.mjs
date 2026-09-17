import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { HOME } from './config.mjs';
import { readResources, appendBounded, isLowMemory } from './machineResources.mjs';

/**
 * The on-disk half of the resource diagnostic. All the judgement is in
 * machineResources.mjs; this file reads, appends and writes, and carries no
 * policy — the split CLAUDE.md asks for, so the branches that matter stay
 * testable without a filesystem.
 *
 * LOCAL ONLY, AND DELIBERATELY. Putting this in the heartbeat payload would
 * change the hosted schema, which is production and needs a migration and an
 * owner's decision. The question — "what did the machine have when the beat
 * stopped landing?" — is answerable entirely on the machine that has the
 * problem, so it is answered there and nothing is asked of anybody.
 */
const FILE = () => path.join(HOME, 'resources.json');

export async function readHistory() {
  try {
    const raw = await readFile(FILE(), 'utf8');
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    // Absent, unreadable or corrupt are all "no history yet". This is a
    // diagnostic; refusing to start because its own log is malformed would be
    // the tail wagging the dog.
    return [];
  }
}

/**
 * Record one sample. Returns the reading, or null if nothing could be written.
 *
 * NEVER THROWS, AND THE CALLER IS A HEARTBEAT. A diagnostic that can fail the
 * beat it observes turns a memory question into a missed beat, precisely when
 * the machine is least able to afford one.
 *
 * `beatFailed` is the field this exists for. Free memory alone is a curiosity;
 * free memory AT THE MOMENT A BEAT DID NOT LAND is the correlation three
 * separate agents asserted without evidence.
 */
export async function recordSample({ beatFailed = null, command = null, now = null } = {}) {
  try {
    const reading = {
      ...readResources(os, { now: now ?? new Date().toISOString() }),
      beatFailed,
      command,
    };
    const next = appendBounded(await readHistory(), reading);
    await mkdir(path.dirname(FILE()), { recursive: true });
    await writeFile(FILE(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return reading;
  } catch {
    return null;
  }
}

/** A one-line summary for the operator, or null when nothing could be read. */
export function describe(reading) {
  if (!reading) return null;
  const { memFreeMb, memTotalMb, memFreePct } = reading;
  if (memFreeMb === null || memTotalMb === null) return 'memory: unknown on this platform';
  const low = isLowMemory(reading) ? '  LOW' : '';
  return `memory: ${memFreeMb} MB free of ${memTotalMb} (${memFreePct}%)${low}`;
}
