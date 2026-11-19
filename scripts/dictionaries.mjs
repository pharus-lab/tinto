import { copyFile, mkdir } from 'node:fs/promises'

const destination = new URL('../dist/dictionaries/', import.meta.url)
await mkdir(destination, { recursive: true })

for (const language of ['en', 'es']) {
  const source = new URL('.', import.meta.resolve('dictionary-' + language))
  await Promise.all(['aff', 'dic'].map(extension =>
    copyFile(new URL('index.' + extension, source), new URL(language + '.' + extension, destination))
  ))
  await copyFile(new URL('license', source), new URL(language + '-license.txt', destination))
}
