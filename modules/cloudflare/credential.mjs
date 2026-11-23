// Tinto blog module for Cloudflare — authorship credentials.
// A post carries a W3C Verifiable Credential 2.0 secured with the Data Integrity
// cryptosuite eddsa-jcs-2022 (Ed25519 over JSON Canonicalization, RFC 8785).
// The author is a did:key. Tinto signs with this file and the module verifies
// with it; both use only Web Crypto, so it runs in Node and in Workers.

export const CREDENTIAL_CONTEXT = 'https://www.w3.org/ns/credentials/v2'
export const CREDENTIAL_TYPE = 'AuthorshipCredential'
// IPTC digital source types, the vocabulary C2PA and schema.org also use.
const IPTC = 'http://cv.iptc.org/newscodes/digitalsourcetype/'
export const SOURCE_TYPES = {
  written: IPTC + 'digitalCreation',
  ai: IPTC + 'trainedAlgorithmicMedia',
  composite: IPTC + 'composite',
  compositeWithAI: IPTC + 'compositeWithTrainedAlgorithmicMedia'
}
export const ORIGINS = /** @type {const} */ (['written', 'pasted', 'imported', 'ai'])

/**
 * @typedef {{ written: number, pasted: number, imported: number, ai: number }} Characters
 * @typedef {{ position: number, origin: 'written' | 'pasted' | 'imported' | 'ai' | 'mixed', digitalSourceType: string | null }} PartOrigin
 * @typedef {{
 *   verified: true, author: { id: string, name: string }, original: boolean, ai: boolean,
 *   digitalSourceType: string | null, parts: PartOrigin[], signed: string,
 *   characters?: Characters, process?: WritingSummary | null, sha256?: string,
 *   translation: { from: string, by: string, edited: boolean, url?: string } | null
 * }} Authorship
 * @typedef {{ typed: number, deleted: number, pasted: number, imported: number, generated: number, activeMinutes: number, sessions: number }} WritingSummary
 */

/**
 * Written text is a digital creation. Pasted and imported text came from
 * somewhere Tinto did not see, so on its own it makes no claim.
 * @param {Characters} characters @returns {string | null}
 */
export function sourceTypeOf({ written, pasted, imported, ai }) {
  if (ai) return written || pasted || imported ? SOURCE_TYPES.compositeWithAI : SOURCE_TYPES.ai
  if (pasted || imported) return written ? SOURCE_TYPES.composite : null
  return written ? SOURCE_TYPES.written : null
}
/** @param {Characters} characters @returns {PartOrigin['origin']} */
export function originOf(characters) {
  const present = ORIGINS.filter(origin => characters[origin] > 0)
  return present.length > 1 ? 'mixed' : present[0] ?? 'written'
}
/** The paragraphs and headings of a post body, in order. @param {string} html @returns {string[]} */
export const postBlocks = html => html.match(/<(p|h[1-6])>[\s\S]*?<\/\1>/g) ?? []

/** JSON Canonicalization Scheme (RFC 8785). @param {unknown} value @returns {string} */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw Error('A credential cannot contain ' + value + '.')
    if (value === undefined) throw Error('A credential cannot contain undefined.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(item => canonicalize(item ?? null)).join(',') + ']'
  const record = /** @type {Record<string, unknown>} */ (value)
  // Keys sort by UTF-16 code units, as JavaScript's default sort does.
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalize(record[key])).join(',') + '}'
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** @param {Uint8Array} bytes */
export function base58btc(bytes) {
  let number = 0n
  for (const byte of bytes) number = number * 256n + BigInt(byte)
  let text = ''
  while (number > 0n) { text = ALPHABET[Number(number % 58n)] + text; number /= 58n }
  for (const byte of bytes) { if (byte !== 0) break; text = '1' + text }
  return text
}
/** @param {string} text */
export function fromBase58btc(text) {
  let number = 0n
  for (const char of text) {
    const digit = ALPHABET.indexOf(char)
    if (digit < 0) throw Error('Not base58btc.')
    number = number * 58n + BigInt(digit)
  }
  const bytes = []
  while (number > 0n) { bytes.unshift(Number(number % 256n)); number /= 256n }
  for (const char of text) { if (char !== '1') break; bytes.unshift(0) }
  return new Uint8Array(bytes)
}

