/**
 * WRITING AN OVERRIDE GRANT, SO NOBODY HAS TO TYPE JSON INTO NOTEPAD AGAIN.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * The grant channel had a reader and no writer. `readOverride` refuses a grant
 * on roughly a dozen grounds -- no paths and no actions, a missing reason, an
 * `expires_at` that is not a STRING, one that does not parse, one already past,
 * one beyond MAX_GRANT_MS -- and CLAUDE.md records that every one of them
 * "fails EXACTLY like the guard being strict". The only way to produce a grant
 * was to hand-write the file, so every one of those refusals was reachable by a
 * typo, and indistinguishable from the guard simply working.
 *
 * Measured cost of that, 2026-09-21: a session spent six exchanges trying to
 * place one grant, routed the operator through a Notepad edit, and supplied
 * MALFORMED JSON while doing it. The grant never landed and the work behind it
 * did not happen. This module is the answer to that specific hour.
 *
 * ═══ THE CHECK IS A ROUND TRIP, NOT A SECOND COPY OF THE RULES ═══
 *
 * `MAX_GRANT_MS` is not exported, the string-typed `expires_at` check is not
 * exported, and the "at least one of paths/actions" rule is not exported. A
 * writer that re-derived any of them would be hollow gate 2: a check that
 * agrees with itself and drifts the moment `readOverride` changes.
 *
 * So `writeGrant` WRITES AND THEN ASKS THE SHIPPED READER whether what it wrote
 * is live. If `readOverride` will not honour the file, the previous state is
 * restored and the caller is told. The writer therefore cannot produce a grant
 * the guard rejects -- not because it knows the rules, but because it defers to
 * the only thing that does.
 *
 * ═══ WHAT IS PURE AND WHAT IS NOT ═══
 *
 * `validateGrantShape` is pure -- no fs, no clock beyond the `now` it is handed
 * -- so the suite can reach every branch (rule 10). The filesystem half is
 * `writeGrant`, and it is deliberately thin: build, write, read back, restore
 * on refusal.
 *
 * ═══ WHAT THIS DOES NOT CLAIM ═══
 *
 * It is not an authorisation. It writes a file the guard already trusts anybody
 * with filesystem access to write -- guardSession.mjs says so itself: "a session
 * can write outside the repository ... so an agent COULD forge one of these".
 * This adds no authority that did not already exist; it removes a text editor
 * from the path and makes the provenance a required field instead of an
 * optional one.
 */

/** A path entry that is exactly this token grants everything. Nothing else globs. */
export const WILDCARD = '*';

/**
 * Is this a spelling the guard will actually match?
 *
 * THE SILENT-NO-OP SPELLINGS ARE THE WHOLE REASON THIS FUNCTION EXISTS.
 * CLAUDE.md enumerates them: `src/`, `src`, `''`, `src/*`, `*.mjs`, `src/**` and
 * `.claude/*` all grant NOTHING, and a grant that grants nothing is
 * indistinguishable from the guard being strict. They are refused here rather
 * than written and left to fail later at the only moment somebody is blocked.
 */
function pathComplaint(p) {
  if (typeof p !== 'string') return 'not a string';
  if (p.trim() !== p) return 'has leading or trailing whitespace';
  if (p === '') return 'is empty';
  if (p === WILDCARD) return null;
  if (p.includes('\\')) return 'uses a backslash; grants are repo-relative with forward slashes';
  if (p.includes('*')) return `contains a glob; only the bare "${WILDCARD}" wildcards, every other path is exact`;
  if (p.startsWith('/')) return 'is absolute; grants are relative to the repository root';
  if (/^[A-Za-z]:/.test(p)) return 'is a drive-absolute path; grants are relative to the repository root';
  if (p.startsWith('./') || p.startsWith('../')) return 'is not normalised; write it relative to the repository root';
  if (p.split('/').includes('..')) return 'walks upward with ".."';
  if (p.endsWith('/')) return 'names a directory; the guard matches exact files, so a trailing slash grants nothing';
  return null;
}

function actionComplaint(a) {
  if (typeof a !== 'string') return 'not a string';
  if (a.trim() !== a) return 'has leading or trailing whitespace';
  if (a === '') return 'is empty';
  if (a === WILDCARD) return null;
  if (a.includes('*')) return `contains a glob; only the bare "${WILDCARD}" wildcards, every other action is an exact tool name`;
  return null;
}

