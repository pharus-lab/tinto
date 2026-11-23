# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Writers who do two jobs with equal weight, often the same person:

- **Drafting and revising long work.** Manuscripts, chapters and essays where the writer keeps alternative wordings, reviews drafts against the original, and exports to Word or PDF.
- **Publishing to their own websites.** Posts, journal entries and notes that go from the manuscript to one or more sites the writer runs, each in that site's own design.

Writing happens in English and Spanish.

## Product Purpose

Tinto is a local manuscript editor that keeps a writer's undecided wordings, drafts and history together in one portable file. It publishes finished pieces to the writer's own websites. Success means the writer can draft, revise and publish without the work leaving their control, and anyone reading the result can trust who wrote it.

## Positioning

- **One editor, many sites.** Tinto is a central writing tool that publishes to several of the writer's own websites. Each site keeps its own design, sections and media; Tinto supplies the content.
- **Local and portable.** A project is one file on the writer's computer. There is no account, it works offline, and nothing leaves the machine unless the writer sends it: a post to a site they connected, a document they choose to translate, or a Drive backup. The one automatic request is a check for a newer release on GitHub when Tinto opens; it carries nothing from the writer's projects and can be turned off in Settings → About.

## Operating Context

- **App.** Currently a desktop app built with Electron, for macOS and Linux. Its interface is written with web technologies.
- **Projects.** Each project is a `.tinto` file, a SQLite database. Projects live in folders the writer chooses.
- **Websites.** A site joins through the Tinto blog module, an HTTPS API (protocol 2) that the site hosts. A ready-made module for Cloudflare Workers lives in `modules/cloudflare`. The in-app guide (Settings → Websites → ?) installs it with the help of the writer's coding agent.
- **Backups.** Optional backups go to the writer's own Google Drive. They are experimental in 1.0 (shown only with `TINTO_EXPERIMENTAL=1`) until they are tried with a real Google account.

## Capabilities and Constraints

**Writing (shipped):**
- **Alternatives.** Nested wording alternatives live inside the manuscript.
- **Structure.** Linked sections by heading, and moving documents between projects.
- **Revision.** Drafts reviewed paragraph by paragraph against their source. Version history keeps automatic versions every five minutes of changes, retained for 30 days, and named versions, retained until deleted.
- **Formatting.** Bold, italic and the author's underline.
- **Typography.** Five themes (Tinto, Sepia, Newsprint, Fountain pen and High contrast), each in light and dark. The manuscript font can be a font on the computer or a font the writer adds. An added font is checked against every character in the project, and Tinto names any it cannot draw.
- **Translation.** A document can become an automatic translation in another language, with the writer's own API key from OpenAI or OpenRouter (Responses API, `store: false`) or Anthropic (Messages API through Anthropic's SDK), always with a strict JSON schema. Tested with OpenAI `gpt-6.2-astra`, the default; the writer can choose other models. The translation is its own document, marked as automatic in the editor, in Publish and on the website. Every generated character carries the `ai` origin until the writer changes it, and a document and its translation publish together at one address.
- **Exchange.** Import and export TXT, DOCX, PDF, Markdown, HTML, RTF, ODT and EPUB locally. Import reads text-based PDFs and DRM-free ebooks. Exports use the chosen wording and the manuscript font. A font the writer added travels inside PDF, Word, EPUB and HTML files when its license allows it.
- **Spelling.** English and Spanish built in, with more dictionaries downloadable.

**Publishing (shipped):**
- **Websites.** Several connected sites, each with its own publishing URL and API key, encrypted with the operating system keychain.
- **Posts.** A cover, a gallery, and attachments (PDF, audio, video, ZIP, CSV), plus the site's own categories.
- **Drafts and preview.** Drafts on the site that stay off its pages, and a preview in the site's own design through a signed link that lasts one hour.
- **Releases.** Each publication with new text is saved as a named version in History ("Released on <site>"), and Tinto shows when the text has changed since.

