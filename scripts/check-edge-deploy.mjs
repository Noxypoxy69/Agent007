#!/usr/bin/env node
/**
 * WHAT YOU ARE ABOUT TO DEPLOY, AGAINST WHAT IS ALREADY SERVING TRAFFIC.
 *
 *   node scripts/check-edge-deploy.mjs <deployed-dir> <about-to-deploy-dir>
 *
 * Get the first with `supabase functions download mcp`, or from the deployed
 * bundle any other way. The second is what you are shipping.
 *
 * WHY THIS EXISTS. docs/ORDER.md item 0b describes a deploy that would have
 * REMOVED 232 lines currently serving traffic -- the single-transaction claim
 * path, the rpc shape check, the refusal-reason mapping -- and reinstated a
 * race, while looking from outside exactly like a successful deploy. "A pure
 * regression wearing a fresh version number." Nothing checked, because the
 * check was a person remembering to look.
 *
 * FOUR CHECKS, AND EVERY ONE OF THEM FAILED FOR REAL ON 2026-09-16:
 *
 *   1. NORMALISE LINE ENDINGS FIRST. The deployed copy came back CRLF and the
 *      repo is LF, so a raw comparison reported every single line changed --
 *      1813 of 1813 -- and a reader would conclude the whole file had been
 *      rewritten. That is CLAUDE.md's "grep compares wrapping, not content" in
 *      a place nobody had met it yet. Everything below compares normalised.
 *
 *   2. NOTHING MAY BE REMOVED, UNLESS YOU SAY HOW MANY. Additions are a
 *      release; removals are how a deploy silently reverts somebody else's fix.
 *      A changed line shows up as both a removal and an addition, so "zero
 *      removals" also proves nothing was MODIFIED -- the stronger claim, and
 *      the one worth making.
 *
 *      IT REFUSED A LEGITIMATE CHANGE WITHIN AN HOUR OF BEING WRITTEN, which is
 *      the correct behaviour and an incomplete design: editing two lines in a
 *      handler is two removals, and a gate that cannot tell that from a revert
 *      is one people route around. So `--expect-removed N` states the count in
 *      advance. A NUMBER AND NOT A FLAG, deliberately: a boolean override is
 *      satisfied by typing it, while a count can only be supplied by somebody
 *      who read the diff, and it refuses when the real figure is LOWER too --
 *      which is the case where you expected to replace something and did not.
 *
 *   3. THE ENTRYPOINT'S IMPORTS MUST BE SATISFIED BY THE SHARED FILE SHIPPING
 *      WITH IT. Pairing a new entrypoint with an older _shared.js is a runtime
 *      failure on the first request, not a build error, so nothing catches it
 *      before production does. Comments are stripped before parsing the import
 *      block, because a commented-out name inside `import { ... }` otherwise
 *      reads as an import and the check reports phantom misses.
 *
 *   4. BOTH FILES MUST PARSE. Cheap, and the only one of the four that a
 *      person would have thought to do.
 *
 * IT DOES NOT CHECK verify_jwt, BECAUSE IT CANNOT SEE IT -- and that is the
 * fifth thing that will bite somebody, so it is printed as a reminder rather
 * than left silent. The mcp function runs with jwt verification OFF on purpose:
 * it authenticates by looking the bearer up in its own token tables. A deploy
 * that lets that default back to ON refuses every registration-token call at
 * once, and the failure looks like a credential problem rather than a deploy.
 *
 * Exit 0 only when all four pass.
 */

import { readFile, readdir } from 'node:fs/promises';

const lf = (s) => s.replace(/\r\n/g, '\n');

/** Lines present in `a` and not in `b`, counted with multiplicity. */
export function linesMissingFrom(a, b) {
  const counts = new Map();
  for (const line of lf(b).split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  const missing = [];
  for (const line of lf(a).split('\n')) {
    const n = counts.get(line) ?? 0;
    if (n === 0) missing.push(line);
    else counts.set(line, n - 1);
  }
  return missing;
}

/** Names the entrypoint imports from ./_shared.js, with comments stripped first. */
export function sharedImports(source) {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const names = new Set();
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/_shared\.js['"]/g;
  for (const m of bare.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z0-9_$]+$/.test(n)) names.add(n);
    }
  }
  return names;
}

/** Names a module exports. */
export function moduleExports(source) {
  const names = new Set();
  const decl = /^export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z0-9_$]+)/gm;
  for (const m of source.matchAll(decl)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
}

/*
 * THE CHECK ITSELF, behind a guard so importing this file runs nothing. A
 * module that performs its work on import cannot be unit tested without being
 * executed, which is how a check script ends up with no tests at all.
 */
