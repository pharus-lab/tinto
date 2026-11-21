# Tinto blog module for Cloudflare

This folder lets a site on Cloudflare Workers receive posts from Tinto, a writing app. The module adds a publishing API for Tinto, a public feed of the posts, and the post images. The site keeps its own pages and style. You render the posts with your own layout.

| Address | What it does |
| --- | --- |
| `<basePath>` | Lets Tinto check the site and its key. |
| `<basePath>/posts/…` | Receives posts and images from Tinto. Requires the API key. |
| `<basePath>/feed` | Public JSON with every published post, for the site build. |
| `<basePath>/media/<post>/<file>` | Public post images, served from R2. |

**The quickest path is Tinto's guide.** In Tinto, open **Settings → Websites** and choose **?** next to *Add a website*. The guide does three things:
- writes this folder into your site, with the configuration filled in;
- gives your coding agent a prompt that follows the section below;
- walks you through the key, the rebuild hook, and the connection.

To update the module later, run the guide's *Save module* step on the same site folder. It replaces the code and keeps `tinto.config.mjs`.

## For coding agents

Connect this module to the site you are working in. Only change what the steps ask for.

1. **Check the hosting.** The site must deploy to Cloudflare Workers, so it has `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`. If it deploys to Cloudflare Pages or another host, stop and explain.
2. **Review `tinto/tinto.config.mjs`.** This is the only file in `tinto/` to edit.
   - `name` and `site` are already filled in. `site` must be the canonical address, the one other hosts redirect to.
   - `languages` is optional. Set it only when the URL segment of a language differs from its code, or when the site should refuse other languages. For example, `{ en: 'en', es: 'es' }` maps each Tinto code to a segment.
   - `postPath` returns the path of a post's page, for example `post => '/' + post.locale + '/blog/' + post.slug`. Leave it `null` until those pages exist.
3. **Add the bindings without IDs.** Wrangler 4.45 or later creates the D1 database and the R2 bucket on the next deploy. Do not run `wrangler d1 create`, and do not paste IDs. If Wrangler is older, add `wrangler@latest` as a dev dependency.
   ```jsonc
   "d1_databases": [{ "binding": "TINTO_DB" }],
   "r2_buckets": [{ "binding": "TINTO_MEDIA" }]
   ```
   Resources that already exist can be bound with their IDs instead.
4. **Route requests to the module.** In the Worker's `fetch`, after any redirect to the canonical host and before static assets, add the following. `tinto.fetch` returns `null` outside `basePath`. The import paths are relative to the Worker file. Use `./tinto/…` when that file is at the project root.
   ```js
   import { createTintoBlog } from '../tinto/worker.mjs'
   import tintoConfig from '../tinto/tinto.config.mjs'
   const tinto = createTintoBlog(tintoConfig)

   // In fetch(request, env, ctx):
   const handled = await tinto.fetch(request, env, ctx)
   if (handled) return handled
   ```
   A site that serves only static assets has no Worker yet. Add `worker.mjs` at the project root:
   ```js
   import { createTintoBlog } from './tinto/worker.mjs'
   import tintoConfig from './tinto/tinto.config.mjs'
   const tinto = createTintoBlog(tintoConfig)

   export default {
     async fetch(request, env, ctx) {
       return (await tinto.fetch(request, env, ctx)) ?? env.ASSETS.fetch(request)
     }
   }
   ```
   Then point the configuration at it, and let it run first for the module's addresses:
   ```jsonc
   "main": "worker.mjs",
   "assets": { "directory": "<your build folder>", "binding": "ASSETS", "run_worker_first": ["/api/tinto/*"] }
   ```
5. **Make the posts available to pages.**
   - **Astro.** Add the collection in `src/content.config.ts`:
     ```ts
     import { defineCollection } from 'astro:content'
     import { tintoPosts } from '../tinto/astro.mjs'
     import tintoConfig from '../tinto/tinto.config.mjs'
     export const collections = { posts: defineCollection({ loader: tintoPosts(tintoConfig) }) }
     ```
   - **Other static frameworks.** Read `<site><basePath>/feed` at build time. It returns `{ tinto: 1, name, posts }`.
   - **Server-rendered sites.** Read the feed, or the `tinto_posts` table in `TINTO_DB`, while serving.
6. **Leave the rest to the owner.** Do not create secrets, deploy, commit or push. The owner adds `TINTO_API_KEY` and, for static sites, `TINTO_DEPLOY_HOOK`.
7. **Check your work.** Run the site's build and tests. When you are done, report:
   - the files you changed;
   - the publishing URL, `<site><basePath>`;
   - any step the owner must do by hand.

### Showing posts in the site's design

Only do this when asked.
- Add a post list and a post page that reuse the site's existing layout, components, typography and styles.
- Render `post.html` as HTML. It contains only `p`, `h1`–`h6`, `strong`, `em` and `u` (the author's underline; posts from older Tinto versions may use `mark`), with no attributes, and the module checks it again on every build. Render `title`, `summary` and `tags` as text.
- Show `cover` and `images` with their `alt`. Their `url` is on the same origin, so a strict CSP such as `img-src 'self'` keeps working.
- Follow the site's language routes, and set `postPath` to match the new post page.

## Secrets

- **`TINTO_API_KEY` (required).** Tinto's guide generates the key. You can also run `openssl rand -base64 32`. Store it with `npx wrangler secret put TINTO_API_KEY` from the site folder.
- **`TINTO_DEPLOY_HOOK` (static sites).** In the Cloudflare dashboard, open the Worker's **Settings → Builds → Deploy Hooks**. Create a hook for the production branch, then store its URL with `npx wrangler secret put TINTO_DEPLOY_HOOK`.

Deploy the site after adding the module. Then add `<site><basePath>` and the key in Tinto's **Settings → Websites**.

## How it behaves

- **Saving a post.** Tinto sends new images first, then the post. The module:
  - checks each image's name against its SHA-256;
  - checks each image's type from its bytes (15 MB at most);
  - checks the HTML and the fields;
  - saves the post in `tinto_posts`, creating the tables when it saves the first post;
  - calls the deploy hook.

  If the hook fails, Tinto shows the error, and publishing again retries.
- **Addresses and languages.** An address can be used once per locale. A second post with the same address in that locale gets an error in Tinto. When `languages` is set, other languages are refused.
- **Images the post stops using.** They are kept for one hour after a change, so pages built before the change still show them. Each later change removes the expired ones. Image keys in R2 start with `tinto/`, so the bucket can hold other files.
- **The build.** The loader reads the site's live feed.
  - **404:** the module has not been deployed yet, so the site builds without posts.
  - **Any other failure on Workers Builds** (`WORKERS_CI=1`): the build stops, so the live site keeps its posts.
  - **Any other failure locally:** the build continues without posts.

  Set `TINTO_FEED` to read another address.
- **Local testing.** Run `npx wrangler dev --local-upstream localhost:8787 --var TINTO_API_KEY:<a long test key>`, then add `http://localhost:8787<basePath>` in Tinto. `wrangler dev` creates local D1 and R2 storage. `--local-upstream` keeps routes in the Wrangler configuration from sending local requests to the production host. Tinto accepts plain `http` only for localhost.
- **Protocol.** Tinto's `docs/site-contract.md` describes the protocol (Tinto blog module, protocol 1).
