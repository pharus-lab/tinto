# Tinto blog module, protocol 1

A website that includes the Tinto blog module can receive posts from Tinto. The module exposes a small HTTPS API and gives the writer two values to paste into Tinto's **Settings → Websites**:

- **Publishing URL**: the base address of the API, for example `https://example.com/api/tinto`.
- **API key**: a random secret of 20 to 512 printable ASCII characters, without spaces.

A site on Cloudflare Workers can copy the ready-made module in [modules/cloudflare](../modules/cloudflare/README.md) instead of implementing this API.

One Tinto installation can publish to several websites, and one website can accept posts from several Tinto installations that share its key. The module stores the posts, serves the images, and updates the site in whatever way the site is built.

## Requests

Every request carries `Authorization: Bearer <key>` and `Accept: application/json`. Tinto does not follow redirects, so the publishing URL must be the final address. It must use `https:`. Plain `http:` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, so a module can be tested locally.

| Request | Body | Successful response |
| --- | --- | --- |
| `GET <url>` | None | `200` with `{ "tinto": 1, "name": "Site name" }`. Tinto calls this to check the address and key when the site is added or tested. It must not change anything. |
| `PUT <url>/posts/<id>/images/<file>` | The image bytes, with its `Content-Type` | Any `2xx`. Sending the same file again is harmless. |
| `PUT <url>/posts/<id>` | A post, as JSON | Any `2xx`, optionally with `{ "url": "https://…" }`, the post's public address. |
| `DELETE <url>/posts/<id>` | None | Any `2xx`, or `404` when the post does not exist. |

- **`id`** is a UUID. It stays the same for a document or section published from one project to one website, whatever its title or address. `PUT` creates or replaces the post with that id.
- **`file`** is the first 32 hexadecimal characters of the image's SHA-256, plus `.png`, `.jpg`, `.webp`, `.gif` or `.avif`. The file name depends only on the content, so a stored image never changes. Tinto checks each image's signature before sending it. Images are at most 15 MB, and a post has at most 20 of them.

Tinto uploads every new image of a post before it sends the post. It does not upload images that the post already had on that website.

## The post

```json
{
  "slug": "first-light",
  "language": "en",
  "title": "First light",
  "summary": "A short note.",
  "date": "2026-11-21",
  "tags": ["research", "notes"],
  "html": "<p>Some <strong>bold</strong> &amp; <u>underlined</u> text.</p>",
  "cover": { "file": "3f2a…9c.png", "type": "image/png", "alt": "A bench in the park" },
  "images": [{ "file": "a71d…04.jpg", "type": "image/jpeg", "alt": "" }],
  "updatedAt": "2026-11-21T18:00:00.000Z"
}
```

| Field | Meaning |
| --- | --- |
| `slug` | The address chosen by the writer: lowercase ASCII letters, digits and single hyphens, up to 100 characters. |
| `language` | The document's language code, such as `en`, `es` or `en-GB`. The site decides how it maps languages to its routes, and it can refuse languages it does not publish. |
| `title`, `summary` | Plain text, up to 200 and 500 characters. Escape them when rendering. |
| `date` | The writer's publication date, `YYYY-MM-DD`. |
| `tags` | Up to 20 plain-text strings of up to 40 characters. |
| `html` | The chosen wording only. It contains just `<p>`, `<h1>` to `<h6>`, `<strong>`, `<em>` and `<u>` (the author's underline), without attributes, and all text is escaped. Accept `<mark>` as well, which earlier Tinto versions sent for the same mark. For a linked section, the section heading becomes `title` and is left out of the body. |
| `cover` | `{ "file", "type", "alt" }` or `null`. `file` names an image uploaded for this post. |
| `images` | The gallery, in the writer's order, with the same shape as `cover`. |
| `updatedAt` | The ISO 8601 time of this publication. |

Respond to `PUT` only after the post is saved and the site update has started. When the post cannot be published, return an error instead. Tinto then keeps its previous record, and the writer can send the same post again.

## Errors

Return a JSON body `{ "error": "message" }` with a plain-language message for the writer. Tinto shows the message for `400`, `409`, `413` and `422`, and explains the other statuses itself:

| Status | Use it when |
| --- | --- |
| `401` or `403` | The key is missing or wrong. |
| `404` on `GET <url>` | There is no module at this address. |
| `409` | Another post in the same language already uses the address. |
| `413` | An image is larger than the site accepts. |
| `400` or `422` | The site rejects the post or image, for example an unsupported language. |
| `429` | The site is limiting requests. |

## What the module is responsible for

- **Keys.** Store the key as a secret, compare it in constant time, and let the owner replace it. When the key changes, the writer adds the same publishing URL again in Tinto with the new key.
- **Validation.** Treat every request as untrusted. Check the id, file names, image types and the HTML subset again before storing or rendering anything.
- **Images.** Serve images from the site's own origin. Delete images that a post no longer references, once no published page uses them. `DELETE` removes the post and all of its images.
- **Updating the site.** Make the change visible, for example by rendering pages on request or by starting a rebuild of a static site.
