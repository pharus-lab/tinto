import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DictionaryData } from './spelling'

export interface DictionaryPack { code: string; name: string; installed: boolean }

const revision = '8cfea406b505e4d7df52d5a19bce525df98c54ab'
const upstream = 'https://raw.githubusercontent.com/wooorm/dictionaries/' + revision + '/dictionaries/'
const catalog = [
  {
    code: 'en-GB', name: 'English (UK)',
    files: {
      'index.aff': '8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b',
      'index.dic': '869fe17ba4ee4b5401c60a666ee2d6a3dcc237f460b7294435df1cc6a799aa57',
      license: '81b644347b40804c25811267efbea024a30b2bb1642fefa9c9c50f7b0bbcb67f'
    }
  },
  {
    code: 'fr', name: 'French',
    files: {
      'index.aff': '05a735d34c912e4e381ff08ee7c747923ccf5cf9dca81d8467982fa1ca51c2b7',
      'index.dic': '984e933237bc1224a48f42828233be9b03228260ef67aa8e2bdddcd03a26230d',
      license: '0c785aebc7aae8aa00b8163e9b3219a8785a9900b71e85475204e48a5651ced4'
    }
  }
]

function findPack(code: string) {
  const pack = catalog.find(item => item.code === code)
  if (!pack) throw Error('This dictionary is not in the download list.')
  return pack
}

export async function listPacks(userData: string): Promise<DictionaryPack[]> {
  return catalog.map(({ code, name }) => ({ code, name, installed: existsSync(join(userData, 'dictionaries', code)) }))
}

export async function installPack(userData: string, code: string): Promise<void> {
  const pack = findPack(code)
  const root = join(userData, 'dictionaries')
  const target = join(root, pack.code)
  if (existsSync(target)) return
  await mkdir(root, { recursive: true })
  const temporary = await mkdtemp(join(root, '.' + pack.code + '-'))
  try {
    for (const [file, expected] of Object.entries(pack.files)) {
      const response = await fetch(upstream + pack.code + '/' + file, { signal: AbortSignal.timeout(45_000) }).catch(() => {
        throw Error('Could not reach the dictionary download. Check your connection and try again.')
      })
      if (!response.ok) throw Error('Could not download ' + pack.name + '. Try again when connected.')
      const contents = Buffer.from(await response.arrayBuffer())
      if (createHash('sha256').update(contents).digest('hex') !== expected) {
        throw Error('The downloaded ' + pack.name + ' dictionary failed verification.')
      }
      await writeFile(join(temporary, file), contents)
    }
    // Only a complete, verified set of files can become visible to the editor.
    try {
      await rename(temporary, target)
    } catch (error) {
      if (!existsSync(target)) throw error // Another download may have finished first.
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function readPack(userData: string, code: string): Promise<DictionaryData> {
  const pack = findPack(code)
  const directory = join(userData, 'dictionaries', pack.code)
  if (!existsSync(directory)) throw Error('Download the ' + pack.name + ' dictionary in Settings to check this document.')
  const [aff, dic] = await Promise.all(['index.aff', 'index.dic'].map(file => readFile(join(directory, file), 'utf8')))
  return { aff, dic }
}
