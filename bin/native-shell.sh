#!/bin/sh
# Entry point for the core shell and the recorder service:
#   native-shell.sh NODE PROGRAM [ARGS...] [-- SHELL [ARGS...]]
# NODE "auto" runs the user's current global Node: mise's choice for the home
# directory, else the first node on PATH. A toolchain upgrade then cannot
# strand the installation on a removed version. If no Node is found, starts the
# wrapped shell directly, so every new terminal still opens.
node=$1
shift
if [ "$node" = auto ]; then
  node=
  if command -v mise >/dev/null 2>&1; then
    node=$(cd "${HOME:-/}" 2>/dev/null && mise which node 2>/dev/null) || node=
  fi
  [ -x "$node" ] || node=$(command -v node 2>/dev/null) || node=
  [ -n "$node" ] || node="Node"
fi
if [ -x "$node" ]; then exec "$node" "$@"; fi
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ $# -gt 0 ] && shift
if [ $# -eq 0 ]; then
  echo "herdr-resurrect: $node is missing and no shell follows --." >&2
  exit 1
fi
echo "herdr-resurrect: $node is missing; opening the shell without recovery." >&2
exec "$@"
