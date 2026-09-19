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

import { judgeShellCommand } from '../src/shellAllowlist.mjs';

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
