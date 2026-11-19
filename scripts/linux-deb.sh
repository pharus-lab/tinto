#!/bin/sh
# Build from the portable Electron folder produced by npm run package.
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in
  arm64) electron_arch=arm64; deb_arch=arm64 ;;
  x64|amd64) electron_arch=x64; deb_arch=amd64 ;;
  *) echo "Usage: sh scripts/linux-deb.sh arm64|amd64" >&2; exit 2 ;;
esac

portable="out/Tinto-linux-$electron_arch"
test -x "$portable/Tinto"
version=$(node -p "require('./package.json').version")
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
install -d "$stage/root/DEBIAN" "$stage/root/opt/tinto" "$stage/root/usr/bin" "$stage/root/usr/share/applications"
cp -a "$portable/." "$stage/root/opt/tinto/"
# The portable folder created by packager is private to its build user.
find "$stage/root/opt/tinto" -type d -exec chmod 0755 {} +
chmod 4755 "$stage/root/opt/tinto/chrome-sandbox"
ln -s /opt/tinto/Tinto "$stage/root/usr/bin/tinto"
cat > "$stage/root/usr/share/applications/tinto.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Tinto
GenericName=Writing Editor
Comment=Write locally with alternative wording and independent drafts
Exec=tinto
TryExec=tinto
Icon=accessories-text-editor
Terminal=false
Categories=Office;WordProcessor;
StartupWMClass=Tinto
DESKTOP

size=$(du -sk "$stage/root/opt/tinto" | cut -f1)
cat > "$stage/root/DEBIAN/control" <<CONTROL
Package: tinto
Version: $version
Architecture: $deb_arch
Section: editors
Priority: optional
Maintainer: Tinto contributors
Installed-Size: $size
Depends: libc6 (>= 2.28), libgtk-3-0t64 | libgtk-3-0, libasound2t64 | libasound2, libcups2t64 | libcups2, libnss3, libnspr4, libgbm1, libdrm2, libudev1, libxkbcommon0, libxcomposite1, libxdamage1, libxfixes3, libxrandr2, libsecret-1-0
Recommends: xdg-utils
Description: Local manuscript editor with nested alternative wording
 Keep alternate passages, linked sections and version history in a local
 project. English and Spanish spelling dictionaries are included.
CONTROL

export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0}
name="tinto_${version}_${deb_arch}.deb"
dpkg-deb --root-owner-group -Zxz -z1 --build "$stage/root" "$stage/$name"
mv "$stage/$name" "out/$name"
echo "out/$name"
