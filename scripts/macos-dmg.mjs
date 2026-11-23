// Package the already-built, verified macOS app in a drag-to-Applications image.
// The image opens to an arranged window: Tinto, an arrow to Applications, and how
// to install or upgrade (assets/dmg-background.html is the source of its background).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
if (process.platform !== 'darwin') throw Error('Create the macOS installer on macOS.')
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Set a final three-part release version before creating its installer.')
const app = resolve('out/Tinto-darwin-arm64/Tinto.app')
const plist = join(app, 'Contents/Info.plist')
if (!existsSync(plist)) throw Error('Run npm run package -- darwin arm64 first.')
const builtVersion = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()
if (builtVersion !== version) throw Error('The app version does not match package.json. Rebuild the app first.')
const architectures = execFileSync('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS/Tinto')], { encoding: 'utf8' }).trim()
if (architectures !== 'arm64') throw Error('This release installer requires the Apple silicon app.')

const release = resolve('out/release', version)
await mkdir(release, { recursive: true })
const name = 'Tinto-' + version + '-mac-arm64.dmg'
if (existsSync(join(release, name))) throw Error('This installer already exists. Keep its evidence/checksums and choose a new release version instead of overwriting it.')
const staging = await mkdtemp(join(tmpdir(), 'tinto-installer-'))
async function sha256(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
try {
  const payload = join(staging, 'payload')
  await mkdir(payload)
  execFileSync('/usr/bin/ditto', ['--norsrc', '--noextattr', app, join(payload, 'Tinto.app')])
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(payload, 'Tinto.app')])
  await symlink('/Applications', join(payload, 'Applications'))
  await writeFile(join(payload, 'Install Tinto.txt'), [
    'Tinto ' + version + ' for macOS on Apple silicon', '',
    'Quit Tinto, then drag Tinto.app into Applications. If you already have Tinto, choose Replace.',
    'Your manuscripts and preferences are stored separately from the application.',
    'Eject this disk image and open Tinto from Applications.', '',
    'This build is ad-hoc signed and is not notarized by Apple. If macOS prevents the first launch,',
    'open System Settings > Privacy & Security and choose Open Anyway for Tinto.', '',
    'English and UK English spelling/grammar and Spanish spelling are included and run offline.',
    'Both automatic checking switches start off. Use Check writing to check a document on demand.', '',
    'https://github.com/pharus-lab/tinto', ''
  ].join('\n'))
  await mkdir(join(payload, '.background'))
  await copyFile('assets/dmg-background.tiff', join(payload, '.background', 'background.tiff'))

  // Keep the same Pandoc source archive alongside every release (see NOTICE.md).
  const sourceName = 'pandoc-3.10.tar.gz'
  const sourceHash = '9c6af03b81a6f6d4669a21635ed31888759a81b999c64856601730c2ea4ad304'
  let source = resolve('out/release', sourceName)
  if (!existsSync(source)) {
    source = join(staging, sourceName)
    const response = await fetch('https://hackage.haskell.org/package/pandoc-3.10/pandoc-3.10.tar.gz')
    if (!response.ok) throw Error('Could not download the corresponding Pandoc source: ' + response.status)
    await writeFile(source, new Uint8Array(await response.arrayBuffer()))
  }
  if (await sha256(source) !== sourceHash) throw Error('The Pandoc source archive does not match the verified release checksum.')

  // A writable image first, so Finder can save the window's layout in it.
  const writable = join(staging, 'layout.dmg')
  execFileSync('/usr/bin/hdiutil', ['create', '-srcfolder', payload, '-volname', 'Tinto ' + version, '-fs', 'HFS+', '-format', 'UDRW', writable], { stdio: 'inherit' })
  const attached = execFileSync('/usr/bin/hdiutil', ['attach', writable, '-readwrite', '-noverify', '-noautoopen'], { encoding: 'utf8' })
  const mount = attached.trim().split('\n').pop().split('\t').pop().trim()
  try {
    arrangeWindow(mount)
    if (!existsSync(join(mount, '.DS_Store'))) throw Error('Finder did not save the installer window. Allow Terminal to control Finder and run npm run dmg again.')
  } finally {
    execFileSync('/usr/bin/hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' })
  }
  const image = join(staging, name)
  execFileSync('/usr/bin/hdiutil', ['convert', writable, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', image], { stdio: 'inherit' })
  execFileSync('/usr/bin/hdiutil', ['verify', image], { stdio: 'inherit' })
  const imageHash = await sha256(image)
  await copyFile(source, join(release, sourceName))
  await rename(image, join(release, name))
  await writeFile(join(release, 'SHA256SUMS.txt'), imageHash + '  ' + name + '\n' + sourceHash + '  ' + sourceName + '\n')
  console.log(join(release, name))
  console.log('SHA-256: ' + imageHash)
} finally {
  await rm(staging, { recursive: true, force: true })
}

// Finder keeps an icon window's layout in the image's .DS_Store: icon view,
// a fixed size, the background, and where each item sits. Hiding the toolbar
// is not allowed by every Finder version, so it is attempted only.
function arrangeWindow(mount) {
  const script = `on run argv
  set mountPath to item 1 of argv
  tell application "Finder"
    set theDisk to (POSIX file mountPath as alias)
    open theDisk
    delay 2
    set win to container window of theDisk
    set current view of win to icon view
    try
      set toolbar visible of win to false
    end try
    try
      set statusbar visible of win to false
    end try
    set bounds of win to {200, 120, 860, 648}
    set opts to icon view options of win
    set arrangement of opts to not arranged
    set icon size of opts to 104
    set text size of opts to 13
    set background picture of opts to (POSIX file (mountPath & "/.background/background.tiff") as alias)
    set position of item "Tinto.app" of theDisk to {170, 150}
    set position of item "Applications" of theDisk to {490, 150}
    set position of item "Install Tinto.txt" of theDisk to {330, 410}
    update theDisk without registering applications
    delay 2
    close win
  end tell
end run`
  execFileSync('/usr/bin/osascript', ['-', mount], { input: script, stdio: ['pipe', 'inherit', 'inherit'] })
}
