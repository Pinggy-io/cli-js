#!/usr/bin/env bash
# Compiles node-pty's Linux addon on Debian 12, so the packaged binary's terminal loads on glibc 2.34
# and newer. npm ci compiles it with the machine's own compiler, and on Ubuntu 26.04 (ubuntu-latest)
# that pty.node needs GLIBC_2.42. Run it after npm ci, on the architecture the binary targets.
# Needs Docker. scripts/check_linux_addons.js explains the limits, and checks the SDK's files too.
set -euo pipefail

IMAGE="node:24-bookworm"

if [ "$(uname -s)" != "Linux" ]; then
    echo "build_node_pty_linux.sh: runs on Linux only. It compiles pty.node for this machine's architecture." >&2
    exit 1
fi

cd "$(dirname "$0")/.."

# The runner's user owns the result. npm and node-gyp write their caches, and the Node headers
# node-gyp downloads, under /tmp in the container.
docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp \
    --volume "$PWD:/work" \
    --workdir /work \
    "$IMAGE" \
    npm rebuild node-pty

node scripts/check_linux_addons.js "$(node -p process.arch)"
