import { createHash, randomUUID } from 'node:crypto'
import { CREDENTIAL_CONTEXT, CREDENTIAL_TYPE, canonicalize, signCredential, sourceTypeOf } from '../modules/cloudflare/credential.mjs'
import type { AuthorSigner } from './author'
import { postParts, type CharacterOrigins } from './exchange'
import { INTERVAL_BANDS, type BlockJSON } from './model'
import type { WritingEvidence } from './storage'

// A post's authorship credential: a W3C Verifiable Credential 2.0 whose subject
// is the post as a schema.org CreativeWork. It names the author by did:key,
// hashes the text, each paragraph and each file, says where every paragraph's
// characters came from (IPTC digital source types), summarizes how the text
// was written, and points to the credential of the release before it.
export interface CredentialInput {
  postId: string
  title: string
  language: string
  blocks: BlockJSON[]
  html: string
  files: { file: string; type: string }[]
  evidence: WritingEvidence
  previous: { id: string; sha256: string } | null
  time: number
  // An automatic translation names the work it translates and the model that translated it.
  translation?: { language: string; title: string; url: string | null; translator: string }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const instant = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z')
const add = (a: CharacterOrigins, b: CharacterOrigins): CharacterOrigins =>
  ({ written: a.written + b.written, pasted: a.pasted + b.pasted, imported: a.imported + b.imported, ai: a.ai + b.ai })

export function characterTotals(blocks: BlockJSON[]): CharacterOrigins {
  return postParts(blocks).reduce((total, part) => add(total, part.characters), { written: 0, pasted: 0, imported: 0, ai: 0 })
}

export async function authorshipCredential(author: AuthorSigner, input: CredentialInput) {
  const parts = postParts(input.blocks)
  if (parts.map(part => part.html).join('\n') !== input.html) throw Error('The post text changed while it was being signed. Publish again.')
  const total = characterTotals(input.blocks)
  const kind = (characters: CharacterOrigins) => {
    const type = sourceTypeOf(characters)
    return type ? { digitalSourceType: type } : {}
  }
  const { evidence } = input
  const unsigned = {
    '@context': [CREDENTIAL_CONTEXT],
    id: 'urn:uuid:' + randomUUID(),
    type: ['VerifiableCredential', CREDENTIAL_TYPE],
    issuer: { id: author.did, name: author.name },
    validFrom: instant(input.time),
    credentialSubject: {
      id: 'urn:uuid:' + input.postId,
      type: 'CreativeWork',
      name: input.title,
      inLanguage: input.language,
      author: { id: author.did, name: author.name },
      dateModified: instant(input.time),
      sha256: sha256(input.html),
      ...kind(total),
      characters: total,
      hasPart: parts.map((part, index) => ({ type: 'CreativeWork', position: index + 1, sha256: sha256(part.html), ...kind(part.characters), characters: part.characters })),
      associatedMedia: input.files.map(item => ({ type: 'MediaObject', identifier: item.file, encodingFormat: item.type })),
      writingProcess: {
        typedCharacters: evidence.typed,
        deletedCharacters: evidence.deleted,
        pastedCharacters: evidence.pasted,
        importedCharacters: evidence.imported,
        ...(evidence.generated ? { generatedCharacters: evidence.generated } : {}),
        activeMinutes: Math.round(evidence.activeMs / 60_000),
        sessions: evidence.sessions,
        keyIntervals: { bandsMs: INTERVAL_BANDS, counts: evidence.intervals },
        log: { entries: evidence.entries, heads: evidence.heads, intact: evidence.intact }
      },
      ...(input.translation ? {
        translationOfWork: { type: 'CreativeWork', inLanguage: input.translation.language, ...(input.translation.title ? { name: input.translation.title } : {}), ...(input.translation.url ? { url: input.translation.url } : {}) },
        translator: { type: 'SoftwareApplication', name: input.translation.translator }
      } : {}),
      ...(input.previous ? { previousCredential: input.previous } : {})
    }
  }
  const credential = await signCredential(unsigned, author.key, author.did, instant(input.time))
  return { credential, id: unsigned.id, sha256: sha256(canonicalize(credential)) }
}
