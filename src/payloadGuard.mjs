/**
 * NOTHING ABOUT THE OPERATOR LEAVES THE MACHINE.
 *
 * The heartbeat used to be a local JSON blob. It is about to become rows in a
 * hosted database that an external model reads, and that changes what a stray
 * field costs: a local file nobody reads is an untidiness, the same field in a
 * hosted store is a disclosure that cannot be recalled.
 *
 * Three identity leaks were found and fixed in one payload before any of it was
 * exposed (b9623ac, 8fd7004):
 *
 *   1. `worktree` as C:\Users\<name>\Documents\... — the operator's real full
 *      name, twice per session
 *   2. the SAME path again in `git.worktree`, spelled with forward slashes,
 *      because git and the OS disagree about separators
 *   3. `machine.label` "danny-win" and `machine.hostname` "DESKTOP-VPIUDEF"
 *
 * The payload is clean today, and THAT IS THE PROBLEM THIS FILE EXISTS FOR.
 * Every one of those arrived as a side effect of reporting something else —
 * where a worktree is, what a machine is called. None was anybody's idea of
 * publishing a name. The next field somebody adds will arrive the same way, and
 * a fix is not a guarantee: a guard is.
 *
 * SO IT DOES NOT ENUMERATE KNOWN-BAD FIELDS. It walks every string at every
 * depth, through arrays and nested objects alike, and judges the VALUE. A list
 * of suspect field names would have caught none of the three above, because
 * nobody thought to check any of those fields — that is precisely why they
 * shipped.
 *
 * THE SEPARATOR TRAP IS THE SPECIFIC WAY THIS BUG HID. Leak 1 and leak 2 are
 * the same directory written two ways. Handling one spelling catches half the
 * occurrences and looks exactly like working redaction — the payload gets
 * visibly cleaner, the tests pass, and the other half ships. Every path
 * comparison here is done against both spellings, case-insensitively.
 *
 * IDENTITY IS A PARAMETER, NOT AN IMPORT. `scanPayload` takes the username,
 * home and hostname to look for, defaulted from `os`. A scanner that can only
 * see its own machine's identity can only be tested on the machine it runs on,
 * and the regression fixture for this guard has to carry an invented name — a
 * fixture carrying the operator's real name would be the leak, committed.
 */
import os from 'node:os';
import { looksSecret, tokenize } from './argv.mjs';

export const USERNAME = 'username';
export const HOME_DIRECTORY = 'home-directory';
export const HOSTNAME = 'hostname';
export const ABSOLUTE_PATH = 'absolute-path';
export const SECRET = 'secret';

/**
 * A username shorter than this is not searched for.
 *
 * Substring matching on a two-character name flags half the payload — "pi"
 * appears in "pipeline", "ci" in "precommit" — and a guard that fires on
 * everything is removed within the day. Real names on real machines are longer;
 * the short-name case is reported as a gap rather than papered over with a
 * match that cannot be trusted.
 */
const MIN_NAME = 3;

/**
 * A LABEL BUILT FROM A FIRST NAME IS STILL A NAME, and searching for the whole
 * username misses it.
 *
 * This was found by the regression fixture rather than by reasoning, which is
 * the point of having one. Leak 3 in the real incident was machine.label
 * "danny-win" — the operator's first name with a suffix. An identity of
 * "Danny Garcia" does not appear in that string, so a full-username substring
 * test scans it clean. This scanner would have missed one of the three leaks it
 * was written to catch.
 *
 * So the name is also searched for in PARTS, and parts need a boundary or they
 * are worse than useless: a three-letter first name like "Dan" occurs inside
 * "abundant", "mundane" and "redundant", and a guard that fires on those is one
 * nobody keeps. A part matches only where it is not butted against another
 * letter or digit — "jane-win" and "jane_doe" hit, "janitor" does not.
 */
function nameParts(name) {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((p) => p.length >= MIN_NAME)
    .map((p) => p.toLowerCase());
}

