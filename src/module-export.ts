import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Writes the Tinto blog module for Cloudflare (modules/cloudflare, bundled in
// dist/cloudflare-module) into a website's project folder.
export interface ModuleSite { name: string; site: string }
export interface SavedModule { path: string; updated: boolean }

const CONFIG = 'tinto.config.mjs'
const NAME_LINE = "  name: 'Example',"
const SITE_LINE = "  site: 'https://example.com',"

export function checkModuleSite(values: ModuleSite): ModuleSite {
  const name = String(values?.name ?? '').trim()
  let site: URL | null = null
  try { site = new URL(String(values?.site ?? '').trim()) } catch { /* Reported below. */ }
  if (!name || name.length > 80) throw Error('Give the website a name of up to 80 characters.')
  if (!site || !/^https?:$/.test(site.protocol) || site.username || site.password) throw Error('Enter the website address, such as https://example.com.')
  return { name, site: site.origin }
}

// Fills in the template's name and site. A changed template stops here rather
// than producing a configuration with the example values.
export function moduleConfig(template: string, values: ModuleSite): string {
  const { name, site } = checkModuleSite(values)
  if (!template.includes(NAME_LINE) || !template.includes(SITE_LINE)) throw Error('The module bundled with Tinto has an unexpected configuration file. Reinstall Tinto.')
  return template.replace(NAME_LINE, '  name: ' + JSON.stringify(name) + ',').replace(SITE_LINE, '  site: ' + JSON.stringify(site) + ',')
}

// An existing tinto.config.mjs holds the site's own settings, so an update
// replaces only the module code. Files are read and written rather than copied,
// because the source can be inside the app archive.
export async function writeModule(folder: string, source: string, values: ModuleSite): Promise<SavedModule> {
  const target = join(folder, 'tinto')
  const updated = existsSync(join(target, CONFIG))
  const config = updated ? null : moduleConfig(await readFile(join(source, CONFIG), 'utf8'), values)
  const files = (await readdir(source)).filter(file => /\.(mjs|md)$/.test(file) && file !== CONFIG)
  await mkdir(target, { recursive: true })
  for (const file of files) await writeFile(join(target, file), await readFile(join(source, file)))
  if (config) await writeFile(join(target, CONFIG), config)
  return { path: target, updated }
}
