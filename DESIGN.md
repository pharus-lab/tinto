---
name: Tinto
description: A local manuscript editor where the text is the ink and everything else is paper.
colors:
  paper: "#FCFAF6"
  paper-dark: "#201C1E"
  panel: "#F2EEE9"
  panel-dark: "#292326"
  ink: "#262123"
  ink-dark: "#F4EDEA"
  secondary: "#695F60"
  secondary-dark: "#BDAEB1"
  wine: "#963C46"
  wine-dark: "#E4979D"
  on-wine: "#FFFFFF"
  on-wine-dark: "#28181C"
  wash: "#F4E5E6"
  wash-dark: "#432E35"
  divider: "#D9D1CF"
  divider-dark: "#493E42"
  outline: "#938487"
  outline-dark: "#8B787E"
  origin: "#EEE6D6"
  origin-dark: "#3D3530"
  origin-ai: "#E2E8F1"
  origin-ai-dark: "#2C3442"
typography:
  wordmark:
    fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif"
    fontSize: "27px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-1.8px"
  headline:
    fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif"
    fontSize: "42px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-1.4px"
  title:
    fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif"
    fontSize: "29px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.7px"
  manuscript:
    fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif"
    fontSize: "21px"
    fontWeight: 400
    lineHeight: 1.72
  manuscript-heading:
    fontFamily: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif"
    fontSize: "2.15em"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.045em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  field: "4px"
  control: "5px"
  floating: "6px"
  tab: "8px"
  dialog: "9px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.wine}"
    textColor: "{colors.on-wine}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-quiet-hover:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "6px 9px"
  toggle-pressed:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.wine}"
    rounded: "{rounded.control}"
    size: "28px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "7px 10px"
    height: "34px"
  tab-current:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.tab}"
  alternative-option:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 36px 12px 12px"
  alternative-option-chosen:
    backgroundColor: "{colors.wine}"
    textColor: "{colors.on-wine}"
    rounded: "{rounded.control}"
    padding: "12px 36px 12px 12px"
  dialog:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    padding: "24px"
---

# Design System: Tinto

## Overview

**Creative North Star: "Ink on Paper"**

Tinto is a writing desk, not a dashboard. The manuscript is ink, set in a book serif at reading size on warm paper. Everything around it is paper too: tabs, toolbars, panels and dialogs sit in the same family of off-whites (or deep plum-greys at night), separated by hairlines rather than boxes. The only strong color is wine, the ink of the name *tinto*. It marks what the writer chose, where the caret is, and the one action that matters in a dialog.

The interface speaks quietly in the system sans at 13px, so the serif belongs to the writing and to a few titles. Density is calm: generous margins around the text, compact controls at the edges. Depth comes from tone and hairlines. Shadows appear only on things that float above the page: dialogs, menus and notices.

Authorship marks follow the same restraint. Where words came from is shown only when asked, as a faint tint of a different paper behind them. It is never a badge or a color on the ink itself.

**Key Characteristics:**
- A book serif for the manuscript and titles, and the system sans for the interface.
- Warm paper and wine ink, in light and dark through `light-dark()` tokens.
- Hairline dividers (`--divider`) and outlines (`--outline`) instead of filled cards.
- Wine appears sparingly: the chosen option, the primary action, focus and the caret.
- Text marks (alternatives, origins) are tints behind words, never changes to the words.

## Colors

Warm, low-chroma neutrals carry everything; a single deep wine is the ink accent. Every color is a `light-dark()` pair on `:root` in `src/styles.css`, so Appearance (System, Light, Dark) switches all of them together.

