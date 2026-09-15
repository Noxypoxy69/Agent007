#!/usr/bin/env node
import { initConfig, loadConfig, loadRegistry, registerAgent, unregisterAgent, localMachineLabel, CONFIG_FILE, VERSION } from '../src/config.mjs';
import { protectSecret, unprotectSecret, isWindows } from '../src/secretstore.mjs';
import { collect } from '../src/collect.mjs';
import { runDaemon } from '../src/daemon.mjs';
import { publish } from '../src/client.mjs';

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
             --base <sha> [--allow a,b] [--forbid a,b] [--shared a,b]
                                        record a bounded task handoff as a contract
  agentbridge delegations [--json]      list recorded handoffs and their state
  agentbridge delegations --for <session> [--all] [--json]
                                        what THIS session still owes: outstanding
                                        work only, or --all for its whole history
  agentbridge audit-delegation --id <id> [--head <sha>] [--files a,b] [--repo <dir>]
                                        exit 1 if the delegate went outside the contract
  agentbridge doctor                    verify secret sealing and file permissions
  agentbridge daemon start

This layer is READ-ONLY. It observes and publishes state. It does not take
instructions from the bridge, and cannot execute anything on its behalf.
`;

/** Comma-separated CLI list -> array. Empty, absent, or a bare flag mean none. */
const split = (v) => (typeof v === 'string' && v.length ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

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
      const rec = P.createDelegation({
        id: args.id,
        assigning_session: args.from,
        assigned_session: args.to,
        task: args.task,
        lane_id: args.lane ?? null,
        base_sha: args.base,
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
