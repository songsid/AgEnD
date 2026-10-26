#!/bin/bash
# A fake wsl.exe for the installer flow test (tests/windows-installer-flow.test.ts; copied to PATH as wsl.exe). The "Linux" is one long-running
# container ($AGEND_FAKE_WSL_CONTAINER); registered distros are lines in $AGEND_FAKE_WSL_STATE/distros.
#   -d D -u U --exec cmd args…  → cmd with its argv as given (what --exec promises)
#   -d D -u U -- cmd args…      → the command line rebuilt as Windows passes it (an argument with spaces or quotes in
#                                 "…", as PowerShell quotes it) and parsed by the distro's shell — the mangling #2711/#2720
#                                 hit live
#   --list [--running] --quiet, --status, --version, --update, --terminate D, --shutdown, --install …, --set-default D
set -u
state=${AGEND_FAKE_WSL_STATE:?}; ctr=${AGEND_FAKE_WSL_CONTAINER:?}
echo "$*" >> "$state/calls.log"
# wsl.exe's own messages are UTF-16LE unless WSL_UTF8=1 (as the real one); the Linux side's output is passed as it is.
say() { if [ "${WSL_UTF8:-}" = 1 ]; then printf '%s\n' "$1"; else printf '%s\r\n' "$1" | iconv -f UTF-8 -t UTF-16LE; fi; }
distros() { [ -f "$state/distros" ] && while IFS= read -r d; do say "$d"; done < "$state/distros"; }
distro=; user=root; mode=
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--distribution) distro=$2; shift 2;;
    -u|--user) user=$2; shift 2;;
    --list|-l) shift; distros; exit 0;;
    --running|--quiet|-q|--verbose|-v) shift;;
    --status) say "Default Version: 2"; exit 0;;
    --version) say "WSL version: 2.4.12.0"; exit 0;;
    --update) say "The most recent version of Windows Subsystem for Linux is already installed."; exit 0;;
    --shutdown) exit 0;;
    --terminate|-t) exit 0;;
    --set-default|-s|--set-default-version|--set-version) exit 0;;
    --install)
      shift; name=Ubuntu-24.04
      while [ $# -gt 0 ]; do case "$1" in -d|--distribution|--name) name=$2; shift 2;; *) shift;; esac; done
      grep -qx "$name" "$state/distros" 2>/dev/null || echo "$name" >> "$state/distros"; say "Installing: $name"; exit 0;;
    --exec|-e) shift; mode=exec; break;;
    --) shift; break;;
    *) break;;
  esac
done
# Either way a command runs only in a registered Linux (an unregistered -d is refused, as the real wsl.exe does).
[ -n "$distro" ] && ! grep -qx "$distro" "$state/distros" 2>/dev/null && { say "There is no distribution with the supplied name." >&2; exit 1; }
[ $# -eq 0 ] && exit 0
[ "${mode:-}" = exec ] && exec docker exec -i -u "$user" -e WSL_DISTRO_NAME="$distro" "$ctr" "$@"
line=
for a in "$@"; do case "$a" in *[[:space:]\"]*) a=${a//\"/\\\"}; line="$line \"$a\"";; *) line="$line $a";; esac; done
exec docker exec -i -u "$user" -e WSL_DISTRO_NAME="$distro" "$ctr" bash -c "${line# }"
