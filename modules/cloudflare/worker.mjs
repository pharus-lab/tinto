// Tinto blog module for Cloudflare — the HTTPS endpoint Tinto publishes to.
// Protocol 2 is described in Tinto's docs/site-contract.md.
//
// Needs the TINTO_DB (D1) and TINTO_MEDIA (R2) bindings and the TINTO_API_KEY
// secret. TINTO_DEPLOY_HOOK, when set, is called after every change that
// affects published posts, so a static site rebuilds.

import { FILE_CLASSES, FILE_NAME, FILE_TYPES, contentName } from './files.mjs'
import { POST_ID, PROTOCOL, Rejection, checkPost, fileKey, postFiles, publicPost, settings } from './shared.mjs'

// Files a post stops using stay this long, so pages built before the change keep working.
const TRASH_DELAY = 60 * 60 * 1000
// Larger audio, video and documents stream into R2 instead of being held in memory.
const STREAM_FROM = 8 * 1024 * 1024
const POSTS = `CREATE TABLE IF NOT EXISTS tinto_posts (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, language TEXT NOT NULL, locale TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'published', title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', date TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', html TEXT NOT NULL, cover TEXT, images TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
    UNIQUE (locale, category, slug)
  )`
const SCHEMA = [
  POSTS,
  'CREATE INDEX IF NOT EXISTS tinto_posts_feed ON tinto_posts (status, date DESC, updated_at DESC)',
  'CREATE TABLE IF NOT EXISTS tinto_trash (key TEXT PRIMARY KEY, after INTEGER NOT NULL)'
]
// Protocol 1 tables have no category, status or attachments. Their posts are
// copied into the new table, and their images, stored without a class folder,
// are still served (see serveFile).
const UPGRADE = [
  'ALTER TABLE tinto_posts RENAME TO tinto_posts_v1',
  POSTS,
  `INSERT INTO tinto_posts (id, slug, language, locale, title, summary, date, tags, html, cover, images, updated_at)
    SELECT id, slug, language, locale, title, summary, date, tags, html, cover, images, updated_at FROM tinto_posts_v1`,
  'DROP TABLE tinto_posts_v1'
]
const UPSERT = `INSERT INTO tinto_posts (id, slug, language, locale, category, status, title, summary, date, tags, html, cover, images, attachments, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
  ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, language = excluded.language, locale = excluded.locale,
    category = excluded.category, status = excluded.status, title = excluded.title, summary = excluded.summary,
    date = excluded.date, tags = excluded.tags, html = excluded.html, cover = excluded.cover, images = excluded.images,
    attachments = excluded.attachments, updated_at = excluded.updated_at`
const FEED = "SELECT * FROM tinto_posts WHERE status = 'published' ORDER BY date DESC, updated_at DESC"

/**
 * @param {import('./shared.mjs').TintoConfig} config
 * @param {{ now?: () => number }} [options]
 * @returns {{ fetch(request: Request, env: any, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response | null> }}
 */
