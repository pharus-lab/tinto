import { execFileSync } from 'node:child_process'
import { packager } from '@electron/packager'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import './build.mjs'

const project = JSON.parse(await readFile('package.json', 'utf8'))
const runtime = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8'))
const checksums = JSON.parse(await readFile('node_modules/electron/checksums.json', 'utf8'))
const staging = await mkdtemp(join(tmpdir(), 'tinto-package-'))
const [platform = process.platform, arch = process.arch] = process.argv.slice(2)
try {
  await cp('dist', join(staging, 'dist'), { recursive: true })
  await cp('LICENSE', join(staging, 'LICENSE'))
  await cp('NOTICE.md', join(staging, 'NOTICE.md'))
  const licenses = join(staging, 'licenses')
  await mkdir(licenses)
  // Pandoc is GPL-2.0-or-later; its full license travels with the app (see NOTICE.md).
  await cp('licenses/GPL-2.0.txt', join(licenses, 'GPL-2.0.txt'))
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
  // MIT asks for the copyright and permission notice; a package that ships no
  // license file gets one written from its package.json and the MIT text.
  const mit = (await readFile('LICENSE', 'utf8')).split('\n').slice(3).join('\n')
  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (!path || dependency.dev || !existsSync(path)) continue
    const name = path.replace(/node_modules\//g, '').replaceAll('/', '-')
    const files = (await readdir(path)).filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file))
    for (const file of files) await cp(join(path, file), join(licenses, name + '-' + file))
    const info = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))
    if (!files.length && /\bMIT\b/.test(info.license ?? '')) {
      const holder = typeof info.author === 'string' ? info.author.replace(/\s*<[^>]*>/, '') : info.author?.name ?? info.name + ' contributors'
      await writeFile(join(licenses, name + '-LICENSE'), info.name + ' ' + info.version + ' (license: ' + info.license + '). The package ships no license file; this notice is written from its package.json.\n\nMIT License\n\nCopyright (c) ' + holder + '\n' + mit)
    }
  }
  // Use the target binary's notices, including when cross-building after npm ci.
  async function includeRuntimeLicenses({ buildPath, platform }) {
    const runtimeRoot = resolve(buildPath, platform === 'darwin' || platform === 'mas' ? '../../../..' : '../..')
    await cp(join(runtimeRoot, 'LICENSE'), join(buildPath, 'licenses/electron-LICENSE'))
    await cp(join(runtimeRoot, 'LICENSES.chromium.html'), join(buildPath, 'licenses/chromium-LICENSES.html'))
  }
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: project.name, productName: 'Tinto', version: project.version, main: project.main, license: 'MIT' }))
  const osxSign = platform === 'darwin' ? {
    identity: '-', identityValidation: false, preAutoEntitlements: false, gatekeeperAssess: false, continueOnError: false,
    // A local ad-hoc identity has no Developer ID team for library validation.
    optionsForFile: () => ({ timestamp: 'none', hardenedRuntime: false })
  } : undefined
  const icon = platform === 'darwin' ? resolve('assets/Tinto.icns') : undefined
  const output = await packager({
    osxSign, icon, dir: staging, out: resolve(project.version.includes('-') ? 'out/development' : 'out'),
    name: 'Tinto', appBundleId: 'org.tinto.editor', electronVersion: runtime.version, platform, arch,
    download: { checksums }, afterCopy: [includeRuntimeLicenses],
    asar: { unpack: '**/{file-dialogs.mjs,pandoc.wasm,writing-worker.cjs}' }, overwrite: true, prune: false
  })
  if (platform === 'darwin') {
    const bundle = join(output[0], 'Tinto.app')
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', bundle])
    // File Provider adds FinderInfo to app bundles in a synced Documents
    // folder. Verify the distributable payload without machine metadata.
    const clean = join(staging, 'Tinto.app')
    execFileSync('/usr/bin/ditto', ['--norsrc', '--noextattr', bundle, clean])
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', clean])
  }
  console.log(output.join('\n'))
} finally {
  await rm(staging, { recursive: true, force: true })
}
