import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AGENT BRIDGE COORDINATION DATA ONLY. NO WE'RE LOCAL PRODUCTION DATA.
 *
 * The owner's rule, 2026-09-15, on standing up the dedicated Supabase project
 * `agentbridge` (ornbhvaijcpsbcgquzhd) alongside We're Local production
 * (utiohjobvadbsxstzaph):
 *
 *   "Agent Bridge coordination data only. No We're Local customer/business
 *    production data goes into it."
 *
 * That rule was true the moment it was written -- bridge/schema.sql references
 * no product table, and a live audit of the project found exactly ten
 * relations, all of them Agent Bridge's own. This file exists because that is a
 * fact about today, and the same owner's standing instruction is that a
 * precondition must be machine-verifiable rather than prose:
 *
 *   "gates that depend on runtime configuration need runtime-verifiable
 *    preconditions, not prose comments"
 *
 * A comment saying "do not put customer data here" is exactly the prose that
 * instruction rejects. The two ways the rule actually breaks are a query
 * written against a product table, and a connection pointed at the production
 * project; both are text, so both are checkable offline with no credentials.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Agent Bridge holds a service-role key.
 * A single query joining coordination state to `contacts` or `business_owners`
 * would pull customer PII into a system whose entire threat model is built on
 * it holding none -- heartbeats are append-only and retained 48h, lanes are
 * world-shaped, and nothing here was designed to carry a person's phone number.
 * The separation is load-bearing, not tidiness.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The production project. Nothing in this repository may address it. */
const PRODUCTION_PROJECT_REF = 'utiohjobvadbsxstzaph';

/** This repository's own project, for the assertion that the check can see. */
const COORDINATION_PROJECT_REF = 'ornbhvaijcpsbcgquzhd';

/**
 * Relations that belong to the We're Local product.
 *
 * Deliberately NOT a complete list of product tables -- it cannot be, and a
 * check that pretends to completeness invites trust it has not earned. These
 * are the ones carrying customer or merchant identity, which is the class the
 * rule is about. Names that could plausibly be Agent Bridge's own (`sessions`,
 * `lanes`, `machines`, `jobs`) are excluded on purpose: a check that fires on
 * a legitimate name is one somebody deletes.
 */
const PRODUCT_RELATIONS = [
  'business_owners', 'business_claims', 'businesses',
  'merchant_phone_verifications', 'reply_evals', 'business_knowledge',
  'user_roles', 'reminder_templates', 'claim_business_atomic',
  'association_members',
];

/*
 * `notifications` was on this list for about a minute and came back red against
 * clean code: bridge/worker.mjs speaks MCP, whose JSON-RPC lifecycle includes
 * `notifications/initialized`. The word belongs to the protocol as much as to
 * the product table, so it is not a usable signal -- and a gate that goes red
 * on correct code is one somebody switches off, taking the ten true checks with
 * it. Kept as a note because the next person to extend this list will reach for
 * exactly that kind of generic name.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', '.output', 'dist', 'coverage']);

/** Every source and SQL file that ships. */
async function shippedFiles() {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full); continue; }
      if (/\.(mjs|js|sql|json|toml)$/.test(e.name)) out.push(full);
    }
  }
  await walk(ROOT);
  // This file names the forbidden strings in order to check for them.
  return out.filter((f) => path.basename(f) !== 'separationOfProjects.test.mjs');
}

test('the file sweep actually sees this repository', async () => {
  // A sweep that silently found nothing would make every assertion below pass
  // loudest at the moment it stopped looking. This is the positive control.
  const files = await shippedFiles();
  assert.ok(files.length > 30, `sweep found only ${files.length} files`);
  const rel = files.map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  for (const must of ['bridge/schema.sql', 'bridge/httpStore.mjs', 'src/collect.mjs']) {
    assert.ok(rel.includes(must), `sweep missed ${must}`);
  }
});

test('nothing in this repository addresses the production project', async () => {
  const offenders = [];
  for (const f of await shippedFiles()) {
    const src = await readFile(f, 'utf8');
    if (src.includes(PRODUCTION_PROJECT_REF)) {
      offenders.push(path.relative(ROOT, f).replace(/\\/g, '/'));
    }
  }
  assert.deepEqual(
    offenders, [],
    `These files reference the We're Local PRODUCTION project (${PRODUCTION_PROJECT_REF}):\n  `
    + offenders.join('\n  ')
    + `\n\nAgent Bridge talks to ${COORDINATION_PROJECT_REF} only. It holds a service-role\n`
    + 'key; pointing it at production would give a coordination daemon unrestricted\n'
    + 'read/write over customer data.',
  );
});

test('no query is written against a We\'re Local product relation', async () => {
  const offenders = [];
  for (const f of await shippedFiles()) {
    const src = await readFile(f, 'utf8');
    for (const rel of PRODUCT_RELATIONS) {
      // Word-boundary, so `businesses` does not fire on `business` in prose.
      if (new RegExp(`\\b${rel}\\b`).test(src)) {
        offenders.push(`${path.relative(ROOT, f).replace(/\\/g, '/')} references ${rel}`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'Agent Bridge is reaching into We\'re Local product data:\n  ' + offenders.join('\n  ')
    + '\n\nCoordination data only. A join from heartbeats to a customer table would put\n'
    + 'PII into a store designed to hold none -- 48h retention, append-only, and no\n'
    + 'encryption at the field level, because nothing here was ever meant to carry it.',
  );
});

test('the schema creates nothing outside its own two namespaces', async () => {
  // The other direction: not "does it read product data" but "could it become a
  // place product data lands". Every relation the schema creates must be in
  // agentbridge.*, or be one of the three public views PostgREST needs.
  const sql = await readFile(path.join(ROOT, 'bridge', 'schema.sql'), 'utf8');
  const allowedPublic = new Set(['sessions_latest', 'lanes_latest', 'reader_tokens']);

  const created = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_.]+)/gi)]
    .map((m) => m[1]);
  assert.ok(created.length >= 8, `parsed only ${created.length} relations from schema.sql`);

  const stray = created.filter((name) => {
    if (name.startsWith('agentbridge.')) return false;
    if (name.startsWith('public.')) return !allowedPublic.has(name.slice('public.'.length));
    // Unqualified names land in agentbridge via the file's `set search_path`.
    return false;
  });

  assert.deepEqual(
    stray, [],
    `schema.sql creates relations in public beyond the REST projection: ${stray.join(', ')}`,
  );
});
