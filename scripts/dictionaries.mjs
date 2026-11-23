import { copyFile, mkdir, rm } from 'node:fs/promises'

const destination = new URL('../dist/dictionaries/', import.meta.url)
await mkdir(destination, { recursive: true })
// Do not carry retired dictionary assets into a development package.
await Promise.all(['en.aff', 'en.dic', 'en-license.txt', 'fr.aff', 'fr.dic', 'fr-license.txt'].map(file => rm(new URL(file, destination), { force: true })))

// Spanish documents use the Spanish (Mexico) dictionary; its files keep the
// es.* names the writing worker reads.
for (const [language, dictionary] of [['es', 'dictionary-es-mx']]) {
  const source = new URL('.', import.meta.resolve(dictionary))
  await Promise.all(['aff', 'dic'].map(extension =>
    copyFile(new URL('index.' + extension, source), new URL(language + '.' + extension, destination))
  ))
  await copyFile(new URL('license', source), new URL(language + '-license.txt', destination))
}
