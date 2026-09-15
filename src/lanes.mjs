import { readFile } from 'node:fs/promises';

/**
 * Lane ownership map: { laneName: [pathGlob, ...] }.
 *
 * Accepts .json, or a deliberately narrow YAML subset:
 *
 *   messaging:
 *     - scripts/check-gates-*.mjs
 *     - src/lib/reply/**
 *   onboarding:
 *     - src/lib/merchantPhone.server.ts
 *
 * Narrow on purpose. Anchors, flow sequences, multi-line scalars and nesting
 * are rejected rather than half-parsed, because a silently misparsed ownership
 * rule is worse than no rule at all.
 */
export function parseLanesYaml(text) {
  const lanes = {};
  let current = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\t/g, '  ');
    if (raw.trim().startsWith('#')) continue;          // whole-line comment
    const line = raw.replace(/\s+#.*$/, '');           // trailing comment
    if (!line.trim()) continue;

    const item = line.match(/^\s+-\s+(.*)$/);
    if (item) {
      if (!current) throw new Error(`lanes: list item before any lane name (line ${i + 1})`);
      lanes[current].push(stripQuotes(item[1].trim()));
      continue;
    }
    const key = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (key) {
      const [, name, rest] = key;
      if (rest.trim()) {
        if (rest.trim().startsWith('[')) throw new Error(`lanes: flow sequences are not supported (line ${i + 1})`);
        throw new Error(`lanes: "${name}" must be a list of globs (line ${i + 1})`);
      }
      current = name; lanes[current] = [];
      continue;
    }
    throw new Error(`lanes: unsupported syntax at line ${i + 1}: ${line.trim()}`);
  }
  return lanes;
}

const stripQuotes = (s) => s.replace(/^["'](.*)["']$/, '$1');

export async function loadLanes(file) {
  if (!file) return null;
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return null; }
  if (/\.json$/i.test(file)) {
    const o = JSON.parse(text);
    return normalise(o);
  }
  return normalise(parseLanesYaml(text));
}

function normalise(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (!Array.isArray(v)) throw new Error(`lanes: "${k}" must be an array of globs`);
    out[k] = v.map(String);
  }
  return out;
}
