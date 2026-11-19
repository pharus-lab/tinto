import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeStorage, shell } from 'electron'

const scope = 'https://www.googleapis.com/auth/drive.file'
interface Client { client_id: string; client_secret?: string }
interface Tokens { access_token: string; expires_in: number; refresh_token?: string; scope?: string }

export async function browserGrant(client: Client, openBrowser: (url: string) => Promise<unknown>) {
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Could not start Google authorization.')
  const redirect = 'http://127.0.0.1:' + address.port
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope, state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' }).toString()
  let timer: ReturnType<typeof setTimeout> | undefined
  const callback = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Google authorization timed out. Choose Connect to try again.')), 5 * 60_000)
    server.on('request', (request, response) => {
      const result = new URL(request.url ?? '/', redirect)
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      if (request.method !== 'GET' || result.pathname !== '/' || result.searchParams.get('state') !== state) {
        response.writeHead(400).end('Unrecognized authorization request.')
        return
      }
      const code = result.searchParams.get('code')
      if (!code || result.searchParams.has('error')) {
        response.end('Authorization was cancelled. You can return to Tinto.')
        reject(Error('Google authorization was cancelled.'))
        return
      }
      response.end('You can close this page and return to Tinto.')
      resolve(code)
    })
  })
  try {
    const [code] = await Promise.all([callback, openBrowser(url.href)])
    return { code, redirect, verifier }
  } finally {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }
}

async function requestTokens(client: Client, values: Record<string, string>): Promise<Tokens> {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ ...client, ...values }), signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string }
    if (error.error === 'invalid_grant') throw Error('Google authorization has expired. Disconnect and reconnect to continue backups.')
    throw Error('Google could not authorize Tinto. Check the connection and Desktop OAuth client.')
  }
  const tokens = await response.json() as Tokens
  if (!tokens.access_token || (tokens.scope && !tokens.scope.split(' ').includes(scope))) throw Error('Google Drive file access was not granted.')
  return tokens
}

export class DriveAuth {
  private clientFile: string
  private tokenFile: string
  private access: { token: string; until: number } | null = null
  private connecting = false
  private generation = 0

  constructor(userData: string) {
    this.clientFile = join(userData, 'drive-client.enc')
    this.tokenFile = join(userData, 'drive-token.enc')
  }

  get configured() { return existsSync(this.clientFile) }
  get connected() { return existsSync(this.tokenFile) }

  private async keyStore() {
    if (!await safeStorage.isAsyncEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw Error('Unlock your system keychain or Linux keyring to connect Google Drive.')
    }
  }

  private async protect(path: string, value: string) {
    await this.keyStore()
    const bytes = await safeStorage.encryptStringAsync(value)
    const temporary = path + '.' + randomUUID()
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(temporary, bytes, { mode: 0o600 })
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }

  private async reveal(path: string): Promise<string> {
    await this.keyStore()
    return (await safeStorage.decryptStringAsync(await readFile(path))).result
  }

  async connect(clientPath?: string): Promise<void> {
    if (this.connecting) throw Error('Google authorization is already open in your browser.')
    this.connecting = true
    const generation = this.generation
    try {
      let client: Client
      if (clientPath) {
        const credentials = JSON.parse(await readFile(clientPath, 'utf8')).installed
        if (!credentials?.client_id) throw Error('Choose a Google Desktop app OAuth client JSON file.')
        client = { client_id: credentials.client_id, ...(credentials.client_secret ? { client_secret: credentials.client_secret } : {}) }
        await this.protect(this.clientFile, JSON.stringify(client))
      } else {
        if (!this.configured) throw Error('Choose a Desktop OAuth client JSON file to connect Google Drive.')
        client = JSON.parse(await this.reveal(this.clientFile))
      }
      const { code, redirect, verifier } = await browserGrant(client, url => shell.openExternal(url))
      const tokens = await requestTokens(client, { code, redirect_uri: redirect, code_verifier: verifier, grant_type: 'authorization_code' })
      if (generation !== this.generation) throw Error('Google authorization was cancelled.')
      if (!tokens.refresh_token) throw Error('Google did not grant offline access. Reconnect and approve access.')
      await this.protect(this.tokenFile, tokens.refresh_token)
      this.remember(tokens)
    } finally { this.connecting = false }
  }

  private remember(tokens: Tokens): string {
    this.access = { token: tokens.access_token, until: Date.now() + (tokens.expires_in - 60) * 1000 }
    return tokens.access_token
  }

  async token(): Promise<string> {
    if (!this.connected) throw Error('Connect Google Drive in Settings first.')
    if (this.access && this.access.until > Date.now()) return this.access.token
    const generation = this.generation
    const [clientJson, refresh_token] = await Promise.all([this.reveal(this.clientFile), this.reveal(this.tokenFile)])
    const tokens = await requestTokens(JSON.parse(clientJson), { grant_type: 'refresh_token', refresh_token })
    if (generation !== this.generation) throw Error('Google Drive was disconnected.')
    return this.remember(tokens)
  }

  async disconnect(): Promise<void> {
    this.generation++
    this.access = null
    let refresh = ''
    try { if (this.connected) refresh = await this.reveal(this.tokenFile) }
    finally { await rm(this.tokenFile, { force: true }) }
    if (refresh) {
      await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token: refresh }), signal: AbortSignal.timeout(5000) }).catch(() => {})
    }
  }
}
