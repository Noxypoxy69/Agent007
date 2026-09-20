/**
 * QUOTING A WRITE FLAG DOES NOT CHANGE THE VERDICT -- the WRITE_FLAG half of the
 * quoted-selector class that test/quotedSelector.test.mjs closes for git selectors.
 *
 * The judge tests WRITE_FLAG_TOKEN over TOKENISED args (src/shellAllowlist.mjs:626)
 * and the tokenizer strips quotes, so `sort '-o' a b` tokenises to `-o` and is
 * refused exactly like the bare form. If the judge were ever reverted from the
 * per-token WRITE_FLAG_TOKEN to the raw-string WRITE_FLAGS (which anchors on the
 * command TEXT), the quote would sit where the anchor expects whitespace and the
 * bypass would reopen -- the exact defect quotedSelector documents one matcher over.
 *
 * WHY A SEPARATE FILE. quotedSelector exercises the GIT sweep/force selectors. A
 * WRITE_FLAG_TOKEN-only revert leaves every assertion there GREEN while reopening
 * this one. Different matcher, same class, so it needs its own gate.
 *
 * MEASURED THROUGH THE SHIPPED RAIL, 2026-09-19, before this was written:
 *     sort -o a b            DENY   "writes or reads a side file"
 *     sort '-o' a b          DENY   same reason   <- the bypass, closed
 *     sort --output=zz a     DENY
 *     sort -r afile          ALLOW  (a non-write flag is not refused)
 *
 * THE FLAG LIST IS TYPED, matching the quotedSelector precedent, because
 * WRITE_FLAG_NAMES is not exported from shellAllowlist.mjs. The bare form ('' in
 * QUOTES) is asserted alongside the quoted ones deliberately: it is the rule-5
 * control, so removing the matcher entirely turns this file red rather than
 * leaving it asserting mere agreement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeShellCommand, clusterTakesFile } from '../src/shellAllowlist.mjs';

const judge = (c) => judgeShellCommand(c);

const QUOTES = ['', "'", '"'];

/*
 * Mirrors WRITE_FLAG_NAMES in src/shellAllowlist.mjs. The source list is the only
 * place a flag is written down there (one list, two regex shapes); it is not
 * exported, so this is a hand-kept copy. Adding a flag in the source without
 * adding it here only UNDER-tests; the bare-form control below still catches a
 * removal of the whole matcher.
 */
/*
 * PER CARRIER NOW, BECAUSE THE SHORT LETTER DEPENDS ON THE TOOL.
 *
 * This was one union list asserted against `sort`, which encoded the very
 * defect the matcher has since been fixed for: it demanded that `sort -f` be
 * refused, and `-f` on sort is fold-case and touches nothing. Measured before
 * the fix -- `sort -f a.txt` REFUSED, `grep -o pat a.txt` REFUSED, while
 * `sort -ozz a.txt` was ALLOWED and wrote a file.
 *
 * The property this file exists for is unchanged and is still asserted in
 * full: QUOTING DOES NOT CHANGE THE VERDICT. What changed is that the flag
 * has to be a file flag FOR THE CARRIER, so the table below pairs them.
 *
 * Long forms stay on sort: they are distinctive names rather than letters, so
 * they do not collide across tools the way -o and -f do.
 */
const WRITE_FLAGS_BY_CARRIER = [
  ['sort', ['-o', '--output', '--output-file', '--to-file', '--from-file']],
  ['grep', ['-f']],
  ['jq', ['--argfile', '--rawfile', '--slurpfile']],
];

/*
 * READ-ONLY LETTERS THAT MUST SURVIVE EVERY QUOTING. The other direction, and
 * the reason the union had to go: each of these is a perfectly ordinary read
 * option that the single list refused.
 */
const BENIGN_BY_CARRIER = [
  ['sort', ['-f', '-r', '-n', '-fn']],
  ['grep', ['-o', '-r']],
  ['cut', ['-f1']],
];

/*
 * `sort` is a read-only allowlisted command that reaches the write-flag check
 * (it runs before any git-specific branch), confirmed by measuring it above.
 * Non-git on purpose -- git selectors are quotedSelector's job.
 */
const CARRIER = 'sort';

test('THE POSITIVE FIRST: a non-write flag on a read-only command is allowed', () => {
  const v = judge(`${CARRIER} -r afile`);
  assert.equal(v.allowed, true, `a benign flag was refused: ${v.reason}`);
});

