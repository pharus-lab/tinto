#!/bin/sh
# Run in a fresh Playwright Ubuntu container with --init --network none.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
arch=$(dpkg --print-architecture)
dpkg -i "out/tinto_${version}_${arch}.deb"
test "$(stat -c '%U:%G %a' /opt/tinto/chrome-sandbox)" = 'root:root 4755'
grep -Fxq 'Exec=tinto' /usr/share/applications/tinto.desktop
test "$(command -v tinto)" = /usr/bin/tinto
runuser -u pwuser -- env TINTO_PACKAGED_EXECUTABLE=/usr/bin/tinto xvfb-run -a node --test --test-concurrency=1 tests/desktop.test.mjs tests/exchange.test.mjs tests/navigation.test.mjs
