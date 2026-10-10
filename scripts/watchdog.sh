#!/bin/bash
# Watchdog: checks sessions every 5 minutes, restarts if missing.
# Cron: */5 * * * * ~/marveen/scripts/watchdog.sh

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$INSTALL_DIR/logs/watchdog.log"
mkdir -p "$INSTALL_DIR/logs"

# Dashboard port: config-driven (.env WEB_PORT), default 3420.
[ -f "$INSTALL_DIR/.env" ] && WEB_PORT="$(grep -E '^WEB_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
WEB_PORT="${WEB_PORT:-3420}"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

# Resolve which channel an agent must be respawned on, from its OWN
# agent-config.json channelProvider -- the same field src/web/agent-process.ts
# launches from. Sets AGENT_PROVIDER / TOKEN_VAR / STATE_ENV_VAR.
#
# Hardcoding telegram here had two failure modes for a non-telegram agent:
# (a) no TELEGRAM_BOT_TOKEN in its .env, so the loop hit "no bot token,
# skipping" and the watchdog NEVER restarted it -- precisely the agent the
# watchdog exists for stayed dead, while the log line looked routine; or
# (b) it came back on the wrong channel and was mute on its real one.
#
# Unknown / missing / malformed provider falls back to telegram, matching
# the pre-existing default so single-channel telegram installs are unaffected.
resolve_agent_provider() {
  local agent_dir="$1"
  AGENT_PROVIDER=$(python3 -c "import json; d=json.load(open('$agent_dir/agent-config.json')); print(d.get('channelProvider','telegram'))" 2>/dev/null || echo telegram)
  [ -n "$AGENT_PROVIDER" ] || AGENT_PROVIDER=telegram
  case "$AGENT_PROVIDER" in
    slack)      TOKEN_VAR="SLACK_BOT_TOKEN";      STATE_ENV_VAR="SLACK_STATE_DIR" ;;
    discord)    TOKEN_VAR="DISCORD_BOT_TOKEN";    STATE_ENV_VAR="DISCORD_STATE_DIR" ;;
    teams)      TOKEN_VAR="TEAMS_BOT_TOKEN";      STATE_ENV_VAR="TEAMS_STATE_DIR" ;;
    googlechat) TOKEN_VAR="GOOGLECHAT_BOT_TOKEN"; STATE_ENV_VAR="GOOGLECHAT_STATE_DIR" ;;
    *)          AGENT_PROVIDER=telegram; TOKEN_VAR="TELEGRAM_BOT_TOKEN"; STATE_ENV_VAR="TELEGRAM_STATE_DIR" ;;
  esac
}

# Self-test hook: print the resolution for one agent dir and exit, without
# touching tmux, the dashboard API or the log. Lets the contract be tested
# from fixtures (scripts/__tests__/watchdog-provider.test.sh) instead of
# requiring a live agent with a real bot token.
if [ "${1:-}" = "--resolve-provider" ]; then
  [ -n "${2:-}" ] || { echo "usage: watchdog.sh --resolve-provider <agent-dir>" >&2; exit 2; }
  resolve_agent_provider "$2"
  echo "provider=$AGENT_PROVIDER token_var=$TOKEN_VAR state_env_var=$STATE_ENV_VAR"
  exit 0
fi

