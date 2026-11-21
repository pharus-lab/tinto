# Tinto blog module, protocol 2

A website that includes the Tinto blog module can receive posts from Tinto. The module exposes a small HTTPS API. It gives the writer two values to paste into Tinto's **Settings → Websites**:

- **Publishing URL**: the base address of the API, for example `https://example.com/api/tinto`.
- **API key**: a random secret of 20 to 512 printable ASCII characters, without spaces.

A site on Cloudflare Workers can copy the ready-made module in [modules/cloudflare](../modules/cloudflare/README.md) instead of implementing this API.

One Tinto installation can publish to several websites. A website that checks authorship accepts posts from one author, who can use the same author key on several computers. The module stores the posts and files, serves the files, and updates the site in whatever way the site is built.

Protocol 2 adds three things to protocol 1:
- files other than images;
- categories;
- drafts.

Tinto refuses a site on protocol 1 and asks the writer to update its module.

## Requests

Every request carries `Authorization: Bearer <key>` and `Accept: application/json`. Tinto does not follow redirects, so the publishing URL must be the final address. It must use `https:`. Plain `http:` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, so a module can be tested locally.

| Request | Body | Successful response |
| --- | --- | --- |
| `GET <url>` | None | `200` with `{ "tinto": 2, "name": "Site name", "categories": [{ "id": "notes", "label": "Notes" }] }`. Tinto calls this to check the address and key when the site is added or tested. The list of categories can be empty. The request must not change anything. |
| `PUT <url>/posts/<id>/files/<file>` | The file's bytes, with its `Content-Type` | Any `2xx`. Sending the same file again is harmless. |
| `PUT <url>/posts/<id>` | A post, as JSON | Any `2xx`, optionally with `{ "url": "https://…" }`, the post's public address. |
| `DELETE <url>/posts/<id>` | None | Any `2xx`, or `404` when the post does not exist. |

- **`id`** is a UUID. It stays the same for a document or section published from one project to one website, whatever its title or address. `PUT` creates or replaces the post with that id.
- **`file`** is the first 32 hexadecimal characters of the file's SHA-256, followed by its extension. The name depends only on the content, so a stored file never changes. Tinto checks each file's first bytes before sending it.

| Class | Extensions | Largest file |
| --- | --- | --- |
| Images | `png`, `jpg`, `webp`, `gif`, `avif` | 15 MB |
| Documents | `pdf` | 25 MB |
| Audio | `mp3`, `m4a`, `ogg` | 50 MB |
| Video | `mp4`, `webm` | 95 MB |
| Downloads | `zip`, `csv` (UTF-8 text without NUL bytes) | 25 MB |

Tinto uploads every new file of a post, up to three at a time, before it sends the post. It does not upload files that the post already had on that website. A post includes at most 30 files.

## The post

```json
{
  "slug": "first-light",
  "language": "en",
  "category": "notes",
  "status": "published",
  "title": "First light",
  "summary": "A short note.",
  "date": "2026-11-21",
  "tags": ["research", "notes"],
  "html": "<p>Some <strong>bold</strong> &amp; <u>underlined</u> text.</p>",
  "cover": { "file": "3f2a…9c.png", "type": "image/png", "alt": "A bench in the park" },
  "images": [{ "file": "a71d…04.jpg", "type": "image/jpeg", "alt": "" }],
  "attachments": [{ "file": "c0de…11.pdf", "type": "application/pdf", "title": "Field notes", "size": 48213 }],
  "updatedAt": "2026-11-21T18:00:00.000Z",
  "credential": { "@context": ["https://www.w3.org/ns/credentials/v2"], "type": ["VerifiableCredential", "AuthorshipCredential"], "…": "…" }
}
```