export async function main(deployedDir, incomingDir, expectRemoved = 0) {
  const read = (dir, name) => readFile(`${dir}/${name}`, 'utf8');
  const findings = [];

  const deployedNames = (await readdir(deployedDir)).filter((n) => /\.(ts|js)$/.test(n));
  const incomingNames = (await readdir(incomingDir)).filter((n) => /\.(ts|js)$/.test(n));

  /*
   * A FILE THAT DISAPPEARS FROM THE BUNDLE IS A REMOVAL OF EVERY LINE IN IT, and
   * comparing only the files present in BOTH would not notice.
   */
  for (const name of deployedNames) {
    if (!incomingNames.includes(name)) findings.push(`${name}: deployed but missing from the new bundle`);
  }

  let checked = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const name of deployedNames) {
    if (!incomingNames.includes(name)) continue;
    const [was, now] = await Promise.all([read(deployedDir, name), read(incomingDir, name)]);
    const removed = linesMissingFrom(was, now);
    checked += 1;
    const added = linesMissingFrom(now, was);
    totalAdded += added.length;
    totalRemoved += removed.length;
    process.stdout.write(`${name}: +${added.length} -${removed.length}\n`);
    if (removed.length) {
      for (const line of removed.slice(0, 10)) process.stdout.write(`  - ${line}\n`);
      if (removed.length > 10) process.stdout.write(`  ... and ${removed.length - 10} more\n`);
    }
  }

  /*
   * A DEPLOY THAT CHANGES NOTHING IS REPORTED, LOUDLY.
   *
   * Added after watching it happen: version 22 to version 23, byte-identical
   * bundles, a clean success and not one line shipped -- because the deploy ran
   * from a checkout that did not contain the branch. From outside that is
   * indistinguishable from a deploy that worked, which is ORDER 0b's "a pure
   * regression wearing a fresh version number" with the sign flipped.
   *
   * It is NOT a refusal. Redeploying identical bytes is a legitimate thing to
   * do -- forcing a restart, recovering from a failed rollout -- so a gate that
   * blocked it would be wrong and would get switched off. It is a finding only
   * when the caller expected to ship something, and the caller is the one who
   * knows that. So it says exactly what happened and lets them decide.
   */
  if (checked > 0 && totalAdded === 0 && totalRemoved === 0) {
    process.stdout.write(
      '\nNOTHING WOULD CHANGE. Every file in this bundle is byte-identical to what is\n'
      + 'already deployed. If you expected to ship a change, you are deploying from the\n'
      + 'wrong tree -- check the branch is the one carrying it.\n',
    );
  }

  /*
   * THE REMOVAL BUDGET, CHECKED ONCE ACROSS THE WHOLE BUNDLE. Every removed
   * line was printed above, so a caller setting this has been shown exactly
   * what they are agreeing to.
   */
  if (totalRemoved !== expectRemoved) {
    findings.push(
      `this deploy removes ${totalRemoved} line(s) that are serving traffic and `
      + `--expect-removed says ${expectRemoved}. `
      + (totalRemoved > expectRemoved
        ? 'Read the removals printed above: a removal you did not intend is how a deploy '
          + "reverts somebody else's fix while looking like a release."
        : 'Fewer were removed than you expected, which usually means the change you meant '
          + 'to make is not in this bundle.'),
    );
  }

  /*
   * A COUNT OF ZERO IS NOT EVIDENCE THE COMPARISON RAN. If the directories were
   * wrong, both listings are empty, nothing is compared and every check above is
   * vacuously satisfied -- which is the shape of every hollow gate in CLAUDE.md.
   */
  if (checked === 0) findings.push('no file was compared at all: check the two directory paths');

  const entry = incomingNames.find((n) => n === 'index.ts');
  const shared = incomingNames.find((n) => n === '_shared.js');
  if (entry && shared) {
    const [idx, sh] = await Promise.all([read(incomingDir, entry), read(incomingDir, shared)]);
    const wanted = sharedImports(idx);
    if (wanted.size === 0) findings.push('index.ts imports nothing from _shared.js: the import parse failed');
    const provided = moduleExports(sh);
    const missing = [...wanted].filter((n) => !provided.has(n));
    process.stdout.write(`imports: ${wanted.size} wanted, ${missing.length} unsatisfied\n`);
    if (missing.length) {
      findings.push(`_shared.js does not export: ${missing.join(', ')} — the pair would fail at runtime`);
    }
  }

  process.stdout.write(
    '\nNOT CHECKED HERE, AND IT WILL BITE YOU: verify_jwt. The mcp function runs with\n'
    + 'jwt verification OFF because it authenticates against its own token tables.\n'
    + 'Deploy with --no-verify-jwt or every registration-token call starts failing.\n\n',
  );

  if (findings.length) {
    for (const f of findings) process.stderr.write(`REFUSED: ${f}\n`);
    return 1;
    }
    process.stdout.write('all four checks pass\n');
    return 0;
  }

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--expect-removed');
  const expect = at === -1 ? 0 : Number(args[at + 1]);
  /*
   * FILTER ONLY WHEN THE FLAG IS THERE. `at` is -1 when it is absent, so a
   * naive `i !== at + 1` drops argument ZERO -- the first directory -- and the
   * script reports a usage error for the commonest invocation of all. Caught
   * because the check asserted the EXACT exit code: 2 is a usage error and 1 is
   * a refusal, and "non-zero" would have called that passing.
   */
  const positional = at === -1
    ? args
    : args.filter((a, i) => i !== at && i !== at + 1);
  const [deployedDir, incomingDir] = positional;
  if (!deployedDir || !incomingDir || !Number.isInteger(expect) || expect < 0) {
    process.stderr.write(
      'usage: check-edge-deploy.mjs <deployed-dir> <about-to-deploy-dir> '
      + '[--expect-removed <n>]\n',
    );
    process.exit(2);
  }
  process.exit(await main(deployedDir, incomingDir, expect));
}
