import { createHash } from 'node:crypto'

// Tinto blog module, protocol 1. docs/site-contract.md describes the API a
// website implements to receive posts from Tinto.
export const PROTOCOL = 1

export interface SiteConnection { endpoint: string; key: string }
export interface SiteImage { file: string; type: string; alt: string }
export interface SitePost {
  slug: string
  language: string
  title: string
  summary: string
  date: string
  tags: string[]
  html: string
  cover: SiteImage | null
  images: SiteImage[]
  updatedAt: string
}
export interface SiteTransport {
  putImage(postId: string, file: string, bytes: Uint8Array, type: string): Promise<void>
  putPost(postId: string, post: SitePost): Promise<{ url: string | null }>
  deletePost(postId: string): Promise<void>
}

// Plain HTTP is allowed only on this computer, for testing a module locally.
const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])

export function validateConnection(input: SiteConnection): SiteConnection {
  const endpoint = String(input?.endpoint ?? '').trim()
  const key = String(input?.key ?? '').trim()
  let url: URL | null = null
  try { url = new URL(endpoint) } catch { /* Reported below. */ }
  const secure = url && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback.has(url.hostname)))
  if (!url || !secure || url.username || url.password || /[?#]/.test(url.href)) {
    throw Error('Paste the publishing URL from the website. It starts with https:// and has no ? or # part.')
  }
  if (!/^[\x21-\x7e]{20,512}$/.test(key)) throw Error('Paste the complete API key from the website.')
  return { endpoint: url.href.replace(/\/+$/, ''), key }
}

// The same publishing URL always names the same site, so adding it again
// replaces its key and keeps the posts already published there.
export const siteId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 32)

type Action = 'check' | 'image' | 'post' | 'delete'
// Text from a website is shown to the writer, so it is shortened and kept to one line.
const clip = (value: unknown, length: number) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, length) : ''

export class SiteClient implements SiteTransport {
  private connection: SiteConnection
  constructor(connection: SiteConnection) { this.connection = connection }

  private get host() { return new URL(this.connection.endpoint).host }

  // Redirects are refused so the key is only ever sent to the URL the writer entered.
  private async call(path: string, init: RequestInit, action: Action, timeout = 30_000): Promise<unknown> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', 'Bearer ' + this.connection.key)
    headers.set('Accept', 'application/json')
    let response: Response
    try { response = await fetch(this.connection.endpoint + path, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(timeout) }) }
    catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw Error(this.host + ' did not answer in time. Try again.')
      throw Error('Could not reach ' + this.host + '. Check your connection, and that the publishing URL is the final address without redirects.')
    }
    const body = await response.json().catch(() => null)
    if (response.ok || (action === 'delete' && response.status === 404)) return body
    throw this.explain(response.status, body, action)
  }

  private explain(status: number, body: unknown, action: Action): Error {
    const said = clip((body as { error?: unknown } | null)?.error, 300)
    const site = this.host
    if (status === 401 || status === 403) return Error(site + ' rejected the API key. Copy the current key from the website and add the site again in Settings.')
    if (status === 404 && action === 'check') return Error('There is no Tinto blog module at this publishing URL. Copy the URL from the website again.')
    if (status === 409) return Error(said || 'Another post in this language already uses this address on ' + site + '. Choose a different address.')
    if (status === 413) return Error(said || site + ' does not accept an image this large.')
    if (status === 429) return Error(site + ' is limiting requests. Wait a minute and try again.')
    if (status === 400 || status === 422) return Error(said || site + ' rejected the ' + (action === 'image' ? 'image.' : 'post.'))
    return Error(site + ' returned HTTP ' + status + (said ? ': ' + said : '') + '.')
  }

  async info(): Promise<{ name: string }> {
    const body = await this.call('', { method: 'GET' }, 'check') as { tinto?: unknown; name?: unknown } | null
    if (typeof body?.tinto === 'number' && body.tinto > PROTOCOL) throw Error(this.host + ' uses a newer version of the Tinto blog module. Update Tinto to publish there.')
    if (body?.tinto !== PROTOCOL) throw Error('There is no Tinto blog module at this publishing URL. Copy the URL from the website again.')
    return { name: clip(body.name, 80) || this.host }
  }

  async putImage(postId: string, file: string, bytes: Uint8Array, type: string): Promise<void> {
    await this.call('/posts/' + postId + '/images/' + file, {
      method: 'PUT', headers: { 'Content-Type': type }, body: bytes as Uint8Array<ArrayBuffer>
    }, 'image', 120_000)
  }

  async putPost(postId: string, post: SitePost): Promise<{ url: string | null }> {
    const body = await this.call('/posts/' + postId, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post)
    }, 'post') as { url?: unknown } | null
    let url: URL | null = null
    try { url = typeof body?.url === 'string' && body.url.length <= 2048 ? new URL(body.url) : null } catch { /* Not a usable address. */ }
    return { url: url && /^https?:$/.test(url.protocol) ? url.href : null }
  }

  async deletePost(postId: string): Promise<void> {
    await this.call('/posts/' + postId, { method: 'DELETE' }, 'delete')
  }
}
