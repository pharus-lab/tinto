import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import '../scripts/build.mjs'

const bundle = await build({ entryPoints: ['src/writing-service.ts'], platform: 'node', format: 'esm', bundle: true, write: false })
export const { WritingService } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
export function writingService(t) {
  const service = new WritingService(fileURLToPath(new URL('../dist', import.meta.url)))
  t.after(() => service.stop())
  return service
}
