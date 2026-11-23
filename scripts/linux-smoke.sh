#!/bin/sh
# Run as the signed-in desktop user after installing the matching .deb.
set -eu
cd "$(dirname "$0")/.."
deb_version=$(node -p "require('./package.json').version.replace('-', '~')")
if [ "$(id -u)" = 0 ]; then
  echo 'Run this check as your normal Linux desktop user after installing Tinto with sudo apt install.' >&2
  exit 2
fi
test "$(dpkg-query -W -f='${Version}' tinto)" = "$deb_version"
test "$(stat -c '%U:%G %a' /opt/tinto/chrome-sandbox)" = 'root:root 4755'
grep -Fxq 'Exec=tinto' /usr/share/applications/tinto.desktop
grep -Fxq 'Icon=tinto' /usr/share/applications/tinto.desktop
test -s /usr/share/icons/hicolor/scalable/apps/tinto.svg
test "$(command -v tinto)" = /usr/bin/tinto
TINTO_PACKAGED_EXECUTABLE=/usr/bin/tinto node --test --test-concurrency=1 tests/desktop.test.mjs tests/exchange.test.mjs tests/navigation.test.mjs tests/writing-desktop.test.mjs tests/typography.test.mjs tests/authorship.test.mjs tests/publish.test.mjs tests/site-guide.test.mjs