test('QUOTING A WRITE FLAG DOES NOT CHANGE THE VERDICT', () => {
  for (const [carrier, flags] of WRITE_FLAGS_BY_CARRIER) {
    for (const flag of flags) {
      for (const q of QUOTES) {
        const v = judge(`${carrier} ${q}${flag}${q} afile bfile`);
        assert.equal(
          v.allowed, false,
          `${carrier} ${q}${flag}${q} was ALLOWED -- a side-file flag hides what it touches from the judge`,
        );
      }
    }
  }
});

test('AND QUOTING DOES NOT CHANGE IT FOR A BENIGN FLAG EITHER', () => {
  /*
   * The same property in the other direction, which the union list could not
   * express: a read option stays allowed however it is quoted. Without this
   * a matcher that refused everything would satisfy the test above.
   */
  for (const [carrier, flags] of BENIGN_BY_CARRIER) {
    for (const flag of flags) {
      for (const q of QUOTES) {
        const v = judge(`${carrier} ${q}${flag}${q} afile`);
        assert.equal(
          v.allowed, true,
          `${carrier} ${q}${flag}${q} was REFUSED -- it reads and writes nothing: ${v.reason}`,
        );
      }
    }
  }
});

test('A GLUED VALUE IS CAUGHT ANYWHERE IN THE CLUSTER', () => {
  /*
   * The under-block half. A short option carries its value glued and its flag
   * is last in the cluster, so the letter can sit anywhere in the run:
   * `-aozz` is `-a` then `-o zz`. Both of these were ALLOWED before the
   * per-tool table, and both write a file called zz.
   */
  for (const cmd of ['sort -ozz afile', 'sort -aozz afile']) {
    const v = judge(cmd);
    assert.equal(v.allowed, false, `${cmd} was ALLOWED and it writes a file`);
  }

  /* And the neighbour that must NOT be caught by that scan. */
  assert.equal(judge('sort -fn afile').allowed, true,
    'sort -fn is fold-case plus numeric and writes nothing');
});

test('THE INLINE = FORM CARRIES ITS VALUE and is still refused, quoted or not', () => {
  for (const q of QUOTES) {
    const v = judge(`${CARRIER} ${q}--output=zz${q} afile`);
    assert.equal(v.allowed, false, `${CARRIER} ${q}--output=zz${q} was ALLOWED`);
  }
});

test('AND THE REFUSAL IS THE SIDE-FILE REFUSAL, not another layer (rule 18)', () => {
  const v = judge(`${CARRIER} '-o' afile bfile`);
  assert.equal(v.allowed, false);
  assert.match(v.reason, /side file/, `the quoted write flag was refused by something else: ${v.reason}`);
});

test('THE CONTROL: this file can actually fail', () => {
  // Rule 1, held rather than watched once: one of each verdict from the real rail.
  assert.equal(judge(`${CARRIER} afile`).allowed, true, 'the rail refuses everything');
  assert.equal(judge(`${CARRIER} -o afile bfile`).allowed, false, 'the rail allows everything');
});

test('AN OFF-TABLE TOOL STILL FALLS BACK TO THE CONSERVATIVE UNION', () => {
  /*
   * THE SAFETY PROPERTY OF THE PER-TOOL TABLE, and it had no test until a
   * mutation went green: deleting the fallback left every named test passing,
   * because sort, grep and jq are all LISTED and never reach it.
   *
   * The table is precise only for tools whose option set somebody actually
   * read. Anything else must keep the old union behaviour, so adding a tool
   * can only ever LOOSEN -- deliberately, one tool at a time. If an off-table
   * tool started being allowed, the table would have turned from a narrowing
   * into a hole, which is the shape this rail keeps producing.
   *
   * THE CARRIER MUST BE ALLOWLISTED OR THE TEST PROVES NOTHING. My first
   * version used a made-up command, which the command allowlist refuses
   * outright -- so it never reached the write-flag check at all and passed
   * for a reason that had nothing to do with the fallback. The mutation
   * stayed green and that is how I found out. `diff` is allowlisted AND
   * absent from the table, so it exercises the branch.
   */
  for (const q of QUOTES) {
    const v = judge(`diff ${q}-o${q} out.txt afile`);
    assert.equal(v.allowed, false,
      `an off-table tool with ${q}-o${q} was ALLOWED -- the fallback is gone: ${v.reason}`);
  }

  /* Glued, too: the union's path-shaped heuristic still applies off-table. */
  assert.equal(judge('diff -osrc/x.mjs afile').allowed, false,
    'an off-table tool with a glued path-shaped value must still be refused');
});