function containsBounded(haystack, needle) {
  const alnum = /[a-z0-9]/;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    const before = i === 0 ? '' : haystack[i - 1];
    const after = i + needle.length >= haystack.length ? '' : haystack[i + needle.length];
    if (!alnum.test(before) && !alnum.test(after)) return true;
    i = haystack.indexOf(needle, i + 1);
  }
  return false;
}

/**
 * Absolute paths, in the spellings that appear on the platforms we run on.
 *
 * THE DRIVE LETTER NEEDS A LEFT BOUNDARY, and leaving it off is not a
 * theoretical worry — it was the first thing this scanner got wrong. A bare
 * `[A-Za-z]:[\\/]` matches the "s:/" inside "https://", so every git remote URL
 * in the payload was reported as an absolute path. A guard that flags every
 * URL is noise, and noise is how a guard gets switched off.
 *
 * So the drive letter must start the string or follow something that is not a
 * word character. That still catches an embedded path — `failed at
 * C:\Users\x\y` — which the anchored-only form would miss, and a stack trace or
 * error message is exactly where a path turns up without anyone intending it.
 */
const WINDOWS_ABS = /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/;
const POSIX_HOME_ABS = /(^|[\s"'(=])\/(home|Users)\//;

/** Both spellings of a path, lower-cased, because Windows paths are case-insensitive. */
function pathForms(p) {
  if (!p) return [];
  const s = String(p);
  return [...new Set([s.replace(/\//g, '\\').toLowerCase(), s.replace(/\\/g, '/').toLowerCase()])];
}

/** What this machine would leak. Overridable so a test can scan for somebody else's name. */
export function machineIdentity(overrides = {}) {
  let username = '';
  let homedir = '';
  let hostname = '';
  try {
    username = os.userInfo().username ?? '';
  } catch {
    /* userInfo throws on some locked-down containers; an empty name is searched for never */
  }
  try {
    homedir = os.homedir() ?? '';
  } catch {
    /* as above */
  }
  try {
    hostname = os.hostname() ?? '';
  } catch {
    /* as above */
  }
  return { username, homedir, hostname, ...overrides };
}

/**
 * A short, masked excerpt of what matched.
 *
 * "There is a username somewhere in 900 lines of JSON" is not actionable, so a
 * leak carries a sample. But the report is a thing people paste into chat, so
 * the sample must not be a second copy of the leak: the middle is masked and
 * the whole is truncated. Enough to recognise the field, not enough to publish.
 */
function maskedSample(value) {
  const s = String(value);
  const short = s.length <= 72 ? s : `${s.slice(0, 48)}…${s.slice(-16)}`;
  return short.replace(/[^\s\\/:.,_@-]{3,}/g, (w) =>
    w.length <= 4 ? `${w[0]}${'*'.repeat(w.length - 1)}` : `${w.slice(0, 2)}${'*'.repeat(Math.min(w.length - 3, 8))}${w.slice(-1)}`,
  );
}

/**
 * Git object ids are long lowercase hex, and so is one of looksSecret's shapes.
 *
 * A heartbeat is FULL of commit SHAs — that is most of what it reports — so
 * running the secret detector over them unmodified marks every session as
 * leaking credentials, and the guard becomes noise on its first run.
 *
 * The cost of this exemption is stated rather than hidden: a lowercase-hex
 * secret of git-object length is not detected AS A SECRET here. It is a real
 * gap, it is in the handoff under remaining risks, and it is narrow — uppercase
 * hex, any other alphabet, and every prefixed token shape still match.
 */
const GIT_OBJECT_ID = /^[0-9a-f]{7,40}$/;

/**
 * A canonical UUID is the OPPOSITE of a leak here, and must not be flagged.
 *
 * `machine.id` is a random v4 uuid, and it exists precisely so the payload can
 * identify a machine without naming it — it is the fix for leak 3, not a
 * credential. looksSecret matches it anyway (36 chars of [A-Za-z0-9-] trips the
 * long-opaque-token shape), so the scanner's first run reported the anonymising
 * identifier as a secret. Flagging a field whose whole purpose is privacy is
 * the fastest way to teach somebody to ignore this guard.
 */
const CANONICAL_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Walk every string in the payload and report what must not be published.
 *
 * @param {unknown} payload   any JSON-shaped value
 * @param {object}  identity  {username, homedir, hostname}; defaults to this machine
 * @returns {{ok: boolean, leaks: Array<{path: string, kind: string, sample: string}>}}
 */
export function scanPayload(payload, identity = machineIdentity()) {
  const { username = '', homedir = '', hostname = '' } = identity ?? {};
  const user = username.length >= MIN_NAME ? username.toLowerCase() : '';
  const userParts = username.length >= MIN_NAME ? nameParts(username) : [];
  const host = hostname.length >= MIN_NAME ? hostname.toLowerCase() : '';
  const homes = pathForms(homedir);

  const leaks = [];
  const seen = new Set();
  const add = (path, kind, value) => {
    const key = `${path}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    leaks.push({ path, kind, sample: maskedSample(value) });
  };

  const inspect = (value, path) => {
    const low = value.toLowerCase();

    if (user && low.includes(user)) add(path, USERNAME, value);
    else if (userParts.some((part) => containsBounded(low, part))) add(path, USERNAME, value);
    // Both spellings, every time. See the header: this is how leak 2 survived.
    if (homes.some((h) => low.includes(h))) add(path, HOME_DIRECTORY, value);
    if (host && low.includes(host)) add(path, HOSTNAME, value);

    /*
     * ANY absolute path is a leak, name or no name. It discloses the shape of
     * somebody's disk to a reader who has no business knowing it, and it is the
     * carrier every identity leak so far has travelled inside.
     */
    if (WINDOWS_ABS.test(value) || POSIX_HOME_ABS.test(value)) add(path, ABSOLUTE_PATH, value);

    /*
     * One secret engine, not a second implementation: looksSecret from
     * argv.mjs is the source of truth and is applied to the whole string and to
     * each token within it, because a credential can arrive embedded in a
     * command line rather than alone in a field.
     */
    /*
     * THREE WAYS OF CUTTING THE STRING, BECAUSE ONE IS NOT ENOUGH.
     *
     * `tokenize` honours quotes — that is correct for reading a command line,
     * and it is why a secret hides from it. `curl -H "Authorization: Bearer
     * <token>"` is ONE token to a quote-aware splitter, and a token containing
     * spaces and a colon matches no credential shape, so the whole string scans
     * clean while carrying a bearer token in plain sight.
     *
     * So the value is also split on plain separators, which puts the token on
     * its own. Keeping tokenize as well matters for the opposite case: a
     * quoted argument that IS the secret, spaces and all.
     */
    const candidates = [value, ...tokenize(value), ...value.split(/[\s"'`,;=|]+/)];
    for (const tok of candidates) {
      if (!tok || GIT_OBJECT_ID.test(tok) || CANONICAL_UUID.test(tok)) continue;
      if (looksSecret(tok)) {
        add(path, SECRET, tok);
        break;
      }
    }
  };

  const walk = (node, path) => {
    if (typeof node === 'string') return inspect(node, path);
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}/${i}`));
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], `${path}/${escapePointer(k)}`);
    }
    // numbers, booleans and null carry no identity
  };

  walk(payload, '');
  return { ok: leaks.length === 0, leaks };
}

/** RFC 6901: ~ and / are escaped so a key containing a slash still points somewhere real. */
const escapePointer = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

/** Render a scan for a terminal. Wording is never asserted on; the exit code is. */
export function formatLeaks(leaks) {
  if (!leaks.length) return '';
  const width = Math.max(...leaks.map((l) => l.kind.length));
  return [
    `agentbridge: ${leaks.length} thing(s) in this payload must not be published`,
    ...leaks.map((l) => `  ${l.kind.padEnd(width)}  ${l.path || '/'}   ${l.sample}`),
  ].join('\n');
}
