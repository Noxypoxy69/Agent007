/**
 * ACTIONS THAT LEAVE NO TRACE IN THE REPOSITORY, AND THEREFORE NO TRACE AT STOP.
 *
 * THE GAP, STATED EXACTLY. The guard's documented posture for everything it does
 * not block at PreToolUse is "not blocked here, detected at Stop by
 * protected-file drift". For an MCP write that lands on a repository file that
 * is true, and the claim is sound. But a production migration, an edge-function
 * deploy, a sent email, a scheduled cron run and a driven browser change NO BYTE
 * UNDER THE WORKTREE. Stop hashes protected files and compares them to a
 * snapshot; it has nothing to compare for any of these. For this class the
 * stated fallback is not a weaker layer, it is NO layer.
 *
 * Measured at 61bbeb2, all ALLOW at PreToolUse:
 *   mcp__claude_ai_Supabase__apply_migration       production SQL
 *   mcp__claude_ai_Supabase__deploy_edge_function  production deploy
 *   mcp__claude-in-chrome__javascript_tool         executes JS
 *   mcp__claude-in-chrome__computer                drives the desktop
 *   mcp__claude_ai_Gmail__send_message             irreversible outbound
 *   CronCreate                                     schedules a future agent run
 *
 * THIS MODULE DOES NOT BLOCK ANYTHING AND IS NOT WIRED TO ANYTHING. It answers
 * one question -- "what would this action do, and whose authority is that?" --
 * and the answer is data. Wiring it into the guard is a separate change with its
 * own end-to-end proof, deliberately not made here.
 *
 * WHY NOT JUST DEFAULT-DENY, WHICH IS THE OBVIOUS ANSWER. It was tried. Commit
 * 520cee2 default-denied every tool name it did not recognise and refused 24 of
 * a real 54-tool roster -- an outage, and an outage gets the hook switched off,
 * which loses every layer at once. a1d7f6c removed it for that reason. CLAUDE.md
 * rule 19 is the lesson: allowing by known name leaks, denying by unknown name is
 * an outage.
 *
 * SO THE DEFAULT-DENY IS SCOPED TO A NAMESPACE RATHER THAN GLOBAL. Within a
 * server that can reach production, money or a person's inbox, an unrecognised
 * operation is OWNER authority; outside those servers nothing changes. A new
 * Supabase tool added next month is owner-gated the day it appears without
 * anybody remembering to list it, and a new local tool is unaffected. That is
 * rule 7 applied to authority: generate the coverage from the namespace instead
 * of from the operations somebody happened to think of.
 *
 * AUTHORITY COMES FROM CLAUDE.md AND IS NOT INVENTED HERE. Danny is the owner.
 * Production deploys, destructive actions, spending, merges to main and anything
 * a customer receives are his, and NO COORDINATOR MAY APPROVE THEM ON HIS
 * BEHALF. src/permissionRequest.mjs already routes this; canDecidePermission
 * already enforces the refusal. This module classifies; it does not decide who
 * may approve, because that decision already has an owner elsewhere.
 *
 * PURE. No clock, no filesystem, no network, no spawn.
 */

/** What an action does to the world outside this repository. */
export const NONE = 'none';
export const REVERSIBLE_EXTERNAL = 'reversible-external';
export const IRREVERSIBLE_OUTBOUND = 'irreversible-outbound';
export const PRODUCTION_STATE = 'production-state';
export const SPENDS_MONEY = 'spends-money';
export const FUTURE_EXECUTION = 'future-execution';
export const HOST_CONTROL = 'host-control';

export const CONSEQUENCES = Object.freeze([
  NONE, REVERSIBLE_EXTERNAL, IRREVERSIBLE_OUTBOUND,
  PRODUCTION_STATE, SPENDS_MONEY, FUTURE_EXECUTION, HOST_CONTROL,
]);

/** Whose approval the action needs. Vocabulary from CLAUDE.md, not invented. */
export const UNRESTRICTED = 'unrestricted';
export const COORDINATOR = 'coordinator';
export const OWNER = 'owner';