test('A VALUE-TAKING LETTER OWNS THE REST OF THE CLUSTER (D7)', () => {
  /*
   * THE OVER-BLOCK HALF, and the one the glued-value scan created. Scanning
   * a whole cluster for the file letter finds it inside another option's
   * VALUE, where it is not an option at all:
   *
   *     grep -eself   the pattern is "self"; the f is a character in it
   *     rg -tconfig   the type is "config"
   *     sort -ko      the key spec is "o"
   *
   * All three were DENY before the value-letter table and all three read
   * nothing and write nothing. Measured against HEAD before the change and
   * after it, with the nine side-file forms below unchanged.
   */
  for (const cmd of ['grep -eself README.md', 'grep -esuffix README.md',
    'rg -tconfig thing', 'rg -tfsharp thing', 'sort -ko package.json']) {
    const v = judge(cmd);
    assert.equal(v.allowed, true,
      `${cmd} was REFUSED -- the file letter is inside another option's value: ${v.reason}`);
  }
});

test('BUT ORDER DECIDES IT, so the file letter still wins when it comes first', () => {
  /*
   * RULE 5's positive control for the test above, and the property that makes
   * the table safe rather than merely permissive. In `-fe` the file letter is
   * first, so `e` is its PATH and this must stay refused; in `-ef` the `-e`
   * is first, so `f` is part of the pattern. Same two characters, opposite
   * verdicts, and only the ordering rule gets both right.
   *
   * Without this, a value-letter table that swallowed the file letter
   * outright would satisfy the D7 test forever while opening a hole.
   */
  assert.equal(judge('grep -fe README.md').allowed, false,
    'grep -fe names a pattern FILE called e and must stay refused');
  assert.equal(judge('grep -ef README.md').allowed, true,
    'grep -ef is the pattern "f" and reads nothing else');

  /* And the glued path forms the earlier rounds closed are untouched. */
  for (const cmd of ['sort -ozz afile', 'sort -aozz afile', 'grep -fpatterns.txt README.md',
    'jq -f evil.jq package.json', 'sort -aosrc/evil.mjs package.json']) {
    assert.equal(judge(cmd).allowed, false, `${cmd} was ALLOWED and it names a side file`);
  }
});

test('THE GIT ROW IS LOAD-BEARING FOR READS, AND NOT FOR THE REASON IT CLAIMED (D8)', () => {
  /*
   * An audit read this row's comment -- "-o on git means other/untracked in
   * ls-files" -- as meaning the row is what keeps `git ls-files -o` working,
   * concluded it therefore bought nothing, and recommended deleting it.
   *
   * Measured with the row and without it. The justification was false AND the
   * recommendation was wrong, in opposite directions:
   *
   *     git ls-files -o --exclude-standard       DENY both ways  <- GIT_POISON
   *     git ls-files --others --exclude-standard ALLOW both ways <- the spelling that works
   *     git blame -f src/shellAllowlist.mjs      ALLOW with row, DENY without
   *
   * Eleven read-only git forms depend on the row. This pins all three facts
   * so the next reader does not have to re-derive them from a comment.
   */
  assert.equal(judge('git ls-files -o --exclude-standard').allowed, false,
    'GIT_POISON lists -o; if this passes, the poison matcher has been narrowed');
  assert.match(judge('git ls-files -o --exclude-standard').reason, /git flag/,
    'refused by the wrong layer -- this must be GIT_POISON, not the write-flag matcher (rule 18)');

  assert.equal(judge('git ls-files --others --exclude-standard').allowed, true,
    'the working spelling for listing untracked files must stay allowed');

  assert.equal(judge('git blame -f src/shellAllowlist.mjs').allowed, true,
    'git blame -f is --show-name and writes nothing -- removing the git row denies it');

  /* The row is an EMPTY set, so a glued path must still be caught tool-agnostically. */
  assert.equal(judge('git blame -fsrc/shellAllowlist.mjs').allowed, false,
    'a glued path after -f is a side file whatever the tool');
});

