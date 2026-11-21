# Tinto site contract, version 1

This contract defines what Tinto writes to a Cloudflare account when a writer publishes a post. The website reads this data during its build. Tinto owns the writes. The site only reads the table and the objects.

## D1 table

Tinto creates the table when the site is connected or tested. This makes the statement safe to repeat in a site migration.

```sql
CREATE TABLE IF NOT EXISTS tinto_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  locale TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  body_html TEXT NOT NULL,
  cover TEXT,
  images TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE (slug, locale)
)
```

| Column | Meaning |
| --- | --- |
| `id` | Stable UUID for one published document or linked section. It does not change when the title or address changes. |
| `slug` | The address chosen by the writer: lowercase ASCII letters, digits and single hyphens. |
| `locale` | The document's spelling language. Values include `en` and `es`, plus any installed dictionary code such as `fr` or `en-GB`. Posts in different languages can share a slug, which allows translations to be paired. |
| `title`, `summary` | Plain text. Escape these values when rendering. |
| `date` | The writer's publication date, formatted as `YYYY-MM-DD`. |
| `tags` | A JSON array of plain-text strings. |
| `body_html` | The selected wording only. It contains only `<p>`, `<h1>` to `<h6>`, `<strong>`, `<em>` and `<mark>`, without attributes, and all text is escaped. For a linked section, the section's own heading becomes `title` and is omitted from the body. |
| `cover` | JSON `{ "key", "type", "alt" }` or `NULL`. |
| `images` | A JSON array of `{ "key", "type", "alt" }` objects, in the writer's gallery order. |
| `updated_at` | The ISO 8601 time of the latest publication. |

## R2 objects

Images are stored at `posts/<id>/<sha256 prefix>.<ext>`, where `<ext>` is `png`, `jpg`, `webp`, `gif` or `avif`. Each key depends on the image content, so an object never changes after it is written. The site can therefore serve images with a long immutable cache lifetime. `type` contains the verified MIME type. Images are no larger than 15 MB, and a post has at most 20 images.

Objects under `tinto-connection-check/` are temporary connection checks. Tinto deletes each one immediately after writing it.

## Publishing order

1. New images are uploaded to R2.
2. The post row is upserted in D1 by `id`.
3. The Workers Builds deploy hook is triggered.
4. After the hook accepts the build, images that the post no longer uses are deleted.

Unpublishing deletes the row, triggers the hook, and then deletes the post's images. If the hook fails, Tinto keeps the images and offers **Retry rebuild**. A build therefore never reads a row whose images are missing. A page from a build started before an image was removed can briefly reference an image that no longer exists.

## Notes for the website

- **Reading the posts:** read `tinto_posts` at build time, for example with `SELECT * FROM tinto_posts ORDER BY date DESC, updated_at DESC`. A read-only build credential is enough: D1 Read, provided through `wrangler d1 execute --remote --json` or the D1 query API.
- **Serving images:** serve them from the site's own origin, for example at `/media/<key>` through an R2 binding in the Worker.
- **Language routes:** map each `locale` to the site's language routes, for example `en` → `/en` and `es` → `/es`.
