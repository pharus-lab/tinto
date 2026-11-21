import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { didFromPublicKey } from '../modules/cloudflare/credential.mjs'
import { protect, reveal } from './secure-file'

// The writer's author identity: an Ed25519 key that signs every post, named as
// a did:key so any Verifiable Credentials tool can check the signature. The
// private key stays in the operating system keychain, or in an export file
// encrypted with a passphrase the writer chooses.
export interface AuthorSummary { name: string; did: string }
export interface AuthorSigner extends AuthorSummary { key: CryptoKey }
interface StoredAuthor { name: string; did: string; privateKey: string }

const purpose = 'sign your posts as their author'
const EXPORT_KIND = 'tinto-author-key'
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 }
const MIN_PASSPHRASE = 12

export function checkName(value: unknown): string {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw Error('Enter your name as an author, up to 100 characters.')
  return name
}
function checkPassphrase(value: unknown): string {
  const passphrase = String(value ?? '')
  if ([...passphrase].length < MIN_PASSPHRASE) throw Error('Use a passphrase of at least ' + MIN_PASSPHRASE + ' characters.')
  return passphrase
}
const derive = (passphrase: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) =>
  scrypt(passphrase.normalize('NFC'), salt, 32, { ...SCRYPT, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)))

async function publicDid(privateKey: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  return didFromPublicKey(new Uint8Array(Buffer.from(String(jwk.x), 'base64url')))
}
async function importPrivate(pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', Buffer.from(pkcs8, 'base64'), { name: 'Ed25519' }, true, ['sign'])
}

export class AuthorKeys {
  private cached: StoredAuthor | null | undefined
  constructor(private readonly file: string) {}

  private async stored(): Promise<StoredAuthor | null> {
    if (this.cached !== undefined) return this.cached
    this.cached = existsSync(this.file) ? JSON.parse(await reveal(this.file, purpose)) as StoredAuthor : null
    return this.cached
  }
  private async keep(author: StoredAuthor) {
    await protect(this.file, JSON.stringify(author), purpose)
    this.cached = author
  }

  async summary(): Promise<AuthorSummary | null> {
    const author = await this.stored()
    return author && { name: author.name, did: author.did }
  }

  async create(name: unknown): Promise<AuthorSummary> {
    if (await this.stored()) throw Error('This computer already has an author key.')
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const author = { name: checkName(name), did: didFromPublicKey(raw), privateKey: pkcs8 }
    await this.keep(author)
    return { name: author.name, did: author.did }
  }

  async rename(name: unknown): Promise<AuthorSummary> {
    const author = await this.stored()
    if (!author) throw Error('Create your author key first.')
    await this.keep({ ...author, name: checkName(name) })
    return { name: checkName(name), did: author.did }
  }

  async signer(): Promise<AuthorSigner | null> {
    const author = await this.stored()
    return author && { name: author.name, did: author.did, key: await importPrivate(author.privateKey) }
  }

  // scrypt and AES-256-GCM, bound to the key's did so a file cannot be relabelled.
  async exportKey(passphrase: unknown): Promise<Uint8Array> {
    const author = await this.stored()
    if (!author) throw Error('Create your author key first.')
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', await derive(checkPassphrase(passphrase), salt), iv)
    cipher.setAAD(Buffer.from(EXPORT_KIND + '\n' + author.did))
    const data = Buffer.concat([cipher.update(JSON.stringify({ name: author.name, privateKey: author.privateKey })), cipher.final()])
    const file = {
      kind: EXPORT_KIND, version: 1, did: author.did, name: author.name,
      kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
      data: data.toString('base64')
    }
    return new TextEncoder().encode(JSON.stringify(file, null, 2))
  }

  // Reads an export without keeping it, so the writer can confirm a replacement first.
  async readExport(bytes: Uint8Array, passphrase: unknown): Promise<StoredAuthor> {
    let file: any
    try { file = JSON.parse(new TextDecoder().decode(bytes)) } catch { file = null }
    if (file?.kind !== EXPORT_KIND || file.version !== 1 || file.kdf?.name !== 'scrypt' || file.cipher?.name !== 'aes-256-gcm') {
      throw Error('This is not a Tinto author key file.')
    }
    const { N, r, p } = file.kdf
    if (N !== SCRYPT.N || r !== SCRYPT.r || p !== SCRYPT.p) throw Error('This author key file needs a newer version of Tinto.')
    let secret: { name: string; privateKey: string }
    try {
      const decipher = createDecipheriv('aes-256-gcm', await derive(checkPassphrase(passphrase), Buffer.from(file.kdf.salt, 'base64')), Buffer.from(file.cipher.iv, 'base64'))
      decipher.setAAD(Buffer.from(EXPORT_KIND + '\n' + String(file.did)))
      decipher.setAuthTag(Buffer.from(file.cipher.tag, 'base64'))
      secret = JSON.parse(Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString())
    } catch (error) {
      if (error instanceof Error && /passphrase of at least/.test(error.message)) throw error
      throw Error('The passphrase does not open this author key file.')
    }
    const key = await importPrivate(secret.privateKey)
    const did = await publicDid(key)
    if (did !== file.did) throw Error('This author key file is damaged.')
    return { name: checkName(secret.name), did, privateKey: secret.privateKey }
  }

  async adopt(author: StoredAuthor): Promise<AuthorSummary> {
    await this.keep(author)
    return { name: author.name, did: author.did }
  }
}
