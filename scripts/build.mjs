import { build } from 'esbuild'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import './dictionaries.mjs'

await mkdir('dist', { recursive: true })
// Tinto writes this folder into a website from Settings → Websites → ?. Test
// processes build in parallel, so files are overwritten in place, never removed first.
await mkdir('dist/cloudflare-module', { recursive: true })
const moduleFiles = await readdir('modules/cloudflare')
for (const file of await readdir('dist/cloudflare-module')) {
  if (!moduleFiles.includes(file)) await rm('dist/cloudflare-module/' + file, { force: true })
}
await Promise.all([
  build({ entryPoints: ['src/main.ts', 'src/preload.ts'], outdir: 'dist', bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['electron', 'pandoc-wasm'], target: 'node22' }),
  build({ entryPoints: ['src/file-dialogs.ts'], outfile: 'dist/file-dialogs.mjs', bundle: true, platform: 'node', format: 'esm', external: ['electron'], target: 'node22' }),
  copyFile('node_modules/pandoc-wasm/src/pandoc.wasm', 'dist/pandoc.wasm'),
  build({ entryPoints: ['src/app.ts'], outfile: 'dist/app.js', bundle: true, platform: 'browser', target: 'es2022' }),
  copyFile('node_modules/pdfjs-dist/build/pdf.min.mjs', 'dist/pdf.mjs'),
  copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.mjs'),
  ...['index.html', 'styles.css', 'spelling.css', 'draft.css'].map(file => copyFile('src/' + file, 'dist/' + file)),
  ...moduleFiles.map(file => copyFile('modules/cloudflare/' + file, 'dist/cloudflare-module/' + file)),
])
