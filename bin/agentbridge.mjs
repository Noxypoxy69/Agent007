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
  agentbridge ask --action <action> [--question <q>] [--json]
             [--project <p>] [--repo <r>] [--lane <l>] [--task <t>]
                                        ASK THE LEDGER BEFORE ASKING THE OWNER.
                                        exit 0 allowed, 1 denied, 3 owner_required,
                                        4 no_decision (ask once, then record it)
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
      process.exit(2);
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
          process.exit(2);
        }
        const mine = P.delegationsForSession(all, forSession, { includeAll: args.all === true });
        if (args.json) { console.log(JSON.stringify(mine, null, 2)); process.exit(0); }
        if (!mine.length) {
          // Exit 0. An agent with an empty queue is the normal, healthy case;
          // making absence an error would have every clean startup look broken.
          console.log(args.all === true
            ? `no delegations recorded for ${forSession}`
            : `no outstanding delegations for ${forSession}`);
          process.exit(0);
        }
        for (const d of mine) {
          console.log(`${d.id}  [${d.state}]  from ${d.assigning_session}`);
          console.log(`  task     ${d.task}`);
          console.log(`  base     ${d.base_sha}${d.head_sha ? `   head ${d.head_sha}` : ''}`);
          console.log(`  allowed  ${d.allowed_paths?.length ? d.allowed_paths.join(', ') : '(none)'}`);
          console.log(`  forbidden ${d.forbidden_paths?.length ? d.forbidden_paths.join(', ') : '(none)'}`);
        }
        process.exit(0);
      }

      if (args.json) { console.log(JSON.stringify(all, null, 2)); process.exit(0); }
      if (!all.length) { console.log('no delegations recorded'); process.exit(0); }
      for (const d of all) {
        console.log(`${d.id}  [${d.state}]  ${d.assigning_session} -> ${d.assigned_session}`);
        console.log(`  task     ${d.task}`);
        console.log(`  base     ${d.base_sha}${d.head_sha ? `   head ${d.head_sha}` : ''}`);
        if (d.allowed_paths.length) console.log(`  allowed  ${d.allowed_paths.join(', ')}`);
        if (d.forbidden_paths.length) console.log(`  forbidden ${d.forbidden_paths.join(', ')}`);
        if (d.audit) console.log(`  audit    ${d.audit.ok ? 'clean' : `${d.audit.violations.length} violation(s)`}`);
      }
      process.exit(0);
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
        process.exit(2);
      }
      const resolved = await resolveCommit(repo, args.base);
      if (!resolved.ok) {
        console.error(resolved.reason === 'not-a-git-worktree'
          ? `error: ${repo} is not a git worktree; pass --repo <dir>`
          : `error: base "${resolved.rev}" does not resolve to a commit in ${repo}`);
        console.error('the Bridge resolves the base itself — do not type a SHA from memory');
        process.exit(2);
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
      try { registry = await loadLaneRegistry(args['registry-file']); }
      catch (e) { console.error(`error: ${e.message}`); process.exit(2); }

      if (!registry) {
        console.error('warning: no lane registry configured, so --to was not verified.');
        console.error('         set lanesFile in config, or pass --registry-file <path>.');
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
          process.exit(2);
        }
        bound = r;
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
      const v = P.validateDelegation(rec);
      if (!v.ok) { for (const e of v.errors) console.error(`  - ${e}`); process.exit(2); }
      if (all.some((d) => d.id === rec.id)) { console.error(`delegation "${rec.id}" already exists`); process.exit(2); }
      await writeDelegations([...all, rec]);
      console.log(`recorded delegation ${rec.id}: ${rec.assigning_session} -> ${rec.assigned_session} from ${rec.base_sha.slice(0, 12)}`);
      process.exit(0);
    }

    const d = all.find((x) => x.id === args.id);
    if (!d) { console.error(`no delegation "${args.id}"`); process.exit(2); }

    // delegation-state --id <id> --to returned|accepted|rejected|withdrawn [--head <sha>]
    if (cmd === 'delegation-state') {
      const t = P.transition(d, args.to, {
        head_sha: args.head ?? null,
        audit: d.audit,
        now: new Date().toISOString(),
      });
      if (!t.ok) { for (const e of t.errors) console.error(`  - ${e}`); process.exit(2); }
      await writeDelegations(all.map((x) => (x.id === d.id ? t.record : x)));
      console.log(`${d.id}: ${d.state} -> ${t.record.state}${t.record.head_sha ? ` @ ${t.record.head_sha.slice(0, 12)}` : ''}`);
      process.exit(0);
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
        process.exit(1);
      }
      console.log(`integration permitted — ${d.id} accepted at ${d.head_sha.slice(0, 12)}, audit clean`);
      process.exit(0);
    }

    let files = split(args.files);
    if (!files.length) {
      const head = args.head ?? d.head_sha;
      if (!head) { console.error('need --head <sha> or --files'); process.exit(2); }
      const { run } = await import('../src/exec.mjs');
      const r = await run('git', ['diff', '--name-only', `${d.base_sha}..${head}`], { cwd: args.repo ?? process.cwd() });
      if (!r.ok) { console.error(`cannot diff ${d.base_sha}..${head}: ${r.error}`); process.exit(2); }
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
    process.exit(result.ok ? 0 : 1);
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
  if (cmd === 'ask' || cmd === 'owner-decide' || cmd === 'owner-decisions' || cmd === 'owner-revoke') {
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
      const r = D.resolveOwnerDecision(rows, args.action, context);
      if (args.json) {
        console.log(JSON.stringify({ action: args.action, context, ...r }, null, 2));
      } else {
        console.log(`${r.outcome.toUpperCase()}  ${args.action}`);
        console.log(`  ${r.reason}`);
        if (r.decision_id) console.log(`  decision ${r.decision_id} at ${r.matched_scope} scope`);
        if (r.candidates.length > 1) console.log(`  candidates: ${r.candidates.join(', ')}`);
        if (Object.keys(r.constraints ?? {}).length) {
          console.log(`  constraints: ${JSON.stringify(r.constraints)}`);
        }
        // The question is printed ONLY when nothing answers it. This is the
        // behaviour the whole feature exists for, so it is one branch, here.
        if (r.outcome === 'no_decision' && typeof args.question === 'string') {
          console.log(`\nASK THE OWNER ONCE:\n  ${args.question}`);
        }
      }
      process.exit({ allowed: 0, denied: 1, owner_required: 3, no_decision: 4 }[r.outcome]);
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
    let registry;
    try { registry = await loadLaneRegistry(args['registry-file']); }
    catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
    if (!registry) {
      console.error('no lane registry configured. set lanesFile in config, or pass --registry-file <path>.');
      process.exit(2);
    }
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

  if (cmd === 'daemon') {
    if (args._[0] !== 'start') { console.error('usage: agentbridge daemon start'); process.exit(2); }
    await runDaemon();
    process.exit(0);
  }

  console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exit(2);
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