/**
 * Servers whose operations can reach production, money, a person, or the host.
 *
 * Membership here turns on WHAT THE SERVER CAN REACH, never on how many of its
 * tools look dangerous. Within one of these an unrecognised operation is OWNER;
 * the reads are named below and everything else is gated.
 */
const CONSEQUENTIAL_NAMESPACES = Object.freeze({
  'mcp__claude_ai_Supabase__': PRODUCTION_STATE,
  'mcp__claude_ai_Cloudflare_Developer_Platform__': PRODUCTION_STATE,
  'mcp__claude_ai_Vercel__': PRODUCTION_STATE,
  'mcp__claude_ai_Gmail__': IRREVERSIBLE_OUTBOUND,
  'mcp__claude_ai_Slack__': IRREVERSIBLE_OUTBOUND,
  'mcp__claude_ai_Google_Drive__': REVERSIBLE_EXTERNAL,
  'mcp__claude_ai_Google_Calendar__': REVERSIBLE_EXTERNAL,
  'mcp__claude-in-chrome__': HOST_CONTROL,
});

/**
 * Operations inside a consequential namespace that only READ.
 *
 * Matched on the operation suffix, so one entry covers a tool whatever server
 * prefix it arrives under. This list may only ever GROW by someone establishing
 * that an operation reads; a wrong entry here is a silent hole, which is the
 * asymmetry that decides how additions are weighed.
 */
const READ_OPERATIONS = Object.freeze(new Set([
  'list_projects', 'list_tables', 'list_extensions', 'list_migrations', 'list_branches',
  'list_organizations', 'list_edge_functions', 'get_project', 'get_organization',
  'get_project_url', 'get_publishable_keys', 'get_edge_function', 'get_advisors',
  'get_cost', 'query_logs', 'search_docs', 'generate_typescript_types',
  'd1_databases_list', 'kv_namespaces_list', 'r2_buckets_list', 'workers_list',
  'workers_get_worker', 'workers_get_worker_code', 'hyperdrive_configs_list',
  'd1_database_get', 'kv_namespace_get', 'r2_bucket_get', 'hyperdrive_config_get',
  'search_cloudflare_documentation', 'migrate_pages_to_workers_guide',
  'search_threads', 'get_message', 'get_thread', 'list_labels', 'list_drafts', 'get_draft',
  /*
   * ── SEVEN OVER-BLOCKS, FOUND BY AUDIT AGAINST THE REAL ROSTER ─────────────
   *
   * Each of these was refused as irreversible-outbound once the classifier was
   * wired, and none of them sends anything:
   *
   *   slack_search_public_and_private  a READ. Its sibling slack_search_public
   *                                    was already here; the private variant was
   *                                    simply not listed. Enumeration failing in
   *                                    the direction rule 19 warns about.
   *   create_draft, update_draft       a draft is NOT SENT. list_drafts and
   *                                    get_draft were already reads, so the
   *                                    model already distinguished drafts --
   *                                    and writing a draft for the OWNER to send
   *                                    is the safe pattern this should
   *                                    encourage, not gate.
   *   create_label, label_message,     a label is filing, not outbound. Nothing
   *   update_message_labels            leaves the account; unlabel_message
   *                                    exists and undoes it.
   *   slack_add_reaction               an emoji, removable, on a message that
   *                                    was already posted.
   *
   * By this module's own rule-19 argument, an over-blocking guard gets switched
   * off and that loses every layer at once. A draft and a label are exactly the
   * ordinary work whose refusal makes somebody disable the hook.
   *
   * WHAT IS DELIBERATELY NOT ADDED: send_message, forward, reply,
   * slack_send_message, slack_schedule_message, trash/spam operations. Those
   * either reach a recipient or destroy mail, and both are the owner's call.
   */
  'create_draft', 'update_draft', 'create_label', 'label_message', 'update_message_labels',
  'slack_add_reaction', 'slack_search_public_and_private',
  'slack_read_channel', 'slack_read_thread', 'slack_search_public', 'slack_search_channels',
  'slack_search_users', 'slack_read_user_profile', 'slack_read_canvas', 'slack_read_file',
  'slack_list_channel_members', 'slack_get_reactions', 'slack_search_emojis',
  'search_files', 'read_file_content', 'get_file_metadata', 'get_file_permissions',
  'list_recent_files', 'download_file_content',
  'list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time',
  'read_page', 'get_page_text', 'read_console_messages', 'read_network_requests',
  'find', 'tabs_context_mcp', 'list_connected_browsers', 'shortcuts_list',
  'authenticate', 'complete_authentication', 'confirm_cost',
]));