# ISOLATION PARITY: the dashboard launches every sub-agent with a per-agent
# CLAUDE_CONFIG_DIR (agent-process.ts provisions <agent>/.claude-config, gated
# on the fleet OAuth token) so plugin registries never clobber each other in
# the shared ~/.claude. channel-watchdog.sh already rebuilds the same CFG_ENV
# on its respawn path (channel-watchdog.sh:183-201); this watchdog's tmux
# launch dropped it, so the FIRST auto-recovery silently moved an agent back
# onto the shared ~/.claude. Same gating as agent-process.ts: no token file ->
# no isolation (degraded shared mode is then the intended behaviour). The
# token is read inside the pane via $(cat), so the literal secret never lands
# in the command string, `ps` output or tmux pane history.
# oauthTokenFile (card 006b506b WhiteHat F5, MikroB comment 13989): a second
# launch site besides src/web/agent-process.ts -- this one hadn't been taught
# the field at all, so a watchdog-triggered respawn of an agent configured with
# its own setup-token silently exported the FLEET token instead, exactly the
# failure src/web/agent-oauth-token-file.ts's fail-closed stance exists to
# prevent (an agent given its own token that quietly ran on the fleet's would
# spend exactly the quota the field exists to protect, with no signal anywhere
# that it happened). Present-but-unusable must refuse the restart, never fall
# back to the fleet token. Both call sites capture this via command
# substitution (a subshell), so the refusal cannot travel out as a global the
# way resolve_agent_provider's AGENT_PROVIDER does -- it is encoded in stdout
# instead, as a "REFUSE:<reason>" line the prefix text can never otherwise
# produce (the prefix is always "export ... && "). This mirrors a SUBSET of
# checkOauthTokenFile's checks (path shape, mode, ownership via same-file
# test, non-empty, setup-token prefix); that TS module is canonical -- keep
# this in sync if its rules change.
#
# Card bc32d233 (006b506b Cybersec delta-GO ea46eecf, G1-G4): the config-level resolution (ENOENT
# vs any other read/parse failure, field type/shape) moved into scripts/lib/oauth_token_file_check.py
# (one script, mirroring resolveOauthTokenFileSetting/readAgentConfigForOauthDecision exactly,
# instead of this file's own bare `except Exception: print('')`, which silently treated an
# unreadable config or a malformed-but-key-naming one as "unset" -> fleet token, G1). AGENT_DIR is
# passed as argv, never interpolated into a Python source string -- G3's surviving mutant was
# exactly that interpolation: a single-quote in the path broke out of the quoted shell argument the
# old f-string built. The remaining FILE-level checks (isolation dir, symlink/missing, mode,
# fleet-identity, setup-token shape) stay here, plus two checks G2 found missing: content-bad-
# characters and a byte-identical COPY of the fleet token under another name (not just the same
# inode) -- also delegated to the same script so the comparison never prints either token's value.
OAUTH_TOKEN_FILE_CHECK_PY="${OAUTH_TOKEN_FILE_CHECK_PY:-$INSTALL_DIR/scripts/lib/oauth_token_file_check.py}"
agent_launch_env() {
  local AGENT_DIR="$1"
  local CONFIG_VERDICT CONFIG_RC
  CONFIG_VERDICT=$(python3 "$OAUTH_TOKEN_FILE_CHECK_PY" "$AGENT_DIR" 2>/dev/null)
  CONFIG_RC=$?

  # Card bc32d233 (RedHat NO-GO 14838, QA2 FAIL 14840, MikroB 14734's own named requirement):
  # a missing/crashing/empty-output checker used to fall through this case silently to the
  # unconditional fleet-token fallback below -- exactly the fail-open class G1 exists to close,
  # just at the PROCESS level instead of the config-content level. A non-zero exit, or any
  # output that is not exactly "UNSET"/"SET:*"/"REFUSE:*" (empty, multi-line, garbage), is now
  # REFUSE:checker-failed. "UNSET" (never "") is the checker's explicit "no field" sentinel --
  # see oauth_token_file_check.py's own docstring for why an empty string is never trusted here.
  if [ "$CONFIG_RC" -ne 0 ]; then
    printf '%s' "REFUSE:checker-failed"
    return
  fi

  case "$CONFIG_VERDICT" in
    REFUSE:*)
      printf '%s' "$CONFIG_VERDICT"
      return
      ;;
    UNSET)
      ;;
    SET:*)
      local OWN_TOKEN_PATH="${CONFIG_VERDICT#SET:}"
      if [ ! -d "$AGENT_DIR/.claude-config" ]; then
        printf '%s' "REFUSE:not-isolated"; return
      fi
      if [ -L "$OWN_TOKEN_PATH" ] || [ ! -f "$OWN_TOKEN_PATH" ]; then
        printf '%s' "REFUSE:missing-or-symlink"; return
      fi
      if [ ! -s "$OWN_TOKEN_PATH" ]; then
        printf '%s' "REFUSE:empty"; return
      fi
      local MODE
      MODE=$(stat -c '%a' "$OWN_TOKEN_PATH" 2>/dev/null || stat -f '%Lp' "$OWN_TOKEN_PATH" 2>/dev/null)
      if [ "$MODE" != "600" ]; then
        printf '%s' "REFUSE:mode-not-0600"; return
      fi
      if [ -s "$INSTALL_DIR/store/.claude-oauth-token" ] && [ "$OWN_TOKEN_PATH" -ef "$INSTALL_DIR/store/.claude-oauth-token" ]; then
        printf '%s' "REFUSE:is-fleet-token-file"; return
      fi
      if ! head -c 20 "$OWN_TOKEN_PATH" 2>/dev/null | grep -q '^sk-ant-oat'; then
        printf '%s' "REFUSE:not-a-setup-token"; return
      fi
      if python3 "$OAUTH_TOKEN_FILE_CHECK_PY" --bad-content-characters "$OWN_TOKEN_PATH" 2>/dev/null; then
        printf '%s' "REFUSE:content-bad-characters"; return
      fi
      if python3 "$OAUTH_TOKEN_FILE_CHECK_PY" --same-as-fleet-token "$OWN_TOKEN_PATH" "$INSTALL_DIR/store/.claude-oauth-token" 2>/dev/null; then
        printf '%s' "REFUSE:same-as-fleet-token"; return
      fi
      printf '%s' "export CLAUDE_CONFIG_DIR=\"$AGENT_DIR/.claude-config\" && export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat '$OWN_TOKEN_PATH')\" && "
      return
      ;;
    *)
      printf '%s' "REFUSE:checker-failed"
      return
      ;;
  esac

  if [ -d "$AGENT_DIR/.claude-config" ] && [ -s "$INSTALL_DIR/store/.claude-oauth-token" ]; then
    printf '%s' "export CLAUDE_CONFIG_DIR=\"$AGENT_DIR/.claude-config\" && export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat '$INSTALL_DIR/store/.claude-oauth-token')\" && "
  fi
}

