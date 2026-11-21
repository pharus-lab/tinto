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
- **Local and portable.** A project is one file on the writer's computer. There is no account, it works offline, and nothing leaves the machine unless the writer sends it: a Drive backup, or a post to a site they connected.

## Operating Context

- **App.** Currently a desktop app built with Electron, for macOS and Linux. Its interface is written with web technologies.
- **Projects.** Each project is a `.tinto` file, a SQLite database. Projects live in folders the writer chooses.
- **Websites.** A site joins through the Tinto blog module, an HTTPS API (protocol 2) that the site hosts. A ready-made module for Cloudflare Workers lives in `modules/cloudflare`. The in-app guide (Settings → Websites → ?) installs it with the help of the writer's coding agent.
- **Backups.** Optional backups go to the writer's own Google Drive.

## Capabilities and Constraints

**Writing (shipped):**
- **Alternatives.** Nested wording alternatives live inside the manuscript.
- **Structure.** Linked sections by heading, and moving documents between projects.
- **Revision.** Drafts reviewed paragraph by paragraph against their source. Version history keeps automatic versions every five minutes of changes, retained for 30 days, and named versions, retained until deleted.
- **Formatting.** Bold, italic and the author's underline.
- **Exchange.** Import from TXT, DOCX and text-based PDF. Export to DOCX and PDF with the chosen wording.
- **Spelling.** English and Spanish built in, with more dictionaries downloadable.

**Publishing (shipped):**
- **Websites.** Several connected sites, each with its own publishing URL and API key, encrypted with the operating system keychain.
- **Posts.** A cover, a gallery, and attachments (PDF, audio, video, ZIP, CSV), plus the site's own categories.
- **Drafts and preview.** Drafts on the site that stay off its pages, and a preview in the site's own design through a signed link that lasts one hour.
- **Releases.** Each publication with new text is saved as a named version in History ("Released on <site>"), and Tinto shows when the text has changed since.

**Constraints:**
- The interface is in English. Writing and spell checking support English and Spanish.
- Tinto does not use Git. Versions, drafts and releases live inside the project file.

**Open decisions:** see Authorship and Provenance under Brand Commitments.

## Brand Commitments

- **Name and identity.** The name is Tinto, with the Tinto wordmark used for the app icon (`assets/`).

### Authorship and provenance

Authorship is paramount. This is a binding commitment; the mechanism is not built yet.

- **Installations are bound to an author.** Each distribution of the app is locked to one author, so its publications are attributable to that author and cannot be altered after publishing.
- **Human writing is recorded.** In the age of AI, Tinto records which text the writer wrote by hand, in the spirit of photography's original-capture initiatives.
- **AI output is labeled.** AI-produced content, such as a future AI translation, is allowed only when it is watermarked and shown as AI.
- **Original work is labeled quietly.** The label is subtle and never distracts from the content.
- **Integrity is hard to alter.** It rests on content hashes (SHA-256), signatures or version-control-like history. Tinto already names published files by their SHA-256 and keeps a hash of each release's text.
- **Undecided:** the mechanism, the author identity model, and the label design.

Candidate open technologies, researched 2026-11-21 and not chosen:
- **C2PA Content Credentials 2.3.** Manifests for plain-text documents, and a `c2pa.ai-disclosure` assertion that can mark specific paragraphs.
- **c2patxt.** An unofficial Python library that embeds and verifies those manifests in Unicode text.
- **Google's Credentio.** A C++ library that validates them.
- **The IETF Proof of Process draft and Witnessd.** Evidence of keyboard writing, anchored to external timestamps.
- **Writermark SDK.** An alpha-stage library that tracks per-character provenance.
- **SynthID Text.** An open-source watermark for text that a model generates.

Known limits of these approaches:
- Evidence of typing shows that typing happened, not that the ideas are original.
- A missing AI watermark is not proof of human authorship.
- Text watermarks weaken under translation and heavy rewriting.

Check each candidate's license before adopting it.

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
