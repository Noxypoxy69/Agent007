import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

/**
 * WILL THE ARTIFACT LOAD? A DIGEST CANNOT ANSWER THAT.
 *
 * The deploy gate proves the bytes are what we think (a digest over the artifact)
 * and that they arrived (the control plane's own hash, read back). Neither says
 * the module STARTS. The failure sits exactly between those two steps and every
 * step around it reports success: a valid digest of an unloadable file deploys
 * cleanly, the read-back matches, the log is green, and every route answers 500.
 *
 * THIS IS NOT HYPOTHETICAL AND IT HAS ALREADY HAPPENED HERE. f04426d is
 * code-c's own commit -- "I took the Bridge down with a duplicate const, and no
 * check I had could see it". I nearly repeated it three hours later: resolving a
 * merge I ended with two `const UUID` in index.ts and 1079 tests passed, because
 * index.ts is a Deno entrypoint that NOTHING IN THE SUITE CAN IMPORT. That is
 * why the suite is silent about it by construction, and why this check has to
 * exist outside the suite's reach, on the artifact itself.
 *
 * WHY IT SHELLS OUT TO NODE'S PARSER INSTEAD OF ANALYSING SCOPE.
 *
 * The obvious implementation walks the file counting braces to find top-level
 * declarations. I wrote that an hour ago for a different check and it was WRONG:
 * the uuid regex literal `/^[0-9a-f]{8}-.../` contains `{8}` and `{4}`, my
 * counter read them as block braces, and it reported two same-scope declarations
 * that were not. A hand-rolled parser gives a confident wrong answer about the
 * one question that decides whether a deploy proceeds.
 *
 * `node --check` is a real parser and it already draws the exact line we need.
 * Measured before relying on it:
 *
 *   const A = 1; const A = 2;                        -> exit 1, "already been declared"
 *   const B = 1; function f(){ const B = 2; }        -> exit 0   (legitimate shadowing)
 *
 * So the check is: hand every artifact file to a parser and believe the parser.
 *
 * MEASURED LIMIT, AND IT IS SHARPER THAN I ASSUMED. node --check is WEAKER on
 * .ts than on .mjs, because node type-strips TypeScript on a more permissive
 * path. Measured on this machine:
 *
 *   'export function f( {'   as .ts   -> exit 0   ACCEPTED
 *   the same bytes          as .mjs  -> exit 1
 *   'const A=1; const A=2;' as .ts   -> exit 1
 *
 * So the entrypoint -- index.ts, the file that actually went down -- gets the
 * weaker parse. The DUPLICATE DECLARATION shape is still caught there, which is
 * the outage this exists for, but a malformed .ts can pass. I found this by
 * testing the claim rather than by assuming the parser was uniform, and it is
 * recorded here because a gate that quietly covers less than its header says is
 * the thing this repository keeps finding.
 *
 * .mjs turns out to be the only strict parser of the three -- .js is weak too,
 * for a different reason (module format) than .ts. So every non-.mjs file gets a
 * STRICT second pass as .mjs. That parse cannot be
 * blocking -- real TypeScript syntax is a syntax error to it, so a failure there
 * is not evidence of a broken file -- so it reports `weak-parse-coverage`
 * instead, naming the file whose strict result is unknown. Blocking stays with
 * what the parser can actually prove.
 *
 * WHAT A PASS DOES NOT MEAN. This runs node's parser, not a Deno isolate. It
 * cannot see what the runtime refuses at module scope -- randomness, timers and
 * I/O in the global scope are a real class and Cloudflare Workers has bitten
 * this project with exactly that. A green result here means "every file parses
 * and no file declares the same binding twice in one scope". It does not mean
 * "this will boot". Stated here rather than left to be discovered, for the same
 * reason the read-back records the control plane's hash instead of pretending to
 * compare it to a source digest.
 */

/** Files a JavaScript/TypeScript runtime will actually try to parse. */
const PARSEABLE = /\.(mjs|cjs|js|ts)$/;