/**
 * Non-MCP tools whose consequence is not visible from their input shape.
 *
 * Small and explicit. Everything absent from here and outside a consequential
 * namespace classifies as NONE, which is the permissive default that keeps this
 * from becoming the 24-of-54 outage again.
 */
const NAMED_ACTIONS = Object.freeze({
  CronCreate: FUTURE_EXECUTION,
  CronDelete: FUTURE_EXECUTION,
  RemoteTrigger: FUTURE_EXECUTION,
  SendUserFile: REVERSIBLE_EXTERNAL,
  /*
   * A NOTIFICATION TO THE OWNER IS NOT "SOMETHING A CUSTOMER RECEIVES".
   *
   * This was IRREVERSIBLE_OUTBOUND, which became OWNER in the table below, which
   * meant that once the classifier was WIRED into the guard, telling Danny
   * something required Danny's approval first. Circular, and an immediate
   * outage: it is the mechanism for reaching him when a session needs him.
   * Measured 2026-09-18 -- test/claudeGuardToolDispatch.test.mjs already names
   * PushNotification in its list of tools that "cannot touch the repo and must
   * not be blocked", and the wiring broke that contract.
   *
   * The OWNER tier exists for production state, spending, and anything a
   * CUSTOMER receives -- CLAUDE.md says so in those words. A push to the owner's
   * own device is none of them. Its sibling SendUserFile, which also sends to
   * the owner and equally cannot be unsent, is already REVERSIBLE_EXTERNAL, so
   * this is the consistent classification rather than a new opinion.
   *
   * WHY THIS IS NOT JUST WEAKENING A CONTROL TO GO GREEN: the consequence was
   * harmless while nothing consulted it, and wiring is what turned a debatable
   * label into a refusal. An over-blocking guard gets switched off, which loses
   * every layer at once (rule 19), and the first thing anyone would switch off
   * is the one that stops them reporting a problem.
   */
  PushNotification: REVERSIBLE_EXTERNAL,
});

/**
 * Consequence -> whose approval it needs.
 *
 * PRODUCTION_STATE, SPENDS_MONEY and IRREVERSIBLE_OUTBOUND are OWNER because
 * CLAUDE.md says so in as many words: production deploys, spending and anything
 * a customer receives are Danny's, and no coordinator may approve them for him.
 *
 * HOST_CONTROL IS OWNER, AND IT WAS COORDINATOR UNTIL 2026-09-18. Danny decided
 * it, asked directly and answered directly, and it is recorded at
 * d-owner-action-authority-gating-20260918 so nobody has to take an agent's word
 * for it -- this ruling reached me second-hand and was in no record, which is
 * why it was put back to him rather than acted on.
 *
 * The reasoning, so the entry is arguable rather than merely cited: driving the
 * host is not one consequence, it is the ABILITY TO PRODUCE ANY OF THE OTHERS.
 * A browser session that can click can deploy, spend, and send mail to a
 * customer, and it does it wearing the authority of whoever is already logged
 * in. Classifying the general capability below the specific acts it can perform
 * lets a coordinator approve, in one call, everything this table reserves to the
 * owner in six.
 */
const AUTHORITY_FOR = Object.freeze({
  [NONE]: UNRESTRICTED,
  [REVERSIBLE_EXTERNAL]: COORDINATOR,
  [FUTURE_EXECUTION]: COORDINATOR,
  [HOST_CONTROL]: OWNER,
  [IRREVERSIBLE_OUTBOUND]: OWNER,
  [PRODUCTION_STATE]: OWNER,
  [SPENDS_MONEY]: OWNER,
});

