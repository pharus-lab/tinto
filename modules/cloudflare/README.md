# Tinto blog module for Cloudflare

Copy this folder into a site that runs on Cloudflare Workers to receive posts from [Tinto](../../README.md). The module adds the Tinto publishing API, a public feed of the posts, and the post images. The site keeps its own pages and style. You render the posts with your own layout.

| Address | What it does |
| --- | --- |
| `<basePath>` | Lets Tinto check the site and its key. |
| `<basePath>/posts/…` | Receives posts and images from Tinto. Requires the API key. |
| `<basePath>/feed` | Public JSON with every published post, for the site build. |
| `<basePath>/media/<post>/<file>` | Public post images, served from R2. |

The module protocol is described in [docs/site-contract.md](../../docs/site-contract.md).

## Set up a site

1. **Copy the folder.** Copy `modules/cloudflare` into the site as `tinto/`. The files are plain ES modules (`.mjs`) with no dependencies.
2. **Edit `tinto/tinto.config.mjs`.** This is the only file in the module that you change.
   - `name`: shown in Tinto.
   - `site`: the canonical address.
   - `basePath`: where the module answers.
   - `languages`: maps Tinto language codes to your locale segments, such as `{ en: 'en', es: 'castellano' }`.
   - `postPath`: builds each post's public path. Set it to `null` until the site has post pages.
3. **Create the storage and add the bindings to `wrangler.jsonc`.** The module creates its tables on the first post, so the database needs no migrations.
   ```sh
   npx wrangler d1 create my-site-tinto
   npx wrangler r2 bucket create my-site-tinto-media
   ```
   ```jsonc
   "d1_databases": [{ "binding": "TINTO_DB", "database_name": "my-site-tinto", "database_id": "<id from the first command>" }],
   "r2_buckets": [{ "binding": "TINTO_MEDIA", "bucket_name": "my-site-tinto-media" }]
   ```
4. **Route requests to the module.** Do this in the Worker, after any redirect to the canonical host. `fetch` returns `null` for every address outside `basePath`.
   ```js
   import { createTintoBlog } from '../tinto/worker.mjs'
   import tintoConfig from '../tinto/tinto.config.mjs'
   const tinto = createTintoBlog(tintoConfig)

   // In fetch(request, env, ctx):
   const handled = await tinto.fetch(request, env, ctx)
   if (handled) return handled
   ```
   A site that serves only static assets needs a small Worker. Add `"main": "worker.mjs"`, and set `"run_worker_first": ["/api/tinto/*"]` under `assets`:
   ```js
   export default { async fetch(request, env, ctx) { return (await tinto.fetch(request, env, ctx)) ?? env.ASSETS.fetch(request) } }
   ```
5. **Add the secrets.**
   - `TINTO_API_KEY` is required. Generate it with `openssl rand -base64 32`, then run `npx wrangler secret put TINTO_API_KEY`.
   - `TINTO_DEPLOY_HOOK` is optional. Static sites need it so they rebuild after each post. In the dashboard, open the Worker's **Settings → Builds → Deploy Hooks**, create a hook for the production branch, and save its URL with `npx wrangler secret put TINTO_DEPLOY_HOOK`.
6. **Show the posts in your own layout.**
   - **Astro:** add the loader in `src/content.config.ts`, then render the posts with your own page:
     ```ts
     import { defineCollection } from 'astro:content'
     import { tintoPosts } from '../tinto/astro.mjs'
     import tintoConfig from '../tinto/tinto.config.mjs'
     export const collections = { posts: defineCollection({ loader: tintoPosts(tintoConfig) }) }
     ```
     ```astro
     <Layout title={post.title}><article set:html={post.html} /></Layout>
     ```
     `post.html` contains only `p`, `h1`–`h6`, `strong`, `em` and `mark`, without attributes, and the module checks it again on every build. Images have a same-origin `url`, so a strict CSP such as `img-src 'self'` keeps working.
   - **Other frameworks:** read `<site><basePath>/feed` at build time, or read `TINTO_DB` while serving.
7. **Connect Tinto.** In Tinto, open **Settings → Websites**. Enter `https://<your-site><basePath>` as the publishing URL, plus the key from step 5.

## How it behaves

- **Saving a post.** Tinto sends new images first, then the post. The module checks each image's name against its SHA-256, checks its type from its bytes (15 MB at most), and checks the HTML and fields. It then saves the post in `tinto_posts` and calls the deploy hook. If the hook fails, Tinto shows the error, and publishing again retries.
- **Addresses and languages.** An address can be used once per locale. A second post in the same locale gets an error in Tinto. Languages missing from `languages` are refused.
- **Images the post stops using.** They are kept for one hour after a change, so pages built before the change still show them. Each later change removes the expired ones. Image keys in R2 start with `tinto/`, so the bucket can hold other files.
- **The build.** The loader reads the site's live feed. A 404 means the module has not been deployed yet, and the site builds without posts. On Workers Builds (`WORKERS_CI=1`), any other failure stops the build, so the live site keeps its posts. Locally, the build continues without posts. Set `TINTO_FEED` to read another address.
- **Local testing.** Run `npx wrangler dev --var TINTO_API_KEY:<a long test key>`, then add `http://localhost:8787<basePath>` in Tinto. Tinto accepts plain `http` only for localhost.
