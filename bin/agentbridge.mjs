#!/usr/bin/env node
import { initConfig, loadConfig, loadRegistry, registerAgent, unregisterAgent, localMachineLabel, CONFIG_FILE, VERSION } from '../src/config.mjs';
import { protectSecret, unprotectSecret, isWindows } from '../src/secretstore.mjs';
import { collect } from '../src/collect.mjs';
import { runDaemon } from '../src/daemon.mjs';
import { publish } from '../src/client.mjs';
import { resolveCommit } from '../src/git.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const HELP = `agentbridge ${VERSION} — read-only multi-agent coordination daemon

  agentbridge init --bridge-url <url> [--secret <hex>] [--label <name>]
  agentbridge register --agent code-c --lane messaging --worktree <path>
  agentbridge unregister --agent code-c
  agentbridge status [--json]
  agentbridge heartbeat [--dry-run]      one-shot collect (+publish unless --dry-run)
  agentbridge lanes [--file <f>] [--path <p>] [--json]
                                        show the lane registry, or explain one path
  agentbridge release-risk [--json] [--strict]
                                        exit 1 if any worktree carries release risk
  agentbridge delegate --id <id> --from <session> --to <session> --task <text>
             [--base <commit-ish>] [--repo <dir>] [--allow a,b] [--forbid a,b] [--shared a,b]
                                        record a bounded task handoff as a contract.
                                        the base is RESOLVED THROUGH GIT and defaults
                                        to HEAD; one that does not resolve is refused
  agentbridge delegations [--json]      list recorded handoffs and their state
  agentbridge delegations --for <session> [--all] [--json]
                                        what THIS session still owes: outstanding
                                        work only, or --all for its whole history
  agentbridge audit-delegation --id <id> [--head <sha>] [--files a,b] [--repo <dir>]
                                        exit 1 if the delegate went outside the contract
                                        [--record] persists the verdict onto the contract,
                                        which is what may-integrate later reads
  agentbridge delegation-state --id <id> --to returned|accepted|rejected|withdrawn
             [--head <sha>]             drive the contract lifecycle. returning requires
                                        the head SHA of the delivered work
  agentbridge may-integrate --id <id>   exit 1 unless the contract is accepted AND its
                                        recorded audit held. both, not either
  agentbridge wait-for-work --session <session_id> [--since <iso>]
             [--once] [--timeout <seconds>]
                                        WAIT to be woken instead of polling. The
                                        Bridge never calls out to this machine;
                                        this holds a request open and returns
                                        the moment work is assigned, cancelled,
                                        or a message arrives for you. Events are
                                        ids and times, NOT instructions: read
                                        the task or message yourself.
                                        exit 0 something happened, 3 nothing did
  agentbridge return-task --task <task_id> --session <session_id> --lease <lease_token>
             [--notes <text>] [--repo <dir>]
                                        HAND YOUR OWN WORK BACK. The head SHA is
                                        DERIVED FROM GIT, never a flag: a return
                                        with a typed commit is a claim, not
                                        evidence. Only the session the task was
                                        assigned to may return it.
                                        exit 0 returned, 1 refused (the Bridge
                                        answered and said no), 2 could not run
  agentbridge register-session --agent <agent_id> --session <session_id>
             [--lane <l>] [--capacity idle|busy|blocked|offline] [--repo <dir>]
             [--watch] [--interval <seconds>]
                                        SELF-REGISTER, locally AND hosted. repo,
                                        worktree and head are DERIVED FROM GIT,
                                        never flags; the server stamps the time.
                                        --watch refreshes automatically so a live
                                        session never ages out, and deregisters
                                        on Ctrl-C
  agentbridge unregister-session --session <session_id>
                                        clean shutdown, rather than aging out
  agentbridge lead-work --id <id> --agent <a> --session <s> --scope <text>
             --base <commit-ish> [--head <commit-ish>] [--tests <t>] [--repo <dir>]
  agentbridge lead-work [--json]        provenance for work nobody delegated.
                                        self-work is first-class, NOT a contract
                                        with the names filled in wrong
  agentbridge supersede --id <new> --supersedes <old> --reason <text>
             --replacement-task <id> [--replacement-head <sha>] [--repo <dir>]
                                        append a correction BESIDE a wrong record.
                                        accepted and withdrawn are terminal on
                                        purpose, so this is the only way to put a
                                        ledger entry right; the mistake stays
  agentbridge token-budget --record --handoff <file> [--tier <t>] [--task <id>]
  agentbridge token-budget [--json]     verified work per token. DESCRIPTIVE ONLY —
                                        never rewrites a handoff, never gates
  agentbridge ask --action <action> [--question <q>] [--by <agent>] [--json]
             [--project <p>] [--repo <r>] [--lane <l>] [--task <t>]
                                        ASK THE LEDGER BEFORE ASKING THE OWNER.
                                        exit 0 allowed, 1 denied, 3 owner_required,
                                        4 escalate (ask ONCE — passing --question
                                        records it), 5 already_escalated (somebody
                                        already asked; do NOT ask again)
  agentbridge answered --id <escalation_id> --decision <decision_id>
                                        close an open question with the decision
                                        that answers it, so the next worker is
                                        answered by the ledger instead of you
  agentbridge owner-decide --id <id> --owner <who> --statement <text>
             --scope bridge|project|repo|lane|task [--scope-id <x>]
             --effect allow|deny|require_owner --capabilities a,b
             [--constraints <json>] [--supersedes <id>]
                                        record what the owner decided, once, for
                                        every worker present and future
  agentbridge owner-decisions [--all] [--json]
                                        decisions in force, or --all for the
                                        whole history including superseded
  agentbridge owner-revoke --id <id> --owner <who> [--reason <text>]
                                        stop a decision applying, without
                                        erasing what the owner originally said
  agentbridge workers [--registry-file <f>] [--json]
                                        the worker pool: agents, their live
                                        sessions, where each is, and capacity
  agentbridge doctor                    verify secret sealing and file permissions
  agentbridge daemon start

