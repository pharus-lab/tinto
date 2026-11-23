# Third-party software in Tinto

Tinto's own code is released under the MIT license (see `LICENSE`). The packaged app also contains the following software, each under its own license. The app's `licenses` folder holds the license and notice files of every dependency it ships.

## Pandoc

Tinto converts Markdown, RTF, ODT and EPUB files with **pandoc 3.10**, compiled to WebAssembly (`pandoc.wasm`, from the `pandoc-wasm` package). Tinto runs it as a separate program in a worker and exchanges files with it.

- Copyright (C) 2006–2024 John MacFarlane and pandoc contributors.
- Pandoc is free software, released under the **GNU General Public License, version 2 or later**. The full text is in `licenses/GPL-2.0.txt`.
- **Source code.** The complete source of pandoc 3.10 is attached to each Tinto release on GitHub as `pandoc-3.10.tar.gz`, and is also available at <https://hackage.haskell.org/package/pandoc-3.10/pandoc-3.10.tar.gz> and <https://github.com/jgm/pandoc/tree/3.10>.
- The JavaScript wrapper `pandoc-wasm` is © Tweag I/O Limited, Johannes Wilm and contributors, under the MIT license.

## Harper

English spelling and grammar use the official **harper.js 3.2.0** package and its full, inlined WebAssembly engine. Harper is released under **Apache License 2.0**; the complete license is included as `licenses/harper.js-LICENSE` in the packaged app. Harper's source is available at <https://github.com/Automattic/harper/tree/v3.2.0>. Tinto does not modify or rebuild the bundled engine.

## Dictionaries

- **English and UK English** are provided by Harper.
- **Spanish** (`dictionary-es`): available under GPL-3.0, LGPL-3.0 or MPL-1.1; Tinto distributes it under the MPL-1.1. The dictionary files are their own source.

## Other components

Electron and Chromium (their licenses ship inside the app), Anthropic's TypeScript SDK (`@anthropic-ai/sdk`), ProseMirror, pdf.js, fontkit, nspell, fflate, diff and Lezer, each under the MIT, BSD or Apache-2.0 license given in the app's `licenses` folder.
