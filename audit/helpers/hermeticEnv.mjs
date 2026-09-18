/**
 * A TEST MUST NOT INHERIT THE DEVELOPER'S CREDENTIALS.
 *
 * Every CLI test spawns the binary with `{ ...process.env, ...env }`, which
 * quietly hands the child whatever the operator happens to have exported. On
 * 2026-09-15 that turned the delegation suite red for one shell and green for
 * another: with AGENTBRIDGE_READER_TOKEN set, `delegate` consulted the REAL
 * hosted registry instead of the fixture's, resolved against live workers the
 * test had never created, and five assertions failed. The same commit was
 * simultaneously passing in a shell without the token.
 *
 * That is worse than a flaky test. It is a suite whose result depends on who
 * ran it, which means a green run stops being evidence -- and the failure mode
 * is silent in exactly the direction that matters, since a machine with no
 * credentials (CI) would pass while the machine doing the work would not.
 *
 * So the ambient credentials are STRIPPED rather than overridden. A test that
 * wants one sets it explicitly in its own `env`, which is then applied on top.
 */

/** Variables that must never leak from the operator's shell into a test. */
export const AMBIENT_CREDENTIALS = [
  'AGENTBRIDGE_READER_TOKEN',
  'AGENTBRIDGE_REGISTRATION_TOKEN',
  'AGENTBRIDGE_SUPABASE_URL',
  'AGENTBRIDGE_SUPABASE_KEY',
  'AGENTBRIDGE_MCP_URL',
  'AGENTBRIDGE_REGISTER_URL',
];

/**
 * process.env with the ambient credentials removed, plus the caller's own.
 *
 * @param {object} own  variables this test genuinely wants set
 */
export function hermeticEnv(own = {}) {
  const base = { ...process.env };
  for (const k of AMBIENT_CREDENTIALS) delete base[k];
  return { ...base, ...own };
}