// did:key for Ed25519: multicodec 0xed01 followed by the 32-byte public key.
/** @param {Uint8Array} publicKey */
export const didFromPublicKey = publicKey => 'did:key:z' + base58btc(new Uint8Array([0xed, 0x01, ...publicKey]))
/** @param {string} did */
export function publicKeyFromDid(did) {
  const match = /^did:key:z([1-9A-HJ-NP-Za-km-z]{40,60})$/.exec(did)
  const bytes = match ? fromBase58btc(match[1]) : null
  if (!bytes || bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw Error('The author is not an Ed25519 did:key.')
  return bytes.subarray(2)
}

const sha256 = async (/** @type {string} */ text) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
/** @param {Uint8Array} bytes */
export const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
export const digest = async (/** @type {string} */ text) => hex(await sha256(text))
/** @param {Record<string, unknown>} proofConfig @param {Record<string, unknown>} document */
async function hashData(proofConfig, document) {
  const [config, data] = await Promise.all([sha256(canonicalize(proofConfig)), sha256(canonicalize(document))])
  return new Uint8Array([...config, ...data])
}

/**
 * Secures a credential with an eddsa-jcs-2022 proof.
 * @param {Record<string, unknown>} unsecured @param {CryptoKey} privateKey @param {string} did @param {string} [created]
 */
export async function signCredential(unsecured, privateKey, did, created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
  /** @type {Record<string, unknown>} */
  const proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created, verificationMethod: did + '#' + did.slice('did:key:'.length), proofPurpose: 'assertionMethod' }
  if (unsecured['@context']) proof['@context'] = unsecured['@context']
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, await hashData(proof, unsecured)))
  return { ...unsecured, proof: { ...proof, proofValue: 'z' + base58btc(signature) } }
}

/**
 * Verifies an eddsa-jcs-2022 credential issued by a did:key.
 * @param {any} credential @returns {Promise<{ verified: boolean, did: string | null, reason?: string }>}
 */