| Field | Meaning |
| --- | --- |
| `slug` | The address chosen by the writer: lowercase ASCII letters, digits and single hyphens, up to 100 characters. |
| `language` | The document's language code, such as `en`, `es` or `en-GB`. The site decides how it maps languages to its routes, and it can refuse languages it does not publish. |
| `category` | One of the ids the site returned from `GET <url>`, or `""` when the site has none. Sites use it for sections or separate pages. |
| `status` | `"published"`, or `"draft"`. A draft and its files are stored, but the draft stays off the site's pages until a later `PUT` publishes it. |
| `title`, `summary` | Plain text, up to 200 and 500 characters. Escape them when rendering. |
| `date` | The writer's publication date, `YYYY-MM-DD`. |
| `tags` | Up to 20 plain-text strings of up to 40 characters. |
| `html` | The chosen wording only. It contains just `<p>`, `<h1>` to `<h6>`, `<strong>`, `<em>` and `<u>` (the author's underline), without attributes, and all text is escaped. Accept `<mark>` as well, which earlier Tinto versions sent for the same mark. For a linked section, the section heading becomes `title` and is left out of the body. |
| `cover` | An image: `{ "file", "type", "alt" }`, or `null`. |
| `images` | The gallery, in the writer's order. Each entry has the same shape as `cover`. |
| `attachments` | Documents, audio, video and downloads, in the writer's order: `{ "file", "type", "title", "size" }`. The writer chooses each `title`. It is the only file name that leaves Tinto. |
| `updatedAt` | The ISO 8601 time of this publication. |
| `credential` | The author's signed authorship credential. See *Authorship* below. A module that does not check authorship can ignore it. |

Respond to `PUT` only after the post is saved and the site update has started. When the post cannot be published, return an error instead. Tinto then keeps its previous record, and the writer can send the same post again.

Each time Tinto publishes a post whose text changed, it saves a named version of the document in its own History (*Released on <site>*). The website therefore holds the text of that release until the next publication. Tinto shows *Changed since the release* while the writer keeps editing.

## Preview (optional)

A module can let the writer see a post in the site's own design before publishing it. Tinto sends `PUT <url>/previews/<id>` with the same JSON as a post. The module checks it like a post and keeps it apart from the live post.

The module answers with `{ "url": "<origin><path>?…" }`, a signed link on the same origin as the publishing URL that works for a limited time. Tinto opens that link in the writer's browser. The page shows the post with the site's layout. It must not be indexed, and it must not change anything that is published or start a rebuild.

A module without previews answers `404`, and Tinto then asks the writer to update the module. A module whose site has no preview page answers `422` with a message saying so.

## Authorship (optional)

Tinto signs every post and preview with the writer's author key. The `credential` field is a [W3C Verifiable Credential 2.0](https://www.w3.org/TR/vc-data-model-2.0/) secured with an embedded [Data Integrity](https://www.w3.org/TR/vc-data-integrity/) proof, cryptosuite [`eddsa-jcs-2022`](https://www.w3.org/TR/vc-di-eddsa/): Ed25519 over the JSON Canonicalization Scheme (RFC 8785). Any Verifiable Credentials library that supports that cryptosuite can check it.

- **Issuer.** The author, named by an Ed25519 [`did:key`](https://w3c-ccg.github.io/did-key-spec/), with their name: `"issuer": { "id": "did:key:z6Mk…", "name": "Ana" }`. The proof's `verificationMethod` is that key.
- **Subject.** The post as a schema.org `CreativeWork`:

| Field | Meaning |
| --- | --- |
| `id` | `urn:uuid:<id>`, the post id. |
| `name`, `inLanguage` | The post's `title` and `language`. |
| `author` | The same `{ "id", "name" }` as the issuer. |
| `sha256` | The SHA-256 of `html`, in hexadecimal. |
| `characters` | How many characters of the body were `written` in Tinto, `pasted` from elsewhere, `imported` from a file, or generated by `ai`. |
| `digitalSourceType` | An [IPTC digital source type](https://cv.iptc.org/newscodes/digitalsourcetype/): `digitalCreation` when everything was written in Tinto, `composite` when written text is mixed with pasted or imported text, `trainedAlgorithmicMedia` or `compositeWithTrainedAlgorithmicMedia` when AI produced some or all of it. Absent when the body is only pasted or imported text, whose source Tinto did not see. |
| `hasPart` | One entry per paragraph or heading of `html`, in order: `{ "position", "sha256", "characters", "digitalSourceType" }`. Each `sha256` is that of the element's HTML, from `<p>` to `</p>`. |
| `associatedMedia` | Every file of the post: `{ "identifier": "<file>", "encodingFormat": "<type>" }`. |
| `writingProcess` | How the text was written, as Tinto measured it: characters typed, deleted, pasted and imported, active minutes, sessions, intervals between keystrokes counted in bands, and the hashes that end the document's writing record. Counts and timing only, never the text or the keys. |
| `previousCredential` | `{ "id", "sha256" }` of the credential sent before this one for the same post, so the releases form a chain. |

A module that checks authorship should:
1. verify the proof;
2. check that the subject describes this exact post: its `id`, `name`, `inLanguage`, the hash of `html` and of each element, and the set of files;
3. accept only its author's key, from its configuration or from the first signed post it received;
4. answer `{ "authorship": "verified" }` in the `PUT` response.

Tinto tells the writer when a site does not answer `verified`. A post from another key, or without a credential once the site has an author, gets `403` with a message for the writer; a credential that does not verify or does not match gets `422`.

Show the result quietly, for example *Original · written by Ana* when every character was written in Tinto. Always say when a post includes AI-generated text.

## Errors

Return a JSON body `{ "error": "message" }` with a plain-language message for the writer. Tinto shows the message for `400`, `409`, `413` and `422`, and explains the other statuses itself:

| Status | Use it when |
| --- | --- |
| `401` or `403` | The key is missing or wrong. A `403` with a message also explains a post from another author. |
| `404` on `GET <url>` | There is no module at this address. |
| `409` | Another post in the same language and category already uses the address. |
| `413` | A file is larger than the site accepts. |
| `400` or `422` | The site rejects the post or file, for example an unsupported language or category. |
| `429` | The site is limiting requests. |

## What the module is responsible for

- **Keys.** Store the key as a secret, compare it in constant time, and let the owner replace it. When the key changes, the writer adds the same publishing URL again in Tinto with the new key.
- **Validation.** Treat every request as untrusted. Before storing or rendering anything, check again:
  - the id and file names;
  - each file's type, from its first bytes and its hash;
  - the HTML subset;
  - the category and status.
- **Files.** Serve files from the site's own origin:
  - Answer `Range` requests for audio, video and documents.
  - Send downloads as attachments.
  - Delete files that a post no longer references, once no published page uses them.
  - On `DELETE`, remove the post and all of its files.
- **Updating the site.** Make published changes visible, for example by rendering pages on request or by starting a rebuild of a static site. Drafts do not need a rebuild.