This layer is READ-ONLY. It observes and publishes state. It does not take
instructions from the bridge, and cannot execute anything on its behalf.
`;

/** Comma-separated CLI list -> array. Empty, absent, or a bare flag mean none. */
const split = (v) => (typeof v === 'string' && v.length ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/**
 * Load the lane registry, or null when none is configured.
 *
 * Returns null rather than throwing for "no registry", because that is a
 * legitimate state on a machine that has not set one up. A registry that
 * EXISTS but is malformed is a different thing and does throw -- silently
 * treating a broken registry as an absent one would let a typo disable
 * identity checking wholesale.
 */
async function loadLaneRegistry(explicitFile) {
  const cfg = await loadConfig();
  const file = explicitFile || cfg?.lanesFile?.[0] || cfg?.lanesFile || null;
  if (!file) return null;
  const { readFile } = await import('node:fs/promises');
  const R = await import('../src/laneRegistry.mjs');
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch { throw new Error(`cannot read lane registry: ${file}`); }
  const reg = R.parseLaneRegistry(text, { source: file });
  const v = R.validateRegistry(reg);
  if (!v.ok) throw new Error(`lane registry ${file} is invalid: ${v.errors[0]}`);
  return { reg, file, R };
}

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));

/*
 * A COMMAND THAT MUST NOT CALL process.exit().
 *
 * On node 24 / Windows, calling process.exit() after a `fetch` trips a libuv
 * assertion and kills the process with 127:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
 *
 * The command prints the right answer and then dies, so anything reading the
 * exit code sees a failure that did not happen. Reproduced in four lines
 * outside this project, so it is node's, not ours. Exiting NATURALLY is clean.
 *
 * Every other branch still exits explicitly, which is fine because none of them
 * opens a socket. A branch that does sets this flag instead, and the
 * unknown-command handler at the bottom honours it -- `return` is not available
 * here, this being module top level rather than a function body.
 */
let handled = false;

/**
 * Stop a command the way process.exit() used to, without calling it.
 *
 * WHY A THROW. Only `process.exitCode` + a natural exit survives a preceding
 * fetch; process.exit() trips the libuv assertion above however carefully the
 * sockets are drained (measured: destroying undici's dispatcher and deferring
 * through setImmediate both still die with 127). But `process.exitCode = n`
 * alone does NOT stop execution the way exit did, and a refusal that carries on
 * is worse than a crash -- it would record the contract it just refused.
 *
 * So the sentinel throws, which halts exactly where exit halted, and the block
 * boundary converts it into an exit code. Control flow is unchanged; only the
 * mechanism is.
 *
 * `return` is not available: this is module top level, not a function body.
 */
class Done extends Error {
  constructor(code) { super(`done:${code}`); this.exitCode = code; }
}
const done = (code) => { throw new Done(code); };

try {
  if (!cmd || cmd === 'help' || args.help) { console.log(HELP); process.exit(0); }

  if (cmd === 'init') {
    const cfg = await initConfig({ bridgeUrl: args['bridge-url'], secret: args.secret, label: args.label });
    console.log(`machine id  : ${cfg.machineId}`);
    console.log(`bridge url  : ${cfg.bridgeUrl ?? '(none — local-only mode)'}`);
    console.log(`config      : ${CONFIG_FILE}`);
    console.log(`secret seal : ${cfg.sealScheme}${cfg.degraded ? '  (DEGRADED)' : ''}`);
    console.log(`permissions : ${cfg.permissions.scheme} ${cfg.permissions.ok ? 'OK' : 'FAILED'}`);
    if (cfg.degraded) {
      console.error(`\n!! Could not seal the secret with DPAPI: ${cfg.degradedReason}`);
      console.error('!! It is stored in plaintext. Do NOT point this at a hosted bridge until fixed.');
    }
    if (!cfg.permissions.ok) {
      console.error(`\n!! Config file permissions are too broad: ${JSON.stringify(cfg.permissions.detail)}`);
    }
    // The secret is only printed on request, so it does not land in scrollback
    // or a pasted terminal transcript by default.
    if (args['show-secret']) {
      console.log(`\nShared secret (register this machine on the bridge with it):\n  ${cfg.secret}\n`);
      console.log('Treat that value like an SSH key.');
    } else {
      console.log('\nRun with --show-secret when you are ready to register this machine on the bridge.');
    }
    process.exit(cfg.degraded || !cfg.permissions.ok ? 1 : 0);
  }

  if (cmd === 'register') {
    for (const k of ['agent', 'lane', 'worktree']) {
      if (!args[k] || args[k] === true) { console.error(`missing --${k}`); process.exit(2); }
    }
    const rec = await registerAgent({ agentId: args.agent, lane: args.lane, worktree: args.worktree });
    console.log(`registered ${rec.agentId} (lane ${rec.lane}) -> ${rec.worktree}`);
    process.exit(0);
  }

  if (cmd === 'unregister') {
    await unregisterAgent(args.agent);
    console.log(`unregistered ${args.agent}`);
    process.exit(0);
  }

  if (cmd === 'status' || cmd === 'heartbeat') {
    const cfg = await loadConfig();
    if (!cfg) { console.error('Not initialised. Run: agentbridge init'); process.exit(2); }
    const payload = await collect(cfg, await loadRegistry());

    if (cmd === 'heartbeat' && !args['dry-run']) {
      const r = await publish(cfg, payload);
      console.error(r.ok && r.accepted ? 'published.' : `publish failed: ${r.status ?? '-'} ${r.reason ?? ''}`);
    }
    if (args.json || cmd === 'heartbeat') { console.log(JSON.stringify(payload, null, 2)); process.exit(0); }

    console.log(`machine ${localMachineLabel(cfg)} [${payload.machine.name}] (${payload.machine.platform})  ${payload.sentAt}`);
    if (!payload.processProbe.ok) console.log(`  ! process probe failed: ${payload.processProbe.error}`);
    for (const s of payload.sessions) {
      const g = s.git;
      if (!g.ok) { console.log(`\n${s.agentId} [${s.lane}]  ERROR ${g.reason}  ${s.worktree}`); continue; }
      console.log(`\n${s.agentId} [${s.lane}]  ${s.worktree}`);
      console.log(`  branch   ${g.branch ?? '(detached)'}  head ${g.head?.slice(0, 12)}`);
      console.log(`  base     ${g.baseSha?.slice(0, 12) ?? '?'}   ${g.mainRef} ${g.mainSha?.slice(0, 12) ?? '?'}`);
      console.log(`  unpushed ${g.unpushed ?? '?'} (${g.unpushedReason ?? '-'})  ahead ${g.aheadOfMain ?? '?'} / behind ${g.behindMain ?? '?'}`);
      console.log(`  files    ${g.staged.length} staged, ${g.dirty.length} dirty, ${g.untracked.length} untracked`);
      if (s.locks.length) console.log(`  locks    ${s.locks.map((l) => `${l.resource}(${l.ageSeconds}s)`).join(', ')}`);
      if (s.processes.length) console.log(`  running  ${s.processes.map((p) => `${p.kind}:${p.pid}${p.ambiguous ? '?' : ''}`).join(', ')}${s.processes.some((p) => p.ambiguous) ? '   (? = ambiguous match, may belong to another worktree)' : ''}`);
    }
    process.exit(0);
  }

  /*
   * delegate / delegations / audit-delegation — the handoff as a contract.
   *
   * Records who assigned what to whom, from which SHA, with which files in and
   * out of bounds. Stored beside the machine's own state rather than in the
   * repository: it is coordination data, not project history.
   *
   * `audit-delegation` is the point of the whole thing -- it takes the files
   * the delegate actually changed and COMPUTES whether the contract held,
   * instead of a human reading a diff and remembering what was agreed.
   */
  if (cmd === 'delegate' || cmd === 'delegations' || cmd === 'audit-delegation'
      || cmd === 'delegation-state' || cmd === 'may-integrate') {
    /*
     * EVERY EXIT IN THIS BLOCK GOES THROUGH done(), WHICH THROWS.
     *
     * These commands consult the hosted registry, and process.exit() after a
     * fetch dies with a libuv assertion (exit 127) on node 24 / Windows -- the
     * command does its work and then reports a failure that did not happen,
     * which for `delegate` means a caller re-records a contract that already
     * exists. Measured before choosing this: destroying undici's dispatcher and
     * deferring through setImmediate both still die. Only exitCode plus a
     * natural exit survives.
     *
     * The throw halts exactly where exit did, so control flow is unchanged.
     * This boundary turns it back into an exit code.
     */
    try {
    const { readDelegations, writeDelegations } = await import('../src/provenanceStore.mjs');
    const P = await import('../src/provenance.mjs');

    /*
     * A STORE THAT CANNOT BE READ IS "CANNOT RUN", NOT "NOTHING TO DO".
     *
     * readDelegations throws on a corrupt file rather than returning [] -- see
     * provenanceStore.mjs, which is deliberate so a bad parse never silently
     * discards every record on the next write. The top-level catch would turn
     * that into exit 1, which in this CLI means "a finding" and is what a hook
     * reads as a real refusal. 2 is the code the rest of the tool already uses
     * for a precondition that makes the command impossible.
     *
     * This matters most for --for: an agent asking "what do I owe?" must be
     * able to tell "nothing" from "I could not find out".
     */
    let all;
    try {
      all = await readDelegations();
    } catch (e) {
      console.error(`error: cannot read the delegation store: ${e.message}`);
      done(2);
    }

    if (cmd === 'delegations') {
      /*
       * `--for` with no value parses to boolean true. Filtering on that would
       * match no record and print "nothing outstanding" to an agent that has
       * work -- a wrong answer delivered confidently, which is worse here than
       * an error, because the whole point of the command is to be trusted on
       * startup. Refuse instead.
       */
      const forSession = args['for'];
      if (forSession !== undefined) {
        if (typeof forSession !== 'string' || !forSession.length) {
          console.error('usage: agentbridge delegations --for <session-id> [--all] [--json]');
          done(2);
        }
        const mine = P.delegationsForSession(all, forSession, { includeAll: args.all === true });
        if (args.json) { console.log(JSON.stringify(mine, null, 2)); done(0); }
        if (!mine.length) {
          // Exit 0. An agent with an empty queue is the normal, healthy case;
          // making absence an error would have every clean startup look broken.
          console.log(args.all === true
            ? `no delegations recorded for ${forSession}`
            : `no outstanding delegations for ${forSession}`);
          done(0);
        }
        for (const d of mine) {
          console.log(`${d.id}  [${d.state}]  from ${d.assigning_session}`);
          console.log(`  task     ${d.task}`);
          console.log(`  base     ${d.base_sha}${d.head_sha ? `   head ${d.head_sha}` : ''}`);
          console.log(`  allowed  ${d.allowed_paths?.length ? d.allowed_paths.join(', ') : '(none)'}`);
          console.log(`  forbidden ${d.forbidden_paths?.length ? d.forbidden_paths.join(', ') : '(none)'}`);
        }
        done(0);
      }

      if (args.json) { console.log(JSON.stringify(all, null, 2)); done(0); }
      if (!all.length) { console.log('no delegations recorded'); done(0); }
      for (const d of all) {
        console.log(`${d.id}  [${d.state}]  ${d.assigning_session} -> ${d.assigned_session}`);
        console.log(`  task     ${d.task}`);
        console.log(`  base     ${d.base_sha}${d.head_sha ? `   head ${d.head_sha}` : ''}`);
        if (d.allowed_paths.length) console.log(`  allowed  ${d.allowed_paths.join(', ')}`);
        if (d.forbidden_paths.length) console.log(`  forbidden ${d.forbidden_paths.join(', ')}`);
        if (d.audit) console.log(`  audit    ${d.audit.ok ? 'clean' : `${d.audit.violations.length} violation(s)`}`);
      }
      done(0);
    }

    if (cmd === 'delegate') {
      /*
       * THE BRIDGE RESOLVES THE BASE. AN AGENT NEVER TYPES ONE FROM MEMORY.
       *
       * validateDelegation checks the SHA's SHAPE, which a fabricated string
       * satisfies. On 2026-09-15 a contract was recorded against a forty-
       * character hex string that had never named an object -- a short SHA the
       * agent knew, padded out. It stored cleanly and pointed nowhere.
       *
       * So the identifier comes from the machine, not the operator: --base is
       * optional and defaults to HEAD, whatever is given is resolved through
       * git, and an unresolvable base refuses the whole command. The stored
       * value is always the canonical 40-character id, never the abbreviation
       * that was typed.
       *
       * Exit 2: a base that does not resolve makes the command impossible,
       * which is what 2 means here. Nothing is written.
       */
      const repo = typeof args.repo === 'string' && args.repo.length ? args.repo : process.cwd();
      if (args.base !== undefined && typeof args.base !== 'string') {
        console.error('--base needs a value: a commit-ish this repository can resolve');
        done(2);
      }
      const resolved = await resolveCommit(repo, args.base);
      if (!resolved.ok) {
        console.error(resolved.reason === 'not-a-git-worktree'
          ? `error: ${repo} is not a git worktree; pass --repo <dir>`
          : `error: base "${resolved.rev}" does not resolve to a commit in ${repo}`);
        console.error('the Bridge resolves the base itself — do not type a SHA from memory');
        done(2);
      }
      if (typeof args.base === 'string' && args.base !== resolved.sha) {
        console.log(`base ${args.base} -> ${resolved.sha}`);
      }

      /*
       * THE TARGET IS RESOLVED THROUGH THE REGISTRY, NOT TAKEN ON TRUST.
       *
       * Same rule as the base SHA one screen up, for the same reason: an
       * identifier the machine can check should never be typed from memory.
       * `--to danny-win-f1` was accepted for days as a free-floating string.
       * It happens to be a real session -- the registry maps it to code-b --
       * but nothing verified that, and a typo would have recorded a contract
       * addressed to nobody, which is indistinguishable from one nobody has
       * picked up yet.
       *
       * resolveWorker joins the durable agent to its live runtime and REFUSES
       * on unknown-agent, no-live-session, or several candidates (naming them,
       * rather than silently choosing the newest).
       *
       * NO REGISTRY CONFIGURED IS NOT A PASS AND NOT A FAILURE -- it is a
       * separate, named state. Refusing outright would break every machine
       * that has not set one up; accepting silently would make this check
       * vanish exactly where nobody has configured anything. It warns, loudly,
       * and says how to stop seeing the warning.
       */
      let bound = null;
      let registry = null;
      /*
       * TARGET VERIFICATION, IN PRIORITY ORDER.
       *
       *   1. the LIVE registry, derived from runtime self-registration
       *   2. a lane registry FILE, if one was configured
       *   3. neither: accept, but record the target as legacy-unverified
       *
       * The live registry wins because it is the only one that can be wrong in
       * a way that corrects itself. A file is right until a session restarts
       * and then stays confidently wrong.
       *
       * Path 3 is NOT deleted. Removing it would refuse every delegation on a
       * machine where nothing has registered yet, which is every machine on its
       * first run. It is kept, and what changes is that it no longer pretends:
       * the contract is stamped legacy-unverified and says so on the way past.
       */
      let verification = 'legacy-unverified';
      const { readRegistrations } = await import('../src/registrationStore.mjs');
      const LR = await import('../src/liveRegistry.mjs');
      let live = [];
      try { live = await readRegistrations(); }
      catch (e) {
        // A corrupt registration file must not silently downgrade to the
        // unverified path -- that turns a broken machine into a permissive one.
        console.error(`error: cannot read the registration store: ${e.message}`);
        done(2);
      }

      /*
       * HOSTED REGISTRATIONS JOIN THE ROSTER, AND AN OUTAGE REFUSES.
       *
       * If the hosted registry is configured and failing, this command stops.
       * Carrying on with local state would silently downgrade a cross-machine
       * target from verified to accepted-on-trust at exactly the moment nobody
       * is watching, and would be indistinguishable from a machine that has no
       * hosted project at all. Not-configured is fine and stays local-only.
       */
      const H = await import('../src/hostedRegistry.mjs');
      const hosted = await H.fetchHostedRegistrations(process.env);
      if (hosted.state === H.HOSTED.UNREACHABLE || hosted.state === H.HOSTED.MALFORMED) {
        console.error(`error: the hosted registry is configured but ${hosted.state}: ${hosted.detail ?? ''}`);
        console.error('       refusing rather than recording this target as unverified —');
        console.error('       an outage must not quietly downgrade a verified delegation.');
        done(2);
      }
      if (hosted.state === H.HOSTED.OK) live = H.mergeRegistrations(live, hosted.rows);

      const liveReg = LR.registryFromSessions(live, { now: new Date().toISOString() });
      if (liveReg.sessions.length) {
        /*
         * resolveLiveAgent, NOT laneRegistry.resolveWorker.
         *
         * Both answer "which runtime is this agent", but resolveWorker takes a
         * registry parsed from a YAML file and this path has live rows. The
         * hosted coordinator needs the same answer and cannot load a YAML
         * parser, so the live-registry resolution lives in src/coordination.mjs
         * and BOTH callers use it. Two implementations of identity disagree the
         * first time one is fixed, and this project has already paid for that
         * once.
         */
        const CO = await import('../src/coordination.mjs');
        const asSession = liveReg.sessions.find((s) => s.session_id === args.to);
        const agentId = asSession ? asSession.agent_id : args.to;
        const r = CO.resolveLiveAgent(liveReg.sessions, agentId);
        if (!r.ok) {
          console.error(`error: --to "${args.to}" did not resolve against the LIVE registry: ${r.reason}`);
          if (r.candidates?.length) console.error(`       candidates: ${r.candidates.join(', ')}`);
          console.error('       workers register with: agentbridge register-session --agent <a> --session <s>');
          done(2);
        }
        /*
         * AN INDEPENDENT LIVENESS RE-CHECK, AND IT IS NOT DECORATION.
         *
         * Measured on 2026-09-15 rather than assumed: breaking resolveWorker's
         * `capacity !== 'offline'` filter ALONE was enough to let a declared-
         * offline worker accept a contract. isLive did not save it, because
         * isLive only LABELS the capacity — the filter was the single
         * enforcement point, so what looked like two layers was one layer and
         * one annotation.
         *
         * This is the second layer, made real. It consults isLive directly
         * against the registration row, so the two protections now fail
         * independently: breaking either one still refuses, and only breaking
         * both lets a dead session through. The redundancy harness proves each
         * case separately.
         */
        const chosen = live.find((s) => s?.session_id === r.session_id);
        if (!chosen || !LR.isLive(chosen, { now: new Date().toISOString() })) {
          console.error(`error: --to "${args.to}" resolved to session ${r.session_id}, which is not live`);
          console.error('       the resolver and the liveness check disagree — refusing rather than guessing');
          done(2);
        }

        bound = r;
        verification = 'verified';
        if (r.session_id !== args.to) console.log(`to ${args.to} -> session ${r.session_id} (agent ${r.agent_id})`);
      } else {
        try { registry = await loadLaneRegistry(args['registry-file']); }
        catch (e) { console.error(`error: ${e.message}`); done(2); }
      }

      if (bound) {
        // Resolved live. Nothing further to try.
      } else if (!registry) {
        console.error('warning: no live registrations and no lane registry, so --to was NOT verified.');
        console.error('         this contract is recorded as legacy-unverified.');
        console.error('         to verify targets, have each worker run:');
        console.error('           agentbridge register-session --agent <agent_id> --session <session_id>');
      } else {
        const { reg, R } = registry;
        // Accept either the durable agent id or a live session id, and store
        // the session. A person reads "code-b"; the ledger needs the runtime.
        const asSession = reg.sessions?.find((s) => s.session_id === args.to);
        const agentId = asSession ? asSession.agent_id : args.to;
        const r = R.resolveWorker(reg, { agent_id: agentId });
        if (!r.ok) {
          console.error(`error: --to "${args.to}" did not resolve: ${r.reason}`);
          if (r.candidates?.length) console.error(`       candidates: ${r.candidates.join(', ')}`);
          console.error('       the Bridge resolves the target — do not type a session id from memory');
          done(2);
        }
        bound = r;
        /*
         * A FILE-RESOLVED TARGET IS STILL NOT `verified`.
         *
         * The file said this session exists; nothing checked that it is
         * RUNNING. That is a weaker claim than a heartbeat, and collapsing the
         * two would let a stale roster produce contracts indistinguishable from
         * ones the Bridge actually confirmed.
         */
        verification = 'file-registry-unverified-liveness';
        if (r.session_id !== args.to) console.log(`to ${args.to} -> session ${r.session_id} (agent ${r.agent_id})`);
      }

      const rec = P.createDelegation({
        id: args.id,
        assigning_session: args.from,
        assigned_session: bound ? bound.session_id : args.to,
        task: args.task,
        lane_id: args.lane ?? null,
        base_sha: resolved.sha,
        allowed_paths: split(args.allow),
        forbidden_paths: split(args.forbid),
        shared_paths: split(args.shared),
        now: new Date().toISOString(),
      });
      /*
       * THE MARKER IS STAMPED HERE AND NEVER INFERRED LATER.
       *
       * Existing contracts carry no marker at all, and verificationOf() reads an
       * absent one as legacy-unverified, permanently. That is deliberate: every
       * delegation recorded before today took the warn-and-accept path, and
       * there is no way to go back and establish who those were really
       * addressed to. Backfilling would rewrite the provenance of all of them at
       * once, which is the same error as editing a ledger to agree with the
       * present.
       */
      rec.target_verification = verification;

      const v = P.validateDelegation(rec);
      if (!v.ok) { for (const e of v.errors) console.error(`  - ${e}`); done(2); }
      if (all.some((d) => d.id === rec.id)) { console.error(`delegation "${rec.id}" already exists`); done(2); }
      await writeDelegations([...all, rec]);
      console.log(`recorded delegation ${rec.id}: ${rec.assigning_session} -> ${rec.assigned_session} from ${rec.base_sha.slice(0, 12)}`);
      console.log(`  target ${verification}`);
      /*
       * NO done() — this branch consults the hosted registry, and
       * exiting after a fetch trips a libuv assertion on node 24 / Windows that
       * kills the process with 127 AFTER it has done the work. The delegation
       * was written; reporting a failure at that point is the worst possible
       * lie, because a caller would re-record a contract that already exists.
       * See `handled` at the top of this file.
       */
      handled = true;
    }

    /*
     * Guarded, because `delegate` above no longer exits. Without this, a
     * successful delegation ran straight on into the lookup for a DIFFERENT
     * subcommand and reported `no delegation "<id>"` immediately after
     * recording it -- a contradiction in consecutive lines of output.
     */
    const d = handled ? null : all.find((x) => x.id === args.id);
    if (!handled && !d) { console.error(`no delegation "${args.id}"`); done(2); }

    // delegation-state --id <id> --to returned|accepted|rejected|withdrawn [--head <sha>]
    if (cmd === 'delegation-state') {
      const t = P.transition(d, args.to, {
        head_sha: args.head ?? null,
        audit: d.audit,
        now: new Date().toISOString(),
      });
      if (!t.ok) { for (const e of t.errors) console.error(`  - ${e}`); done(2); }
      await writeDelegations(all.map((x) => (x.id === d.id ? t.record : x)));
      console.log(`${d.id}: ${d.state} -> ${t.record.state}${t.record.head_sha ? ` @ ${t.record.head_sha.slice(0, 12)}` : ''}`);
      done(0);
    }

    /*
     * may-integrate — THE HARD GATE.
     *
     * Delegated work may be integrated only when the contract completed AND the
     * computed audit held. Both, not either: an accepted delegation whose audit
     * was never run is a human saying "looks fine", which is the thing this
     * whole mechanism exists to replace.
     *
     * Exits 1 when integration is not permitted, so it can sit in front of a
     * merge the same way release-risk sits in front of a push.
     */
    if (cmd === 'may-integrate') {
      const reasons = [];
      if (d.state !== 'accepted') reasons.push(`state is "${d.state}", not "accepted"`);
      if (!d.head_sha) reasons.push('no head_sha was ever returned');
      if (!d.audit) reasons.push('no audit has been recorded');
      else if (!d.audit.ok) reasons.push(`the recorded audit found ${d.audit.violations.length} violation(s)`);

      if (reasons.length) {
        console.log(`INTEGRATION REFUSED — ${d.id}`);
        for (const r of reasons) console.log(`  - ${r}`);
        done(1);
      }
      console.log(`integration permitted — ${d.id} accepted at ${d.head_sha.slice(0, 12)}, audit clean`);
      done(0);
    }

    // audit-delegation's tail. `handled` means `delegate` already finished and
    // declined to exit; without this guard it falls through to auditing a
    // delegation it never asked about, with d null.
    if (!handled) {
    let files = split(args.files);
    if (!files.length) {
      const head = args.head ?? d.head_sha;
      if (!head) { console.error('need --head <sha> or --files'); done(2); }
      const { run } = await import('../src/exec.mjs');
      const r = await run('git', ['diff', '--name-only', `${d.base_sha}..${head}`], { cwd: args.repo ?? process.cwd() });
      if (!r.ok) { console.error(`cannot diff ${d.base_sha}..${head}: ${r.error}`); done(2); }
      files = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    }

    const result = P.auditChangedPaths(d, files);

    // --record persists the verdict onto the contract, which is what
    // may-integrate later reads. Without it an audit is a console message that
    // nothing downstream can check, and "I ran it and it was fine" is exactly
    // the unverifiable claim this replaces.
    if (args.record) {
      const stamped = { ...d, audit: { ...result, head_sha: args.head ?? d.head_sha, at: new Date().toISOString() } };
      await writeDelegations(all.map((x) => (x.id === d.id ? stamped : x)));
    }

    if (args.json) console.log(JSON.stringify({ delegation: d.id, result }, null, 2));
    else {
      console.log(`audit ${d.id}: ${files.length} file(s) changed`);
      for (const v of result.violations) console.log(`  VIOLATION  ${v.path}  (${v.reason}) — ${v.detail}`);
      if (result.shared.length) console.log(`  shared touched: ${result.shared.join(', ')}`);
      console.log(result.ok ? '  contract held' : `  ${result.violations.length} violation(s)`);
    }
    done(result.ok ? 0 : 1);
    }
    } catch (e) {
      // done() landing here is a deliberate stop, not a fault. Anything else is
      // a real error and must keep its stack rather than being flattened into
      // an exit code.
      if (!(e instanceof Done)) throw e;
      process.exitCode = e.exitCode;
    }
    handled = true;
  }

  /*
   * register-session / unregister-session / workers — RUNTIME SELF-REGISTRATION.
   *
   *   agentbridge register-session --agent <agent_id> --session <session_id>
   *              [--lane <lane_id>] [--capacity idle|busy|blocked|offline] [--repo <dir>]
   *   agentbridge unregister-session --session <session_id>
   *
   * THE ROSTER IS NOT TYPED. A hand-authored registry is humans writing machine
   * truth: wrong the moment a session restarts, and wrong confidently, because
   * `--to code-b` keeps resolving against a name that was accurate last week.
   *
   * WHAT THE WORKER MAY DECLARE, AND WHAT IT MAY NOT. It declares its durable
   * agent_id and its own session_id, because only it knows those. Everything
   * locating it in the world -- repo_id, worktree_id, head_sha -- is DERIVED
   * FROM GIT in this process and cannot be passed as a flag. That is the teeth:
   * an agent cannot claim to be working in a repository it is not in, so it
   * cannot make itself the resolution target for work there.
   *
   * heartbeat_at is stamped here rather than accepted, for the same reason. A
   * worker that could send its own timestamp could keep a dead session live.
   */
  /*
   * unregister-session IS ITS OWN COMMAND, not a branch inside register-session.
   *
   * It used to share that block and exit from inside it. When it stopped
   * exiting -- because it now makes a request, and exiting after one trips the
   * libuv assertion -- sharing the block meant execution fell straight on into
   * the registration path and demanded an --agent the caller had no reason to
   * pass. Two commands in one block only worked while one of them could exit.
   */
  /*
   * return-task — A WORKER HANDS ITS OWN WORK BACK.
   *
   * The counterpart to assign_task, and deliberately NOT a coordinator tool.
   * `returned` has to be written by the party that did the work, or the accept
   * that follows is the same actor on both sides of a review.
   *
   * The head SHA is resolved from git exactly as register-session resolves it,
   * for the same reason: a return carrying a typed commit is a claim, and every
   * unverifiable status update in this project has had that shape.
   */
  /*
   * wait-for-work — EVENT-DRIVEN, WITHOUT GIVING THE BRIDGE A WAY IN.
   *
   * The coordinator polls hourly at best, so work assigned at 14:00 sat until a
   * worker's next heartbeat. The fix is not a webhook -- a local session has no
   * inbound address, and a data plane that POSTs wherever a token holder points
   * it is an SSRF engine. So the worker waits and the Bridge answers.
   *
   * WHAT COMES BACK IS A DOORBELL. Ids and timestamps, never the instruction:
   * the worker reads the task or the message through the path it already has.
   */
  if (cmd === 'wait-for-work') {
    if (!args.session || typeof args.session !== 'string') {
      console.error('error: --session <session_id> is required');
      process.exit(2);
    }

    const Hw = await import('../src/hostedRegistry.mjs');
    const seconds = Number(args.timeout ?? 25);
    if (!Number.isFinite(seconds) || seconds < 1) {
      console.error('error: --timeout must be at least 1 second');
      process.exit(2);
    }

    let cursor = typeof args.since === 'string' && args.since.trim() ? args.since.trim() : null;
    let woke = false;

    for (;;) {
      const res = await Hw.waitForEvents(process.env, {
        session_id: args.session,
        since: cursor,
        timeout_ms: Math.round(seconds * 1000),
      // The client waits LONGER than the server: otherwise every quiet period
      // ends as a client abort and "nothing happened" is indistinguishable
      // from a broken connection.
      }, { timeoutMs: Math.round(seconds * 1000) + 15000 });

      if (res.state === Hw.HOSTED.NOT_CONFIGURED) {
        console.error('error: no registration token, so there is nothing to wait on');
        console.error('       set AGENTBRIDGE_REGISTRATION_TOKEN (a scoped token, NOT a database key)');
        process.exitCode = 2;
        break;
      }
      if (res.state === Hw.HOSTED.REFUSED) {
        console.error(`error: the Bridge refused the wait: ${res.detail}`);
        process.exitCode = 2;
        break;
      }
      if (res.state === Hw.HOSTED.REJECTED) {
        console.error(`error: the Bridge REFUSED this credential (${res.detail})`);
        console.error('       check the token, not the network; the cursor has not moved');
        process.exitCode = 2;
        break;
      }
      if (res.state !== Hw.HOSTED.OK) {
        console.error(`error: the Bridge is unreachable (${res.detail})`);
        console.error('       nothing was missed; the cursor has not moved');
        process.exitCode = 2;
        break;
      }

      cursor = res.cursor ?? cursor;

      for (const e of res.events) {
        woke = true;
        if (e.kind === 'assigned') {
          console.log(`assigned  ${e.task_id}${e.lane_id ? `  lane ${e.lane_id}` : ''}  at ${e.at}`);
        } else if (e.kind === 'cancelled') {
          console.log(`cancelled ${e.task_id}  at ${e.at}`);
        } else {
          console.log(`message   from ${e.from ?? '?'} [${e.type ?? '?'}]  at ${e.at}`);
        }
      }
      if (res.events.length) {
        // The ids are the whole payload. Reading the content is a separate,
        // deliberate act through the authenticated path.
        console.log(`  cursor  ${cursor}`);
        console.log('  read the details with `agentbridge workers` or the coordination log');
      }

      if (args.once) {
        // exit 3 = nothing happened. Distinct from 0, so a shell loop can tell
        // "woken" from "waited and nothing came" without parsing stdout.
        if (!woke) process.exitCode = 3;
        break;
      }
      if (res.events.length) break;
    }

    await Hw.closeHttp();
    handled = true;
  }

  if (cmd === 'return-task') {
    if (!args.task || typeof args.task !== 'string') {
      console.error('error: --task <task_id> is required');
      process.exit(2);
    }
    if (!args.session || typeof args.session !== 'string') {
      // NOT defaulted from the registry. A worker that returns work under
      // whichever session happens to be registered is exactly the confusion
      // the session check on the far end exists to catch.
      console.error('error: --session <session_id> is required (the session the task was assigned to)');
      process.exit(2);
    }

    /*
     * THE FENCING TOKEN, AND WHY THIS REFUSES LOCALLY RATHER THAN LETTING THE
     * BRIDGE SAY NO.
     *
     * /return requires lease_token and has no fallback -- the comparison IS the
     * zombie catch, and a path that accepts a return without one is the path
     * every zombie takes by omitting a field. Sending the request anyway earns
     * an HTTP 400 that reads like a malformed client. Refusing here says the
     * true thing: this worker does not hold the credential the task's row is
     * fenced with.
     *
     * IT IS PER TASK, NOT PER SESSION, ON PURPOSE. claim_task mints a fresh
     * token on every claim, so a worker holding two tasks holds two tokens. One
     * stored against the session would send the wrong one for one of them, and
     * the far end would read that as a stale lease -- the zombie refusal firing
     * on a worker that is not a zombie.
     */
    if (!args.lease || typeof args.lease !== 'string') {
      console.error('error: --lease <lease_token> is required (the fencing token for THIS task)');
      console.error('       claim_task mints it when the task is assigned; it is what proves the');
      console.error('       lease you hold is still the current one');
      console.error('       NOTE: nothing delivers it to a worker yet -- see the gap named in');
      console.error('       test/leaseWiring.test.mjs. Until then this command cannot succeed.');
      process.exit(2);
    }

    const { resolveCommit: resolveForReturn } = await import('../src/git.mjs');
    const cwdR = args.repo ?? process.cwd();
    const gR = await resolveForReturn(cwdR, 'HEAD');
    if (!gR.ok) {
      console.error(`error: cannot read HEAD in ${cwdR}: ${gR.reason}`);
      console.error('       the returned commit is derived from git, never accepted as a flag');
      process.exit(2);
    }

    const Hr = await import('../src/hostedRegistry.mjs');
    const res = await Hr.returnWork(process.env, {
      task_id: args.task,
      session_id: args.session,
      lease_token: args.lease,
      head_sha: gR.sha,
      notes: typeof args.notes === 'string' ? args.notes : null,
    });

    if (res.state === Hr.HOSTED.OK) {
      console.log(`returned ${args.task}`);
      console.log(`  commit   ${gR.sha.slice(0, 12)}`);
      console.log(`  session  ${args.session}`);
      if (args.notes) console.log(`  notes    ${args.notes}`);
      console.log('  the coordinator sees this in its inbox; acceptance is theirs, not yours');
    } else if (res.state === Hr.HOSTED.REFUSED) {
      // The Bridge answered and said no. Every reason at once, because the
      // worker can usually fix exactly one of them and needs to know which.
      console.error(`refused: ${args.task} was not returned`);
      for (const e of res.errors ?? []) console.error(`  - ${e}`);
      if (!(res.errors ?? []).length) console.error(`  - ${res.detail}`);
      process.exitCode = 1;
    } else if (res.state === Hr.HOSTED.NOT_CONFIGURED) {
      console.error('error: no registration token, so there is nowhere to return work to');
      console.error('       set AGENTBRIDGE_REGISTRATION_TOKEN (a scoped token, NOT a database key)');
      process.exitCode = 2;
    } else if (res.state === Hr.HOSTED.REJECTED) {
      // Already exited non-zero before this change; what was wrong was the
      // WORD. "Unreachable" sends a worker to check a network it cannot fix.
      console.error(`error: the Bridge REFUSED this credential (${res.detail})`);
      console.error('       the work is NOT returned; check the token, not the network');
      process.exitCode = 2;
    } else {
      console.error(`error: the Bridge is unreachable (${res.detail})`);
      console.error('       the work is NOT returned; nothing was recorded');
      process.exitCode = 2;
    }

    // Same exit discipline as register-session: this just made a request, and
    // exiting explicitly after one trips the libuv assertion on Windows.
    await Hr.closeHttp();
    handled = true;
  }

  if (cmd === 'unregister-session') {
    const R = await import('../src/registrationStore.mjs');

    {
      if (!args.session) { console.error('error: --session <session_id> is required'); process.exit(2); }

      /*
       * DEREGISTERING HAS TO REACH THE HOSTED REGISTRY TOO.
       *
       * This removed the LOCAL row and stopped there. Hosted kept the session,
       * so a worker that deregistered deliberately went on looking idle to
       * every other machine until it aged out ten minutes later -- and on a
       * worker machine there is no way to notice, because `workers` has no
       * reader token and cannot see hosted state at all.
       *
       * Observed: code-d ran this, reported itself gone, and was still in the
       * hosted roster 36 minutes later. It was telling the truth about what it
       * had done. The command was not doing all of it.
       *
       * The row is read BEFORE removal because publishing "offline" needs the
       * identity that is about to be deleted: machine_id and a full 40-char
       * head_sha are required by the write path and cannot be reconstructed
       * from a session id.
       */
      const mine = (await R.readRegistrations()).find((r) => r?.session_id === args.session) ?? null;
      const { removed } = await R.removeRegistration(args.session);
      console.log(removed ? `unregistered ${args.session}` : `no registration for ${args.session}`);

      if (mine) {
        const Hu = await import('../src/hostedRegistry.mjs');
        const pub = await Hu.publishRegistration(process.env, { ...mine, capacity: 'offline' });
        if (pub.state === Hu.HOSTED.OK) {
          console.log('  hosted   marked offline — other machines will stop seeing this session');
        } else if (pub.state === Hu.HOSTED.NOT_CONFIGURED) {
          console.log('  hosted   NOT CONFIGURED — local only; a hosted row, if any, will age out');
        } else {
          /*
           * THE SAME EXIT-0 BUG b6 FOUND IN register-session, AND THIS IS THE
           * WORSE PLACE FOR IT.
           *
           * The comment here already said the consequence out loud -- "a
           * session other machines still believe is alive, which is what gets
           * work addressed to nobody" -- and then the command exited 0 anyway.
           * A deregistration that did not deregister is precisely the failure
           * that hands work to a worker who has gone home.
           *
           * Found by auditing the rest of the CLI after b6's finding rather
           * than by b6 reporting it; register-session was what it probed.
           */
          if (pub.state === Hu.HOSTED.REJECTED) {
            console.error(`  hosted   REJECTED (${pub.detail})`);
            console.error('           The Bridge refused this credential. NOT a network problem.');
          } else {
            console.error(`  hosted   UNREACHABLE (${pub.detail})`);
          }
          console.error('           This session may STILL APPEAR LIVE to other machines, and');
          console.error('           work may be addressed to it. Re-run this once it is fixed.');
          await Hu.closeHttp();
          done(1);
        }
        await Hu.closeHttp();
      }

      // Same exit discipline as the registration path below: this may have just
      // made a request, and exiting explicitly after one trips the libuv
      // assertion on Windows.
      handled = true;
    }
  }

  if (cmd === 'register-session') {
    const R = await import('../src/registrationStore.mjs');

    if (!args.agent || typeof args.agent !== 'string') {
      console.error('error: --agent <agent_id> is required (your durable identity)');
      process.exit(2);
    }
    if (!args.session || typeof args.session !== 'string') {
      // NOT defaulted to the agent id. Defaulting would manufacture exactly the
      // identity this registry exists to verify, and would look like it worked.
      console.error('error: --session <session_id> is required, and is NOT derived from --agent');
      process.exit(2);
    }
    const capacity = args.capacity ?? 'idle';
    if (!['idle', 'busy', 'blocked', 'offline'].includes(capacity)) {
      console.error(`error: --capacity must be idle|busy|blocked|offline, got "${capacity}"`);
      process.exit(2);
    }

    /*
     * --interval IS VALIDATED HERE, BEFORE ANYTHING IS PUBLISHED.
     *
     * It used to be checked inside the `if (args.watch)` block further down --
     * which runs AFTER the first beat() has already posted the registration.
     * So `--watch --interval 1` published the row, refused, and then called
     * process.exit(2) on a process that had just done a fetch: the same libuv
     * assertion as the success path, turning a refusal into exit 127 and
     * leaving a published registration that nothing was going to refresh.
     *
     * A refusal must happen before the work, not after it. This was found by
     * the structural gate in test/registerSessionExit.test.mjs on the day it
     * was written, in code that had already been reviewed for exactly this.
     */
    const everyMs = Number(args.interval ?? 120) * 1000;
    if (args.watch && (!Number.isFinite(everyMs) || everyMs < 5000)) {
      console.error('error: --interval must be at least 5 seconds');
      process.exit(2);
    }

    const { resolveCommit } = await import('../src/git.mjs');
    const cwd = args.repo ?? process.cwd();
    const g = await resolveCommit(cwd, 'HEAD');
    if (!g.ok) {
      console.error(`error: cannot register from ${cwd}: ${g.reason}`);
      console.error('       repo, worktree and head are derived from git, not accepted as flags');
      process.exit(2);
    }

    const { basename } = await import('node:path');
    const row = {
      agent_id: args.agent,
      session_id: args.session,
      // Derived. A worker cannot name a repo it is not standing in.
      repo_id: basename(g.worktree),
      worktree_id: basename(g.worktree),
      lane_id: args.lane ?? null,
      capacity,
      head_sha: g.sha,
      heartbeat_at: new Date().toISOString(),
      /*
       * How this identity was established. `runtime-self-registration` is the
       * only value this path writes, and it is what distinguishes a target the
       * Bridge verified from one it merely accepted — see VERIFICATION in
       * src/liveRegistry.mjs.
       */
      verification: 'runtime-self-registration',
    };

    const { loadConfig } = await import('../src/config.mjs');
    const cfgForMachine = await loadConfig();
    row.machine_id = cfgForMachine?.machineId ?? null;

    const H = await import('../src/hostedRegistry.mjs');

    /*
     * ONE REGISTRATION, WRITTEN TO BOTH PLACES.
     *
     * Local answers "who is running on THIS machine" and works with no network.
     * Hosted answers "is code-b alive on the OTHER machine", which is the
     * question a cross-machine delegation actually asks and which local state
     * can never answer.
     *
     * A hosted failure does NOT fail the command: the worker really is running,
     * and refusing to record that locally because a network call failed would
     * take a machine offline for a reason that has nothing to do with it. It is
     * reported loudly instead, and the row keeps origin 'local' -- which is
     * what stops it being mistaken for something another machine has confirmed.
     */
    /*
     * HEAD IS RE-RESOLVED ON EVERY BEAT, NOT CAPTURED ONCE.
     *
     * --watch republished the ORIGINAL row with nothing but a fresh timestamp,
     * so head_sha froze at whatever the tree was when the watcher started.
     * Measured on this machine: the registry advertised code-c at d564569
     * while its worktree was thirteen commits further on, and had done for
     * hours. The heartbeat said "I am alive", which was true, and the head said
     * "I am at d564569", which was false, and nothing in the row distinguished
     * the two.
     *
     * That is the confidently-wrong shape this registry exists to replace.
     * canAssign compares a task's base_sha against the tree it is going to, so
     * a frozen head does not merely mislead a reader -- it is an input to a
     * decision about whether work may be handed out.
     *
     * Found because code-d re-registered cleanly and its head was RIGHT, which
     * is what made everyone else's visibly wrong.
     *
     * WHEN GIT CANNOT ANSWER, PUBLISH NULL. The liveness claim is still true --
     * the process is plainly running -- so the beat continues; but the previous
     * sha is not re-sent, because a stale value presented as current is the bug
     * being fixed, and re-sending it on failure would reintroduce it exactly
     * when the tree is in the least knowable state. null reads as "unknown",
     * which is what the server instructions already tell every client to do
     * with a null, and it is loud on stderr besides.
     */
    async function beat(capacityNow) {
      const fresh = await resolveCommit(cwd, 'HEAD');
      if (!fresh.ok) {
        console.error(`  heartbeat: cannot read HEAD in ${cwd} (${fresh.reason})`);
        console.error('             publishing head_sha as null rather than a stale one');
      }
      const r = {
        ...row,
        head_sha: fresh.ok ? fresh.sha : null,
        capacity: capacityNow,
        heartbeat_at: new Date().toISOString(),
      };
      await R.upsertRegistration(r);
      const pub = await H.publishRegistration(process.env, r);
      return pub;
    }

    const first = await beat(capacity);
    console.log(`registered ${row.agent_id} as session ${row.session_id}`);
    console.log(`  repo     ${row.repo_id} @ ${row.head_sha.slice(0, 12)}`);
    console.log(`  capacity ${row.capacity}${row.lane_id ? `   lane ${row.lane_id}` : ''}`);
    /*
     * THE EXIT CODE IS PART OF THE REPORT, AND IT WAS LYING.
     *
     * Found by b6 probing live: with a REJECTED token this printed
     * "registered", wrote the local roster row, reported the hosted half as
     * unreachable, and exited 0. Anything scripting the CLI reads exit 0 as
     * success, so the one machine-readable signal said the opposite of what
     * happened.
     *
     * NOT_CONFIGURED IS NOT A FAILURE. Running without a registration token is
     * a legitimate mode -- local-only, useful, and chosen. It exits 0 and says
     * plainly that other machines cannot see this session.
     *
     * EVERYTHING ELSE IS. The command's central act did not happen, so the exit
     * code says so.
     */
    if (first.state === H.HOSTED.OK) {
      console.log('  hosted   published — other machines can resolve this session');
    } else if (first.state === H.HOSTED.NOT_CONFIGURED) {
      console.log('  hosted   NOT CONFIGURED — local only, not visible to other machines');
      console.log('           set AGENTBRIDGE_REGISTRATION_TOKEN (a scoped token, NOT a database key)');
    } else if (first.state === H.HOSTED.REJECTED) {
      /*
       * A REFUSAL IS PERMANENT UNTIL A CREDENTIAL CHANGES, so --watch is not
       * entered: re-sending a token the Bridge has already refused, every two
       * minutes, forever, is a retry loop that cannot succeed and hides the one
       * fact the operator needs.
       */
      console.error(`  hosted   REJECTED (${first.detail})`);
      console.error('           The Bridge answered and refused this credential. This is NOT a');
      console.error('           network problem and retrying will not fix it — check the token.');
      console.error('           The local roster row was written; this session is LOCAL ONLY and');
      console.error('           no other machine can resolve it.');
      await H.closeHttp();
      done(1);
    } else {
      console.error(`  hosted   UNREACHABLE (${first.detail}) — registered LOCALLY ONLY`);
      /*
       * Unreachable is transient, so --watch DOES continue: surviving a network
       * blip is the entire point of a watcher. A one-shot still exits non-zero,
       * because the hosted publish it reported did not happen.
       */
      if (!args.watch) {
        await H.closeHttp();
        done(1);
      }
    }

    /*
     * --watch: KEEP IT ALIVE WITHOUT A HUMAN.
     *
     * A registration that must be re-run by hand is a registration that goes
     * stale the first time somebody is busy, and the whole staleness mechanism
     * then reads as "this worker died" when it merely stopped being typed at.
     *
     * The interval is deliberately well inside the 10-minute window rather than
     * near it: a refresh that lands at 9m59s on a slow network has already
     * aged the worker out, and the failure looks like flapping rather than a
     * timing problem.
     */
    if (args.watch) {
      // everyMs was validated before the first publish — see the note there.
      console.log(`  watch    refreshing every ${everyMs / 1000}s (stale after 600s); Ctrl-C to stop`);

      /*
       * UNPARKING IS THE EXIT. There is no process.exit() on this path.
       *
       * stop() ends with a publishRegistration -- a fetch -- and exiting
       * explicitly after a fetch is the libuv assertion documented at the top
       * of this file. Ctrl-C therefore CRASHED instead of deregistering, which
       * is what made "clean shutdown" untestable: the one path whose entire job
       * is to say "I am going away" was the one path that died before it could
       * finish saying it, so a worker stopped deliberately left exactly the
       * same trace as a worker that was killed.
       *
       * So stop() clears the timer and resolves the park promise. Control
       * returns to the bottom of this block and leaves through the same
       * closeHttp() + natural exit as every other outcome here.
       */
      let stopping = false;
      let timer = null;
      let unpark;
      const parked = new Promise((resolve) => { unpark = resolve; });

      const stop = async () => {
        if (stopping) return;
        stopping = true;
        /*
         * STOP BEATING FIRST. A heartbeat landing between the removal below and
         * the exit would re-register the session that was just removed, and the
         * worker would then age out ten minutes later looking as though it had
         * died rather than stopped -- the exact confusion deregistering exists
         * to prevent.
         */
        clearInterval(timer);
        // A clean shutdown DEREGISTERS rather than waiting to age out. Ten
        // minutes of a dead worker looking idle is ten minutes of contracts
        // addressed to nobody.
        try { await R.removeRegistration(row.session_id); } catch { /* best effort */ }
        try {
          await H.publishRegistration(process.env, { ...row, capacity: 'offline' });
        } catch { /* best effort */ }
        console.log(`\nunregistered ${row.session_id}`);
        unpark();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);

      /*
       * THE TIMER IS WHAT HOLDS THE PROCESS OPEN. Do not unref it.
       *
       * The first version unref'd this and then tried to stay alive with a
       * top-level `await new Promise(() => {})`. An unsettled promise is NOT a
       * libuv handle: node saw no remaining work and exited immediately,
       * printing "Detected unsettled top-level await" and leaving a
       * registration that never refreshed. It looked like it was watching. It
       * had already stopped.
       *
       * That is the whole failure this flag exists to prevent, reintroduced by
       * the flag itself, and it was invisible until somebody actually ran it
       * for longer than one interval.
       */
      timer = setInterval(async () => {
        const r = await beat(capacity);
        if (r.state === H.HOSTED.REJECTED) {
          // A credential refused mid-watch will be refused every time. Say so
          // in the words that describe it rather than blaming the network.
          console.error(`  heartbeat: hosted REJECTED (${r.detail}) — the token is being refused,`);
          console.error('             this session is no longer visible to other machines');
        } else if (r.state !== H.HOSTED.OK && r.state !== H.HOSTED.NOT_CONFIGURED) {
          console.error(`  heartbeat: hosted unreachable (${r.detail})`);
        }
      }, everyMs);
      /*
       * PARK HERE UNTIL stop(). Three separate things are needed and ALL THREE
       * were got wrong once, each in a way that looked like it worked:
       *
       *   the ref'd interval   keeps the event loop alive. Unref'ing it made
       *                        node exit immediately with "Detected unsettled
       *                        top-level await", leaving a registration that
       *                        never refreshed while the command claimed to be
       *                        watching.
       *   this await           stops execution falling THROUGH this block into
       *                        the rest of the dispatch. Replacing it with a
       *                        bare `return` is a syntax error at module top
       *                        level; dropping it entirely sent the process on
       *                        to the unknown-command handler, which printed
       *                        the help text and exited 2.
       *   it must SETTLE       this was `new Promise(() => {})`, which cannot.
       *                        That forced stop() to end in process.exit(), and
       *                        exiting after stop()'s fetch is the crash. An
       *                        unresolvable park and a clean shutdown are not
       *                        compatible; the park has to have a way out.
       *
       * None of the three is visible in under one interval, which is why this
       * is the one flag in the CLI that had to be run for real rather than
       * reasoned about.
       */
      await parked;
    }

    /*
     * THE ONLY EXIT FROM THIS COMMAND, AND IT IS NOT process.exit().
     *
     * Both paths here have just published over HTTP: the one-shot through
     * beat(), the --watch through stop(). undici keeps a global dispatcher with
     * pooled sockets, and calling process.exit() while it still holds handles
     * trips the assertion documented in src/hostedRegistry.mjs:
     *
     *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
     *
     * So register-session printed its correct output and then died nonzero, and
     * every caller checking an exit code saw a failure that had not happened.
     * closeHttp() drains the pool, the handled flag stops execution falling
     * through to the unknown-command handler, and node then exits naturally
     * with 0 -- the same shape workers uses, for the same reason.
     */
    await H.closeHttp();
    handled = true;
  }

  /*
   * lead-work — PROVENANCE FOR WORK NOBODY DELEGATED.
   *
   *   agentbridge lead-work --id <id> --agent <a> --session <s> --scope <text>
   *              --base <commit-ish> [--head <commit-ish>] [--tests <text>] [--repo <dir>]
   *   agentbridge lead-work [--json]
   *
   * The ledger refuses a contract whose assigning and assigned sessions are the
   * same, correctly: a contract to yourself is not a handoff, and allowing it
   * would let anyone manufacture the appearance of oversight. But the
   * integrator does real work, and with self-delegation forbidden all of it was
   * falling out of provenance -- the runtime registration enforcement shipped
   * with no contract and no audit.
   *
   * So this is a first-class record that says what it is, rather than a
   * contract wearing a disguise. Both shas are RESOLVED THROUGH GIT here, for
   * the same reason --base is on `delegate`: a sha somebody typed from memory
   * once pointed at nothing for days.
   */
  if (cmd === 'lead-work') {
    const { readLeadWork, writeLeadWork } = await import('../src/provenanceStore.mjs');
    const LW = await import('../src/leadWork.mjs');

    let rows;
    try { rows = await readLeadWork(); }
    catch (e) { console.error(`error: cannot read the lead-work ledger: ${e.message}`); process.exit(2); }

    if (!args.id) {
      if (args.json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
      if (!rows.length) { console.log('no lead work recorded'); process.exit(0); }
      for (const r of rows) {
        console.log(`${r.work_id}  ${r.agent_id}/${r.session_id}  ${r.base_sha.slice(0, 12)}..${r.head_sha.slice(0, 12)}`);
        console.log(`  ${r.scope}`);
        console.log(`  files ${r.files_changed.length}${r.tests ? `   tests ${r.tests}` : ''}`);
      }
      process.exit(0);
    }

    const { resolveCommit } = await import('../src/git.mjs');
    const { run: gitRun } = await import('../src/exec.mjs');
    const cwd = args.repo ?? process.cwd();

    const base = await resolveCommit(cwd, args.base);
    if (!base.ok) { console.error(`error: --base did not resolve: ${base.reason}`); process.exit(2); }
    const head = await resolveCommit(cwd, args.head ?? 'HEAD');
    if (!head.ok) { console.error(`error: --head did not resolve: ${head.reason}`); process.exit(2); }

    // The files are COMPUTED from the diff, not listed by the author. A record
    // whose file list is typed is a record that can quietly omit a file.
    const diff = await gitRun('git', ['diff', '--name-only', `${base.sha}..${head.sha}`], { cwd });
    if (!diff.ok) { console.error(`error: cannot diff: ${diff.error}`); process.exit(2); }
    const files = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

    const result = LW.appendLeadWork(rows, {
      work_id: args.id,
      agent_id: args.agent,
      session_id: args.session,
      repo_id: (await import('node:path')).basename(head.worktree),
      base_sha: base.sha,
      head_sha: head.sha,
      scope: args.scope,
      files_changed: files,
      tests: args.tests ?? null,
      created_at: new Date().toISOString(),
    });
    if (!result.ok) { for (const e of result.errors) console.error(`  - ${e}`); process.exit(2); }

    await writeLeadWork(result.rows);
    console.log(`recorded lead work ${result.record.work_id}: ${files.length} file(s)`);
    console.log(`  ${result.record.base_sha.slice(0, 12)}..${result.record.head_sha.slice(0, 12)}`);
    process.exit(0);
  }

  /*
   * supersede — THE CORRECTION, WITHOUT THE EDIT.
   *
   *   agentbridge supersede --id <new> --supersedes <old> --reason <text>
   *              --replacement-task <id> [--replacement-head <sha>] [--repo <dir>]
   *
   * WHY THIS COMMAND HAD TO EXIST. `accepted` and `withdrawn` are terminal in
   * TRANSITIONS, deliberately: a cancelled contract that can return to
   * `assigned` is indistinguishable from one that was never cancelled. The cost
   * is that a record which is WRONG can never be put right, and this ledger has
   * four of those -- the laneRegistry contracts covering work that shipped as
   * 771522e. Without a correction path the ledger is condemned to misstate what
   * happened, permanently.
   *
   * So a correction is APPENDED BESIDE the mistake and the mistake stays
   * readable. "What is true now" follows the chain; "what happened" reads
   * everything, errors included.
   *
   * THE APPEND-ONLY CHECK IS MADE HERE, NOT TRUSTED. applySupersession returns
   * new rows and never touches disk, so the assertion runs against what WOULD
   * be written, before anything is. A module that promises to append and a
   * caller that verifies it appended are two different guarantees, and this
   * project has been bitten too often by the first being mistaken for the
   * second.
   */
  if (cmd === 'supersede') {
    const { readDelegations, writeDelegations } = await import('../src/provenanceStore.mjs');
    const S = await import('../src/supersession.mjs');
    const { resolveCommit } = await import('../src/git.mjs');

    let before;
    try {
      before = await readDelegations();
    } catch (e) {
      console.error(`error: cannot read the delegation store: ${e.message}`);
      process.exit(2);
    }

    /*
     * A REAL GIT RESOLVER, ALWAYS. The module refuses a supplied sha when no
     * resolver is given, so passing none would not be a shortcut -- it would be
     * a refusal. A correction naming a commit nobody can find is a second wrong
     * record, which is exactly what this command exists to stop.
     */
    const cwd = args.repo ?? process.cwd();

    /*
     * THE RESOLVER CONTRACT IS SYNCHRONOUS AND STRICT: supersession.mjs calls
     * `resolveSha(sha) === true`. The first version of this wiring passed an
     * async function returning the resolved sha, so the module received a
     * Promise, compared it to true, and refused a perfectly real commit.
     *
     * It failed CLOSED, which is the right direction for this mistake — a
     * wiring bug that accepted an unverifiable sha would have been silent and
     * permanent, whereas this one stopped the first correction dead. But an
     * async-vs-sync mismatch is invisible to typecheck, lint and the module's
     * own tests, which inject a synchronous stub.
     *
     * So git runs HERE, ahead of time, and what the module gets is the plain
     * boolean predicate it asked for.
     */
    const verified = new Set();
    if (args['replacement-head']) {
      const r = await resolveCommit(cwd, args['replacement-head']);
      if (r.ok) verified.add(args['replacement-head']);
    }
    const resolveSha = (sha) => verified.has(sha);

    const result = await S.applySupersession(before, {
      id: args.id,
      supersedes: args.supersedes,
      reason: args.reason,
      replacement_task_id: args['replacement-task'],
      replacement_head_sha: args['replacement-head'] ?? null,
      recorded_by_agent: args.agent ?? 'danny-win-10',
      recorded_by_session: args.session ?? 'danny-win-10',
      recorded_at: new Date().toISOString(),
    }, { resolveSha });

    if (!result.ok) {
      for (const e of result.errors) console.error(`  - ${e}`);
      process.exit(2);
    }

    const proof = S.assertAppendOnly(before, result.rows);
    if (!proof.ok) {
      // Belt and braces: if this ever fires, something rewrote history and the
      // write must not happen. Nothing has been touched on disk at this point.
      console.error('REFUSED — the correction would not have been append-only:');
      for (const e of proof.errors) console.error(`  - ${e}`);
      process.exit(2);
    }

    await writeDelegations(result.rows);

    /*
     * AND AGAIN, AGAINST WHAT ACTUALLY LANDED.
     *
     * The check above is on rows in memory, which can only fail if
     * applySupersession changes. This one re-reads the file and is the one that
     * can catch something real today: a serialisation fault, a truncated write,
     * or another process writing the ledger between the read and the write --
     * the shared-index problem this project has already been bitten by twice.
     *
     * It cannot un-write a bad file, so it reports rather than pretending to
     * recover. An operator who is told the ledger is no longer append-only can
     * go and look; one who is told nothing cannot.
     */
    const landed = await readDelegations();
    const onDisk = S.assertAppendOnly(before, landed);
    if (!onDisk.ok) {
      console.error('WARNING — the ledger on disk is not an append of what was read:');
      for (const e of onDisk.errors) console.error(`  - ${e}`);
      console.error('  another process may have written it concurrently. Inspect before trusting it.');
      process.exit(1);
    }

    console.log(`recorded correction ${result.record.id ?? '(unnamed)'}: supersedes ${result.record.supersedes}`);
    console.log(`  reason      ${result.record.reason}`);
    console.log(`  replacement ${result.record.replacement_task_id}${result.record.replacement_head_sha ? ` @ ${String(result.record.replacement_head_sha).slice(0, 12)}` : ''}`);
    console.log(`  append-only verified: ${before.length} -> ${result.rows.length} records, none edited`);
    process.exit(0);
  }

  /*
   * token-budget — measure verified work per token, and PERSIST it.
   *
   *   agentbridge token-budget --record --handoff <file> [--tier <t>] [--task <id>]
   *   agentbridge token-budget [--json]        show what has been measured
   *
   * DESCRIPTIVE ONLY. This prints numbers and stores numbers. It never rewrites
   * or truncates a handoff, never produces message text, and nothing downstream
   * reads these to gate anything -- so a measurement can never come back to an
   * agent as prose, and brevity cannot win on its own. Token use is optimised
   * only after correctness, evidence and safety are satisfied, which is why the
   * tier travels with every measurement rather than being inferred from length.
   */
  if (cmd === 'token-budget') {
    const { readMeasurements, writeMeasurements } = await import('../src/provenanceStore.mjs');
    const TB = await import('../src/tokenBudget.mjs');

    let rows;
    try {
      rows = await readMeasurements();
    } catch (e) {
      console.error(`error: cannot read the measurement store: ${e.message}`);
      process.exit(2);
    }

    if (args.record) {
      if (typeof args.handoff !== 'string' || !args.handoff) {
        console.error('error: --handoff <file> is required with --record');
        process.exit(2);
      }
      const { readFile } = await import('node:fs/promises');
      let text;
      try { text = await readFile(args.handoff, 'utf8'); }
      catch (e) { console.error(`error: cannot read ${args.handoff}: ${e.message}`); process.exit(2); }

      const measured = TB.measureHandoff({
        text,
        tier: args.tier ?? null,
        has_mutation_evidence: Boolean(args['mutation-evidence']),
        bridge_state: {},
      });
      const row = {
        at: new Date().toISOString(),
        task_id: args.task ?? null,
        ...measured,
        metrics: TB.metricsFor(measured),
      };
      // Append. A measurement is an observation of a moment; editing one would
      // make the series a claim about the present rather than a record.
      await writeMeasurements([...rows, row]);
      console.log(`recorded measurement${row.task_id ? ` for ${row.task_id}` : ''}: ${JSON.stringify(row.metrics)}`);
      process.exit(0);
    }

    if (args.json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
    if (!rows.length) { console.log('no measurements recorded'); process.exit(0); }
    for (const r of rows) {
      console.log(`${r.at}  ${r.task_id ?? '(no task)'}  ${JSON.stringify(r.metrics)}`);
    }
    process.exit(0);
  }

  /*
   * THE OWNER DECISION LEDGER — "tell your AI team once".
   *
   *   agentbridge ask --action <a> [--question <q>] [--project/--repo/--lane/--task]
   *   agentbridge owner-decide --id <id> --owner <who> --statement <text> ...
   *   agentbridge owner-decisions [--all] [--json]
   *   agentbridge owner-revoke --id <id> --owner <who> [--reason <text>]
   *
   * `ask` IS THE ENFORCEMENT POINT, and its exit code is the whole interface.
   * A worker runs it before putting any question in front of the builder:
   *
   *   0  allowed         proceed. do NOT ask.
   *   1  denied          refuse. do NOT ask.
   *   3  owner_required  escalate to the builder.
   *   4  no_decision     ask ONCE, then record the answer with owner-decide.
   *
   * Exit 2 keeps its existing meaning across this CLI: the command could not
   * run at all. It is deliberately NOT one of the four outcomes, because "I
   * could not read the ledger" must never be mistaken for "nothing covers
   * this" -- the second sends a worker off to bother the builder, and the first
   * means the worker has no idea what it is allowed to do.
   */
  if (cmd === 'ask' || cmd === 'answered' || cmd === 'owner-decide' || cmd === 'owner-decisions' || cmd === 'owner-revoke') {
    /*
     * Same done()/Done boundary as the delegation block. `ask` does not fetch
     * today, so process.exit would be safe here -- but these exit codes ARE the
     * command's interface (0 allowed, 1 denied, 3 owner_required, 4 ask once,
     * 5 already asked), and leaving two different stopping mechanisms in one
     * binary is how the next person adds a fetch to `ask` and gets 127 for a
     * refusal.
     */
    try {
    const { readDecisions, writeDecisions } = await import('../src/provenanceStore.mjs');
    const D = await import('../src/ownerDecisions.mjs');

    let rows;
    try {
      rows = await readDecisions();
    } catch (e) {
      console.error(`error: cannot read the owner decision ledger: ${e.message}`);
      process.exit(2);
    }

    const context = {
      project: args.project ?? null,
      repo: args.repo ?? null,
      lane: args.lane ?? null,
      task: args.task ?? null,
    };

    if (cmd === 'ask') {
      if (typeof args.action !== 'string' || !args.action.trim()) {
        console.error('error: --action <action> is required, e.g. --action deploy.production');
        console.error('       an unclassified action cannot be matched against a decision');
        process.exit(2);
      }
      /*
       * THE PRE-FLIGHT, NOT JUST THE LOOKUP.
       *
       * The ledger stops the same question being asked twice across TIME. It
       * does nothing about five agents starting at once and all reaching
       * no_decision on the same question within a minute, which is the shape
       * that actually happens. So an escalation is itself recorded, and a
       * worker asking something already open is told so and does NOT ask.
       *
       * Exit 5 is that case, distinct from 4: 4 means "ask once", 5 means
       * "somebody already did". Collapsing them would put the duplicate
       * question in front of the builder anyway.
       */
      const E = await import('../src/escalation.mjs');
      const { readEscalations, writeEscalations } = await import('../src/provenanceStore.mjs');

      let escalations;
      try {
        escalations = await readEscalations();
      } catch (e) {
        // A ledger that cannot be read must not be treated as empty: empty
        // means "nobody has asked", which is exactly the wrong answer here.
        console.error(`error: cannot read the escalation ledger: ${e.message}`);
        done(2);
      }

      const now = new Date().toISOString();
      const pre = E.preflight({
        decisions: rows,
        escalations,
        action: args.action,
        context,
        now,
        resolve: D.resolveOwnerDecision,
      });
      const r = pre.decision;

      /*
       * RECORDING THE ESCALATION IS WHAT MAKES THE NEXT WORKER SILENT.
       *
       * Only when a question is actually being put to the builder, and only
       * when --question was supplied: a bare `ask` is a query about policy, not
       * an escalation, and recording those would suppress real questions
       * nobody ever asked.
       */
      let opened = null;
      if (pre.outcome === 'escalate' && typeof args.question === 'string' && args.question.trim()) {
        const built = E.createEscalation({
          escalation_id: `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          action: args.action,
          context,
          question: args.question,
          asked_by: args.by ?? args.from ?? 'unknown-worker',
          asked_at: now,
        });
        if (!built.ok) { for (const err of built.errors) console.error(`  - ${err}`); done(2); }
        await writeEscalations([...escalations, built.record]);
        opened = built.record;
      }

      if (args.json) {
        console.log(JSON.stringify({
          action: args.action, context, outcome: pre.outcome,
          decision: r, escalation: pre.escalation ?? opened, reason: pre.reason ?? r.reason,
        }, null, 2));
      } else {
        console.log(`${pre.outcome.toUpperCase()}  ${args.action}`);
        console.log(`  ${pre.reason ?? r.reason}`);
        if (r.decision_id) console.log(`  decision ${r.decision_id} at ${r.matched_scope} scope`);
        if (r.candidates.length > 1) console.log(`  candidates: ${r.candidates.join(', ')}`);
        if (Object.keys(r.constraints ?? {}).length) {
          console.log(`  constraints: ${JSON.stringify(r.constraints)}`);
        }

        if (pre.outcome === 'already_escalated') {
          console.log(`\n  asked by ${pre.escalation.asked_by} at ${pre.escalation.asked_at}`);
          console.log(`  their wording: ${pre.escalation.question}`);
          console.log('  DO NOT ASK AGAIN. Wait for the answer; it will arrive as an owner decision.');
        }

        // The question is printed ONLY when this worker is the one asking.
        if (pre.outcome === 'escalate' && typeof args.question === 'string') {
          console.log(`\nASK THE OWNER ONCE:\n  ${args.question}`);
          if (opened) {
            console.log(`\n  recorded as ${opened.escalation_id} — other workers will be told this is open.`);
            console.log('  close it with: agentbridge answered --id '
              + `${opened.escalation_id} --decision <decision_id>`);
          } else {
            console.log('\n  NOT recorded: pass --question to open an escalation other workers can see.');
          }
        }
      }

      done({
        allowed: 0, denied: 1, owner_required: 3, escalate: 4, already_escalated: 5,
      }[pre.outcome]);
    }

    /*
     * answered — close an open question with the decision that answers it.
     *
     *   agentbridge answered --id <escalation_id> --decision <decision_id>
     *
     * The answer is a DECISION ID, not prose. Closing with free text would
     * leave the next worker to interpret it; closing with a decision id means
     * the next worker gets `allowed` from the ledger and never asks at all.
     * That is the loop actually closing rather than the question merely going
     * quiet.
     */
    if (cmd === 'answered') {
      const E = await import('../src/escalation.mjs');
      const { readEscalations, writeEscalations } = await import('../src/provenanceStore.mjs');

      let escalations;
      try { escalations = await readEscalations(); }
      catch (e) { console.error(`error: cannot read the escalation ledger: ${e.message}`); done(2); }

      const target = escalations.find((e) => e.escalation_id === args.id);
      if (!target) { console.error(`no open escalation "${args.id}"`); done(2); }

      // The decision must EXIST. Closing an escalation with an id nobody
      // recorded would leave the next worker resolving to no_decision and
      // asking again -- the question would look closed and behave open.
      if (!rows.some((d) => d.decision_id === args.decision)) {
        console.error(`no owner decision "${args.decision}": record it first with owner-decide`);
        done(2);
      }

      const res = E.answerEscalation(target, { decision_id: args.decision, at: new Date().toISOString() });
      if (!res.ok) { for (const err of res.errors) console.error(`  - ${err}`); done(2); }

      await writeEscalations(escalations.map((e) => (e.escalation_id === target.escalation_id ? res.record : e)));
      console.log(`closed ${target.escalation_id} with decision ${args.decision}`);
      console.log(`  "${target.question}"`);
      console.log('  the next worker to ask this will be answered by the ledger, not by you.');
      done(0);
    }

    if (cmd === 'owner-decisions') {
      const live = new Set(D.activeDecisions(rows).map((d) => d.decision_id));
      const shown = args.all ? rows : rows.filter((d) => live.has(d.decision_id));
      if (args.json) { console.log(JSON.stringify(shown, null, 2)); process.exit(0); }
      if (!shown.length) { console.log('no owner decisions recorded'); process.exit(0); }
      for (const d of shown) {
        // A dead decision is shown as dead, never hidden. The builder must be
        // able to see what they originally said and what replaced it.
        const state = d.revoked_at ? 'revoked' : (live.has(d.decision_id) ? 'active' : 'superseded');
        console.log(`${d.decision_id}  [${state}]  ${d.effect}  ${d.scope_type}${d.scope_id ? `:${d.scope_id}` : ''}`);
        console.log(`  "${d.statement}"`);
        console.log(`  covers   ${d.capabilities.join(', ')}`);
        console.log(`  by       ${d.created_by} at ${d.created_at}`);
        if (d.supersedes) console.log(`  replaces ${d.supersedes}`);
        if (d.revoked_at) console.log(`  revoked  ${d.revoked_at} by ${d.revoked_by}`);
      }
      process.exit(0);
    }

    if (cmd === 'owner-decide') {
      const rec = D.createDecision({
        decision_id: args.id,
        owner_id: args.owner,
        decision_type: args['type'] ?? 'policy',
        statement: args.statement,
        scope_type: args.scope,
        scope_id: args['scope-id'] ?? null,
        effect: args.effect,
        capabilities: split(args.capabilities),
        constraints: args.constraints ? JSON.parse(args.constraints) : {},
        // created_by defaults to the owner. validateDecision REFUSES a record
        // where they differ, which is what stops a worker writing its own
        // permission slip; --by exists so that forgery is expressible in a
        // test rather than only in theory.
        created_by: args.by ?? args.owner,
        created_at: new Date().toISOString(),
        supersedes: args.supersedes ?? null,
      });
      const v = D.validateDecision(rec);
      if (!v.ok) { for (const e of v.errors) console.error(`  - ${e}`); process.exit(2); }
      if (rows.some((d) => d.decision_id === rec.decision_id)) {
        console.error(`decision "${rec.decision_id}" already exists — decisions are append-only; supersede it instead`);
        process.exit(2);
      }
      if (rec.supersedes && !rows.some((d) => d.decision_id === rec.supersedes)) {
        console.error(`cannot supersede "${rec.supersedes}": no such decision`);
        process.exit(2);
      }
      await writeDecisions([...rows, rec]);
      console.log(`recorded ${rec.decision_id}: ${rec.effect} ${rec.capabilities.join(', ')} at ${rec.scope_type}${rec.scope_id ? `:${rec.scope_id}` : ''}`);
      if (rec.supersedes) console.log(`  supersedes ${rec.supersedes} (which stays in the ledger)`);
      process.exit(0);
    }

    // owner-revoke
    const target = rows.find((d) => d.decision_id === args.id);
    if (!target) { console.error(`no decision "${args.id}"`); process.exit(2); }
    const r = D.revokeDecision(target, {
      at: new Date().toISOString(),
      by: args.owner,
      reason: args.reason ?? null,
    });
    if (!r.ok) { for (const e of r.errors) console.error(`  - ${e}`); process.exit(2); }
    await writeDecisions(rows.map((d) => (d.decision_id === target.decision_id ? r.record : d)));
    console.log(`revoked ${target.decision_id} — it stops applying now and stays in the ledger`);
    process.exit(0);
    } catch (e) {
      // done() landing here is a deliberate stop carrying an exit code, not a
      // fault. Anything else keeps its stack rather than being flattened.
      if (!(e instanceof Done)) throw e;
      process.exitCode = e.exitCode;
    }
    handled = true;
  }

  /*
   * lanes — show the resolved registry, or explain one path.
   *
   *   agentbridge lanes                    lanes, holders, capabilities
   *   agentbridge lanes --file <path>      read a specific registry file
   *   agentbridge lanes --path src/x.ts    who owns this, and how each lane sees it
   *
   * Validation errors exit 2 and print every problem at once: an operator
   * fixing a lane file should not discover its faults one run at a time.
   */
  if (cmd === 'lanes') {
    const cfg = await loadConfig();
    const file = args.file || cfg?.lanesFile?.[0] || cfg?.lanesFile || 'lanes.registry.example.yml';
    const { readFile } = await import('node:fs/promises');
    const R = await import('../src/laneRegistry.mjs');

    let text;
    try { text = await readFile(file, 'utf8'); }
    catch { console.error(`cannot read lane registry: ${file}`); process.exit(2); }

    let reg;
    try { reg = R.parseLaneRegistry(text, { source: file }); }
    catch (e) { console.error(`${e.message}`); process.exit(2); }

    const v = R.validateRegistry(reg);
    if (!v.ok) {
      console.error(`lane registry ${file} has ${v.errors.length} problem(s):`);
      for (const e of v.errors) console.error(`  - ${e}`);
      process.exit(2);
    }

    if (args.path) {
      const owners = R.ownersOfPath(reg, args.path);
      const rows = reg.lanes.map((l) => ({ lane_id: l.lane_id, sees: R.classifyPath(reg, l.lane_id, args.path) }));
      if (args.json) { console.log(JSON.stringify({ path: args.path, owners, lanes: rows }, null, 2)); process.exit(0); }
      console.log(`${args.path}\n  owned by: ${owners.length ? owners.join(', ') : '(unclaimed)'}`);
      for (const r of rows) console.log(`  ${r.lane_id.padEnd(18)} sees it as ${r.sees}`);
      process.exit(0);
    }

    const contested = R.contestedLanes(reg);
    if (args.json) { console.log(JSON.stringify({ file, reg, contested }, null, 2)); process.exit(0); }

    console.log(`lane registry ${file}  (${reg.lanes.length} lanes, ${reg.agents.length} agents, ${reg.assignments.length} assignments)\n`);
    for (const l of reg.lanes) {
      const holders = R.holdersOfLane(reg, l.lane_id)
        .map((h) => h.agent_id ?? `session:${h.session_id}`).join(', ') || '(unheld)';
      console.log(`${l.lane_id}  [${l.status}]  ${l.display_name}`);
      console.log(`  held by   ${holders}`);
      if (l.capabilities.length) console.log(`  grants    ${l.capabilities.join(', ')}`);
      if (l.owned_paths.length) console.log(`  owns      ${l.owned_paths.join(', ')}`);
      if (l.shared_paths.length) console.log(`  shared    ${l.shared_paths.join(', ')}`);
    }
    for (const c of contested) {
      console.log(`\nLANE CONTESTED — "${c.lane_id}" is held by ${c.agents.length} agents: ${c.agents.join(', ')}`);
    }
    process.exit(contested.length ? 1 : 0);
  }

  /*
   * release-risk — the guard half of Section A.
   *
   * `status` reports state and always exits 0; a human has to notice. That is
   * exactly how release/integrate-2026-09-14 sat with nine local-only commits
   * and no upstream until somebody read the text. This command applies the
   * rules in src/releaseRisk.mjs and EXITS NON-ZERO on a blocking finding, so
   * it can sit in a pre-push hook and actually refuse.
   *
   * Exit codes are the contract, because a hook reads the code and not the
   * prose: 0 clean or warnings only, 1 at least one block, 2 cannot run.
   *
   * Read-only. It evaluates other agents' worktrees and never writes to them.
   */
  if (cmd === 'release-risk') {
    const cfg = await loadConfig();
    if (!cfg) { console.error('Not initialised. Run: agentbridge init'); process.exit(2); }
    const { evaluateReleaseRisk, formatReleaseRisk } = await import('../src/releaseRisk.mjs');
    const payload = await collect(cfg, await loadRegistry());

    const opts = args.strict ? { strictEverywhere: true } : {};
    const results = payload.sessions.map((s) => ({
      label: `${s.agentId} [${s.lane}]`,
      worktree: s.worktree,
      result: evaluateReleaseRisk(s.git, opts),
    }));

    if (args.json) {
      console.log(JSON.stringify({ machine: payload.machine, checkedAt: payload.sentAt, results }, null, 2));
    } else {
      console.log(`release-risk on ${localMachineLabel(cfg)} [${payload.machine.name}]  ${payload.sentAt}\n`);
      for (const r of results) console.log(formatReleaseRisk(r.label, r.result));
    }

    const blocking = results.reduce((n, r) => n + r.result.blocking, 0);
    const warnings = results.reduce((n, r) => n + r.result.warnings, 0);
    if (!args.json) console.log(`\n${blocking} blocking, ${warnings} warning(s) across ${results.length} worktree(s)`);
    process.exit(blocking > 0 ? 1 : 0);
  }

  if (cmd === 'doctor') {
    const cfg = await loadConfig();
    if (!cfg) { console.error('Not initialised. Run: agentbridge init'); process.exit(2); }
    const st = cfg.secretStatus;
    let fail = false;

    console.log(`platform    : ${process.platform}`);
    console.log(`config      : ${CONFIG_FILE}`);
    console.log(`seal scheme : ${st.scheme ?? '(none)'}`);
    console.log(`unsealed    : ${st.unsealed ? 'yes' : 'NO — ' + st.reason}`);
    console.log(`permissions : ${st.permissions.scheme} ${st.permissionsOk ? 'OK' : 'FAILED'}`);
    if (!st.permissionsOk) console.log(`              ${JSON.stringify(st.permissions.detail)}`);

    if (!st.unsealed) fail = true;
    if (!st.permissionsOk) fail = true;
    if (st.weakOnWindows) {
      console.error('\n!! Secret is stored in PLAINTEXT on Windows. Re-run: agentbridge init');
      fail = true;
    }

    // Prove the seal actually round-trips on this machine, rather than
    // assuming it does because the platform says it should.
    if (st.unsealed) {
      const probe = 'agentbridge-selftest-' + Date.now();
      const sealed = await protectSecret(probe);
      const back = await unprotectSecret(sealed);
      const roundTrip = back.ok && back.secret === probe;
      console.log(`seal roundtrip: ${roundTrip ? 'OK' : 'FAILED'} (${sealed.scheme})`);
      if (isWindows() && sealed.scheme !== 'dpapi-user') {
        console.error('!! DPAPI unavailable on this machine; secrets would be stored in plaintext.');
        fail = true;
      }
      if (!roundTrip) fail = true;
    }

    console.log(fail ? '\nRESULT: FAIL' : '\nRESULT: OK');
    process.exit(fail ? 1 : 0);
  }

  /*
   * `workers` — the pool, as the machine sees it.
   *
   * Scheduling questions ("who is idle", "can these two run at once") were
   * being answered by counting folders in Documents, which is how capacity got
   * reported as 3 when 5 worktrees were sitting free. This prints what the
   * registry actually holds, so the answer comes from state rather than from
   * somebody's mental model of the machine.
   */
  if (cmd === 'workers') {
    /*
     * THE POOL COMES FROM WHAT IS RUNNING, not from a file somebody typed.
     *
     * A file registry is still honoured with --registry-file, because it is
     * useful for inspecting a hypothetical roster, but it is no longer what
     * `workers` means by default. Capacity read from a stale file is exactly
     * the confidently-wrong answer the runtime registry exists to replace.
     */
    const R = await import('../src/laneRegistry.mjs');
    const LR = await import('../src/liveRegistry.mjs');
    const H = await import('../src/hostedRegistry.mjs');
    const { readRegistrations } = await import('../src/registrationStore.mjs');

    let registry = null;
    if (args['registry-file']) {
      try { registry = await loadLaneRegistry(args['registry-file']); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
    }

    if (!registry) {
      let local = [];
      try { local = await readRegistrations(); }
      catch (e) { console.error(`error: cannot read the registration store: ${e.message}`); process.exit(2); }

      const hosted = await H.fetchHostedRegistrations(process.env);
      if (hosted.state === H.HOSTED.UNREACHABLE || hosted.state === H.HOSTED.MALFORMED) {
        // "I cannot see the workers" and "there are no workers" must not print
        // the same. A half-roster is worse than a refusal here, because it is
        // the thing somebody schedules against.
        console.error(`error: the hosted registry is configured but ${hosted.state}: ${hosted.detail ?? ''}`);
        console.error('       refusing to print a partial pool.');
        process.exit(2);
      }
      const merged = H.mergeRegistrations(local, hosted.state === H.HOSTED.OK ? hosted.rows : []);
      const reg = LR.registryFromSessions(merged, { now: new Date().toISOString() });
      const roster = R.workerRoster(reg);
      const originOf = new Map(merged.map((m) => [m.session_id, m.origin ?? 'local']));

      if (args.json) {
        console.log(JSON.stringify(roster.map((w) => ({
          ...w,
          sessions: (w.sessions ?? []).map((s) => ({ ...s, origin: originOf.get(s.session_id) ?? 'local' })),
        })), null, 2));
      } else if (!roster.length) {
        console.log('no workers registered');
        console.log('  workers register with: agentbridge register-session --agent <a> --session <s> --watch');
      } else {
        for (const w of roster) {
          const sessions = w.sessions ?? [];
          console.log(`${w.agent_id}  ${sessions.length ? '' : '(no live session)'}`);
          for (const s of sessions) {
            // local vs hosted stays visible: the second is a claim another
            // machine can check, the first is this machine talking about itself.
            const origin = originOf.get(s.session_id) ?? 'local';
            console.log(`  ${s.session_id}  ${s.capacity ?? 'unknown'}  ${s.repo_id ?? '-'} / ${s.worktree_id ?? '-'}  [${origin}]`);
          }
        }
      }
      // NO process.exit() HERE. This branch has just made a fetch, and exiting
      // explicitly after one trips a libuv assertion on Windows (see `handled`
      // at the top). Exiting naturally is clean; the flag stops execution
      // falling through to the unknown-command handler.
      await H.closeHttp();
      handled = true;
    }

    /*
     * The FILE-registry path, and it must be an `else`.
     *
     * The live branch above no longer calls process.exit(), so without this
     * guard execution ran straight on into `registry.R` with registry null --
     * the command printed the correct roster and then an error about reading a
     * property of null. Removing an exit turns every following statement into a
     * sequel to the branch that was supposed to be terminal.
     */
    if (!handled) {
    const roster = registry.R.workerRoster(registry.reg);
    if (args.json) { console.log(JSON.stringify(roster, null, 2)); process.exit(0); }
    if (!roster.length) { console.log('no workers registered'); process.exit(0); }
    for (const w of roster) {
      const sessions = w.sessions ?? [];
      console.log(`${w.agent_id}  ${sessions.length ? '' : '(no live session)'}`);
      for (const s of sessions) {
        console.log(`  ${s.session_id}  ${s.capacity ?? 'unknown'}  ${s.repo_id ?? '-'} / ${s.worktree_id ?? '-'}`);
      }
      if (w.lanes?.length) console.log(`  lanes: ${w.lanes.join(', ')}`);
    }
    process.exit(0);
    }
  }

  if (cmd === 'daemon') {
    if (args._[0] !== 'start') { console.error('usage: agentbridge daemon start'); process.exit(2); }
    await runDaemon();
    process.exit(0);
  }

  // `handled` means a branch above finished its work and deliberately declined
  // to call process.exit() — see the flag's declaration. Without this guard the
  // command would print its answer and then its own help text.
  if (!handled) { console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exit(2); }
} catch (e) {
  /*
   * THE OUTER BOUNDARY DID NOT KNOW ABOUT Done, AND THAT UNDID THE WHOLE
   * MECHANISM.
   *
   * Found by b6 probing live. A refused registration exited 127 -- the shell's
   * conventional "command not found" -- with `error: done:1` on stderr. Two
   * failures from one cause:
   *
   *   Done is an internal control-flow sentinel. This catch printed it to the
   *   operator as though it were a fault message.
   *
   *   It then called process.exit() -- the exact call the sentinel exists to
   *   avoid. After a fetch on node 24 / Windows that trips the libuv assertion
   *   documented at the Done class, and the process dies at 127. So a caller
   *   branching on the exit code could not tell a refused credential from a
   *   missing binary, and the operator this path prints a careful message for
   *   was sent to check their PATH.
   *
   * The inner boundary around the delegation commands got this right. This one
   * never did, so every done() outside that block -- including ones that
   * predate the refusal path -- has been landing here. b6's finding made it
   * reachable on a common path rather than creating it.
   *
   * NOTHING HERE CALLS process.exit(). Setting exitCode and letting the module
   * end lets node drain its handles, which is the entire reason Done throws
   * instead of exiting.
   */
  if (e instanceof Done) {
    process.exitCode = e.exitCode;
  } else {
    console.error('error:', e.message);
    process.exitCode = 1;
  }
}