export async function verifyCredential(credential) {
  const failed = (/** @type {string} */ reason) => ({ verified: false, did: null, reason })
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return failed('The credential is not an object.')
  const { proof, ...unsecured } = credential
  if (!proof || proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022' || proof.proofPurpose !== 'assertionMethod') return failed('The credential has no eddsa-jcs-2022 proof.')
  // An Ed25519 signature is 64 bytes, about 88 base58 characters.
  if (typeof proof.proofValue !== 'string' || !/^z[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(proof.proofValue)) return failed('The proof value is not a base58btc signature.')
  const { proofValue, ...options } = proof
  if (options['@context']) {
    const own = [credential['@context']].flat()
    if (![options['@context']].flat().every((/** @type {unknown} */ item, /** @type {number} */ index) => own[index] === item)) return failed('The proof context does not match the credential.')
    unsecured['@context'] = options['@context']
  }
  const did = String(options.verificationMethod ?? '').split('#')[0]
  const issuer = typeof credential.issuer === 'string' ? credential.issuer : credential.issuer?.id
  if (!did || did !== issuer) return failed('The proof is not signed by the credential issuer.')
  try {
    const key = await crypto.subtle.importKey('raw', publicKeyFromDid(did), { name: 'Ed25519' }, false, ['verify'])
    const verified = await crypto.subtle.verify('Ed25519', key, fromBase58btc(proofValue.slice(1)), await hashData(options, unsecured))
    return verified ? { verified, did } : failed('The signature does not match the credential.')
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'The credential could not be verified.')
  }
}

const isCount = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
/** @param {any} value @returns {Characters | null} */
function characters(value) {
  return value && ORIGINS.every(origin => isCount(value[origin])) ? { written: value.written, pasted: value.pasted, imported: value.imported, ai: value.ai } : null
}

/**
 * Checks that a verified credential describes exactly this post: its id,
 * title, language, the hash of the body and of each paragraph, and its files.
 * Returns what a page can show about who wrote it and how.
 * @param {any} credential @param {{ title: string, language: string, html: string }} post
 * @param {string} id @param {string[]} files @returns {Promise<Authorship>}
 */
export async function describePost(credential, post, id, files) {
  const subject = credential?.credentialSubject
  const issuer = typeof credential?.issuer === 'string' ? credential.issuer : credential?.issuer?.id
  const fail = (/** @type {string} */ what) => { throw Error('The authorship credential does not match this post: ' + what + '.') }
  if (![credential?.type].flat().includes(CREDENTIAL_TYPE) || !subject || typeof subject !== 'object') fail('it is not an authorship credential')
  if (subject.id !== 'urn:uuid:' + id) fail('it is for another post')
  if (subject.author?.id !== issuer) fail('its author is not its signer')
  if (subject.name !== post.title || subject.inLanguage !== post.language) fail('the title or language differs')
  if (subject.sha256 !== await digest(post.html)) fail('the text differs')
  const blocks = postBlocks(post.html)
  const parts = Array.isArray(subject.hasPart) ? subject.hasPart : []
  if (parts.length !== blocks.length) fail('the paragraphs differ')
  /** @type {PartOrigin[]} */
  const origins = []
  for (const [index, part] of parts.entries()) {
    const counted = characters(part?.characters)
    if (part?.position !== index + 1 || !counted || part.sha256 !== await digest(blocks[index])) fail('paragraph ' + (index + 1) + ' differs')
    origins.push({ position: index + 1, origin: originOf(/** @type {Characters} */ (counted)), digitalSourceType: sourceTypeOf(/** @type {Characters} */ (counted)) })
  }
  const media = (Array.isArray(subject.associatedMedia) ? subject.associatedMedia : []).map((/** @type {any} */ item) => String(item?.identifier ?? ''))
  if (media.length !== files.length || [...files].sort().join() !== [...media].sort().join()) fail('the files differ')
  const total = characters(subject.characters)
  if (!total) fail('the character counts are missing')
  return {
    verified: true,
    author: { id: issuer, name: typeof subject.author.name === 'string' ? subject.author.name.slice(0, 100) : '' },
    original: origins.every(part => part.origin === 'written'),
    ai: origins.some(part => part.origin === 'ai' || (part.origin === 'mixed' && part.digitalSourceType === SOURCE_TYPES.compositeWithAI)),
    digitalSourceType: sourceTypeOf(/** @type {Characters} */ (total)),
    parts: origins,
    signed: String(credential.proof?.created ?? ''),
    // What a reader can check: the counts of each origin, the measured writing
    // (counts and timing only) and the fingerprint of the text.
    characters: total,
    process: writingSummary(subject.writingProcess),
    sha256: typeof subject.sha256 === 'string' ? subject.sha256 : '',
    // An automatic translation says from which language, by which model, and
    // whether its author changed any of the generated words.
    translation: subject.translationOfWork && typeof subject.translationOfWork === 'object' ? {
      from: String(subject.translationOfWork.inLanguage ?? '').slice(0, 20),
      by: String(subject.translator?.name ?? '').slice(0, 80),
      edited: Number(total.written) > 0,
      url: typeof subject.translationOfWork.url === 'string' ? subject.translationOfWork.url.slice(0, 300) : ''
    } : null
  }
}
/** @param {any} process */
function writingSummary(process) {
  if (!process || typeof process !== 'object') return null
  const count = (/** @type {unknown} */ value) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
  return {
    typed: count(process.typedCharacters), deleted: count(process.deletedCharacters), pasted: count(process.pastedCharacters),
    imported: count(process.importedCharacters), generated: count(process.generatedCharacters),
    activeMinutes: count(process.activeMinutes), sessions: count(process.sessions)
  }
}

const LABELS = {
  en: { author: 'its author', ai: 'AI-generated · published by ', withAI: ['Written by ', ' · includes AI-generated text'], original: 'Original · written by ', other: ['Written by ', ' · includes text from other sources'],
    translation: 'Automatic translation', from: ' from ', reviewed: ' · reviewed by ', published: ' · published by ', languages: { en: 'English', es: 'Spanish' } },
  es: { author: 'su autor', ai: 'Generado con IA · publicado por ', withAI: ['Escrito por ', ' · incluye texto generado con IA'], original: 'Original · escrito por ', other: ['Escrito por ', ' · incluye texto de otras fuentes'],
    translation: 'Traducción automática', from: ' del ', reviewed: ' · revisada por ', published: ' · publicada por ', languages: { en: 'inglés', es: 'español' } }
}
/**
 * A short, quiet line for a post page, in English or Spanish (by language
 * code, such as es-MX). AI-generated text is always named.
 * @param {Authorship | null | undefined} authorship @param {string} [language]
 */
export function authorshipLabel(authorship, language = 'en') {
  if (!authorship?.verified) return ''
  const text = String(language).toLowerCase().startsWith('es') ? LABELS.es : LABELS.en
  const name = authorship.author.name || text.author
  if (authorship.translation) {
    const code = /** @type {keyof typeof text.languages} */ (String(authorship.translation.from).toLowerCase().slice(0, 2))
    const from = text.languages[code] ? text.from + text.languages[code] : ''
    return text.translation + from + (authorship.translation.edited ? text.reviewed : text.published) + name
  }
  if (authorship.digitalSourceType === SOURCE_TYPES.ai) return text.ai + name
  if (authorship.ai) return text.withAI[0] + name + text.withAI[1]
  if (authorship.original) return text.original + name
  return text.other[0] + name + text.other[1]
}

const DETAILS = {
  en: {
    summary: 'Verify the signature',
    intro: 'Tinto signed this post with its author’s key when it was published, and this site checked the signature before accepting it.',
    signature: 'Signature', valid: 'Valid · checked by this site when the post arrived',
    author: 'Author', key: 'Author key', signed: 'Signed', words: 'Where the words came from', translation: 'Translation',
    process: 'Writing in Tinto', fingerprint: 'Text fingerprint (SHA-256)', standard: 'Standard',
    standardValue: 'W3C Verifiable Credential 2.0 · Ed25519 signature (eddsa-jcs-2022)',
    origins: { written: 'written in Tinto', pasted: 'pasted', imported: 'imported', ai: 'AI-generated' },
    allWritten: 'All written in Tinto', otherSources: 'Includes text from other sources', withAI: 'Includes AI-generated text',
    translated: (/** @type {string} */ from, /** @type {string} */ by, /** @type {boolean} */ edited) => 'Automatic translation from ' + from + (by ? ' by ' + by : '') + (edited ? ' · reviewed and changed by the author' : ' · published as generated'),
    original: 'Read the original',
    counts: (/** @type {WritingSummary} */ p) => [p.typed && p.typed + ' characters typed', p.generated && p.generated + ' characters generated by AI', p.pasted && p.pasted + ' pasted', p.imported && p.imported + ' imported',
      p.activeMinutes && p.activeMinutes + (p.activeMinutes === 1 ? ' active minute' : ' active minutes'), p.sessions && p.sessions + (p.sessions === 1 ? ' session' : ' sessions')].filter(Boolean).join(' · '),
    notes: [
      'The signature shows that this text was published, exactly as it reads here, by whoever holds this author key. Changing a single character would break it.',
      'The counts come from Tinto’s record of how the text was written. Tinto keeps only counts and timing, never the keys pressed.',
      'It does not prove that the ideas are original, or who is behind the key beyond the name they chose.'
    ],
    download: 'Download the signed credential (JSON) to check it with any W3C Verifiable Credentials verifier'
  },
  es: {
    summary: 'Verificar la firma',
    intro: 'Tinto firmó esta publicación con la llave de su autor al publicarla, y este sitio comprobó la firma antes de aceptarla.',
    signature: 'Firma', valid: 'Válida · este sitio la comprobó al recibir la publicación',
    author: 'Autor', key: 'Llave del autor', signed: 'Firmada', words: 'De dónde vienen las palabras', translation: 'Traducción',
    process: 'Escritura en Tinto', fingerprint: 'Huella del texto (SHA-256)', standard: 'Estándar',
    standardValue: 'Credencial verificable W3C 2.0 · firma Ed25519 (eddsa-jcs-2022)',
    origins: { written: 'escrito en Tinto', pasted: 'pegado', imported: 'importado', ai: 'generado con IA' },
    allWritten: 'Todo escrito en Tinto', otherSources: 'Incluye texto de otras fuentes', withAI: 'Incluye texto generado con IA',
    translated: (/** @type {string} */ from, /** @type {string} */ by, /** @type {boolean} */ edited) => 'Traducción automática del ' + from + (by ? ' con ' + by : '') + (edited ? ' · revisada y cambiada por el autor' : ' · publicada tal como se generó'),
    original: 'Leer el original',
    counts: (/** @type {WritingSummary} */ p) => [p.typed && p.typed + ' caracteres tecleados', p.generated && p.generated + ' caracteres generados con IA', p.pasted && p.pasted + ' pegados', p.imported && p.imported + ' importados',
      p.activeMinutes && p.activeMinutes + (p.activeMinutes === 1 ? ' minuto activo' : ' minutos activos'), p.sessions && p.sessions + (p.sessions === 1 ? ' sesión' : ' sesiones')].filter(Boolean).join(' · '),
    notes: [
      'La firma muestra que este texto lo publicó, tal como se lee aquí, quien tiene esta llave de autor. Cambiar un solo carácter la rompería.',
      'Los conteos vienen del registro que Tinto lleva de cómo se escribió el texto. Tinto guarda solo conteos y tiempos, nunca las teclas.',
      'No prueba que las ideas sean originales, ni quién está detrás de la llave más allá del nombre que eligió.'
    ],
    download: 'Descargar la credencial firmada (JSON) para comprobarla con cualquier verificador de credenciales W3C'
  }
}
const LANGUAGE_NAMES = { en: { en: 'English', es: 'Spanish' }, es: { en: 'inglés', es: 'español' } }

/**
 * Everything a reader can check about a post's signature, in the post's
 * language, as plain data for the site to lay out (for example inside a
 * <details> element, which needs no script).
 * @param {(Authorship & { credential?: string }) | null | undefined} authorship @param {string} [language]
 * @returns {{ summary: string, intro: string, rows: { label: string, value: string, code?: boolean, href?: string, link?: string }[], notes: string[], download: { label: string, href: string } | null } | null}
 */
export function authorshipDetails(authorship, language = 'en') {
  if (!authorship?.verified) return null
  const code = String(language).toLowerCase().startsWith('es') ? 'es' : 'en'
  const text = DETAILS[code]
  /** @type {{ label: string, value: string, code?: boolean, href?: string, link?: string }[]} */
  const rows = [
    { label: text.signature, value: text.valid },
    { label: text.author, value: authorship.author.name || (code === 'es' ? LABELS.es.author : LABELS.en.author) },
    { label: text.key, value: authorship.author.id, code: true }
  ]
  const signed = Date.parse(authorship.signed)
  if (Number.isFinite(signed)) rows.push({ label: text.signed, value: new Intl.DateTimeFormat(code === 'es' ? 'es-MX' : 'en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(signed) + ' UTC' })
  const counts = authorship.characters
  const total = counts ? counts.written + counts.pasted + counts.imported + counts.ai : 0
  if (counts && total) {
    const share = (/** @type {keyof Characters} */ key) => counts[key] ? Math.max(1, Math.round(counts[key] / total * 100)) + '% ' + text.origins[key] : ''
    rows.push({ label: text.words, value: counts.written === total ? text.allWritten : (['written', 'ai', 'pasted', 'imported']).map(key => share(/** @type {keyof Characters} */ (key))).filter(Boolean).join(' · ') })
  } else rows.push({ label: text.words, value: authorship.original ? text.allWritten : authorship.ai ? text.withAI : text.otherSources })
  if (authorship.translation) {
    const from = String(authorship.translation.from).toLowerCase().slice(0, 2)
    const name = /** @type {Record<string, string>} */ (LANGUAGE_NAMES[code])[from] ?? authorship.translation.from
    rows.push({ label: text.translation, value: text.translated(name, authorship.translation.by, authorship.translation.edited), ...(authorship.translation.url ? { href: authorship.translation.url, link: text.original } : {}) })
  }
  const measured = authorship.process ? text.counts(authorship.process) : ''
  if (measured) rows.push({ label: text.process, value: measured })
  if (authorship.sha256) rows.push({ label: text.fingerprint, value: authorship.sha256, code: true })
  rows.push({ label: text.standard, value: text.standardValue })
  return { summary: text.summary, intro: text.intro, rows, notes: text.notes, download: authorship.credential ? { label: text.download, href: authorship.credential } : null }
}
