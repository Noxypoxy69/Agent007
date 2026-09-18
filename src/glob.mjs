/**
 * Minimal, dependency-free glob -> RegExp for lane path-ownership rules.
 * Supports: ** (crosses /), * (within a segment), ? (one non-/ char).
 * Deliberately not a full glob implementation; lanes.yml rules are simple
 * and a small tested matcher beats an untested dependency here.
 */
export function globToRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += '\\' + c;
    else if (c === '/') out += '/';
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

export function matchesAny(p, patterns) {
  const norm = String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  return patterns.some((pat) => globToRegex(String(pat).replace(/\\/g, '/')).test(norm));
}

/**
 * Given lanes {laneName: [globs]} and a path, return the owning lane name,
 * or null if unclaimed. First match wins, so order in lanes.yml is meaningful.
 */
export function ownerOf(p, lanes) {
  for (const [lane, patterns] of Object.entries(lanes || {})) {
    if (matchesAny(p, patterns || [])) return lane;
  }
  return null;
}
