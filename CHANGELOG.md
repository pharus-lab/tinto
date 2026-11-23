# Changelog

## 1.1.3 — 2026-11-23

- Tinto for **Ubuntu and Debian** on amd64 and arm64, as `.deb` installers built and checked on Linux, alongside the macOS installer.
- The Linux window opens on Wayland desktops that use software rendering.
- Debian installers for amd64 and arm64 verify the application version and architecture before packaging. The Linux window groups under Tinto’s launcher icon and keeps the menu bar hidden until you press Alt.
- A failed save keeps pending typing evidence available for retry. Renaming the active project preserves subsequent authorship records. A failure to remember open tabs no longer prevents the final manuscript edit from being saved on close.
- On Linux, Tinto checks that Electron used the system keyring before saving credentials. Local writing and saving remain available when the keyring is locked or unavailable.

## 1.1.2 — 2026-11-23

- **Writing coach notes stay while you edit.** Each note follows its passage as you type around or inside it, marked **Edited** once you change it, and stays until **Check again**, **Dismiss** or the new **Mark as solved**. A passage you delete keeps its note in the sidebar, without an underline. Dismiss results clears the local results only.
- **Mark as solved**: the next review checks the revised passage; if the problem remains, the coach raises it again, labeled **Still there**. **Dismiss** now tells the coach too, so it does not suggest the same change again.
- Coach notes, and the notes you solved or dismissed, are kept on this computer for each document: they survive switching to Markdown, closing the document and restarting Tinto. They are not stored in the .tinto project.
- **Settings → Writing → AI service** shows an estimate of what Translate and the writing coach have cost since you started or last reset, as a bar split between the two, from the tokens each service reports and its published prices. OpenRouter's own reported cost is used when it gives one; models chosen with Other… count tokens only. **Reset** starts the total again.

## 1.1.1 — 2026-11-23

- **Writing coach (AI)**, an advanced check marked with sparkles in the Writing checks sidebar and in Settings → Writing, off by default. With the key and model of Settings → Writing → AI service, **Check writing** also asks it to review the open document or linked section: it explains problems with grammar, punctuation, sentence structure and confusing or needlessly long wording, and suggests how to improve each passage. It is a coach, not an editor: notes have no Apply, only Dismiss, and it never changes the text or the authorship record. Its switch and notes sit below the local results. It works in English, English (UK) and Spanish (Mexico), answers in the document's language, and sends nothing while you type.
- Wider local grammar checks: word choice and usage (“should of”, “taller then”, “will effect”), word order, misheard idioms, double comparatives, and stray spaces. A filter bug that hid words written together or apart (“alot”) is fixed. House-style rules stay off.
- **Include style hints**, a new switch that starts off, adds wordiness and long sentences to English grammar checks.
- Spanish documents are Spanish (Mexico): the spelling dictionary is now `dictionary-es-mx` 2.0.0, and translations into Spanish follow Mexican Spanish. Documents keep the language code `es`.
- Settings → Writing → Automatic translation is now **AI service**, shared by Translate and the writing coach.
- **Settings → Appearance → Toolbar** chooses which tools the document bar and the formatting bar show, to keep the workspace uncluttered. All start shown; hidden tools keep their keyboard shortcuts, and dividers between empty groups disappear.

## 1.1.0 — 2026-11-23

