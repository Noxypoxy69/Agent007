@echo off
rem  START AN AGENT SESSION THE BRIDGE CAN SEE.
rem
rem    agent code-a
rem    agent code-b
rem    agent fixer
rem
rem  WHY A .cmd AND NOT `npm run agent`. The npm route was written first and it
rem  FAILS, which Danny hit immediately:
rem
rem    Input must be provided either through stdin or as a prompt argument
rem
rem  npm runs its script with stdin piped, so claude sees no TTY and starts in
rem  headless print mode instead of an interactive session. Nothing about the
rem  environment was wrong -- the launcher simply could not hand over the
rem  terminal it was started from. A .cmd sets the variable in THIS shell and
rem  then execs claude directly, so the terminal is never handed through a pipe.
rem
rem  WHAT THIS BUYS, both halves of tonight's problem:
rem    AGENTBRIDGE_AGENT_ID  the SessionStart poll hook refuses without it and
rem                          exits 0, which is why the watcher had never run
rem                          once and the roster showed everyone offline.
rem    cwd = this repository  a session started here loads .claude/settings.json
rem                          and therefore the guard, the Stop gate and the poll
rem                          hook. Started from the home directory it loads none
rem                          of them, which is how a session ran unguarded for a
rem                          day while believing otherwise.

setlocal
if "%~1"=="" (
  echo usage: agent ^<agent-id^>  [e.g. agent code-a^]
  echo.
  echo   The id is the DURABLE agent id the bridge knows -- code-a, code-b, fixer --
  echo   not a session name. A typo does not fail: it creates a SECOND identity on
  echo   the roster, and work is routed by identity. Run  npm run agent:check -- %%1 --print
  echo   first if you want it validated against the local registry.
  exit /b 2
)

cd /d "%~dp0"
set "AGENTBRIDGE_AGENT_ID=%~1"
if not "%~2"=="" set "AGENTBRIDGE_LANE=%~2"

rem  QUOTED, BECAUSE AN AGENT ID IS DATA AND cmd.exe TREATS IT AS SCRIPT.
rem  Unquoted, the shell metacharacters in an id are live to cmd.exe:
rem  an id of the form a-AMP-echo-PWNED executed that echo. Found by blind
rem  audit, after three earlier gate versions only ever passed "code-a".
rem  NOTE: rem does NOT protect a metacharacter -- cmd.exe splits a rem
rem  line on an ampersand and runs the tail. Writing the literal attack
rem  string into this comment REINTRODUCED the bug it describes.
echo agent   : "%AGENTBRIDGE_AGENT_ID%"
echo cwd     : "%CD%"
echo.

claude
