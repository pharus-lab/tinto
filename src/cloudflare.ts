import { randomUUID } from 'node:crypto'

export interface SiteConfig { accountId: string; databaseId: string; bucket: string; token: string; deployHook: string }
export type Row = Record<string, unknown>
export interface SiteTransport {
  query(sql: string, params?: string[]): Promise<Row[]>
  putObject(key: string, bytes: Uint8Array, type: string): Promise<void>
  deleteObject(key: string): Promise<void>
  triggerDeploy(): Promise<void>
}

// Site contract v1. docs/site-contract.md describes the same table for the
// website build. Every parameter is sent as text, as the D1 query API expects.
export const POSTS_TABLE = `CREATE TABLE IF NOT EXISTS tinto_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  locale TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  body_html TEXT NOT NULL,
  cover TEXT,
  images TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE (slug, locale)
)`
export const UPSERT_POST = `INSERT INTO tinto_posts (id, slug, locale, title, summary, date, tags, body_html, cover, images, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULLIF(?9, ''), ?10, ?11)
ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, locale = excluded.locale, title = excluded.title,
  summary = excluded.summary, date = excluded.date, tags = excluded.tags, body_html = excluded.body_html,
  cover = excluded.cover, images = excluded.images, updated_at = excluded.updated_at`
export const DELETE_POST = 'DELETE FROM tinto_posts WHERE id = ?1'

const api = 'https://api.cloudflare.com/client/v4'
const hookPath = /^\/client\/v4\/workers\/builds\/deploy_hooks\/[A-Za-z0-9-]{8,128}$/

export function validateConfig(input: SiteConfig): SiteConfig {
  const value = (field: keyof SiteConfig) => String(input?.[field] ?? '').trim()
  const accountId = value('accountId').toLowerCase()
  const databaseId = value('databaseId').toLowerCase()
  const bucket = value('bucket')
  const token = value('token')
  const deployHook = value('deployHook')
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw Error('Enter the 32-character Account ID from the Cloudflare dashboard.')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(databaseId)) throw Error('Enter the D1 database ID. It looks like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.')
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw Error('Enter the R2 bucket name: 3 to 63 lowercase letters, numbers or hyphens.')
  if (!/^[\x21-\x7e]{20,}$/.test(token)) throw Error('Paste the complete Cloudflare API token.')
  let hook: URL | null = null
  try { hook = new URL(deployHook) } catch { /* Reported below. */ }
  // The hook URL is itself a credential. Only Cloudflare's endpoint may receive it.
  if (!hook || hook.origin !== 'https://api.cloudflare.com' || !hookPath.test(hook.pathname) || hook.search || hook.hash || hook.username || hook.password) {
    throw Error('Paste the Deploy Hook URL from Workers Builds. It starts with https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/.')
  }
  return { accountId, databaseId, bucket, token, deployHook: hook.href }
}

interface Envelope { success?: boolean; errors?: { code?: number; message?: string }[]; result?: unknown }
type Context = 'd1' | 'r2' | 'hook'

function explain(status: number, body: Envelope | null, context: Context, config: SiteConfig): Error {
  const messages = (body?.errors ?? []).map(error => error.message ?? '').filter(Boolean)
  const detail = messages.join(' ')
  if (context === 'd1' && /UNIQUE constraint failed/i.test(detail)) return Error('Another post in this language already uses this address. Choose a different address.')
  if (status === 429) {
    return Error(context === 'hook'
      ? 'Workers Builds starts at most 10 deploy hook builds per minute. Wait a minute, then retry the rebuild.'
      : 'Cloudflare is limiting requests. Wait a minute and try again.')
  }
  if (context === 'hook') {
    if (status === 404) return Error('Workers Builds no longer recognises this Deploy Hook. Create a new hook and reconnect the site in Settings.')
    return Error('Workers Builds could not start a rebuild (HTTP ' + status + (detail ? ': ' + detail : '') + ').')
  }
  const authentication = status === 401 || status === 403 || (body?.errors ?? []).some(error => error.code === 10000)
  if (context === 'r2') {
    if (authentication) return Error('The API token cannot write to the R2 bucket “' + config.bucket + '”. Give it Workers R2 Storage Bucket Item Write on that bucket.')
    if (status === 404) return Error('Cloudflare could not find the R2 bucket “' + config.bucket + '” in this account.')
    return Error('R2 returned HTTP ' + status + (detail ? ': ' + detail : '') + '.')
  }
  if (authentication) return Error('The API token cannot use this D1 database. Give it D1 Edit on the account and check the Account ID.')
  if (status === 404) return Error('Cloudflare could not find D1 database ' + config.databaseId + ' in this account.')
  return Error('D1 returned HTTP ' + status + (detail ? ': ' + detail : '') + '.')
}

// Slashes separate R2 key segments and must stay literal in the request path.
const objectPath = (key: string) => key.split('/').map(encodeURIComponent).join('/')

export class CloudflareSite implements SiteTransport {
  private config: SiteConfig
  constructor(config: SiteConfig) { this.config = config }

  private async call(url: string, init: RequestInit, context: Context, authorized = true): Promise<Envelope | null> {
    const headers = new Headers(init.headers)
    if (authorized) headers.set('Authorization', 'Bearer ' + this.config.token)
    let response: Response
    try { response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(120_000) }) }
    catch { throw Error('Cloudflare could not be reached. Check your connection and try again.') }
    const body = await response.json().catch(() => null) as Envelope | null
    if (response.ok && body?.success !== false) return body
    if (context === 'r2' && init.method === 'DELETE' && response.status === 404) return body
    throw explain(response.status, body, context, this.config)
  }

  private get account() { return api + '/accounts/' + this.config.accountId }

  async query(sql: string, params: string[] = []): Promise<Row[]> {
    const body = await this.call(this.account + '/d1/database/' + this.config.databaseId + '/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params })
    }, 'd1')
    const results = body?.result as { success?: boolean; results?: Row[] }[] | undefined
    if (!Array.isArray(results) || results.some(result => result.success === false)) throw Error('D1 did not complete the query.')
    return results.at(-1)?.results ?? []
  }

  async putObject(key: string, bytes: Uint8Array, type: string): Promise<void> {
    const body = await this.call(this.account + '/r2/buckets/' + this.config.bucket + '/objects/' + objectPath(key), {
      method: 'PUT', headers: { 'Content-Type': type }, body: bytes as Uint8Array<ArrayBuffer>
    }, 'r2')
    const stored = body?.result as { key?: string; size?: string | number } | undefined
    if (stored?.size !== undefined && Number(stored.size) !== bytes.byteLength) throw Error('R2 stored an incomplete copy of ' + key + '. Publish again.')
  }

  async deleteObject(key: string): Promise<void> {
    await this.call(this.account + '/r2/buckets/' + this.config.bucket + '/objects/' + objectPath(key), { method: 'DELETE' }, 'r2')
  }

  async triggerDeploy(): Promise<void> {
    await this.call(this.config.deployHook, { method: 'POST' }, 'hook', false)
  }
}

// Writing the table checks D1 access; a disposable object checks the bucket.
// The deploy hook is not called, because that would start a real build.
export async function verifySite(site: SiteTransport): Promise<void> {
  await site.query(POSTS_TABLE)
  const key = 'tinto-connection-check/' + randomUUID() + '.txt'
  await site.putObject(key, new TextEncoder().encode('Tinto connection check'), 'text/plain; charset=utf-8')
  await site.deleteObject(key)
}