- Tinto also looks for a new version once a day while it stays open, not only when it opens. Each new version is announced once, and Settings → About still turns the check off.
- Independent live spelling and English grammar checks, both off by default, with **Check writing** for the current document or linked section.
- A Writing checks sidebar with explanations, individual corrections, Ignore, and controls to disable and restore grammar rules. Right-click and Shift+F10 offer the same suggestions.
- A personal dictionary shared across projects on this computer, with shared accepted words for English dialects.
- Writing controls retain the chosen replacement and focus as results arrive, avoid duplicate manual checks, and preserve saved preferences when storage fails. Restoring rules/removing accepted words can reveal retained results, with a clear refresh state after text or checking settings change.
- Writing checks now support English, UK English, and Spanish only. The optional French dictionary download is removed; existing French documents keep their language and remain editable.
- Website setup instructions work with any coding agent and use project-relative paths in copied prompts. The README includes screenshots of the main writing, draft review, history, checking, publishing, and website setup workflows.
- Official Harper.js 3.2.0 runs locally in a dedicated worker with bundled WebAssembly. English and UK English need no download; Spanish retains nspell spelling support. Style, readability and word-choice advice are excluded.
- Corrections preserve formatting, Markdown, chosen alternatives and existing text origins, and are individually undoable. Writing checks add no typing or AI-generation evidence, signed fields, or project migration.
- The macOS installer, `Tinto-1.1.0-mac-arm64.dmg`, opens to a window that shows where to drag Tinto, and how to upgrade over an earlier version.
- Version 1.1 targets macOS on Apple silicon. Linux distribution follows native Linux validation in a later release; the full checklist is in `docs/v1.1-release.md`.

## 1.0.0 — 2026-11-22

The first release of Tinto, a local manuscript editor that keeps a writer's undecided wordings, drafts and history beside the text, translates them when asked, and publishes to the writer's own websites with signed authorship.

### Writing

- **Projects** are single `.tinto` files in folders you choose. They work offline and need no account.
- **Alternatives**: keep several wordings of a passage, nested inside each other, and choose one at any time.
- **Drafts** are working copies of a document or section, reviewed paragraph by paragraph against their source.
- **History** saves a version every five minutes of changes (kept 30 days) and named versions (kept until you delete them). Changed passages are compared side by side, with optional line numbers.
- **Headings** navigation, linked sections, and Markdown editing.
- **Spelling** in English and Spanish, with more dictionaries to download.

### Reading and typography

- Five themes of paper and ink (Tinto, Sepia, Newsprint, Fountain pen, High contrast), each in light and dark.
- A manuscript font of your choice, including fonts you add. Tinto checks every character of the project and names any the font cannot draw.
- Text starts in a centered column of about 66 characters that narrows to fit smaller windows.
- Settings is organized in sections: Appearance, Writing, Project, Author and Websites.

### Translation

- **Translate** a document into another language with your own API key from OpenAI, Anthropic (Claude) or OpenRouter, choosing the model. Tested with OpenAI GPT-6.2 Astra, the default. The translation opens as its own document, keeps bold, italic and underline, and is marked as automatic; the words you change become yours.
- Publish a document and its translation together, at the same address. Websites label it as an automatic translation, reviewed or not, and its signed credential names the original and the model.

### Exchange

- Import and export TXT, DOCX, PDF, Markdown, HTML, RTF, ODT and EPUB, all on your computer.
- Exports use the chosen wording and the manuscript font. A font you added travels inside PDF, Word, EPUB and HTML files when its license allows it.

### Publishing and authorship

- Publish documents and sections to any website with the Tinto blog module (protocol 2), with images, attachments, categories and drafts. A ready-made module for Cloudflare Workers and a step-by-step guide are included.
- Preview a post in the website's own design before publishing.
- Every post is signed with your author key (a `did:key`) as a W3C Verifiable Credential. It records where its words came from: typed in Tinto, pasted or imported.

### New versions

- When Tinto opens, it checks GitHub once for a newer release and offers its download. Nothing from your projects is sent, and the check can be turned off in Settings → About.

### Known limitations

- Available for **macOS on Apple silicon**. Linux packages can be built from source.
- The app is **not notarized** by Apple yet. The first time you open it, choose **Open Anyway** in System Settings → Privacy & Security. For the same reason, new versions are announced but not installed automatically.
- **Google Drive backup** is experimental and hidden. Start Tinto with `TINTO_EXPERIMENTAL=1` to try it.

### Licenses

Tinto is released under the MIT license. It includes pandoc 3.10, released under the GNU GPL version 2 or later. Pandoc's source is attached to this release; see `NOTICE.md`.
