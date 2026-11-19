import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import './dictionaries.mjs'

await mkdir('dist', { recursive: true })
await Promise.all([
  build({ entryPoints: ['src/main.ts', 'src/preload.ts'], outdir: 'dist', bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['electron'], target: 'node22' }),
  build({ entryPoints: ['src/app.ts'], outfile: 'dist/app.js', bundle: true, platform: 'browser', target: 'es2022' }),
  copyFile('node_modules/pdfjs-dist/build/pdf.min.mjs', 'dist/pdf.mjs'),
  copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/pdf.worker.mjs'),
  ...['index.html', 'styles.css', 'spelling.css', 'draft.css'].map(file => copyFile('src/' + file, 'dist/' + file)),
])
