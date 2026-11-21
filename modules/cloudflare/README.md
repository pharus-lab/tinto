# Tinto blog module for Cloudflare

This folder lets a site on Cloudflare Workers receive posts from Tinto, a writing app. The module adds a publishing API for Tinto, a public feed of the published posts, and the post files: images, documents, audio, video and downloads. The site keeps its own pages and style. You render the posts with your own layout.

| Address | What it does |
| --- | --- |
| `<basePath>` | Lets Tinto check the site and its key. |
| `<basePath>/posts/…` | Receives posts, drafts and files from Tinto. Requires the API key. |
| `<basePath>/feed` | Public JSON with every published post, for the site build. Drafts are not included. |
| `<basePath>/files/<post>/<file>` | Public post files, served from R2. |
| `<basePath>/preview/<post>?…` | A post shown in the site's own design, through a signed link that Tinto opens for one hour. |
| `<basePath>/credentials/<post>` | The author's signed authorship credential of a published post, for anyone to verify. |

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
   - `categories` is optional. It lists the sections or pages a post can belong to, such as `{ blog: 'Blog', notes: 'Notes' }`. Tinto offers them when publishing. Leave it `null` when the site has one list of posts, and do not invent categories the owner has not asked for.
   - `postPath` returns the path of a post's page, for example `post => '/' + post.locale + '/' + post.category + '/' + post.slug`. Leave it `null` until those pages exist.
   - `author` is filled in by Tinto with the writer's author key, or `null`. Leave it as it is.
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
   Then point the configuration at it, and let it run first for the module's addresses and the preview page:
   ```jsonc
   "main": "worker.mjs",
   "assets": { "directory": "<your build folder>", "binding": "ASSETS", "run_worker_first": ["/api/tinto/*", "/tinto-preview*"] }
   ```
   The module reads the preview page through the `ASSETS` binding, so keep that binding name.
5. **Make the posts available to pages.**
   - **Astro.** Add the collection in `src/content.config.ts`:
     ```ts
     import { defineCollection } from 'astro:content'
     import { tintoPosts } from '../tinto/astro.mjs'
     import tintoConfig from '../tinto/tinto.config.mjs'
     export const collections = { posts: defineCollection({ loader: tintoPosts(tintoConfig) }) }
     ```
   - **Other static frameworks.** Read `<site><basePath>/feed` at build time. It returns `{ tinto: 2, name, posts }`, with published posts only.
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
- Show `cover` and `images` with their `alt`.
- List `attachments` by their `title`, linking to their `url`:
  - use `<audio>` and `<video>` for media;
  - link PDFs normally;
  - use the `download` attribute for ZIP and CSV.

  Every `url` is on the same origin, so a strict CSP such as `default-src 'self'` keeps working.
- When the site has categories, use `post.category` to place each post on its page or section.
- Show who wrote the post, quietly, near the title or the date: `authorshipLabel(post.authorship)` from `tinto/credential.mjs` returns a line such as *Original · written by Ana*, or an empty string for a post without a verified credential. Style it like the site's other small metadata. Never hide it when `post.authorship.ai` is true. Link it to `post.authorship.credential` if the owner wants readers to check the signature.
- Follow the site's language routes, and set `postPath` to match the new post page.
- Add the preview page described below, built from the same post layout.

### Preview page

Tinto's **Preview** shows a post in the site's design before it is published. The site provides one page, at `previewPath` (`/tinto-preview` by default). Build it from the same layout and components as a real post page, with markers in place of the values. The module fills the markers for each preview and returns 404 to anyone who opens the page directly.

- **Fields.** Use `%%title%%`, `%%summary%%`, `%%date%%`, `%%category%%`, `%%language%%` and `%%authorship%%` (the quiet authorship line) in text or attributes. They are filled in as escaped text. Use `%%body%%` inside a `div` for the post HTML.
- **Repeated or optional parts.** Wrap the markup for one item in `<template data-tinto-each="…">`. The module repeats it for each item and removes it when there is none.

| Block | Item markers |
| --- | --- |
| `cover` | `%%url%%`, `%%alt%%`. Used once, or removed when there is no cover. |
| `images` | `%%url%%`, `%%alt%%` |
| `tags` | `%%tag%%` |
| `attachments` | `%%url%%`, `%%title%%`, `%%type%%`, `%%size%%` |

- **Keep it out of search and listings.** Leave the page out of the sitemap and navigation, and add `<meta name="robots" content="noindex">`.

Example in Astro, at `src/pages/tinto-preview.astro`. Use the site's own layout and classes:

```astro
---
import PostLayout from '../layouts/PostLayout.astro'
---
<PostLayout title="%%title%%" noindex>
  <article class="post">
    <h1>%%title%%</h1>
    <p class="byline">%%authorship%%</p>
    <p class="summary">%%summary%%</p>
    <template data-tinto-each="cover"><img class="cover" src="%%url%%" alt="%%alt%%"></template>
    <div class="post-body">%%body%%</div>
    <ul class="attachments"><template data-tinto-each="attachments"><li><a href="%%url%%">%%title%%</a> · %%size%%</li></template></ul>
  </article>
</PostLayout>
```

## Authorship

