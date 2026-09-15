/**
 * Path classification. The daemon never transmits file *contents*; this module
 * additionally decides which file *paths* are safe to transmit.
 *
 * Tradeoff, stated plainly: a redacted path loses coordination signal. Knowing
 * ".env is dirty in code-b" is useful. We default to redacting anyway, because
 * the coordination value is low and the blast radius of leaking a secret-store
 * filename into a hosted database is not. Set redactSensitivePaths:false in
 * config to send real paths.
 */
const SENSITIVE = [
  { re: /(^|[\\/])\.env($|\.|[\w.-]*$)/i, tag: 'env' },
  { re: /(^|[\\/])\.npmrc$/i, tag: 'npmrc' },
  { re: /(^|[\\/])\.netrc$/i, tag: 'netrc' },
  { re: /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)/i, tag: 'ssh-key' },
  { re: /\.(pem|pfx|p12|jks|keystore)$/i, tag: 'key-material' },
  { re: /(^|[\\/])(secrets?|credentials?)([\\/.]|$)/i, tag: 'secret-store' },
  { re: /(service[-_]?account|gcp[-_]?key).*\.json$/i, tag: 'service-account' },
  { re: /\.(key|crt|cer)$/i, tag: 'key-material' },
];

/**
 * Replace the operator's home directory with `~`.
 *
 * A DIFFERENT PROBLEM FROM THE ONE ABOVE, and it was hidden by the similar
 * name. redactSensitivePaths decides whether a SECRET-BEARING FILENAME is
 * transmitted. It says nothing about the operator's identity, and the identity
 * is in every path: a worktree reported as
 *
 *   C:\Users\DANNY GARCIA\Documents\social-sparks-code-c
 *
 * carries a real person's full name, twice per session, in a payload bound for
 * a hosted database and from there to whatever model reads the MCP surface.
 * Nobody decided to disclose that; it arrived as a side effect of reporting
 * where a worktree is.
 *
 * The identity earns nothing for coordination. `~\Documents\social-sparks-code-c`
 * still distinguishes worktrees, still matches against a lane's declared
 * worktree name, and still reads clearly in a collision message. The full name
 * is pure leakage.
 *
 * Applied to TRANSMITTED state only. Local output keeps real paths -- an
 * operator looking at their own machine should see their own machine, and a
 * path they cannot paste into a terminal is a worse tool.
 *
 * Case-insensitive on Windows because `C:\Users\X` and `c:\users\x` are the
 * same directory, and separator-normalised because git reports forward slashes
 * for a worktree the OS reports with backslashes -- the same path arrived in
 * both spellings in one payload, and matching only one of them would have
 * redacted half the occurrences and left the other half in place, which looks
 * exactly like working redaction.
 */
export function redactHome(p, home, enabled = true) {
  if (!enabled || typeof p !== 'string' || !home) return p;
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const np = norm(p);
  const nh = norm(home);
  if (!nh) return p;

  const hay = process.platform === 'win32' ? np.toLowerCase() : np;
  const needle = process.platform === 'win32' ? nh.toLowerCase() : nh;

  if (hay === needle) return '~';
  if (!hay.startsWith(`${needle}/`)) return p;

  const rest = np.slice(nh.length + 1);
  return `~${sep}${sep === '\\' ? rest.replace(/\//g, '\\') : rest}`;
}

/**
 * Is this still an absolute path of any flavour, on any platform?
 *
 * Deliberately not `path.isAbsolute`: that answers for the platform running
 * the check, and a payload collected on Windows can be scanned anywhere. All
 * three shapes have to be recognised wherever this runs.
 */
export function isAbsoluteLike(p) {
  if (typeof p !== 'string' || !p) return false;
  return /^[A-Za-z]:[\\/]/.test(p)      // C:\ or C:/
    || /^[\\/]{2}[^\\/]/.test(p)        // \\server\share (UNC)
    || /^\//.test(p);                   // POSIX
}

/**
 * A worktree path safe to transmit: home-relative, or failing that, a bare name.
 *
 * WHY redactHome IS NOT ENOUGH, found 2026-09-15 when publish() began refusing
 * its own heartbeat. redactHome rewrites a path that starts with the home
 * directory AS A STRING. Two real cases slip past it and ship absolute:
 *
 *   8.3 SHORT NAMES. `C:\Users\DANNYG~1\AppData\Local\Temp\x` and
 *   `C:\Users\DANNY GARCIA\AppData\Local\Temp\x` are the same directory, and
 *   Windows hands out the short form freely -- every temp path on this machine
 *   is spelled that way. As a string it does not start with home, so it was
 *   never relativised. The operator's name is still in it, just abbreviated,
 *   and `DANNYG~1` is not meaningfully less identifying than `DANNY GARCIA`.
 *   Resolving the long form is the caller's job (it needs the filesystem);
 *   passing both spellings here is the pure half.
 *
 *   A WORKTREE OUTSIDE HOME. `D:\work\repo` has no home prefix to strip, so it
 *   came through untouched -- fully absolute, disclosing the machine's layout.
 *
 * Neither earns anything for coordination. What the payload needs is to tell
 * worktrees apart and match a lane's declared worktree name; the final segment
 * does both. So: relativise to home where possible, and where it is not,
 * transmit the name alone rather than the route to it.
 *
 * `home` accepts one spelling or several. Several is the point -- long form and
 * 8.3 form are the same identity surface and both must be stripped.
 */
export function portableWorktree(p, home, enabled = true) {
  if (!enabled || typeof p !== 'string' || !p) return p;

  const homes = (Array.isArray(home) ? home : [home]).filter(
    (h) => typeof h === 'string' && h.length,
  );
  for (const h of homes) {
    const r = redactHome(p, h, true);
    if (r !== p) return r;             // matched one spelling; done
  }

  if (!isAbsoluteLike(p)) return p;    // already relative: nothing to disclose

  // No home matched and it is absolute. Keep the distinguishing part, drop the
  // route. Split on both separators: a Windows path can arrive slash-spelled.
  const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return name && name !== p ? name : p;
}

export function classifyPath(p) {
  for (const { re, tag } of SENSITIVE) if (re.test(p)) return tag;
  return null;
}

export function redactPath(p, enabled = true) {
  const tag = classifyPath(p);
  if (!tag) return { path: p, sensitive: false };
  if (!enabled) return { path: p, sensitive: true, tag };
  return { path: `<<redacted:${tag}>>`, sensitive: true, tag };
}

export function redactPaths(entries, enabled = true) {
  return entries.map((e) => {
    const r = redactPath(e.path, enabled);
    return { ...e, ...r };
  });
}
