#!/usr/bin/env bash
# Runs NX Sentry inside a headless gamescope compositor and captures a screenshot,
# so UI checks never open a window on the developer's desktop.
#
#   scripts/headless_test.sh [-o out.png] [-W 1400] [-H 900] [-s secs]
#                            [-e KEY=VAL]... [--wayland] [-- electron-args...]
#
# -e sets an environment variable for the app only, e.g.
#      scripts/headless_test.sh -e NX_SENTRY_MOCK=1 -e NX_SENTRY_CONFIG_DIR=/tmp/sentry
#   Plain inherited env works too (NX_SENTRY_MOCK=1 scripts/headless_test.sh).
#
# --wayland exposes gamescope's own Wayland socket and switches Electron to the
# Ozone Wayland backend; without it the app gets XWayland and takes the X11
# path. Both are worth testing.
#
# Everything after -- is appended to the Electron command line.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=/tmp/nx-sentry_headless.png
W=1400; H=900; SETTLE=6; EXPOSE=0
ARGS=()
ENVS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o) OUT="$2"; shift 2 ;;
        -W) W="$2"; shift 2 ;;
        -H) H="$2"; shift 2 ;;
        -s) SETTLE="$2"; shift 2 ;;
        -e) ENVS+=("$2"); shift 2 ;;
        --wayland) EXPOSE=1; shift ;;
        --) shift; ARGS=("$@"); break ;;
        *) ARGS+=("$1"); shift ;;
    esac
done

ELECTRON=node_modules/electron/dist/electron

command -v gamescope    >/dev/null || { echo "gamescope not installed"; exit 1; }
command -v gamescopectl >/dev/null || { echo "gamescopectl not installed"; exit 1; }
[[ -x $ELECTRON ]]                 || { echo "$ELECTRON missing - run npm install"; exit 1; }
[[ -f src/main/index.js ]]         || { echo "src/main/index.js missing"; exit 1; }

LOG=$(mktemp /tmp/nx-sentry-headless-XXXXXX.log)
GS_ARGS=(--backend headless -W "$W" -H "$H" -w "$W" -h "$H")

# Electron in a nested headless compositor: no sandbox (no user namespaces here)
# and software GL, since gamescope's headless backend exposes no real device.
APP_ARGS=(. --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage)
if [[ $EXPOSE -eq 1 ]]; then
    GS_ARGS+=(--expose-wayland)
    APP_ARGS+=(--ozone-platform=wayland --enable-features=UseOzonePlatform)
fi
APP_ARGS+=("${ARGS[@]+"${ARGS[@]}"}")

# Claim a private socket name so a real gamescope session on the desktop is
# never touched by our screenshot or our kill.
export GAMESCOPE_WAYLAND_DISPLAY=""
export ELECTRON_DISABLE_SANDBOX=1
export ELECTRON_ENABLE_LOGGING=1

# Every gamescope socket that already exists belongs to somebody else.
PRE_SOCKS=""
for s in "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"/gamescope-*; do
    [[ -S "$s" ]] || continue
    PRE_SOCKS+=" $(basename "$s")"
done

gamescope "${GS_ARGS[@]}" -- \
    env "${ENVS[@]+"${ENVS[@]}"}" "$ELECTRON" "${APP_ARGS[@]}" >"$LOG" 2>&1 &
GS_PID=$!
cleanup() { kill "$GS_PID" 2>/dev/null; wait "$GS_PID" 2>/dev/null; }
trap cleanup EXIT

# Wait for the nested compositor to publish its socket.
#
# Only `gamescope-<N>` counts: the runtime dir also carries `gamescope-limiter-*`
# sockets and `-ei`/`.lock` siblings, and screenshotting one of those just fails.
# And only a socket that was NOT there before we started is ours — a real
# gamescope session, or another agent's headless one, must never be the thing we
# photograph or kill.
RUNDIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
is_gs_sock() { [[ -S "$1" && "$(basename "$1")" =~ ^gamescope-[0-9]+$ ]]; }
SOCK=""
for _ in $(seq 1 100); do
    for s in "$RUNDIR"/gamescope-*; do
        is_gs_sock "$s" || continue
        cand=$(basename "$s")
        [[ " $PRE_SOCKS " == *" $cand "* ]] && continue   # someone else's, already running
        SOCK="$cand"
    done
    [[ -n "$SOCK" ]] && break
    sleep 0.1
done
[[ -n "$SOCK" ]] || { echo "gamescope never came up:"; tail -20 "$LOG"; exit 1; }

sleep "$SETTLE"     # let Electron boot, run discovery and paint a few frames

if ! GAMESCOPE_WAYLAND_DISPLAY="$SOCK" gamescopectl screenshot "$OUT" >/dev/null 2>&1; then
    echo "screenshot failed"; tail -20 "$LOG"; exit 1
fi
for _ in $(seq 1 50); do [[ -s "$OUT" ]] && break; sleep 0.1; done

echo "=== nx-sentry output ==="
grep -aiE "nx-sentry|\[main\]|error|Error:" "$LOG" | head -30
echo "=== screenshot: $OUT ($(stat -c%s "$OUT" 2>/dev/null || echo 0) bytes) ==="
echo "=== full log: $LOG ==="