**Authorship (shipped, v1):**
- **Author key.** One Ed25519 key per installation, named as a `did:key`, kept in the system keychain, created in Settings → Author or on first publish. It can be exported and imported with a passphrase (scrypt, AES-256-GCM).
- **Origin of the words.** An `origin` mark records pasted, dropped and imported text. Unmarked text was typed in Tinto, including corrections typed inside a pasted passage. *Show pasted and imported text* tints them quietly. Exports and posts leave the mark out.
- **Writing record.** Counts and timing of typing (characters, active time, keystroke intervals by band; never the text or the keys), pasted and imported amounts, and the hash of every version and release. It is an append-only, hash-chained table in the project file (`user_version` 5).
- **Signed posts.** Every post and preview carries a W3C Verifiable Credential 2.0 (`eddsa-jcs-2022`). Its subject is the post as a schema.org `CreativeWork`. It holds hashes of the text, each paragraph and each file, the origin of each paragraph as IPTC digital source types, a summary of the writing record, and a link to the previous release's credential.
- **Sites bound to the author.** The Cloudflare module verifies the signature with Web Crypto. It accepts one author, from `tinto.config.mjs` or the first signed post, and refuses changed text. It publishes the credential at `<basePath>/credentials/<post>` and gives pages a quiet label (*Original · written by …*).

**Constraints:**
- The interface is in English. Writing and spell checking support English and Spanish.
- Tinto does not use Git. Versions, drafts and releases live inside the project file.

**Open decisions:** C2PA Content Credentials for published media; label design on each website; testing translation with more services and models.

## Brand Commitments

- **Name and identity.** The name is Tinto, with the Tinto wordmark used for the app icon (`assets/`).

### Authorship and provenance

Authorship is paramount. This is a binding commitment, and its first version is built (see Authorship under Capabilities).

- **Installations are bound to an author.** Each installation signs with one author key, and each website accepts one author. A post cannot be changed after signing without breaking its signature.
- **Human writing is recorded.** Tinto records which text the writer typed, and evidence of how, in the spirit of photography's original-capture initiatives.
- **AI output is labeled.** AI-produced content, such as an automatic translation, is allowed only when it is marked as AI. The credential then names it with the IPTC `trainedAlgorithmicMedia` source type, and sites always show it.
- **Original work is labeled quietly.** The label is subtle and never distracts from the content.
- **Established standards over our own.** W3C Verifiable Credentials 2.0 with Data Integrity `eddsa-jcs-2022`, `did:key`, schema.org `CreativeWork` and IPTC digital source types. Content hashes are SHA-256.

Decided 2026-11-21:
- **Adopted:** the standards above, implemented without dependencies in `modules/cloudflare/credential.mjs`. Tinto and every site share that file.
- **Later:** C2PA Content Credentials for images, audio and video. `c2pa-node` (MIT) is about 50 MB, and its prebuilt binaries lack plain-text support. Its WASM build is too large for Workers.
- **Not adopted:**
  - the Witnessd engine, under AGPL-3.0;
  - the IETF Proof of Process technology, under PolyForm Noncommercial;
  - Writermark, which depends on a server;
  - SynthID Text, which only marks text a model generates.

Known limits:
- Evidence of typing shows that typing happened in Tinto, not that the ideas are original.
- Text typed elsewhere and imported, including the writer's own earlier work, is labeled as imported, not as original.
- Whoever holds the author key can sign. The writer protects the key and its export passphrase.
- The writing record is evidence kept by the writer's own computer, not by a third party. The chain shows edits to the record, but cannot prove that a complete record was never replaced.
- Text watermarks weaken under translation and heavy rewriting, and a missing AI watermark is not proof of human authorship.

## Evidence on Hand

- **Sample project.** "The long way home", a fiction sample with alternatives, sections and a garden chapter, created by Open sample project.
- **Verification record.** Test suites and a verification record in the README.
- **Absent.** No user testimonials, usage numbers, customers or press exist. Future work must not invent them.

## Product Principles

1. **The writer owns the work.** Everything stays local and portable. Nothing leaves the computer without an explicit action.
2. **Authorship is verifiable and honest.** What was written by hand, what was assisted, and what was generated is recorded and labeled. The labels stay quiet.
3. **One editor, many sites.** Tinto supplies the words and files; each website keeps its own design.
4. **The text comes first.** Tools, history and publishing recede behind the manuscript while writing.
5. **Repeatable over clever.** Connecting and updating a site, and publishing again, should be the same simple steps every time.

## Accessibility & Inclusion

- Everything works from the keyboard, with visible focus.
- Controls carry labels for screen readers.
- Writing and spell checking serve both English and Spanish.