/**
 * Check the parts a writer controls, before anything touches the disk.
 *
 * Returns `{ ok: true, grant }` or `{ ok: false, errors: [...] }`. EVERY
 * complaint is collected rather than the first one thrown: the measured failure
 * this replaces was six round trips, and returning one error at a time is how a
 * writer gets six round trips.
 *
 * It deliberately does NOT check the expiry horizon. That bound lives in
 * `readOverride` and is not exported; re-deriving it here is the hollow gate
 * this module's header refuses. `writeGrant` settles it by round trip.
 */
export function validateGrantShape({
  paths = [], actions = [], reason, grantedBy, expiresAt,
} = {}, now = Date.now()) {
  const errors = [];

  if (!Array.isArray(paths)) errors.push('paths must be an array');
  if (!Array.isArray(actions)) errors.push('actions must be an array');

  const cleanPaths = Array.isArray(paths) ? paths : [];
  const cleanActions = Array.isArray(actions) ? actions : [];

  for (const p of cleanPaths) {
    const c = pathComplaint(p);
    if (c) errors.push(`path ${JSON.stringify(p)} ${c}`);
  }
  for (const a of cleanActions) {
    const c = actionComplaint(a);
    if (c) errors.push(`action ${JSON.stringify(a)} ${c}`);
  }

  /*
   * AN EMPTY GRANT IS NO GRANT, and readOverride returns null for it -- which
   * the writer would otherwise report as "the guard refused what I wrote"
   * without saying that the grant named nothing. Caught here so the message
   * names the actual mistake.
   */
  if (cleanPaths.length === 0 && cleanActions.length === 0) {
    errors.push('a grant must name at least one path or one action');
  }

  if (typeof reason !== 'string' || reason.trim() === '') {
    errors.push('a grant needs a reason: one sentence somebody can disagree with');
  }

  /*
   * PROVENANCE IS REQUIRED, NOT DEFAULTED.
   *
   * `readOverride` folds a missing `granted_by` to the string "(unrecorded)"
   * and honours the grant anyway, so the most important field on the record is
   * the one it is easiest to omit. CLAUDE.md's rule -- "an agent that writes
   * its own permission file and fills in granted_by has forged it" -- can only
   * be checked by a reader if the field is there to read. Refusing the write
   * makes the provenance a cost of using the channel at all.
   */
  if (typeof grantedBy !== 'string' || grantedBy.trim() === '') {
    errors.push('a grant needs granted_by: who authorised this, and where they said so');
  }

  let iso = null;
  if (typeof expiresAt !== 'string' || expiresAt.trim() === '') {
    errors.push('a grant needs expires_at as an ISO 8601 STRING (readOverride refuses a number, an array or an object)');
  } else {
    const ms = Date.parse(expiresAt);
    if (!Number.isFinite(ms)) errors.push(`expires_at ${JSON.stringify(expiresAt)} is not a date any parser accepts`);
    else if (ms <= now) errors.push(`expires_at ${new Date(ms).toISOString()} is already in the past`);
    else iso = new Date(ms).toISOString();
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    grant: {
      paths: cleanPaths,
      actions: cleanActions,
      reason: reason.trim(),
      granted_by: grantedBy.trim(),
      expires_at: iso,
    },
  };
}

/**
 * A grant file exists and the guard will not honour it. Say WHY, in facts.
 *
 * ═══ THE HOUR THIS COST, MEASURED ═══
 *
 * On 2026-09-21 a session concluded the override channel was broken, tried six
 * times to place a grant, and routed the operator through a text editor. The
 * actual state, found 2026-09-22T03:29Z: the operator's own grant was sitting
 * at exactly the right key, well-formed, `granted_by: "danny"`, `paths: ["*"]`
 * -- and `expires_at: "2026-09-21T23:00:00Z"`, four and a half hours past. It
 * had lapsed on a clock, not on a decision.
 *
 * `grant-path` reported `live: false, grant: null`, which is true and useless.
 * Its prose branch could only offer "expired, malformed, or an expiry beyond
 * the maximum" -- a list of three, when the file on disk answers the question
 * outright. CLAUDE.md already records that a grant at the wrong key "fails
 * EXACTLY like the guard being strict, which is why it went unnoticed for hours
 * and got re-diagnosed three times". This is the same sentence one cause along.
 *
 * ═══ IT REPORTS, IT NEVER DECIDES ═══
 *
 * `readOverride` remains the only authority on whether a grant is live, and
 * this runs ONLY after it has already said no. So this cannot widen anything:
 * the worst a wrong answer here can do is misdescribe a refusal that has
 * already happened.
 *
 * It therefore states FACTS READ OUT OF THE FILE -- this field is absent, this
 * timestamp is this far in the past -- rather than re-deciding the verdict. The
 * unexported bound is named as an inference and labelled as one, because the
 * writer may not keep a second copy of a rule it does not own.
 */
