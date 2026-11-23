#!/bin/sh
# Build from the portable Electron folder produced by npm run package.
set -eu
umask 022
cd "$(dirname "$0")/.."
case "${1:-}" in
  arm64) electron_arch=arm64; deb_arch=arm64; elf_machine=AArch64 ;;
  x64|amd64) electron_arch=x64; deb_arch=amd64; elf_machine='Advanced Micro Devices X86-64' ;;
  *) echo "Usage: sh scripts/linux-deb.sh arm64|amd64" >&2; exit 2 ;;
esac

version=$(node -p "require('./package.json').version")
deb_version=$(node -p "require('./package.json').version.replace('-', '~')")
output=out
case "$version" in *-*) output=out/development ;; esac
portable="$output/Tinto-linux-$electron_arch"
test -x "$portable/Tinto"
built_version=$(node --input-type=module -e "import { extractFile } from '@electron/asar'; console.log(JSON.parse(extractFile(process.argv[1], 'package.json')).version)" "$portable/resources/app.asar")
if [ "$built_version" != "$version" ]; then
  echo "Portable app is $built_version, expected $version. Run npm run package -- linux $electron_arch first." >&2
  exit 1
fi
built_machine=$(LC_ALL=C readelf -h "$portable/Tinto" | sed -n 's/^ *Machine: *//p')
if [ "$built_machine" != "$elf_machine" ]; then
  echo "Portable executable has ELF machine '$built_machine', expected '$elf_machine' for $deb_arch." >&2
  exit 1
fi
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
install -d "$stage/root/DEBIAN" "$stage/root/opt/tinto" "$stage/root/usr/bin" "$stage/root/usr/share/applications" "$stage/root/usr/share/icons/hicolor/scalable/apps" "$stage/root/usr/share/icons/hicolor/512x512/apps" "$stage/root/usr/share/doc/tinto"
cp -a "$portable/." "$stage/root/opt/tinto/"
# The portable folder created by packager is private to its build user.
find "$stage/root/opt/tinto" -type d -exec chmod 0755 {} +
find "$stage/root/opt/tinto" -type f -exec chmod go-w {} +
chmod 4755 "$stage/root/opt/tinto/chrome-sandbox"
ln -s /opt/tinto/Tinto "$stage/root/usr/bin/tinto"
install -m 0644 assets/Tinto.svg "$stage/root/usr/share/icons/hicolor/scalable/apps/tinto.svg"
install -m 0644 assets/Tinto.png "$stage/root/usr/share/icons/hicolor/512x512/apps/tinto.png"
install -m 0644 NOTICE.md "$stage/root/usr/share/doc/tinto/NOTICE.md"
install -m 0644 LICENSE "$stage/root/usr/share/doc/tinto/copyright"
cat > "$stage/root/usr/share/applications/tinto.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Tinto
GenericName=Writing Editor
Comment=Write locally with alternative wording and independent drafts
Exec=tinto
TryExec=tinto
Icon=tinto
Terminal=false
Categories=Office;WordProcessor;
StartupWMClass=tinto
DESKTOP

size=$(du -sk "$stage/root/opt/tinto" | cut -f1)
cat > "$stage/root/DEBIAN/control" <<CONTROL
Package: tinto
Version: $deb_version
Architecture: $deb_arch
Section: editors
Priority: optional
Maintainer: Tinto contributors
Homepage: https://github.com/pharus-lab/tinto
Installed-Size: $size
Depends: libc6 (>= 2.28), libgtk-3-0t64 | libgtk-3-0, libasound2t64 | libasound2, libcups2t64 | libcups2, libnss3, libnspr4, libgbm1, libdrm2, libudev1, libxkbcommon0, libxcomposite1, libxdamage1, libxfixes3, libxrandr2, libsecret-1-0
Recommends: xdg-utils
Description: Local manuscript editor with nested alternative wording
 Keep alternate passages, linked sections and version history in a local
 project. English and UK English spelling and grammar, and Spanish spelling,
 work offline with the bundled writing engines.
CONTROL

export SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0}
name="tinto_${deb_version}_${deb_arch}.deb"
dpkg-deb --root-owner-group -Zxz -z1 --build "$stage/root" "$stage/$name"
mv "$stage/$name" "$output/$name"
echo "$output/$name"
