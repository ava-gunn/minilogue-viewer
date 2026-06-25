#!/usr/bin/env bash
# Start/stop the local verify-and-tune daemon (training/daemon.py). Connects to the XD via
# the Volt and serves the localhost web app's thumbs-up pipeline on :8753.
#
#   scripts/daemon.sh start [-- extra args]   # e.g. start --tune-after 5
#   scripts/daemon.sh stop
#   scripts/daemon.sh status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/training/.venv/bin/python"
PIDFILE="$ROOT/training/.daemon.pid"
LOG="$ROOT/training/.daemon.log"

is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-}" in
  start)
    shift || true
    if is_running; then echo "daemon already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    PYTHONPATH="$ROOT" nohup "$PY" -m training.daemon "$@" >"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    echo "daemon starting (pid $(cat "$PIDFILE")) — logs: $LOG"
    echo "  scripts/daemon.sh status   to check it connected to the XD"
    ;;
  stop)
    if is_running; then
      pid="$(cat "$PIDFILE")"
      kill "$pid"   # SIGTERM -> clean panic + XD reset + close
      # Wait for it to actually exit (release :8753 + the XD) so an immediate restart
      # doesn't hit "address already in use".
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      rm -f "$PIDFILE"
      echo "daemon stopped"
    else
      echo "daemon not running"; rm -f "$PIDFILE" 2>/dev/null || true
    fi
    ;;
  status)
    if is_running; then
      echo "running (pid $(cat "$PIDFILE"))"
      curl -s http://127.0.0.1:8753/status && echo || echo "  (not responding yet)"
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: scripts/daemon.sh {start|stop|status}"; exit 1 ;;
esac
