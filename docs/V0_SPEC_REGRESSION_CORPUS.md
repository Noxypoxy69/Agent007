# V0 Specification Regression Corpus — from the Rev 2 blind acceptance audit

**Origin:** blind acceptance audit of `AGENT007_AUTHORITY_PROTOCOL_V0-1.md` (Rev 2),
2026-09-21. Verdict `V0_ACCEPTANCE_AUDIT = FAIL`, 12 acceptance-blocking, 8 non-blocking.

**How to use it.** Every future revision is checked against all twelve
counterexamples below. **The fresh auditor is never told about them.** This file
is for the owner and for whoever checks a returned revision — not for the
auditor. A revision that closes a finding only when told about it has not closed
the class.

**Standing rule from the Rev 2 pass, which is why this file exists:** the
auditor's three load-bearing findings (B1, B2, B3) were on nobody's prior list.
They were found because the auditor was given the artifact and the codebase and
told nothing. Preserve that condition.

---

## The blind-test scorecard, recorded before anyone edits anything

Three findings were deliberately withheld from the Rev 2 auditor to test whether
a blind pass would rediscover them.

| withheld finding | independently rediscovered? |
|---|---|
| Docker propagation mismatch (§5 "recommended" vs §12.4 "required") | **PARTLY** — B9(b) found the §5↔§12 half exactly. Did **not** flag §11's ordered step 1 as the same seam. |
| Anti-replay fields added without enforcement | **YES, and further** — B4, naming all six fields, the absent nonce store, and citing `src/sign.mjs:26` "Replay store is the caller's job" — which was itself a withheld observation |
| Signature serialization ambiguity (signature inside the canonicalised envelope) | **NO.** B5(b) covers algorithm binding, not signed-payload definition. **Still unfound — this is the remaining adversarial packet.** |

So the outstanding hand-over is one item, not three.

---

## The twelve counterexamples

Each is the smallest execution that satisfies the written spec while violating
its intended authority property. A revision closes a finding only when the
counterexample stops working.

**B1 — principal_id is the session id.** `src/principalResolution.mjs:155-161`
returns no principal field; `bin/agentbridge.mjs:3364` aliases
`principal = resolution.session`. One party opens two sessions; A authors, B
claims; `claimJob`'s only principal check (`src/auditJob.mjs:874`) compares
`authorP === claimantP`, and two session ids differ. §12 criterion 2's "refuses
for one principal wearing two names" is unsatisfiable by the kept machinery.

**B2 — `independenceOf` KEEP UNCHANGED arms an env forgery.**
`src/auditJob.mjs:811` returns `enforced` when `claimantSource === 'resolved'`,
and the only producer of `'resolved'` is `process.env` at
`bin/agentbridge.mjs:3582-3584`. Set `AGENTBRIDGE_SESSION_ID`, claim your own
candidate, get `satisfies_gate: true`. Second, opposite failure: three
vocabularies for one concept mean an implementer routing `resolvePrincipal` into
`bySource` produces a permanent red instead.

**B3 — authoritative authorship is worker-writable JSONL, last-line-wins.**
Append one line to `~/.agentbridge/<repo>/candidates.jsonl` with
`identity_source: "credential"` and any `principal_id`. `bindAuthorship`'s
first-binding-wins refusal is bypassed entirely, because the reader
(`bin/agentbridge.mjs:3601-3611`) takes the last matching line.

**B4 — six anti-replay fields, no rules.** A conforming verifier emits and a
conforming gate accepts an envelope carrying all six, ignores all six, and
accepts the same signed PASS twice, under a superseded policy, from a retired
generation, out of order. §12 has no criterion exercising any of them.
`independence`'s value domain is literally an ellipsis.

**B5 — verifier input channel unspecified; algorithm unbound.** (a) Worker
invokes the verifier with `author_principal_id` / `reviewer_principal_id` of its
choosing; "never payload-supplied" constrains the envelope, not the verifier's
input. (b) `protocol_version` does not pin the algorithm, and `src/sign.mjs`
ships a live HMAC-SHA256 symmetric signer absent from the preservation map.

