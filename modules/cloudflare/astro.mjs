// Tinto blog module for Cloudflare — an Astro content loader for static sites.
// At build time it reads the site's own public feed (<site><basePath>/feed),
// so the build needs no Cloudflare credentials. Set TINTO_FEED to read another
// address, such as a local `wrangler dev`.

import { PROTOCOL, readFeed, settings } from './shared.mjs'

/**
 * @param {import('./shared.mjs').TintoConfig} config
 * @returns {import('astro/loaders').Loader}
 */
export function tintoPosts(config) {
  const site = settings(config)
  return {
    name: 'tinto-blog',
    async load({ store, logger, generateDigest }) {
      const feed = process.env.TINTO_FEED || site.site + site.basePath + '/feed'
      // On Workers Builds a missing feed stops the build, so the live site keeps its posts.
      const unavailable = (/** @type {string} */ reason) => {
        const message = 'The Tinto feed at ' + feed + ' ' + reason + '.'
        if (process.env.WORKERS_CI === '1') throw Error(message + ' The build stops so the live site keeps its posts.')
        logger.warn(message + ' Building without Tinto posts.')
        store.clear()
      }
      let response
      try { response = await fetch(feed, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }) }
      catch (error) { return unavailable('could not be reached (' + (error instanceof Error ? error.message : String(error)) + ')') }
      if (response.status === 404) {
        // The module is not deployed yet, so there are no posts to show.
        logger.warn('There is no Tinto feed at ' + feed + ' yet. Building without Tinto posts.')
        store.clear()
        return
      }
      if (!response.ok) return unavailable('returned HTTP ' + response.status)
      const body = await response.json().catch(() => null)
      if (typeof body?.tinto === 'number' && body.tinto > PROTOCOL) return unavailable('uses Tinto blog protocol ' + body.tinto + ', but this copy of the module uses ' + PROTOCOL + '. Update the module and deploy')
      if (typeof body?.tinto !== 'number' || body.tinto < 1 || !Array.isArray(body.posts)) return unavailable('did not return a Tinto feed')
      // The build that deploys a module update still reads the live site's older
      // feed. Its posts have no category, so they are read as they are.
      const older = body.tinto < PROTOCOL
      if (older) logger.warn('The live site still runs Tinto blog protocol ' + body.tinto + '. This build reads its posts as they are; publishing them again from Tinto gives them the newer fields.')
      const posts = readFeed(older ? { ...site, categories: null } : site, body.posts)
      store.clear()
      // The same address can exist in different categories.
      for (const post of posts) store.set({ id: [post.locale, post.category, post.slug].filter(Boolean).join('/'), data: post, digest: generateDigest(post) })
      const counts = Object.entries(Object.groupBy(posts, post => post.locale)).map(([locale, list]) => locale + ' ' + (list?.length ?? 0))
      logger.info('Loaded ' + posts.length + ' Tinto post' + (posts.length === 1 ? '' : 's') + (counts.length ? ' (' + counts.join(', ') + ')' : '') + '.')
    }
  }
}