export function explainRefusedGrant(rawText, now = Date.now()) {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return ['the grant file is empty'];
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return [`the grant file is not valid JSON: ${e.message}`];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return ['the grant file does not contain a JSON object'];
  }

  const why = [];

  const hasPaths = Array.isArray(parsed.paths) && parsed.paths.length > 0;
  const hasActions = Array.isArray(parsed.actions) && parsed.actions.length > 0;
  if (!hasPaths && !hasActions) why.push('it names no paths and no actions, so it grants nothing');

  if (typeof parsed.reason !== 'string' || parsed.reason.trim() === '') {
    why.push('"reason" is missing or empty, and the guard requires one');
  }

  /*
   * THE TYPE CHECK IS REPORTED SEPARATELY FROM THE VALUE, because they are
   * different mistakes with the same symptom. An audit found `["2099-01-01"]`
   * and `{"toString":1}` reading as valid before readOverride demanded a
   * string, and a reader told only "expired" would go looking at the calendar.
   */
  if (!('expires_at' in parsed)) {
    why.push('"expires_at" is missing, and a grant with no expiry is refused rather than treated as permanent');
  } else if (typeof parsed.expires_at !== 'string') {
    why.push(`"expires_at" is ${Array.isArray(parsed.expires_at) ? 'an array' : typeof parsed.expires_at}, and the guard requires an ISO 8601 STRING`);
  } else {
    const ms = Date.parse(parsed.expires_at);
    if (!Number.isFinite(ms)) {
      why.push(`"expires_at" is ${JSON.stringify(parsed.expires_at)}, which is not a date any parser accepts`);
    } else if (ms <= now) {
      const agoMs = now - ms;
      const hours = Math.floor(agoMs / 3600000);
      const mins = Math.round((agoMs % 3600000) / 60000);
      const ago = hours > 0 ? `${hours}h ${mins}m ago` : `${mins}m ago`;
      why.push(`IT EXPIRED. "expires_at" is ${parsed.expires_at}, which was ${ago}. The grant is otherwise intact -- this is a clock, not a mistake.`);
    } else {
      /*
       * IN THE FUTURE AND STILL REFUSED. The remaining bound is the maximum
       * horizon, which lives in guardSession.mjs and is not exported. Named as
       * an inference rather than asserted, and the observed distance is given
       * so a reader can judge it without this file knowing the constant.
       */
      const days = Math.round((ms - now) / 86400000);
      why.push(`"expires_at" is ${parsed.expires_at}, about ${days} day(s) away and still in the future, so the likely cause is the guard's maximum grant horizon. A far-future expiry is refused precisely because it is not an expiry.`);
    }
  }

  if (why.length === 0) {
    why.push('the file parses and its fields look present, but the guard still declined it -- read readOverride in src/guardSession.mjs');
  }
  return why;
}

/**
 * Turn a duration in hours into the ISO string `readOverride` demands.
 *
 * A SEPARATE FUNCTION BECAUSE THE STRING TYPE IS LOAD-BEARING. readOverride
 * refuses a non-string `expires_at` outright, and the audit that found that
 * hole recorded `["2099-01-01"]` and `{"toString":1}` as the shapes that got
 * through the older check. Callers that compute a date should come back through
 * here rather than assembling the field themselves.
 */
export function expiryFromHours(hours, now = Date.now()) {
  const n = typeof hours === 'number' ? hours : Number(hours);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(now + Math.round(n * 60 * 60 * 1000)).toISOString();
}