**B6 — `INTEGRATION_READY` compares against illegal values.** `pass` and
`approved` are not in `VERIFICATION_VERDICTS` / `REVIEW_VERDICTS`
(`src/attemptRecord.mjs:104-105`). The predicate is never true; the fix pressure
is to widen a shipped fail-closed enum. `needs_repair` has zero matches in the
repository.

**B7 — `WAITING_BLIND_AUDIT` undefined; HOLD ambiguous.** Zero matches
repo-wide. `consumesSlot` (`src/takeNext.mjs:91`) defaults an unrecognised state
to **busy**, so the new state permanently consumes a worker's slot. And "reports
HOLD" permits a warn-and-proceed reading that turns the repository's only
content-comparing boundary into a log line while satisfying §12 criterion 8.

**B8 — seat re-key orphans a scheduled DELETE and hollows a trigger.**
`guard_session_owner` is BEFORE UPDATE on `agent_id`/`machine_id`;
`reap_stale_seats` is cron-scheduled every five minutes keyed on `session_id`.
Re-key to `(principal_id, machine_id)` without touching them and a scheduled job
deletes rows the new conflict target expects. Also: shared-token registrations
leave `principal_id` NULL, NULLs are distinct in a unique constraint, debris
accumulates exactly as today.

**B9 — "no elevation" is false; the Docker route is optional and unspecified.**
The account IS in Administrators, deny-only *in the filtered token*. A test that
attempts elevation and sees it fail has observed only that nobody clicked. And
§12.4 demands a property whose only identified closure §5 makes optional, over a
surface §1.1 records as unmeasured, without naming what the Docker attempt is.

**B10 — the 51 frozen candidates cannot produce `enforced`.**
`src/trustGenesis.mjs` states they predate authoritative authorship binding and
"can never become enforced by auditing them harder". Using them as the V0 corpus
requires retroactive binding — which is B3 performed deliberately. Separately,
the document overloads `GENESIS`, which is an existing three-value `REGIME` enum.

**B11 — `principal` appears in zero migrations.** 0 matches in
`bridge/schema.sql` and across `supabase/migrations/`. §11 has no migration step.
Add a column to `agentbridge.session_registrations` without recreating
`public.session_registrations` with its full explicit column list and every
PostgREST write fails PGRST204 — an outage this repository has already taken
twice.

**B12 — §4.4 has no build step and no acceptance criterion.** V0 can be declared
accepted with a declared V0 addition entirely unimplemented. It also inherits a
measured self-silencing exemption mechanism whose only cost is "writing a reason
over forty characters".

---

## Non-blocking, retained so a revision does not reintroduce them

N1 daemon exists but nothing loops it · N2 a cron deleter already runs against
the seat table · N3 `guard_session_owner` refuses a silent overwrite, not a
rebind, and binds worker-asserted columns · N4 rule-12 miscitation (it is hollow
gate 2) · N5 `protectedPathParity` is a parity template, not a cross-plane one ·
N6 the bind-mount claim is vendor documentation, not a measurement · N7 the four
ARGUABLE exemptions are counted but never named · N8 removing Stop's dispatcher
before adding the scheduler leaves nothing dispatching.

---

## What the auditor checked and found TRUE

Retained so a future revision does not "fix" something that was already right:
`src/auditJob.mjs:779`; the `recordAudit` fence at :1076; `protectedPathParity`'s
union-derived corpus; `auditBearingClosure`'s transitive closure;
`candidateAuthorship`'s first-binding-wins refusal; the four ARGUABLE count; the
shell-rail header citation; the execution-gate and wildcard-grant statements;
`FINAL_STATES`; and "the authority unit is a tree transition, not a commit range".

Explicitly NOT verified by the auditor, and still open to independent
measurement: the `COMPLETED_PASS: 0` / `COMPLETED_FAIL: 0` / 51-frozen /
seat-count figures (they live in `AGENTBRIDGE_HOME`, outside the worktree), and
the `whoami` measurements.
