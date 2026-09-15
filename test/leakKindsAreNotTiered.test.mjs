import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPayload, USERNAME, HOME_DIRECTORY, ABSOLUTE_PATH } from '../src/payloadGuard.mjs';

/**
 * AN 8.3 HOME PATH IS CLASSIFIED WORSE THAN A LONG ONE, AND THAT IS SURVIVABLE
 * ONLY BECAUSE NOTHING READS THE CLASSIFICATION.
 *
 * Found on 2026-09-15 by the session next door, reviewing my own commit
 * 6ad1009 ("No absolute worktree path leaves the machine, 8.3 spellings
 * included"). That commit fixed the PRODUCER -- collect.mjs and redact.mjs
 * resolve 8.3 names through realpath before emitting. It did not touch the
 * SCANNER, and the title reads as though it did.
 *
 * The same directory on this machine, differing only in spelling:
 *
 *   C:\Users\DANNYG~1\Documents\agentbridge     -> ["absolute-path"]
 *   C:\Users\DANNY GARCIA\Documents\agentbridge -> ["username","home-directory","absolute-path"]
 *
 * The identity rules miss the 8.3 spelling of the very home they are built
 * from. "dannyg~1" does contain "danny", but nameParts requires a boundary and
 * correctly refuses to match a part butted against another letter -- the same
 * rule that stops "Dan" firing inside "abundant". Widening it would trade a
 * label for the false-positive discipline that keeps this guard installed, so
 * the label stays wrong on purpose.
 *
 * THAT TRADE IS ONLY SAFE WHILE EVERY KIND BLOCKS EQUALLY. scanPayload returns
 * {ok: leaks.length === 0} and no consumer filters by kind, so an 8.3 home path
 * is refused before transmit exactly as hard as a long one. Nothing leaks.
 *
 * But that is a property of today's code, not a guarantee. A warn-vs-block
 * policy, a report grouped by kind, or an allowlist for absolute paths on a CI
 * runner would each make the label load-bearing, and an 8.3 home path would
 * silently sort into the wrong tier. Any of those is one commit away and would
 * look entirely reasonable in review.
 *
 * So the constraint is recorded here, where it fails, instead of in a comment.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const IDENTITY = { username: 'Danny Garcia', homedir: 'C:\\Users\\DANNY GARCIA', hostname: 'danny-win' };

const kindsOf = (value) => {
  const r = scanPayload(value, IDENTITY);
  return { ok: r.ok, kinds: [...new Set(r.leaks.map((l) => l.kind))] };
};

test('the 8.3 spelling really is classified worse — the gap is still open', () => {
  // If this ever fails because 8.3 now classifies fully, that is GOOD news and
  // this file should be rewritten, not deleted. It asserts current behaviour so
  // that closing the gap is loud rather than silent.
  const short = kindsOf('C:\\Users\\DANNYG~1\\Documents\\agentbridge');
  const long = kindsOf('C:\\Users\\DANNY GARCIA\\Documents\\agentbridge');

  assert.deepEqual(short.kinds, [ABSOLUTE_PATH], 'KNOWN GAP CLOSED: 8.3 now classifies as identity. Rewrite this file.');
  assert.ok(long.kinds.includes(USERNAME) && long.kinds.includes(HOME_DIRECTORY),
    'the long spelling must still classify as identity, or the scanner regressed');
});

test('BOTH spellings are refused — the mislabelling is not a hole', () => {
  // This is the assertion that makes the gap survivable. It must hold even if
  // the labels above change.
  for (const p of ['C:\\Users\\DANNYG~1\\Documents\\agentbridge', 'C:\\Users\\DANNY GARCIA\\Documents\\agentbridge']) {
    assert.equal(kindsOf(p).ok, false, `an 8.3 home path was not refused: ${p}`);
  }
});

test('ok is leak COUNT, not leak kind — no tier may be treated as harmless', () => {
  // A scan carrying only the weakest kind must still be not-ok. If someone
  // introduces severity, this is the first thing that breaks.
  // A home-shaped path belonging to nobody this identity knows. Note that
  // POSIX_HOME_ABS is deliberately narrow -- "/var/tmp/x" is NOT a leak, since
  // a path with no home in it discloses no one's disk shape.
  const weakest = scanPayload('/home/someone-else/x', IDENTITY);
  assert.deepEqual([...new Set(weakest.leaks.map((l) => l.kind))], [ABSOLUTE_PATH]);
  assert.equal(weakest.ok, false, 'an absolute-path-only scan was treated as clean');

  const clean = scanPayload('agentbridge', IDENTITY);
  assert.deepEqual(clean.leaks, []);
  assert.equal(clean.ok, true, 'the guard must still pass something genuinely clean');
});

/** Every .mjs under the shipped source directories, excluding the guard itself. */
async function shippedModules() {
  const out = [];
  for (const dir of ['src', 'bin', 'bridge', 'mcp']) {
    let entries;
    try { entries = await readdir(path.join(SRC, dir), { withFileTypes: true, recursive: true }); }
    catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
      const full = path.join(e.parentPath ?? e.path ?? path.join(SRC, dir), e.name);
      if (path.basename(full) === 'payloadGuard.mjs') continue;
      out.push(full);
    }
  }
  return out;
}

test('no consumer filters leaks by kind', async () => {
  // The structural half. The behavioural tests above prove today is safe; this
  // one goes red the day somebody makes the label matter.
  const files = await shippedModules();
  assert.ok(files.length > 5, `module sweep found only ${files.length} files — the sweep is broken`);

  const offenders = [];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    // Importing a kind constant from the guard, or branching on a leak's kind,
    // are the two ways a tier gets built.
    if (/from\s+['"].*payloadGuard\.mjs['"]/.test(src)
        && /\b(USERNAME|HOME_DIRECTORY|HOSTNAME|ABSOLUTE_PATH)\b/.test(src)) {
      offenders.push(`${path.relative(SRC, f)} imports a leak-kind constant`);
    }
    /*
     * The span between the callback's open paren and `.kind` must allow `)`.
     * The first version of this used [^)]* and came back GREEN against a
     * planted `.filter((l) => l.kind !== 'absolute-path')` -- the parenthesised
     * parameter closes the character class before `.kind` is ever reached, so
     * it matched only `x => x.kind`, the spelling nobody writes.
     */
    if (/leaks[\s\S]{0,80}?\.(filter|some|every|find|reduce)\([\s\S]{0,80}?\.kind/.test(src)) {
      offenders.push(`${path.relative(SRC, f)} filters leaks by kind`);
    }
  }

  assert.deepEqual(
    offenders, [],
    'Something now treats leak KIND as meaningful:\n  ' + offenders.join('\n  ')
    + '\n\nBefore doing that, fix the 8.3 classification gap this file documents, or an\n'
    + '8.3 home path will sort into the wrong tier and stop being refused.',
  );
});
