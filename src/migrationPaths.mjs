/**
 * WHERE A MIGRATION PACKAGE'S FILES MAY BE, AND NOWHERE ELSE.
 *
 * ═══ THE SAME HOLE, THREE TIMES, IN TWO FILES ═══
 *
 * A migration manifest is an UNTRUSTED DOCUMENT. It arrives with the package it
 * describes, so anything that decides *where to look* by reading it is deciding
 * with the attacker's hand on the wheel. Three readers did:
 *
 *   1. the verifier's phase 1, over `items`        -- fixed in 2f242c7
 *   2. the verifier's companion loop               -- fixed in 8774fa1
 *   3. the PACKAGER's `attach()` drift re-check    -- this module
 *
 * Each fix was written by someone who had just understood the bug, and each one
 * repaired the site in front of them. The third was found by a blind audit that
 * ran `attach` against a directory with NO `state/` directory at all and got:
 *
 *     state       : 1 file(s) re-verified against the manifest, all match
 *
 * It had hashed the operator's LIVE store. `attach`'s own header promises that
 * it "re-verifies every state hash while it is there -- if a state file drifted
 * since the package was built, that is worth failing on rather than silently
 * re-blessing", and that is exactly the silent re-blessing.
 *
 * CLAUDE.md rule 8: fix the matcher, not the five strings the prober tried. A
 * function each site imports is the matcher. The fix that lives in one file's
 * private helper is three strings.
 *
 * This module is deliberately pure and dependency-free so the suite can reach
 * it (rule 10) -- the two scripts that use it are entry points and cannot be
 * imported by tests.
 */
import path from 'node:path';
import { existsSync, statSync, realpathSync } from 'node:fs';

/**
 * Whether a manifest item may be opened at all, and where.
 *
 * THE LOCATION IS DERIVED, NOT OBEYED. The packager writes exactly one value in
 * `destination_relative_to_package` -- `state/<source_relative_to_agentbridge_home>`
 * -- so the reader computes that and checks the field for AGREEMENT. A manifest
 * that disagrees is refused rather than silently ignored, because a disagreement
 * is either a format change somebody must look at or an attack.
 *
 * `source_relative_to_agentbridge_home` is then the only untrusted string left,
 * and it is confined: no absolute path, no drive letter, no `..`, no backslash,
 * no empty segment.
 *
 * @returns a refusal sentence, or null when the item is well-formed
 */
export function payloadPathProblem(item) {
  const rel = item?.source_relative_to_agentbridge_home;
  const bad = relProblem(rel);
  if (bad) return bad;

  const declared = item.destination_relative_to_package;
  const expected = `state/${rel}`;
  if (typeof declared === 'string' && declared !== expected) {
    return `the manifest says this file is at "${declared}", but a package built by scripts/migration-package.mjs always puts it at "${expected}". `
      + 'Refusing to follow the manifest to another location -- that is how a verifier ends up hashing the live store instead of the package.';
  }
  return null;
}

/** The string half, shared by items and companions. */
export function relProblem(rel) {
  if (typeof rel !== 'string' || rel === '') return 'the manifest entry carries no path';
  if (rel.includes('\\')) return `"${rel}" contains a backslash; package paths are forward-slashed`;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    return `"${rel}" is an absolute path; a manifest may only name a location INSIDE the package`;
  }
  if (rel.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    return `"${rel}" walks outside the package; a manifest may only name a location INSIDE the package`;
  }
  return null;
}

/**
 * Open a file the package claims to contain, or say why not.
 *
 * AND A STRING CHECK IS NOT ENOUGH, because the filesystem gets a vote. Nothing
 * resolved links, so a symlink or NTFS junction sitting at `state/<rel>`
 * redirects the read to one live file with no `..` anywhere in the manifest. The
 * packager was hardened against exactly this -- "readFileSync FOLLOWS LINKS" is
 * in its own commit message -- and the verifier beside it was not.
 *
 * So both halves: the manifest string is confined, and then the RESOLVED path
 * must still be a regular file inside the package. Asking the OS with
 * `realpathSync.native` rather than `realpathSync`, for the reason every other
 * resolver in this repository states -- case folding and 8.3 short names.
 *
 * @returns {{file: string}} or {{why: string}}
 */
export function insidePackage(pkgDir, rel) {
  const bad = relProblem(rel);
  if (bad) return { why: bad };

  const file = path.join(pkgDir, rel);
  if (!existsSync(file)) return { why: 'claimed by the manifest and ABSENT from the package' };

  let real;
  let rootReal;
  try {
    real = realpathSync.native(file);
    rootReal = realpathSync.native(pkgDir);
  } catch {
    return { why: `"${rel}" could not be resolved (broken link?)` };
  }
  const within = path.relative(rootReal, real);
  if (within.startsWith('..') || path.isAbsolute(within)) {
    return {
      why: `"${rel}" is a link that resolves OUTSIDE the package, to ${within.split(path.sep).slice(-2).join('/')}. `
        + 'Refusing to read it -- that is how a verifier ends up hashing the live store instead of the package.',
    };
  }
  if (!statSync(real).isFile()) return { why: `"${rel}" does not resolve to a regular file` };
  return { file: real };
}
