#!/bin/sh
# Core shell entry point: native-shell.sh NODE GATEWAY [ARGS...] -- SHELL [ARGS...]
# Runs the recovery gateway with NODE. If NODE is gone (for example after a
# version manager removed it), starts the wrapped shell directly, so every new
# terminal still opens.
node=$1
shift
if [ -x "$node" ]; then exec "$node" "$@"; fi
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ $# -gt 0 ] && shift
if [ $# -eq 0 ]; then
  echo "herdr-resurrect: $node is missing and no shell follows --." >&2
  exit 1
fi
echo "herdr-resurrect: $node is missing; opening the shell without recovery." >&2
exec "$@"