test('THE FILE LETTER IS CHECKED BEFORE THE VALUE LETTER, and that ordering is the rule (D7/F6)', () => {
  /*
   * AN AUDITOR MUTATED THE ORDERING AND NOTHING WENT RED. Swapping the two
   * checks inside clusterTakesFile is a no-op against the shipped tables,
   * because no tool has a letter in both of them -- so the property the
   * table's own comment calls load-bearing was, in fact, untested.
   *
   * It is not hypothetical. The day someone adds a letter to TOOL_VALUE_SHORT
   * that is already a file letter for that tool -- the natural mistake, since
   * a file option DOES take a value -- the ordering decides whether the rail
   * refuses the file or waves it through. So it is asserted directly, on sets
   * that overlap, which the shipped tables do not.
   */
  const fileLetters = new Set(['f']);
  const valueLetters = new Set(['e', 'f']);   // 'f' deliberately in BOTH

  assert.equal(clusterTakesFile('-f', fileLetters, valueLetters), true,
    'the file letter must win when a letter is in both sets -- erring toward refusal');
  assert.equal(clusterTakesFile('-fpatterns.txt', fileLetters, valueLetters), true,
    'a glued path after an overlapping letter must still be caught');
  assert.equal(clusterTakesFile('-ef', fileLetters, valueLetters), false,
    'a value letter that comes FIRST still owns the rest of the cluster');

  /* And the plain behaviour the shipped tables rely on, so this is not
   * only about the overlap case. */
  assert.equal(clusterTakesFile('-eself', new Set(['f']), new Set(['e'])), false,
    'the f inside a pattern value must not read as a file flag');
  assert.equal(clusterTakesFile('-fe', new Set(['f']), new Set(['e'])), true,
    'the file letter first means e is its path');
  assert.equal(clusterTakesFile('--output', new Set(['o']), new Set()), false,
    'a long flag is not a short cluster');
});

test('AN UNMEASURABLE RELAXATION IS NOT TAKEN: jq stays off the value table (L1)', () => {
  /*
   * An auditor flagged that 2979ec9d relaxed `jq -Lf evil.jq` from DENY to
   * ALLOW, and could not test it: jq is not installed here. Nor could I.
   * jq does not use GNU getopt, so the premise the value table rests on --
   * whichever value-taking letter comes FIRST owns the remainder -- may not
   * hold for it at all.
   *
   * The twelve rg relaxations from the same commit WERE measurable and
   * were measured against ripgrep 14.1.1 (-ef -Af -Bf -Cf -mf -gf -tf -Tf
   * -Mf -jf -rf -Ef): not one read a file named f. Those stay. This one
   * does not, because an unmeasured relaxation buys a glued -L<dir> and
   * costs a side-file read if the premise is wrong.
   */
  assert.equal(judge(`jq -Lf evil.jq package.json`).allowed, false,
    'jq -Lf was allowed -- jq is back on the value table and nobody can measure it here');
  assert.equal(judge(`jq -f evil.jq package.json`).allowed, false,
    'the plain pattern-file form must stay refused');

  /*
   * THE COST, MEASURED, AND WIDER THAN I FIRST WROTE IT.
   *
   * 849e202's message said "The cost is a glued -L<dir> behind another flag;
   * jq -L dir and ordinary jq are unaffected, and both are asserted so the
   * cost stays bounded." An auditor measured that the two assertions did not
   * bound what they claimed to, and it is right. With jq off the value table
   * nothing stops clusterTakesFile scanning past the L, so ANY glued -L<dir>
   * whose directory name reaches an f before a non-letter is refused -- not
   * only one "behind another flag":
   *
   *     jq -Lfixtures .name package.json    DENY    <- the f in "fixtures"
   *     jq -Llibfoo   .name package.json    DENY    <- the f in "libfoo"
   *     jq -Lmodules  .name package.json    ALLOW
   *     jq -Lsrc      .name package.json    ALLOW
   *     jq -L./modules .name package.json   ALLOW   <- the . stops the scan
   *     jq -L modules .name package.json    ALLOW   <- separated
   *
   * That is rule 19's outage direction, and it is a real cost rather than a
   * theoretical one. It is still the trade I would make: jq is not installed
   * on this machine, jq does not use GNU getopt so the table's premise may
   * not hold for it at all, and the alternative is an unmeasurable
   * relaxation on a pattern-file flag. But the boundary is now asserted
   * where it actually falls, so nobody has to re-derive it from a sentence.
   */
  for (const refused of ['jq -Lfixtures .name package.json', 'jq -Llibfoo .name package.json']) {
    assert.equal(judge(refused).allowed, false,
      `${refused} is expected to be refused -- if this now passes, jq is back on the `
      + 'value table and the unmeasurable relaxation came with it');
  }
  for (const allowed of ['jq -Lmodules .name package.json', 'jq -Lsrc .name package.json',
    'jq -L./modules .name package.json', 'jq -L modules .name package.json',
    'jq .name package.json']) {
    assert.equal(judge(allowed).allowed, true,
      `${allowed} reads no side file and must stay allowed -- the cost of removing jq `
      + 'from the value table is bounded to glued -L values containing an f');
  }
});
