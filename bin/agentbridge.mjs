#!/usr/bin/env node
import { initConfig, loadConfig, loadRegistry, registerAgent, unregisterAgent, CONFIG_FILE, VERSION } from '../src/config.mjs';
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
  agentbridge release-risk [--json] [--strict]
                                        exit 1 if any worktree carries release risk
  agentbridge doctor                    verify secret sealing and file permissions
  agentbridge daemon start

This layer is READ-ONLY. It observes and publishes state. It does not take
instructions from the bridge, and cannot execute anything on its behalf.
`;

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

    console.log(`machine ${payload.machine.label} (${payload.machine.platform})  ${payload.sentAt}`);
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
      console.log(`release-risk on ${payload.machine.label}  ${payload.sentAt}\n`);
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
