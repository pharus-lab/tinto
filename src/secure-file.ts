import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

// Credentials are encrypted with the operating system credential service.
// Linux without a keyring would fall back to obfuscated plain text, so refuse.
async function keyStore(purpose: string) {
  if (!await safeStorage.isAsyncEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw Error('Unlock your system keychain or Linux keyring to ' + purpose + '.')
  }
}

export async function protect(path: string, value: string, purpose: string) {
  await keyStore(purpose)
  const bytes = await safeStorage.encryptStringAsync(value)
  const temporary = path + '.' + randomUUID()
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(temporary, bytes, { mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

export async function reveal(path: string, purpose: string): Promise<string> {
  await keyStore(purpose)
  return (await safeStorage.decryptStringAsync(await readFile(path))).result
}
