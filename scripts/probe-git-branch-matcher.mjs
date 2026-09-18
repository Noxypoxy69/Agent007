/*
 * TOMBSTONE. This file is empty of behaviour on purpose. DELETE IT.
 *
 * It held a one-shot harness for a `git branch` matcher patch that an audit
 * falsified: the candidate allowed ref mutation the shipped regex denies. The
 * candidate, the three leaking input families and the reasons the harness was
 * itself a hollow gate are all recorded in
 * docs/GUARD_FINDINGS_2026-09-17_fixer.md. Nothing is lost by removing this.
 *
 * WHY IT WAS GUTTED RATHER THAN DELETED, and why that is not merely tidiness:
 * src/moduleGraph.mjs:618 declares PROD = ['src','bin','bridge','mcp','scripts'],
 * so `scripts/` is part of the corpus that decides whether a src/ export counts
 * as production-referenced. A throwaway probe living here is a laundering route:
 * one that merely MENTIONS a src/ export name flips that export from dead to
 * production-referenced, and the dead-export ratchet reads as improving. The
 * original imported only names that were already production-referenced, so
 * nothing was laundered -- measured, test-only 77 and unreferenced 6 unchanged
 * before and after. The hazard was the precedent, not the instance.
 *
 * It also exported a function nothing imported, which is exactly what the
 * dead-export ratchet exists to catch, and the ratchet could not see it:
 * classifyModules (moduleGraph.mjs:445), classifyExports (:640) and deadExports
 * (:691) each filter to relPath.startsWith('src/'), so bin/, bridge/, mcp/ and
 * scripts/ are invisible to it in both directions. The gate's header claims
 * scripts/ is production; only half of that claim is implemented.
 *
 * This file could not be deleted from the session that created it: `git rm` is
 * refused as not-read-only, and no structured tool removes a file. Gutting it
 * removes the behaviour and the export; removing the file needs a terminal.
 */