# Self-test hook, mirroring --resolve-provider: print the launch-env prefix
# for one agent dir and exit, so the isolation contract is testable from
# fixtures (scripts/__tests__/watchdog-config-isolation.test.sh).
if [ "${1:-}" = "--launch-env" ]; then
  [ -n "${2:-}" ] || { echo "usage: watchdog.sh --launch-env <agent-dir>" >&2; exit 2; }
  ENV_PREFIX="$(agent_launch_env "$2")"
  case "$ENV_PREFIX" in
    REFUSE:*) echo "isolation=refuse reason=${ENV_PREFIX#REFUSE:}" ;;
    "") echo "isolation=no" ;;
    *) echo "isolation=yes prefix=$ENV_PREFIX" ;;
  esac
  exit 0
fi

# An agent is READY to be started only once both personality files exist. The
# dashboard wizard creates the directory first and generates CLAUDE.md /
# SOUL.md afterwards through an LLM call that can take minutes
# (routes/agents.ts: "Generating agent CLAUDE.md and SOUL.md..."), so a
# directory alone proves nothing about whether the agent is finished. Claude
# Code reads CLAUDE.md at startup: a session started before the files land
# comes up with no identity, no rules and no persona, and stays that way
# until restarted by hand -- from the outside the creation looks failed.
agent_is_scaffolded() {
  [ -f "$1/CLAUDE.md" ] && [ -f "$1/SOUL.md" ]
}

# Self-test hook, mirroring --resolve-provider: evaluate the predicate and
# exit before touching tmux, so the contract is testable from fixtures
# (scripts/__tests__/watchdog-scaffold-guard.test.sh).
if [ "${1:-}" = "--check-scaffolded" ]; then
  [ -n "${2:-}" ] || { echo "usage: watchdog.sh --check-scaffolded <agent-dir>" >&2; exit 2; }
  if agent_is_scaffolded "$2"; then echo "scaffolded=yes"; else echo "scaffolded=no"; fi
  exit 0
fi


export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