export function createTintoBlog(config, { now = Date.now } = {}) {
  const site = settings(config)
  const prepared = new WeakSet()

  /** @param {Record<string, string>} headers @param {string} origin */
  const finish = (headers, origin) => {
    headers['X-Content-Type-Options'] = 'nosniff'
    if (origin !== site.site) headers['X-Robots-Tag'] = 'noindex, nofollow'
    return headers
  }
  /** @param {number} status @param {unknown} body @param {string} origin @param {boolean} [empty] */
  const json = (status, body, origin, empty = false) => new Response(empty ? null : JSON.stringify(body), {
    status, headers: finish({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'" }, origin)
  })

  /** @param {any} env @param {boolean} [media] */
  function bindings(env, media = true) {
    if (!env?.TINTO_DB || (media && !env.TINTO_MEDIA)) throw new Rejection(503, 'Add the TINTO_DB (D1) and TINTO_MEDIA (R2) bindings to this Worker.')
  }
  /** @param {any} db */
  async function schema(db) {
    if (prepared.has(db)) return
    const table = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tinto_posts'").first()
    if (table && !String(table.sql).includes('category')) await db.batch(UPGRADE.map(sql => db.prepare(sql)))
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
  // Files the post no longer uses, including leftovers of failed attempts,
  // wait in tinto_trash. Expired entries are removed on each change.
  /** @param {any} env @param {string} id @param {Set<string>} keep */
  async function tidy(env, id, keep) {
    const db = env.TINTO_DB
    const unused = (await listKeys(env.TINTO_MEDIA, 'tinto/' + id + '/')).filter(key => !keep.has(key))
    if (unused.length) await db.batch(unused.map(key => db.prepare('INSERT OR IGNORE INTO tinto_trash (key, after) VALUES (?1, ?2)').bind(key, now() + TRASH_DELAY)))
    const expired = (await db.prepare('SELECT key FROM tinto_trash WHERE after <= ?1 LIMIT 100').bind(now()).all()).results.map((/** @type {any} */ row) => String(row.key))
    if (!expired.length) return
    await env.TINTO_MEDIA.delete(expired)
    await db.batch(expired.map(key => db.prepare('DELETE FROM tinto_trash WHERE key = ?1').bind(key)))
  }
  /** @param {any} env @param {string} id */
  async function previousStatus(env, id) {
    const row = await env.TINTO_DB.prepare('SELECT status FROM tinto_posts WHERE id = ?1').bind(id).first()
    return row ? String(row.status) : null
  }

  // Large files stream into R2 while their hash is computed, then are removed
  // again if their name or first bytes do not match.
  /** @param {Request} request @param {any} env @param {string} key @param {string} ext @param {string} expected @param {number} length */
  async function streamFile(request, env, key, ext, expected, length) {
    const head = new Uint8Array(64)
    let filled = 0
    const sniffer = new TransformStream({
      transform(chunk, controller) {
        if (filled < head.length) {
          const part = chunk.subarray(0, head.length - filled)
          head.set(part, filled)
          filled += part.length
        }
        controller.enqueue(chunk)
      }
    })
    // @ts-ignore Workers runtime classes.
    const digest = new crypto.DigestStream('SHA-256')
    // @ts-ignore Workers runtime classes.
    const sized = new FixedLengthStream(length)
    const [toStore, toHash] = /** @type {ReadableStream} */ (request.body).pipeThrough(sniffer).tee()
    await Promise.all([
      toHash.pipeTo(digest),
      toStore.pipeTo(sized.writable),
      env.TINTO_MEDIA.put(key, sized.readable, { httpMetadata: { contentType: FILE_TYPES[ext].type } })
    ])
    const hash = [...new Uint8Array(await digest.digest).subarray(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== expected || !FILE_TYPES[ext].test(head.subarray(0, filled))) {
      await env.TINTO_MEDIA.delete(key)
      throw new Rejection(422, 'The file did not arrive intact or is not the kind of file its name says. Publish again.')
    }
  }

  /** @param {Request} request @param {any} env @param {string} id @param {string} file */
  async function putFile(request, env, id, file) {
    const match = FILE_NAME.exec(file)
    if (!POST_ID.test(id) || !match) throw new Rejection(400, 'The file address is not valid.')
    const ext = match[2]
    const kind = FILE_TYPES[ext]
    const limit = FILE_CLASSES[kind.class].max
    const length = Number(request.headers.get('Content-Length') ?? NaN)
    if (length > limit) throw new Rejection(413, 'Files of this kind can be up to ' + Math.round(limit / 1048576) + ' MB.')
    const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
    if (type !== kind.type) throw new Rejection(422, 'The file type does not match its name.')
    const key = fileKey(id, file)
    // @ts-ignore Workers runtime classes.
    const streaming = typeof crypto.DigestStream === 'function' && typeof FixedLengthStream === 'function'
    if (streaming && ext !== 'csv' && Number.isSafeInteger(length) && length > STREAM_FROM && request.body) {
      await streamFile(request, env, key, ext, match[1], length)
      return new Response(null, { status: 201 })
    }
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.byteLength > limit) throw new Rejection(413, 'Files of this kind can be up to ' + Math.round(limit / 1048576) + ' MB.')
    if (!kind.test(bytes)) throw new Rejection(422, 'The file is not the kind of file its name says.')
    if (await contentName(bytes) !== match[1]) throw new Rejection(422, 'The file did not arrive intact. Publish again.')
    await env.TINTO_MEDIA.put(key, bytes, { httpMetadata: { contentType: kind.type } })
    return new Response(null, { status: 201 })
  }

  /** @param {Request} request @param {any} env @param {string} id @param {string} origin */
  async function putPost(request, env, id, origin) {
    if (!POST_ID.test(id)) throw new Rejection(400, 'The post address is not valid.')
    const raw = await request.text()
    if (raw.length > 2_000_000) throw new Rejection(413, 'The post is larger than this site accepts.')
    let input
    try { input = JSON.parse(raw) } catch { throw new Rejection(400, 'Send the post as JSON.') }
    const post = checkPost(input, site)
    const keep = new Set(postFiles(post).map(file => fileKey(id, file)))
    const missing = (await Promise.all([...keep].map(async key => (await env.TINTO_MEDIA.head(key)) ? null : key))).filter(Boolean)
    if (missing.length) throw new Rejection(422, 'A file of this post has not been uploaded. Publish again.')
    const db = env.TINTO_DB
    await schema(db)
    const before = await previousStatus(env, id)
    try {
      // One transaction: files the post uses again leave the trash before the post refers to them.
      await db.batch([
        ...[...keep].map(key => db.prepare('DELETE FROM tinto_trash WHERE key = ?1').bind(key)),
        db.prepare(UPSERT).bind(id, post.slug, post.language, post.locale, post.category, post.status, post.title, post.summary, post.date,
          JSON.stringify(post.tags), post.html, post.cover ? JSON.stringify(post.cover) : null, JSON.stringify(post.images),
          JSON.stringify(post.attachments), post.updatedAt)
      ])
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(/** @type {any} */ (error)?.message))) {
        throw new Rejection(409, 'Another post in this language' + (site.categories ? ' and category' : '') + ' already uses the address “' + post.slug + '”. Choose a different address.')
      }
      throw error
    }
    await tidy(env, id, keep)
    // A draft is not on any page, so only changes that touch published posts rebuild the site.
    if (post.status === 'published' || before === 'published') await rebuild(env, post.status === 'draft' ? 'saved as a draft' : 'saved')
    return json(200, { url: post.status === 'published' ? publicPost(site, { ...post, id }).url : null }, origin)
  }

  /** @param {any} env @param {string} id @param {string} origin */
  async function deletePost(env, id, origin) {
    if (!POST_ID.test(id)) throw new Rejection(400, 'The post address is not valid.')
    await schema(env.TINTO_DB)
    const before = await previousStatus(env, id)
    await env.TINTO_DB.prepare('DELETE FROM tinto_posts WHERE id = ?1').bind(id).run()
    await tidy(env, id, new Set())
    // A retry after a failed rebuild finds no post, so the rebuild runs then too.
    if (before !== 'draft') await rebuild(env, 'removed')
    return before ? new Response(null, { status: 204 }) : json(404, { error: 'This post is not on the site.' }, origin)
  }

  /** @param {any} env @param {string} method @param {string} origin */
  async function feed(env, method, origin) {
    bindings(env, false)
    let rows = []
    try { rows = (await env.TINTO_DB.prepare(FEED).all()).results ?? [] }
    catch (error) { if (!/no such table|no such column/i.test(String(/** @type {any} */ (error)?.message))) throw error }
    const posts = rows.map((/** @type {any} */ row) => publicPost(site, {
      ...row, tags: JSON.parse(row.tags), cover: row.cover ? JSON.parse(row.cover) : null, images: JSON.parse(row.images),
      attachments: JSON.parse(row.attachments ?? '[]'), updatedAt: row.updated_at
    }))
    return json(200, { tinto: PROTOCOL, name: site.name, posts }, origin, method === 'HEAD')
  }

  /** @param {Request} request @param {any} env @param {string} id @param {string} file @param {string} origin @param {any} ctx */
  async function serveFile(request, env, id, file, origin, ctx) {
    allow(request.method, ['GET', 'HEAD'])
    bindings(env)
    const match = FILE_NAME.exec(file)
    const notFound = () => new Response('Not found', { status: 404, headers: finish({ 'Content-Type': 'text/plain; charset=utf-8' }, origin) })
    if (!POST_ID.test(id) || !match) return notFound()
    const kind = FILE_TYPES[match[2]]
    const behaviour = FILE_CLASSES[kind.class]
    const ranged = behaviour.ranges && request.headers.has('Range') && request.method === 'GET'
    // Names depend on the content, so a whole file can be cached at the edge forever.
    const cache = !ranged && request.method === 'GET' && typeof caches !== 'undefined' ? /** @type {any} */ (caches).default : null
    const cached = cache ? await cache.match(request) : null
    if (cached) return cached
    const read = (/** @type {string} */ key) => request.method === 'HEAD' ? env.TINTO_MEDIA.head(key) : env.TINTO_MEDIA.get(key, ranged ? { range: request.headers } : undefined)
    // Protocol 1 stored images without a class folder; they keep working after an update.
    const object = await read(fileKey(id, file)) ?? await read('tinto/' + id + '/' + file)
    if (!object) return notFound()
    const headers = finish({
      'Content-Type': kind.type, ETag: object.httpEtag, 'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Disposition': behaviour.inline ? 'inline' : 'attachment'
    }, origin)
    if (behaviour.ranges) headers['Accept-Ranges'] = 'bytes'
    const tags = (request.headers.get('If-None-Match') ?? '').split(',').map(tag => tag.trim())
    if (tags.includes(object.httpEtag) || tags.includes('*')) {
      await object.body?.cancel?.()
      return new Response(null, { status: 304, headers })
    }
    if (ranged && object.range && typeof object.range.offset === 'number') {
      const { offset, length } = object.range
      headers['Content-Range'] = 'bytes ' + offset + '-' + (offset + length - 1) + '/' + object.size
      headers['Content-Length'] = String(length)
      return new Response(object.body, { status: 206, headers })
    }
    headers['Content-Length'] = String(object.size)
    const response = new Response(request.method === 'HEAD' ? null : object.body, { headers })
    if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(request, response.clone()))
    return response
  }

  /** @param {Request} request @param {any} env @param {string} path @param {string} origin @param {any} ctx */
  async function route(request, env, path, origin, ctx) {
    const method = request.method
    let match = /^\/files\/([^/]+)\/([^/]+)$/.exec(path)
    if (match) return serveFile(request, env, match[1], match[2], origin, ctx)
    if (path === '/feed') {
      allow(method, ['GET', 'HEAD'])
      return feed(env, method, origin)
    }
    // Everything else is for Tinto and needs the key.
    await authorize(request, env)
    if (path === '' || path === '/') {
      allow(method, ['GET'])
      const categories = Object.entries(site.categories ?? {}).map(([id, label]) => ({ id, label }))
      return json(200, { tinto: PROTOCOL, name: site.name, categories }, origin)
    }
    if ((match = /^\/posts\/([^/]+)\/files\/([^/]+)$/.exec(path))) {
      allow(method, ['PUT'])
      return putFile(request, env, match[1], match[2])
    }
    if ((match = /^\/posts\/([^/]+)$/.exec(path))) {
      allow(method, ['PUT', 'DELETE'])
      return method === 'PUT' ? putPost(request, env, match[1], origin) : deletePost(env, match[1], origin)
    }
    throw new Rejection(404, 'This site has no Tinto address like that.')
  }

  return {
    // Returns null for addresses outside basePath, so the site handles them as usual.
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      if (url.pathname !== site.basePath && !url.pathname.startsWith(site.basePath + '/')) return null
      try { return await route(request, env, url.pathname.slice(site.basePath.length), url.origin, ctx) }
      catch (error) {
        if (error instanceof Rejection) return json(error.status, { error: error.message }, url.origin)
        console.error('Tinto blog module:', error)
        return json(500, { error: 'The site could not complete the request.' }, url.origin)
      }
    }
  }
}
