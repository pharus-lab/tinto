import { didFromPublicKey } from '../modules/cloudflare/credential.mjs'

// A real Ed25519 author key, as Tinto keeps one per installation.
export async function newAuthor(name = 'Ana Escritora') {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const did = didFromPublicKey(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  return { name, did, key: pair.privateKey }
}
