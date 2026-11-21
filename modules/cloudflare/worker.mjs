// Tinto blog module for Cloudflare — the HTTPS endpoint Tinto publishes to.
// Protocol 1: https://github.com/juanrubiop/tinto/blob/main/docs/site-contract.md
//
// Needs the TINTO_DB (D1) and TINTO_MEDIA (R2) bindings and the TINTO_API_KEY
// secret. TINTO_DEPLOY_HOOK, when set, is called after every change so a
// static site rebuilds with the post.

import {
  IMAGE_FILE, IMAGE_TYPES, MAX_IMAGE_BYTES, POST_ID, PROTOCOL, Rejection,
  checkPost, contentName, imageKey, publicPost, settings, sniffImage
} from './shared.mjs'

// Images a post stops using stay this long, so pages built before the change keep working.
const TRASH_DELAY = 60 * 60 * 1000
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tinto_posts (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, language TEXT NOT NULL, locale TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
    html TEXT NOT NULL, cover TEXT, images TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
    UNIQUE (locale, slug)
  )`,
  'CREATE TABLE IF NOT EXISTS tinto_trash (key TEXT PRIMARY KEY, after INTEGER NOT NULL)'
]
const UPSERT = `INSERT INTO tinto_posts (id, slug, language, locale, title, summary, date, tags, html, cover, images, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, language = excluded.language, locale = excluded.locale,
    title = excluded.title, summary = excluded.summary, date = excluded.date, tags = excluded.tags, html = excluded.html,
    cover = excluded.cover, images = excluded.images, updated_at = excluded.updated_at`
const SELECT = 'SELECT * FROM tinto_posts ORDER BY date DESC, updated_at DESC'

/**
 * @param {import('./shared.mjs').TintoConfig} config
 * @param {{ now?: () => number }} [options]
 * @returns {{ fetch(request: Request, env: any, ctx?: unknown): Promise<Response | null> }}
 */
export function createTintoBlog(config, { now = Date.now } = {}) {
  const site = settings(config)
  const prepared = new WeakSet()

  /** @param {Record<string, string>} headers @param {string} origin */
  const finish = (headers, origin) => {
    headers['X-Content-Type-Options'] = 'nosniff'
    headers['Content-Security-Policy'] = "default-src 'none'"
    if (origin !== site.site) headers['X-Robots-Tag'] = 'noindex, nofollow'
    return headers
  }
  /** @param {number} status @param {unknown} body @param {string} origin @param {boolean} [empty] */
  const json = (status, body, origin, empty = false) => new Response(empty ? null : JSON.stringify(body), {
    status, headers: finish({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }, origin)
  })

  /** @param {any} env @param {boolean} [media] */
  function bindings(env, media = true) {
    if (!env?.TINTO_DB || (media && !env.TINTO_MEDIA)) throw new Rejection(503, 'Add the TINTO_DB (D1) and TINTO_MEDIA (R2) bindings to this Worker.')
  }
  /** @param {any} db */
  async function schema(db) {
    if (prepared.has(db)) return
    await db.batch(SCHEMA.map(sql => db.prepare(sql)))
    prepared.add(db)
  }
  // Both keys are hashed first, so the comparison takes the same time whatever they contain.
  /** @param {string} given @param {string} expected */
  async function sameKey(given, expected) {
    const encode = (/** @type {string} */ value) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    const [a, b] = (await Promise.all([encode(given), encode(expected)])).map(buffer => new Uint8Array(buffer))
    let difference = 0
    for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
    return difference === 0
  }
  /** @param {Request} request @param {any} env */
  async function authorize(request, env) {
    const expected = typeof env?.TINTO_API_KEY === 'string' ? env.TINTO_API_KEY.trim() : ''
    if (expected.length < 20) throw new Rejection(503, 'This site has no Tinto API key yet. Set the TINTO_API_KEY secret to a random value of at least 20 characters.')
    const header = request.headers.get('Authorization') ?? ''
    if (!header.startsWith('Bearer ') || !(await sameKey(header.slice(7).trim(), expected))) throw new Rejection(401, 'The API key is not valid for this site.')
    bindings(env)
  }
  /** @param {string} method @param {string[]} allowed */
  function allow(method, allowed) {
    if (!allowed.includes(method)) throw new Rejection(405, 'Use ' + allowed.join(' or ') + ' for this address.')
  }

  /** @param {any} env @param {string} action */
  async function rebuild(env, action) {
    const hook = typeof env.TINTO_DEPLOY_HOOK === 'string' ? env.TINTO_DEPLOY_HOOK.trim() : ''
    if (!hook) return
    let response = null
    try { response = await fetch(hook, { method: 'POST' }) } catch { /* Reported below. */ }
    if (!response?.ok) {
      const status = response ? ' (HTTP ' + response.status + ')' : ''
      throw new Rejection(502, 'The post was ' + action + ', but the site rebuild did not start' + status + '. Try again' + (response?.status === 429 ? ' in a minute' : '') + '.')
    }
  }
  /** @param {any} bucket @param {string} prefix */
  async function listKeys(bucket, prefix) {
    const keys = []
    let cursor
    do {
      const page = await bucket.list({ prefix, cursor })
      keys.push(...page.objects.map((/** @type {{ key: string }} */ object) => object.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return keys
  }
  // Images the post no longer uses, including leftovers of failed attempts,
  // wait in tinto_trash. Expired entries are removed on each change.
  /** @param {any} env @param {string} id @param {Set<string>} keep */
  async function tidy(env, id, keep) {
    const db = env.TINTO_DB
    const unused = (await listKeys(env.TINTO_MEDIA, imageKey(id, ''))).filter(key => !keep.has(key))
    if (unused.length) await db.batch(unused.map(key => db.prepare('INSERT OR IGNORE INTO tinto_trash (key, after) VALUES (?1, ?2)').bind(key, now() + TRASH_DELAY)))
    const expired = (await db.prepare('SELECT key FROM tinto_trash WHERE after <= ?1 LIMIT 100').bind(now()).all()).results.map((/** @type {any} */ row) => String(row.key))
    if (!expired.length) return
    await env.TINTO_MEDIA.delete(expired)
    await db.batch(expired.map(key => db.prepare('DELETE FROM tinto_trash WHERE key = ?1').bind(key)))
  }

  /** @param {Request} request @param {any} env @param {string} id @param {string} file */
  async function putImage(request, env, id, file) {
    const match = IMAGE_FILE.exec(file)
    if (!POST_ID.test(id) || !match) throw new Rejection(400, 'The image address is not valid.')
    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_IMAGE_BYTES) throw new Rejection(413, 'Images can be up to 15 MB.')
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Rejection(413, 'Images can be up to 15 MB.')
    const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
    if (sniffImage(bytes) !== match[2] || type !== IMAGE_TYPES[match[2]]) throw new Rejection(422, 'The file is not the kind of image its name says.')
    if (await contentName(bytes) !== match[1]) throw new Rejection(422, 'The image did not arrive intact. Publish again.')
    await env.TINTO_MEDIA.put(imageKey(id, file), bytes, { httpMetadata: { contentType: IMAGE_TYPES[match[2]] } })
    return new Response(null, { status: 201 })
  }

  /** @param {Request} request @param {any} env @param {string} id @param {string} origin */
  async function putPost(request, env, id, origin) {
    if (!POST_ID.test(id)) throw new Rejection(400, 'The post address is not valid.')
    const raw = await request.text()
    if (raw.length > 2_000_000) throw new Rejection(413, 'The post is larger than this site accepts.')
    let input
    try { input = JSON.parse(raw) } catch { throw new Rejection(400, 'Send the post as JSON.') }
    const post = checkPost(input, site.languages)
    const keep = new Set([post.cover, ...post.images].filter(image => !!image).map(image => imageKey(id, /** @type {any} */ (image).file)))
    for (const key of keep) if (!(await env.TINTO_MEDIA.head(key))) throw new Rejection(422, 'An image of this post has not been uploaded. Publish again.')
    const db = env.TINTO_DB
    await schema(db)
    try {
      // One transaction: images the post uses again leave the trash before the post refers to them.
      await db.batch([
        ...[...keep].map(key => db.prepare('DELETE FROM tinto_trash WHERE key = ?1').bind(key)),
        db.prepare(UPSERT).bind(id, post.slug, post.language, post.locale, post.title, post.summary, post.date, JSON.stringify(post.tags),
          post.html, post.cover ? JSON.stringify(post.cover) : null, JSON.stringify(post.images), post.updatedAt)
      ])
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(/** @type {any} */ (error)?.message))) {
        throw new Rejection(409, 'Another post in this language already uses the address “' + post.slug + '”. Choose a different address.')
      }
      throw error
    }
    await tidy(env, id, keep)
    await rebuild(env, 'saved')
    return json(200, { url: publicPost(site, { ...post, id }).url }, origin)
  }

  /** @param {any} env @param {string} id @param {string} origin */
  async function deletePost(env, id, origin) {
    if (!POST_ID.test(id)) throw new Rejection(400, 'The post address is not valid.')
    await schema(env.TINTO_DB)
    const result = await env.TINTO_DB.prepare('DELETE FROM tinto_posts WHERE id = ?1').bind(id).run()
    await tidy(env, id, new Set())
    // A retry after a failed rebuild finds no post, so the rebuild runs either way.
    await rebuild(env, 'removed')
    return result.meta?.changes ? new Response(null, { status: 204 }) : json(404, { error: 'This post is not on the site.' }, origin)
  }

  /** @param {any} env @param {string} method @param {string} origin */
  async function feed(env, method, origin) {
    bindings(env, false)
    let rows = []
    try { rows = (await env.TINTO_DB.prepare(SELECT).all()).results ?? [] }
    catch (error) { if (!/no such table/i.test(String(/** @type {any} */ (error)?.message))) throw error }
    const posts = rows.map((/** @type {any} */ row) => publicPost(site, {
      ...row, tags: JSON.parse(row.tags), cover: row.cover ? JSON.parse(row.cover) : null, images: JSON.parse(row.images), updatedAt: row.updated_at
    }))
    return json(200, { tinto: PROTOCOL, name: site.name, posts }, origin, method === 'HEAD')
  }

  /** @param {Request} request @param {any} env @param {string} id @param {string} file @param {string} origin */
  async function media(request, env, id, file, origin) {
    allow(request.method, ['GET', 'HEAD'])
    bindings(env)
    const match = IMAGE_FILE.exec(file)
    const object = POST_ID.test(id) && match
      ? await (request.method === 'HEAD' ? env.TINTO_MEDIA.head(imageKey(id, file)) : env.TINTO_MEDIA.get(imageKey(id, file)))
      : null
    if (!object || !match) return new Response('Not found', { status: 404, headers: finish({ 'Content-Type': 'text/plain; charset=utf-8' }, origin) })
    // Names depend on the content, so an image at one address never changes.
    const headers = finish({ 'Content-Type': IMAGE_TYPES[match[2]], ETag: object.httpEtag, 'Cache-Control': 'public, max-age=31536000, immutable' }, origin)
    const tags = (request.headers.get('If-None-Match') ?? '').split(',').map(tag => tag.trim())
    if (tags.includes(object.httpEtag) || tags.includes('*')) {
      await object.body?.cancel?.()
      return new Response(null, { status: 304, headers })
    }
    headers['Content-Length'] = String(object.size)
    return new Response(request.method === 'HEAD' ? null : object.body, { headers })
  }

  /** @param {Request} request @param {any} env @param {string} path @param {string} origin */
  async function route(request, env, path, origin) {
    const method = request.method
    let match = /^\/media\/([^/]+)\/([^/]+)$/.exec(path)
    if (match) return media(request, env, match[1], match[2], origin)
    if (path === '/feed') {
      allow(method, ['GET', 'HEAD'])
      return feed(env, method, origin)
    }
    // Everything else is for Tinto and needs the key.
    await authorize(request, env)
    if (path === '' || path === '/') {
      allow(method, ['GET'])
      return json(200, { tinto: PROTOCOL, name: site.name }, origin)
    }
    if ((match = /^\/posts\/([^/]+)\/images\/([^/]+)$/.exec(path))) {
      allow(method, ['PUT'])
      return putImage(request, env, match[1], match[2])
    }
    if ((match = /^\/posts\/([^/]+)$/.exec(path))) {
      allow(method, ['PUT', 'DELETE'])
      return method === 'PUT' ? putPost(request, env, match[1], origin) : deletePost(env, match[1], origin)
    }
    throw new Rejection(404, 'This site has no Tinto address like that.')
  }

  return {
    // Returns null for addresses outside basePath, so the site handles them as usual.
    async fetch(request, env) {
      const url = new URL(request.url)
      if (url.pathname !== site.basePath && !url.pathname.startsWith(site.basePath + '/')) return null
      try { return await route(request, env, url.pathname.slice(site.basePath.length), url.origin) }
      catch (error) {
        if (error instanceof Rejection) return json(error.status, { error: error.message }, url.origin)
        console.error('Tinto blog module:', error)
        return json(500, { error: 'The site could not complete the request.' }, url.origin)
      }
    }
  }
}
