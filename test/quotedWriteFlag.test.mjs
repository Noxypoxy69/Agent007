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
const WRITE_FLAGS = ['-o', '--output', '--output-file', '--to-file', '--from-file',
  '-f', '--argfile', '--rawfile', '--slurpfile'];

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
  for (const flag of WRITE_FLAGS) {
    for (const q of QUOTES) {
      const v = judge(`${CARRIER} ${q}${flag}${q} afile bfile`);
      assert.equal(
        v.allowed, false,
        `${CARRIER} ${q}${flag}${q} was ALLOWED -- a side-file flag hides what it touches from the judge`,
      );
    }
  }
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
