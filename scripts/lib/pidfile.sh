# shellcheck shell=bash
# PID-file helpers resistant to PID reuse. A bare `kill -0 $pid` answers "some
# process has this PID" — after a sleep/reboot the PID can belong to an
# unrelated process, and a watchdog trusting it would never relaunch its
# campaign. We record the process START TIME next to the PID and require both
# the start time and the expected command line to still match.

# Start time of a live PID ("" when it does not exist). On Linux the kernel's
# starttime (jiffies since boot, /proc/<pid>/stat field 22) — immune to clock
# steps, unlike `ps lstart` (boot time + offset). Elsewhere (macOS) `ps lstart`.
pidfile__start() {
  if [ -r "/proc/$1/stat" ]; then
    # Drop "pid (comm) " first: comm may contain spaces; field 22 is then $20.
    sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'
  else
    ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'
  fi
}

# pidfile_write <file> <pid> — record pid + its start time.
pidfile_write() {
  printf '%s\t%s\n' "$2" "$(pidfile__start "$2")" > "$1"
}

# pidfile_alive <file> <command-substring> — true only if the recorded PID is
# alive, runs the expected command and (when recorded) started at the recorded
# time. A legacy bare-PID file (no start time) is judged on liveness + command
# line only, so upgrading the watchdog mid-campaign never launches a duplicate.
pidfile_alive() {
  local file="$1" expect="$2" pid start cmd
  [ -f "$file" ] || return 1
  IFS=$'\t' read -r pid start < "$file" || [ -n "$pid" ] || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -n "$start" ] && [ "$(pidfile__start "$pid")" != "$start" ]; then return 1; fi
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  case "$cmd" in *"$expect"*) return 0 ;; *) return 1 ;; esac
}
