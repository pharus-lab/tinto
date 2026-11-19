import { execFileSync } from 'node:child_process'
import { packager } from '@electron/packager'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import './build.mjs'

const project = JSON.parse(await readFile('package.json', 'utf8'))
const runtime = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8'))
const staging = await mkdtemp(join(tmpdir(), 'tinto-package-'))
const [platform = process.platform, arch = process.arch] = process.argv.slice(2)
try {
  await cp('dist', join(staging, 'dist'), { recursive: true })
  await cp('LICENSE', join(staging, 'LICENSE'))
  const licenses = join(staging, 'licenses')
  await mkdir(licenses)
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
  for (const [path, dependency] of Object.entries(lock.packages)) {
    if (!path || dependency.dev || !existsSync(path)) continue
    const files = await readdir(path)
    for (const file of files.filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file))) {
      await cp(join(path, file), join(licenses, path.replace(/node_modules\//g, '').replaceAll('/', '-') + '-' + file))
    }
  }
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: project.name, productName: 'Tinto', version: project.version, main: project.main, license: 'MIT' }))
  const osxSign = platform === 'darwin' ? {
    identity: '-', identityValidation: false, preAutoEntitlements: false, gatekeeperAssess: false, continueOnError: false,
    // A local ad-hoc identity has no Developer ID team for library validation.
    optionsForFile: () => ({ timestamp: 'none', hardenedRuntime: false })
  } : undefined
  const output = await packager({ osxSign, dir: staging, out: resolve('out'), name: 'Tinto', appBundleId: 'org.tinto.editor', electronVersion: runtime.version, platform, arch, asar: true, overwrite: true, prune: false })
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
