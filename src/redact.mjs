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
