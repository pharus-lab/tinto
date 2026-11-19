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
  const output = await packager({ dir: staging, out: resolve('out'), name: 'Tinto', appBundleId: 'org.tinto.editor', electronVersion: runtime.version, platform, arch, asar: true, overwrite: true, prune: false })
  console.log(output.join('\n'))
} finally {
  await rm(staging, { recursive: true, force: true })
}