### Primary
- **Tinto Wine** (#963C46 / #E4979D at night): the chosen alternative, primary buttons, focus outlines, the caret, the wordmark's period, the current guide step, and the "changed" state. Text on it uses **On Wine** (#FFFFFF / #28181C).

### Neutral
- **Paper** (#FCFAF6 / #201C1E): the manuscript, dialogs, inputs and the current tab.
- **Panel Paper** (#F2EEE9 / #292326): the title bar, footer, alternatives panel and code blocks. Slightly darker paper for the furniture around the page.
- **Ink** (#262123 / #F4EDEA): all primary text.
- **Pencil Grey** (#695F60 / #BDAEB1): secondary text, labels, hints and placeholders. It meets 4.5:1 on Paper in both appearances.
- **Wash** (#F4E5E6 / #432E35): hover and pressed backgrounds, a wine-tinted paper.
- **Hairline** (#D9D1CF / #493E42): dividers between regions and list rows.
- **Outline** (#938487 / #8B787E): borders of inputs, buttons and dialogs.

### Marks
- **Alternatives:** wine mixed to 16% behind a wording (`color-mix(in srgb, var(--wine) 16%, transparent)`), deepening where alternatives nest.
- **Origin Sand** (#EEE6D6 / #3D3530): behind pasted and imported text, only with *Show pasted and imported text* on.
- **Origin Slate** (#E2E8F1 / #2C3442): behind AI-generated text, a cooler paper so it never reads as the writer's.

### Themes
A theme is a paper and its ink, each with a light and a dark version; Appearance (System, Light, Dark) picks between them. Every theme sets the same eleven tokens under `[data-theme]` in `src/styles.css`, and Settings shows each one as a sample drawn in its own colors.

| Theme | Paper and ink | Accent |
| --- | --- | --- |
| **Tinto** (default) | Ivory paper, plum-black ink | Wine |
| **Sepia** | Aged paper, umber ink | Sienna |
| **Newsprint** | Grey stock, black ink | An editor's blue pencil |
| **Fountain pen** | White paper, blue-black ink | Royal blue |
| **High contrast** | White and black | Deep wine, or pale rose at night |

In every theme and mode, ink is at least 7:1 on paper and panel, and secondary text and the accent are at least 4.5:1. Borders are at least 3:1, and the origin tints stay distinct from the paper. Check a new theme against the same thresholds.

### Named Rules
**The One Ink Rule.** Wine is the only saturated color. It marks a choice, an action or a focus, never decoration, and rarely covers more than a few percent of a screen.

**The Paper Marks Rule.** Anything Tinto says about the text (alternatives, origins) is a tint of paper behind the words. The ink of the manuscript is never recolored.

## Typography

**Manuscript and Display Font:** Iowan Old Style (with Palatino Linotype, Book Antiqua, Georgia, serif)
**Interface Font:** the platform sans (-apple-system, BlinkMacSystemFont, Segoe UI)
**Code Font:** ui-monospace (SFMono-Regular, Menlo), only for commands, keys and prompts

**Character:** an old-style book serif with calligraphic warmth, set against a neutral system sans that stays out of the way. The serif is the writer's voice; the sans is the tool's.

### Hierarchy
- **Wordmark** (italic 600, 27px, line-height 1, -1.8px): *Tinto.* in the title bar, its period in wine.
- **Headline** (500, 42px, 1.2, -1.4px): Home and the welcome screen.
- **Title** (500, 27–29px, 1.2, -0.7px): dialog and panel titles.
- **Manuscript** (400, 17–25px chosen by the writer, default 21px, line-height 1.5–1.95, default 1.72): the text itself, with common ligatures.
- **Manuscript headings** (500, 2.15em / 1.65em / 1.35em, 1.15, H1 tracked -0.045em): chapters and sections inside the manuscript.
- **Body** (400, 13px, 1.45): every interface control and message.
- **Label** (600, 13px, Pencil Grey): group labels in Settings, Home columns and panel groups.

### Manuscript font
The writer chooses the manuscript font in Settings, and it becomes `--serif` for the manuscript and the serif titles. The wordmark keeps the brand's book serif (`--book-serif`). There are two kinds of choice:
- **Fonts on this computer:** Book serif (the default), Georgia, Palatino, Charter, System sans and Monospace.
- **Fonts the writer adds:** TTF, OTF, WOFF or WOFF2 files, one family with its styles. Tinto reads each file and checks it against every character in the project, including wordings not chosen. It names any character the font cannot draw before adding it, and again when a project opens.

### Named Rules
**The Two Voices Rule.** The manuscript font for the writing and for titles; the system sans for the tool. Never set a button, field or message in the manuscript font. Setting the manuscript in a sans or monospace is the writer's choice, never a default.

**The Writer Sets the Measure Rule.** Size, leading and text width belong to the writer in Settings. Interface prose keeps its own measure (about 60ch in guides) and wraps with `text-wrap: pretty`.

## Layout

One column of text in a full-height workspace. From top to bottom:
- a title bar (54px) with the wordmark, tabs and Settings;
- a location bar (50px) with the trail and document tools;
- a toolbar (44px) aligned to the text column;
- the scrolling manuscript;
- a footer (34px).

The Alternatives panel sits on the right at `clamp(270px, 27%, 345px)`.

- **Text width.** *Fixed Margin* (48px each side by default) or *Fixed Width* (a centered column, 680px by default), chosen in Settings.
- **Rhythm.** Spacing steps of 4, 8, 16, 24 and 32px. The manuscript starts 38px below the toolbar and leaves at least 42% of the viewport below the last line, so the end of the text can be written at eye level.
- **Narrow windows.** Below 910px the panel narrows to 248px. Below 580px Home stacks into one column, and tool labels drop to icons.
- **Dialogs.** Up to 560px wide (760px for the guide, 700px for History), at most 82% of the window height, with their own scrolling body.

## Elevation & Depth

Flat by default. Regions are separated by tone (Paper against Panel Paper) and 1px hairlines. Only surfaces that float above the page cast a shadow, and the shadows are soft and offset downward, as paper lifted off a desk.

### Shadow Vocabulary
- **Lifted** (`--shadow`: `0 4px 16px`, plum at 13% light / black at 30% dark): notices, context menus and the spelling menu.
- **Sheet** (`--shadow-dialog`: `0 15px 70px`, plum at 15% / black at 40%): dialogs.
- **Scrim** (`--scrim`: plum at 27% / black at 50%): the backdrop behind a modal dialog.

### Named Rules
**The Desk Rule.** Nothing on the page has a shadow. Only what floats above it does: dialogs, menus and notices.

## Shapes

Small, consistent radii that read as cut paper rather than pills: 4px for fields, 5px for buttons and options, 6px for floating menus and notices, 8px for the top corners of tabs, and 9px for dialogs. Borders are 1px. Marks in the text (alternatives, origins) take a 0.2em or 2px radius and `box-decoration-break: clone`, so a tint that wraps across lines keeps its ends.

## Components

### Buttons
Quiet by default, with one strong action per dialog.
- **Shape:** 5px radius. Interface buttons are text with an optional 16px line icon (1.65 stroke).
- **Quiet:** transparent, `--wash` on hover. Used in toolbars, tabs, the trail and lists.
- **Outline:** 1px `--outline` border, 8px × 12px padding. Used for secondary dialog actions.
- **Primary:** `--wine` fill, `--on-wine` text. One per dialog: Publish, Next, Import key.
- **Toggle:** `aria-pressed`. When on, it takes `--wash` with wine text: format buttons and *Show pasted and imported text*.
- **Focus:** a 2px wine outline offset by 2px on every control.

### Inputs and selects
- **Style:** Paper background, 1px `--outline` border, 4px radius, 7px × 10px padding, 34px tall in Settings.
- **Selects:** custom chevron drawn in currentColor; native appearance under forced colors.
- **Placeholders:** Pencil Grey at full opacity.
- **Form rows:** label on the left, control on the right at `min(320px, 64%)` in Publish and Websites, and `min(156px, 48%)` for reading settings.

### Tabs
Browser-style document tabs in the title bar. The current tab is Paper with a hairline border, open at the bottom into the page. Others are Pencil Grey, warming to wine-mixed paper on hover.

### Alternative options (signature)
Each wording in the Alternatives panel is a serif option on Paper with an outline border. The chosen one fills with wine and its text turns On Wine. A pencil edits in place. Nested alternatives indent behind a hairline.

### Dialogs
Paper sheets with a 9px radius, the Sheet shadow and the Scrim. The title uses the serif at 29px with a close button on the right. Secondary text is Pencil Grey, and actions sit at the bottom right.

### Authorship line and origin marks
In Publish, one line of Pencil Grey such as *Original · written in Tinto · signed as Ana*. In the manuscript, Origin Sand and Origin Slate tints, shown only on request.

## Do's and Don'ts

### Do:
- **Do** set the manuscript, dialog titles and Home headings in `var(--serif)`, and everything else in the system sans at 13px.
- **Do** add every new color as a `light-dark()` token to every theme in `src/styles.css`, and check body and placeholder text at 4.5:1 on Paper in each theme and appearance.
- **Do** separate regions with `--divider` hairlines and tone, as the title bar, panel and footer already do.
- **Do** keep one primary (wine) action per dialog; the rest are outline or quiet buttons.
- **Do** show anything about the text as a paper tint behind the words, off by default when it is not part of writing.

### Don't:
- **Don't** introduce a second saturated accent; wine is the only ink color.
- **Don't** nest bordered cards inside dialogs or panels; use spacing, labels and hairlines.
- **Don't** put shadows on anything that sits on the page.
- **Don't** recolor manuscript text to mark state; tint behind it instead.
- **Don't** set controls or messages in the serif, or manuscript text in the sans.
