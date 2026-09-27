# shellcheck shell=bash
# PID-file helpers resistant to PID reuse. A bare `kill -0 $pid` answers "some
# process has this PID" — after a sleep/reboot the PID can belong to an
# unrelated process, and a watchdog trusting it would never relaunch its
# campaign. We record the process START TIME next to the PID and require both
# the start time and the expected command line to still match.

# Normalized start time of a live PID ("" when the PID does not exist).
pidfile__lstart() {
  ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'
}

# pidfile_write <file> <pid> — record pid + its start time.
pidfile_write() {
  printf '%s\t%s\n' "$2" "$(pidfile__lstart "$2")" > "$1"
}

# pidfile_alive <file> <command-substring> — true only if the recorded PID is
# alive, was started at the recorded time, and runs the expected command.
pidfile_alive() {
  local file="$1" expect="$2" pid lstart cmd
  [ -f "$file" ] || return 1
  IFS=$'\t' read -r pid lstart < "$file" || return 1
  [[ "$pid" =~ ^[0-9]+$ ]] && [ -n "$lstart" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ "$(pidfile__lstart "$pid")" = "$lstart" ] || return 1
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  case "$cmd" in *"$expect"*) return 0 ;; *) return 1 ;; esac
}