TOKEN=""
HDR_FILE=""
if [ -f "$INSTALL_DIR/store/.dashboard-token" ]; then
  TOKEN=$(cat "$INSTALL_DIR/store/.dashboard-token")
  # SECURITY (Cybersec/gate-ops-scripts-token-in-argv, card b267df80): 0600 temp
  # header file instead of a curl argv (/proc/<pid>/cmdline is world-readable).
  HDR_FILE="$(mktemp)"; chmod 600 "$HDR_FILE"
  trap 'rm -f "$HDR_FILE"' EXIT
  printf 'Authorization: Bearer %s\n' "$TOKEN" > "$HDR_FILE"
fi

# Replays delivered-but-not-completed messages from the last 2 hours into
# a freshly restarted agent session. Called after a confirmed restart.
replay_unfinished_messages() {
  local AGENT_ID="$1"
  local SESSION_NAME="$2"

  [ -z "$TOKEN" ] && return

  local NOW CUTOFF RESPONSE TMPDATA
  NOW=$(date +%s)
  CUTOFF=$(( NOW - 7200 ))

  RESPONSE=$(curl -s -m 5 \
    -H @"$HDR_FILE" \
    "http://localhost:${WEB_PORT}/api/messages?to=${AGENT_ID}&limit=200" 2>/dev/null) || return

  [ -z "$RESPONSE" ] || [ "$RESPONSE" = "[]" ] && return

  TMPDATA=$(mktemp)
  echo "$RESPONSE" > "$TMPDATA"

  # Replay logic extracted to its own file (testable) + MSGSZIVARGAS826: every
  # injected message writes a dated marker into the dashboard log -- this used
  # to be a fully record-less injection path, invisible to every detector.
  # stderr goes to the watchdog log, NOT /dev/null (NOTIFYVAKSWEEP826 zaro
  # kor, Marveen msg 16091): the replay python is honest about a failed
  # marker write, but the old 2>/dev/null buried exactly that line -- the
  # instrument built against silence would have gone blind silently.
  python3 "$INSTALL_DIR/scripts/watchdog-replay.py" \
    "$SESSION_NAME" "$AGENT_ID" "$CUTOFF" "$TMPDATA" \
    "$INSTALL_DIR/store/dashboard.log" 2>>"$LOG"

  rm -f "$TMPDATA"
}

# ── Dashboard ──────────────────────────────────────────────────────────────
DASHBOARD_PID=$(ps -ef | grep "node dist/index.js" | grep -v grep | awk '{print $2}' | head -1)
if [ -z "$DASHBOARD_PID" ]; then
  echo "$(timestamp) [watchdog] Dashboard down, restarting..." >> "$LOG"
  cd "$INSTALL_DIR" && nohup npm start >> "$INSTALL_DIR/logs/dashboard.log" 2>&1 &
  sleep 5
  NEW_PID=$(ps -ef | grep "node dist/index.js" | grep -v grep | awk '{print $2}' | head -1)
  echo "$(timestamp) [watchdog] Dashboard restarted (PID: ${NEW_PID:-?})" >> "$LOG"
fi

# ── Main agent session ─────────────────────────────────────────────────────
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_SESSION="${MAIN_AGENT_ID}-channels"

if ! tmux has-session -t "$MAIN_SESSION" 2>/dev/null; then
  # Mutual-exclusion gate, mirroring channel-watchdog.sh's gate 4. The dashboard
  # channel-monitor, channel-watchdog.sh, systemd (Restart=always) and this cron
  # loop can all recreate the main channels session; they coordinate through the
  # shared respawn stamp (store/.channel-last-respawn, written by channels.sh).
  # Without this gate this loop spawned a competing channels.sh every 5 min while
  # another actor was mid-respawn -> two claude processes contending for the same
  # bot token (409) and rapid-exit (root-caused 2026-08-06, ~4.5h outage). Defer
  # while a respawn is inside the grace window (same 15 min as channel-watchdog.sh);
  # only act as the last-resort backstop once every other actor has stopped trying.
  MAIN_RESPAWN_STAMP="$INSTALL_DIR/store/.channel-last-respawn"
  _mlast=0
  [ -f "$MAIN_RESPAWN_STAMP" ] && _mlast="$(stat -c %Y "$MAIN_RESPAWN_STAMP" 2>/dev/null || echo 0)"
  if [ "$(( $(date +%s) - _mlast ))" -lt 900 ]; then
    echo "$(timestamp) [watchdog] $MAIN_SESSION missing but a respawn is within the 900s grace -- deferring (systemd/channels.sh/channel-watchdog cover it)" >> "$LOG"
  else
    echo "$(timestamp) [watchdog] $MAIN_SESSION missing, restarting..." >> "$LOG"
    nohup "$INSTALL_DIR/scripts/channels.sh" >> "$INSTALL_DIR/logs/marveen-channels.log" 2>&1 &
    sleep 5
    if tmux has-session -t "$MAIN_SESSION" 2>/dev/null; then
      echo "$(timestamp) [watchdog] $MAIN_SESSION restarted OK" >> "$LOG"
    else
      echo "$(timestamp) [watchdog] $MAIN_SESSION restart FAILED" >> "$LOG"
    fi
  fi
