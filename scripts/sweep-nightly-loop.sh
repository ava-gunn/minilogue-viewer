#!/usr/bin/env bash
# Nightly driver for the diversity sweep, for a LOGGED-IN session — NOT launchd. macOS denies
# Microphone to CLI tools launchd spawns (silent, no grantable entry), so a launchd/cron job
# records pure silence. Run this from a terminal/tmux that HAS Microphone + disk access (the same
# context your manual runs record from). It waits until each 00:00, then runs the resumable ~8 h
# sweep (which preflights the XD + level and bails cleanly if either is wrong). Ctrl-C to stop.
#
#   # start it so it survives closing the window (inherits this session's mic grant):
#   tmux new -d -s sweep 'bash /Users/ava/Developer/minilogue-viewer/scripts/sweep-nightly-loop.sh'
#   tmux attach -t sweep      # watch it        tmux kill-session -t sweep   # stop it
set -uo pipefail

REPO="/Users/ava/Developer/minilogue-viewer"
LOOPLOG="$REPO/training/.diversity-sweep.loop.log"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOOPLOG"; }

log "nightly loop started (pid $$) — runs the sweep at each 00:00"
while true; do
  target=$(date -v+1d -v0H -v0M -v0S +%s)           # next 00:00:00
  log "next run at $(date -r "$target" '+%F %T')"
  while :; do                                        # sleep in <=5-min chunks so it self-corrects
    rem=$(( target - $(date +%s) ))                  # across system sleep (re-reads the clock)
    [ "$rem" -le 0 ] && break
    [ "$rem" -gt 300 ] && rem=300
    sleep "$rem"
  done
  log "midnight — launching sweep"
  bash "$REPO/scripts/diversity-sweep.sh" || log "sweep exited non-zero (preflight bail / error)"
done