Tinto signs every post with the writer's author key. The signature is a W3C Verifiable Credential (`eddsa-jcs-2022`, Ed25519) that names the author by `did:key`, hashes the text, each paragraph and each file, and says how much of each paragraph was written in Tinto, pasted, imported or generated by AI. Tinto's `docs/site-contract.md` describes it.

- **One author per site.** The site accepts posts signed by the key in `author` in `tinto.config.mjs`. When `author` is `null`, the first signed post sets it, in the `tinto_author` table. After that, unsigned posts and posts from other keys are refused, and Tinto shows the writer why.
- **Changing the author.** Set `author` to the new key, which Tinto shows in **Settings → Author**, and deploy. To go back to the first-post rule, set `author` to `null` and delete the row in `tinto_author`.
- **What pages get.** Each post in the feed has `authorship`: `{ verified, author: { id, name }, original, ai, digitalSourceType, parts, signed, credential }`. `parts` follows the paragraphs and headings of `html`, each with its `origin` (`written`, `pasted`, `imported`, `ai` or `mixed`). Posts from before authorship have `authorship: null`.
- **Checking it again.** `<basePath>/credentials/<post>` returns the signed credential as `application/vc`. Any Verifiable Credentials library that supports `eddsa-jcs-2022` can verify it. So can `verifyCredential` in `tinto/credential.mjs`.

## Secrets

- **`TINTO_API_KEY` (required).** Tinto's guide generates the key. You can also run `openssl rand -base64 32`. Store it with `npx wrangler secret put TINTO_API_KEY` from the site folder.
- **`TINTO_DEPLOY_HOOK` (static sites).** In the Cloudflare dashboard, open the Worker's **Settings → Builds → Deploy Hooks**. Create a hook for the production branch, then store its URL with `npx wrangler secret put TINTO_DEPLOY_HOOK`.

Deploy the site after adding the module. Then add `<site><basePath>` and the key in Tinto's **Settings → Websites**.

## How it behaves

- **Saving a post.** Tinto sends new files first, up to three at a time, then the post. The module:
  - checks each file's name against its SHA-256;
  - checks each file's type from its first bytes;
  - checks the HTML and the fields;
  - saves the post in `tinto_posts`, creating the tables when it saves the first post;
  - calls the deploy hook when the change affects published posts.

  If the hook fails, Tinto shows the error, and publishing again retries.
- **File limits.** Images: 15 MB. PDF, ZIP and CSV: 25 MB. Audio (MP3, M4A, OGG): 50 MB. Video (MP4, WebM): 95 MB.
- **Large files.** Audio, video and documents over 8 MB stream into R2 while their hash is checked, so the Worker never holds the whole file in memory.
- **Drafts.** A draft is stored with its files but stays out of the feed, so building the site leaves it out. Saving or deleting a draft does not call the deploy hook. Publishing it, or moving a published post back to drafts, does.
- **Addresses, languages and categories.** An address can be used once per locale and category. A second post with the same address gets an error in Tinto. When `languages` or `categories` is set, values outside that list are refused.
- **Storage and serving.** Files are stored by class under `tinto/<post>/images|documents|audio|video|downloads/` in R2, so the bucket can hold other files.
  - The module serves them with a permanent cache, and keeps them in Cloudflare's edge cache on custom domains.
  - Audio, video and PDFs answer `Range` requests, so players can seek.
  - ZIP and CSV are sent as downloads.
- **Files the post stops using.** They are kept for one hour after a change, so pages built before the change still show them. Each later change removes the expired ones.
- **Authorship.** The module verifies each post's signature with Web Crypto, checks that it describes exactly that post, and keeps the credential with the post. A site updated from an earlier module keeps its older posts, without authorship, until they are published again.
- **Previews.** Tinto sends the post to `<basePath>/previews/<post>` and opens the signed link that comes back.
  - The preview is stored beside the live post, so nothing published changes, and no rebuild runs.
  - The link works for one hour. Files uploaded only for a preview go to the trash when it expires.
- **Upgrading from protocol 1.** Update the module with Tinto's guide and deploy.
  - The build of that deploy still reads the live protocol 1 feed and keeps its posts.
  - The first change after the deploy upgrades the `tinto_posts` table in place.
  - Images stored by protocol 1 keep being served.
  - Publishing a post again gives it the newer fields.
- **The build.** The loader reads the site's live feed.
  - **404:** the module has not been deployed yet, so the site builds without posts.
  - **Any other failure on Workers Builds** (`WORKERS_CI=1`): the build stops, so the live site keeps its posts.
  - **Any other failure locally:** the build continues without posts.

  Set `TINTO_FEED` to read another address.
- **Local testing.** Run `npx wrangler dev --local-upstream localhost:8787 --var TINTO_API_KEY:<a long test key>`, then add `http://localhost:8787<basePath>` in Tinto. `wrangler dev` creates local D1 and R2 storage. `--local-upstream` keeps routes in the Wrangler configuration from sending local requests to the production host. Tinto accepts plain `http` only for localhost.
- **Protocol.** Tinto's `docs/site-contract.md` describes the protocol (Tinto blog module, protocol 2). Tinto refuses a site whose module uses an older protocol and asks you to update it with the guide.