/**
 * Does this action change a byte under the worktree?
 *
 * THE WHOLE POINT OF THE MODULE IS THAT THIS IS USUALLY FALSE. Stop compares
 * file content against a snapshot, so an action that writes no repository file
 * is invisible to it no matter how consequential it is. Returning false here is
 * the assertion "the documented fallback does not cover this".
 */
function touchesRepository(toolName, input) {
  if (typeof toolName !== 'string') return false;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return true;
  if (['Bash', 'PowerShell', 'Shell', 'Cmd', 'Terminal'].includes(toolName)) return true;
  // An MCP tool that names a repository-relative path can land on a file.
  const path = input?.file_path ?? input?.path ?? null;
  return typeof path === 'string' && path !== '' && !/^[A-Za-z]:|^\//.test(path);
}

const operationOf = (toolName, prefix) => toolName.slice(prefix.length);

/**
 * Classify one tool call. Returns data; refuses nothing; blocks nothing.
 *
 * { consequence, authority, observableAtStop, reason }
 */
export function classifyAction({ tool_name: toolName, tool_input: input = {} } = {}) {
  if (typeof toolName !== 'string' || toolName.trim() === '') {
    /*
     * FAIL CLOSED ON A MALFORMED CALL. An unnameable action cannot be shown to be
     * harmless, and "cannot establish" is not "permitted" -- the same posture the
     * Stop gate takes on an absent snapshot.
     *
     * THE TEST WAS `toolName === ''` AND THAT IS ONE SPELLING OF EMPTY, NOT THE
     * PROPERTY. Measured 2026-09-18 while wiring this module into the guard:
     *
     *   ""      -> production-state / owner     fails closed, correct
     *   "   "   -> none / unrestricted          SAILS THROUGH
     *   "\t"    -> none / unrestricted          SAILS THROUGH
     *
     * A whitespace name matches no namespace and no named action, so it fell out
     * of the bottom as UNRESTRICTED -- the one verdict that means "nothing here
     * needs approval". Exactly backwards for an input nobody can identify, and
     * the same shape as the safeGit lint that named four function spellings
     * instead of the property it was for. `.trim()` asks whether there is a
     * usable name at all rather than comparing against one way of having none.
     */
    return Object.freeze({
      consequence: PRODUCTION_STATE,
      authority: OWNER,
      observableAtStop: false,
      reason: 'the tool name is missing, blank or not a string, so nothing about this action can be established',
    });
  }

  const observableAtStop = touchesRepository(toolName, input ?? {});

  for (const [prefix, consequence] of Object.entries(CONSEQUENTIAL_NAMESPACES)) {
    if (!toolName.startsWith(prefix)) continue;
    const operation = operationOf(toolName, prefix);
    if (READ_OPERATIONS.has(operation)) {
      return Object.freeze({
        consequence: NONE,
        authority: UNRESTRICTED,
        observableAtStop,
        reason: `${operation} is a named read operation`,
      });
    }
    return Object.freeze({
      consequence,
      authority: AUTHORITY_FOR[consequence],
      observableAtStop,
      reason:
        `${operation} is an unrecognised operation in the ${prefix} namespace, which can reach ` +
        `${consequence}; an unrecognised operation there is owner-gated rather than assumed safe`,
    });
  }

  if (Object.prototype.hasOwnProperty.call(NAMED_ACTIONS, toolName)) {
    const consequence = NAMED_ACTIONS[toolName];
    return Object.freeze({
      consequence,
      authority: AUTHORITY_FOR[consequence],
      observableAtStop,
      reason: `${toolName} is a named action with ${consequence} consequence`,
    });
  }

  return Object.freeze({
    consequence: NONE,
    authority: UNRESTRICTED,
    observableAtStop,
    reason: `${toolName} is outside every consequential namespace and is not a named action`,
  });
}

/**
 * The finding this module encodes, as a predicate a test can assert.
 *
 * True when an action is consequential AND invisible to the Stop gate -- i.e.
 * exactly the population for which "detected at Stop" is not a fallback at all.
 */
export function isUncoveredByStop(verdict) {
  return verdict?.consequence !== NONE && verdict?.observableAtStop === false;
}