fi

# ── Sub-agents: restart if missing ────────────────────────────────────────
if [ ! -d "$INSTALL_DIR/agents" ]; then
  exit 0
fi

CLAUDE_BIN="$(command -v claude)"

for AGENT_DIR in "$INSTALL_DIR/agents"/*/; do
  AGENT_ID=$(basename "$AGENT_DIR")
  SESSION_NAME="agent-${AGENT_ID}"

  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    continue
  fi

  # Do not start a half-scaffolded agent: the wizard's LLM call may still be
  # writing CLAUDE.md / SOUL.md. The next tick starts it once both exist.
  if ! agent_is_scaffolded "$AGENT_DIR"; then
    echo "$(timestamp) [watchdog] $AGENT_ID: personality files not ready yet (wizard still generating?), skipping this tick" >> "$LOG"
    continue
  fi

  echo "$(timestamp) [watchdog] $AGENT_ID missing, restarting..." >> "$LOG"

  resolve_agent_provider "$AGENT_DIR"

  CHAN_DIR="$AGENT_DIR/.claude/channels/$AGENT_PROVIDER"
  BOT_TOKEN=$(grep "$TOKEN_VAR" "$CHAN_DIR/.env" 2>/dev/null | cut -d= -f2- | head -1)
  MODEL=$(python3 -c "import json; d=json.load(open('$AGENT_DIR/agent-config.json')); print(d.get('model','claude-haiku-4-5-20251001'))" 2>/dev/null || echo "claude-haiku-4-5-20251001")

  if [ -z "$BOT_TOKEN" ]; then
    echo "$(timestamp) [watchdog] $AGENT_ID: no $AGENT_PROVIDER bot token, skipping" >> "$LOG"
    continue
  fi

  ISO_ENV="$(agent_launch_env "$AGENT_DIR")"
  case "$ISO_ENV" in
    REFUSE:*)
      echo "$(timestamp) [watchdog] $AGENT_ID: oauthTokenFile set but unusable (${ISO_ENV#REFUSE:}) -- NOT restarted (fail-closed, no fallback to the fleet token)" >> "$LOG"
      continue
      ;;
  esac

  CMD="${ISO_ENV}export PATH=\"/opt/homebrew/bin:\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN && export CLAUDE_CODE_DISABLE_AGENT_VIEW=1 && export ${STATE_ENV_VAR}=\"$CHAN_DIR\" && cd \"$AGENT_DIR\" && ${CLAUDE_BIN} --dangerously-skip-permissions --model '$MODEL' --channels plugin:${AGENT_PROVIDER}@claude-plugins-official"

  tmux new-session -d -s "$SESSION_NAME" "$CMD" 2>/dev/null
  sleep 2

  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "$(timestamp) [watchdog] $AGENT_ID restarted OK" >> "$LOG"
    REPLAY_OUT=$(replay_unfinished_messages "$AGENT_ID" "$SESSION_NAME" 2>&1)
    [ -n "$REPLAY_OUT" ] && echo "$(timestamp) $REPLAY_OUT" >> "$LOG"
  else
    echo "$(timestamp) [watchdog] $AGENT_ID restart FAILED" >> "$LOG"
  fi
done
