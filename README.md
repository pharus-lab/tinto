# Tinto

A local manuscript editor for macOS and Linux. Each project is a portable SQLite file with the extension `.tinto`. It contains the manuscripts, hidden wordings, draft comparison baselines, document languages, and version history.

## Open the editor

- **macOS on Apple silicon** — Open `out/Tinto-darwin-arm64/Tinto.app`. This local build uses an ad-hoc signature.
- **Ubuntu or Debian** — Open the matching `.deb` from `out` in the software installer, then launch **Tinto** from the applications menu. Choose `amd64` for Intel or AMD processors and `arm64` for ARM processors. From a terminal, install with `sudo apt install ./tinto_0.1.0_amd64.deb` or the corresponding ARM64 filename.
- **From source** — With Node.js 24.13 or later and npm, run `npm ci` and `npm start`. The first run downloads Electron. Subsequent writing sessions work offline.

## Try a wording

On first launch, choose an existing Tinto folder or create one. To try the editor in an empty folder, click **Open sample project**. This creates **The long way home** in that folder and opens its alternatives panel. Switch to “I want to eat a cat.” and back. Under **Within this passage**, choose “ice cream” or “cake”. **Edit wording** selects the active text in the manuscript. Type to replace it and use the ordinary Undo shortcut to bring it back.

Select text in one paragraph and click **Add alternative** to start a new group. **Add option** makes another copy in the same group. Select text around a whole group to nest it. Use **Option+Right** on macOS or **Alt+Right** on Linux to leave an alternative before starting a new paragraph.

## Writing and projects

- **Settings** in the title bar controls font size, line spacing, appearance, and the default spelling language. The footer language selector belongs to the current document.
- **Home** creates and opens projects, adds documents, imports files, and opens linked sections by heading. Home lists the projects in your selected folder. Use **Choose folder** to browse, **New folder** to create another folder, or the **Tinto folder** menu to return to a previous one. New projects default to the selected folder. Settings shows the current project file path.
- **Create draft** copies the current document or linked section. **Review draft** compares each changed paragraph. Applying a choice updates both copies and their common baseline. A conflict needs an explicit decision.
- **History** lets you name, preview, restore, and delete versions. Tinto autosaves after 450 ms of idle typing and flushes on close. Changed work gets an automatic version after five minutes. Automatic versions stay for 30 days. Named versions stay until deleted.
- **Import file** accepts TXT, DOCX, and text-based PDFs. PDF import reports pages requiring OCR. **Export** writes the open document, section, or draft as DOCX or PDF, with its chosen wording and author formatting.
- English and Spanish dictionaries ship with the app. In **Settings**, download French or UK English and then select it as the document language. Right-click an underlined word or press **Shift+F10** to choose a correction.

## Optional Google Drive backup

Enable the Google Drive API for a Google Cloud project and create a desktop OAuth client. In **Settings**, choose **Connect Google Drive**, select the downloaded client JSON, and authorize Tinto in your system browser. Tinto requests the `drive.file` scope. Store the client file outside manuscript projects. [Google desktop OAuth setup](https://developers.google.com/identity/protocols/oauth2/native-app)

Automatic backups are opt-in per local project. While Tinto is open it checks for changes every 15 minutes. **Back up now** takes an immediate snapshot. The **Tinto Backups** folder holds the five most recent completed backups per project. **Restore backup** downloads and verifies a whole project into a new local file. Use the same OAuth client on another computer to access the app’s backups. Tokens use Electron safeStorage with the operating system credential service. Linux backup connection requires a supported keyring.

## Publish to websites

**Publish** sends the open document or linked section to any website that includes the Tinto blog module. One Tinto can publish to several websites. [docs/site-contract.md](docs/site-contract.md) describes the API a website implements to receive posts. Sites on Cloudflare Workers can copy the ready-made module in [modules/cloudflare](modules/cloudflare/README.md), which adds the API, a feed for the site build, and the post images.

To connect a website for the first time, choose **?** next to *Add a website* in **Settings → Websites**. The guide writes the blog module into a site on Cloudflare Workers, gives your coding agent ready-made prompts, creates the API key, and lists the manual steps up to the connection. Saving the module again to the same site updates its code and keeps the site's configuration.

You can also add a website directly in **Settings → Websites** with the two values the website gives you: its **Publishing URL** and **API key**. Tinto checks both before saving them. **Test** checks them again. **Remove** deletes the key from this computer, and the posts stay on the website. To change a key, add the same publishing URL again with the new key. Posts already published there stay linked.

In the **Publish** dialog, choose the website, then the title, address, date, summary, tags, cover and gallery. Tinto uploads new images first and then sends the post. **Update post** sends changes. **Unpublish** removes the post and its images from the chosen website only. The same document can be published on several websites. Each website keeps its own address and images. A second website starts from the text of the first, and its images are chosen again.

The publishing URLs and keys are encrypted with the operating system's credential service, in the same way as Drive tokens. Each project file stores its posts for each website, so the address, images and description survive a restart. A post is recorded only after the website accepts it. After a failure, send it again. Opening a project with this version upgrades its file, and older Tinto builds cannot open the upgraded file.

## Build and check

- `npm run typecheck` checks the TypeScript.
- `npm test` runs the editor, desktop, storage, drafts, file exchange, backup and publishing checks. Browser tests use system Chrome on macOS. On Linux install Playwright Chromium with `npx playwright install chromium` or set `CHROME_PATH` to an existing Chromium executable. Desktop tests need a graphical session or Xvfb.
- `TINTO_DICTIONARY_NETWORK_TEST=1 npm test` also downloads a pinned French pack and checks it in an offline process.
- `npm run package` builds the app for the current machine. Use `npm run package -- linux x64` or `npm run package -- linux arm64` for a Linux folder. On Linux, run `sh scripts/linux-deb.sh amd64` or `sh scripts/linux-deb.sh arm64` to generate its installer.

## License

Original Tinto code is released under the MIT license. Packaged applications include dependency licenses and the notices supplied with each dictionary.

## Verification record

- **macOS, Apple silicon.** The full 30-test suite passed, including first-open folder selection, folder creation, and switching folders across restarts. The packaged editor passed the nested-choice edit, undo, save, close, and reopen sequence. Desktop checks also covered English and Spanish spelling, linked-section renaming and scroll, reading settings, version restoration, partial draft reconciliation, and local file exchange. A downloaded French dictionary worked after relaunch offline. Pages and Preview opened the exported files. Rendered text retained the gold highlight in both formats.
- **Ubuntu 24.04.** The ARM64 and amd64 installers were installed in separate offline Docker environments. Seven installed-app checks on each architecture covered choosing and creating folders, nested editing and reopening, bilingual spelling, draft review, local file exchange, tab navigation, keyboard focus, reading preferences, and saving to the correct file after a restore. ARM64 ran natively in the Linux VM. The amd64 run used emulation. The automated Chromium launcher required its test sandbox setting in Docker. A regular graphical Linux desktop launch with the distribution's sandbox and keyring still needs a device check.
- **Drive.** A loopback authorization test exercised state, PKCE, token refresh, and disconnect against a simulated Google endpoint. Backup tests restored a complete SQLite project, including pending draft conflicts and hidden wording, and kept five previous backups after a failed upload. A live Google-account backup and restore still requires personal authorization.