/**
 * Suffixes an editor, a merge or a nervous human leaves behind.
 *
 * Used to relate ONE REAL FILE TO ANOTHER, not to guess what a name means. A
 * shadow copy is reported only when stripping one of these produces the name of
 * a file that is actually in the artifact beside it -- index.ts.bak next to
 * index.ts. `notes.bak` alone is just a file and is not reported, because
 * nothing it could shadow exists.
 *
 * That distinction is the whole reason this is safe to ship: it is a fact about
 * two paths, not a heuristic about intent, so it cannot be occasionally wrong in
 * the way that teaches people to ignore a gate.
 */
const SHADOW_SUFFIX = /(\.bak|\.orig|\.old|\.save|\.copy|~)$/i;

/** Node's message when two bindings of one name share a scope. */
const DUPLICATE = /has already been declared/i;

function walkAll(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Check every parseable file in an artifact directory.
 *
 * @param {string} root      repository root
 * @param {string} artifact  directory relative to root, e.g. supabase/functions/mcp
 * @param {object} [opts]
 * @param {(file: string) => {status: number, stderr: string}} [opts.parse]
 *        injected for tests; defaults to `node --check`.
 * @returns {{ok: boolean, checked: number, findings: Array<{file: string, kind: string, detail: string}>}}
 */
export function artifactLoads(root, artifact, { parse } = {}) {
  const dir = path.join(root, artifact);
  const everything = walkAll(dir);
  const files = everything.filter((f) => PARSEABLE.test(f));
  const findings = [];

  /*
   * AN EMPTY ARTIFACT IS A FINDING, NOT A PASS.
   *
   * Every other check here is a negative, and a negative is satisfied by an
   * empty list. A wrong path -- the artifact moved, a rename, a typo in the
   * caller -- would otherwise report "ok: true, 0 findings" and deploy nothing
   * while sounding fine. A non-match is not evidence the search ran.
   */
  if (files.length === 0) {
    return {
      ok: false,
      checked: 0,
      findings: [{
        file: artifact,
        kind: 'artifact-empty',
        detail: 'no parseable files found under this path; the artifact directory is wrong, '
          + 'missing, or empty. Refusing rather than reporting a clean check of nothing.',
      }],
    };
  }

  const run = parse ?? ((file) => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    return { status: r.status ?? 1, stderr: String(r.stderr ?? '') };
  });

  /*
   * SHADOW COPIES ARE REPORTED, NEVER REFUSED, and code-a's reasoning for that
   * is better than mine was.
   *
   * An unreferenced file cannot break the boot, so refusing on one is a red gate
   * for something that is not a hazard -- and the failure mode of a noisy gate
   * is not annoyance, it is that somebody switches it off, and then it is absent
   * for the case that IS a hazard. Both of us watched that happen tonight to
   * checks that cried wolf.
   *
   * It is not invisible either way: the artifact digest already covers every
   * file in the directory, so a stale copy changes the digest and is recorded
   * whether or not anybody reads this. Reporting gives a human the chance to
   * notice; refusing gives them a reason to stop reading.
   */
  const names = new Set(files.map((f) => path.basename(f)));
  for (const f of everything) {
    const base = path.basename(f);
    if (PARSEABLE.test(base)) continue;
    const stripped = base.replace(SHADOW_SUFFIX, '');
    if (stripped !== base && names.has(stripped)) {
      findings.push({
        file: path.relative(root, f).split(path.sep).join('/'),
        kind: 'shadow-copy',
        detail: `sits in the artifact beside ${stripped}, which it shadows by name. `
          + 'It is not parsed and cannot break the boot, so this does not refuse -- but it '
          + 'ships, it changes the digest, and it is how the wrong thing gets deployed.',
      });
    }
  }

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const r = run(file);
    if (r.status === 0) continue;

    findings.push({
      file: rel,
      kind: DUPLICATE.test(r.stderr) ? 'duplicate-declaration' : 'parse-failure',
      detail: firstUseful(r.stderr),
    });
  }

  /*
   * THE STRICT SECOND PASS, for .ts only, and deliberately NOT blocking.
   *
   * A .ts file that also parses as .mjs has had a strict parse and is fully
   * covered. One that does not may be perfectly good TypeScript -- a type
   * annotation is a syntax error to the .mjs parser -- so a failure here proves
   * nothing and must not refuse. What it does is stop the weakness being
   * invisible: it names the file whose strict result is unknown.
   */
  for (const file of files) {
    if (/\.mjs$/.test(file)) continue; // .mjs IS the strict parser
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (findings.some((f) => f.file === rel)) continue; // already failed the real check
    const strict = strictParse(file);
    if (strict.covered && !strict.ok) {
      /*
       * BLOCKING, and this is the correction that matters.
       *
       * The previous version reported every .ts file as `weak-parse-coverage`
       * and refused nothing, on the reasoning that a strict-parse failure might
       * just be TypeScript syntax. After stripping, it cannot be: the types are
       * gone, so a failure is a real one.
       *
       * MEASURED, and it is why this was rewritten. `node --check` on a
       * TWO-LINE .ts file catches `const A = 1; const A = 2;` -- which is what
       * the original fixtures tested, and they passed. On the REAL index.ts,
       * with the same duplicate appended, it exits 0. Node takes the permissive
       * type-stripping path for a file that actually contains TypeScript, and
       * the check this module exists for was blind to the outage it was named
       * after. The fixtures proved the check worked on files that were not
       * TypeScript, while the file it guards is.
       */
      findings.push({
        file: rel,
        kind: DUPLICATE.test(strict.detail) ? 'duplicate-declaration' : 'parse-failure',
        detail: `${strict.detail} (found by stripping types and parsing strictly; `
          + 'node --check accepts this file as-is because TypeScript takes a permissive path)',
      });
      continue;
    }
    if (!strict.covered) {
      findings.push({
        file: rel,
        kind: 'weak-parse-coverage',
        detail: 'this file could not be given a strict parse -- type stripping is unavailable '
          + 'on this runtime. Duplicate declarations in real TypeScript are NOT caught without '
          + 'it, so coverage here is weaker than the header claims.',
      });
    }
  }

  /*
   * ok IGNORES shadow-copy findings BY DESIGN. They are information for a human,
   * not grounds to stop a deploy, and folding them into `ok` would be the
   * refusal this deliberately does not make.
   */
  const ADVISORY = new Set(['shadow-copy', 'weak-parse-coverage']);
  const blocking = findings.filter((f) => !ADVISORY.has(f.kind));
  return { ok: blocking.length === 0, checked: files.length, findings };
}

