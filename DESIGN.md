---
name: "Tinto"
description: "A local manuscript editor where the text is the ink and everything else is paper."
colors: {paper: "#FCFAF6", paper-dark: "#201C1E", panel: "#F2EEE9", panel-dark: "#292326", ink: "#262123", ink-dark: "#F4EDEA", secondary: "#695F60", secondary-dark: "#BDAEB1", wine: "#963C46", wine-dark: "#E4979D", on-wine: "#FFFFFF", on-wine-dark: "#28181C", wash: "#F4E5E6", wash-dark: "#432E35", divider: "#D9D1CF", divider-dark: "#493E42", outline: "#938487", outline-dark: "#8B787E", origin: "#EEE6D6", origin-dark: "#3D3530", origin-ai: "#E2E8F1", origin-ai-dark: "#2C3442", history-addition: "#dcefdc", history-addition-dark: "#294537"}
typography: {wordmark: {fontFamily: &font0 "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif", fontSize: "27px", fontWeight: 600, lineHeight: 1, letterSpacing: "-1.8px"}, headline: {fontFamily: *font0, fontSize: "42px", fontWeight: 500, lineHeight: 1.2, letterSpacing: "-1.4px"}, title: {fontFamily: *font0, fontSize: "29px", fontWeight: 500, lineHeight: 1.2, letterSpacing: "-0.7px"}, manuscript: {fontFamily: *font0, fontSize: "21px", fontWeight: 400, lineHeight: 1.72}, manuscript-heading: {fontFamily: *font0, fontSize: "2.15em", fontWeight: 500, lineHeight: 1.15, letterSpacing: "-0.045em"}, body: {fontFamily: &font1 "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", fontSize: "13px", fontWeight: 400, lineHeight: 1.45}, label: {fontFamily: *font1, fontSize: "13px", fontWeight: 600, lineHeight: 1.45}, code: {fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12.5px", fontWeight: 400, lineHeight: 1.5}, supplementary: {fontSize: "15px", lineHeight: 1.65}, section-title: {fontSize: "18px", fontWeight: 500}, passage: {fontSize: "19px", lineHeight: 1.4}}
rounded: {text-mark: "0.2em", origin-mark: "2px", field: "4px", control: "5px", floating: "6px", tab: "8px", dialog: "9px"}
spacing: {xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "32px"}
components: {button-primary: {backgroundColor: "{colors.wine}", textColor: "{colors.on-wine}", rounded: "{rounded.control}", padding: "8px 12px"}, button-outline: {backgroundColor: "{colors.paper}", textColor: "{colors.ink}", rounded: "{rounded.control}", padding: "8px 12px"}, button-quiet-hover: {backgroundColor: "{colors.wash}", textColor: "{colors.ink}", rounded: "{rounded.control}", padding: "6px 9px"}, toggle-pressed: {backgroundColor: "{colors.wash}", textColor: "{colors.wine}", rounded: "{rounded.control}", size: "28px"}, input: {backgroundColor: "{colors.paper}", textColor: "{colors.ink}", rounded: "{rounded.field}", padding: "7px 10px", height: "34px"}, tab-current: {backgroundColor: "{colors.paper}", textColor: "{colors.ink}", rounded: "{rounded.tab}"}, alternative-option: {backgroundColor: "{colors.paper}", textColor: "{colors.ink}", rounded: "{rounded.control}", padding: "12px 36px 12px 12px"}, alternative-option-chosen: {backgroundColor: "{colors.wine}", textColor: "{colors.on-wine}", rounded: "{rounded.control}", padding: "12px 36px 12px 12px"}, dialog: {backgroundColor: "{colors.paper}", textColor: "{colors.ink}", rounded: "{rounded.dialog}", padding: "24px"}}
---

# Design System: Tinto

## Overview

**Creative North Star: "Ink on Paper"**

Book serif for writing; system sans for controls. Paper surfaces and wine accents.

Full guidance: [.impeccable/design-full.md](.impeccable/design-full.md).