/**
 * The line a human needs, not the stack.
 *
 * Node prints the offending source line, a caret, then the error, then frames
 * from its own internals. The frames are noise to somebody deciding whether to
 * deploy; the error line names the binding.
 */
/**
 * Does this file survive a STRICT parse? Copied to a .mjs name, because the
 * extension is what selects node's permissive TypeScript path.
 */
function strictParse(file) {
  /*
   * A .ts FILE IS TYPE-STRIPPED FIRST, AND THAT IS THE WHOLE FIX.
   *
   * Copying index.ts to a .mjs name and parsing it was never a strict parse of
   * THIS file: real type annotations are a syntax error to the .mjs parser, so
   * the attempt always failed, always for the wrong reason, and always got
   * reported as `weak-parse-coverage` -- an advisory nobody can act on.
   *
   * Stripping the types produces JavaScript that the strict parser accepts, so
   * a failure after stripping is a REAL defect in the file rather than an
   * artefact of the extension.
   */
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return { covered: false, ok: true, detail: '' };
  }

  let js = source;
  if (/\.ts$/.test(file)) {
    try {
      js = stripTypeScriptTypes(source, { mode: 'strip' });
    } catch (err) {
      /*
       * IT IS NOT VALID TYPESCRIPT. That is a real finding, not missing
       * coverage: nothing can load a file the type stripper cannot read.
       */
      return { covered: true, ok: false, detail: firstUseful(String(err?.message ?? err)) };
    }
  }

  const tmp = path.join(tmpdir(), `ab-strict-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  try {
    writeFileSync(tmp, js);
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    if ((r.status ?? 1) === 0) return { covered: true, ok: true, detail: '' };
    return { covered: true, ok: false, detail: firstUseful(String(r.stderr ?? '')) };
  } catch {
    return { covered: false, ok: true, detail: '' };
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function firstUseful(stderr) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.find((l) => /Error/.test(l));
  return (err ?? lines[0] ?? 'parser refused the file').slice(0, 200);
}
