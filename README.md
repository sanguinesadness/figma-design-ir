# Figma Design IR

Figma Design IR is a local-only, read-only Figma Desktop plugin that exports
either the current selection or an entire Figma Design file as an AI-readable
ZIP archive.

The plugin has no network access, telemetry, cloud storage, or background
service. It does not modify the open Figma document.

> **Status:** This repository contains an install-ready pre-v1 build for
> coworker testing. Final synthetic Starter/Figma Desktop acceptance is still in
> progress, so it is not yet a completed v1 release.

## Install

1. Download this repository as a ZIP or clone it, then unpack it locally.
2. Open a Figma Design file in Figma Desktop.
3. Open `Plugins > Development > Import plugin from manifest…`.
4. Select `manifest.json` from the repository folder.
5. Run **Figma Design IR** from `Plugins > Development`.

The built plugin is included. Node.js, npm, and a local build step are not
required for normal use.

To update, download or pull the latest repository version and reload the
development plugin in Figma Desktop. Re-import `manifest.json` if the folder was
moved.

## Export

1. Open the current source copy in Figma Desktop.
2. Select one or more layers for **Current selection**, or choose **Entire
   file** without selecting anything.
3. Enter a lowercase snapshot ID using letters, numbers, dots, dashes, or
   underscores.
4. Confirm that the source copy is current and that you are authorized to export
   it.
5. Select **Export AI archive** and complete Figma Desktop's save flow.

Cancellation discards the in-progress archive and does not request saving a
partial ZIP.

## Use the archive

Unpack the saved `<snapshot-id>.design-ir.zip` outside this repository. Start at:

- `agent/index.md` for the recommended reading order;
- `manifest.json` for scope, completeness, and archive contents;
- `diagnostics.json` for missing, inaccessible, unsupported, or failed data;
- `ir/` for authoritative exact values;
- `assets/` and `previews/` for local visual evidence.

For AI-assisted implementation, point the agent at the unpacked snapshot and ask
it to begin with `agent/index.md`. Canonical JSON is authoritative; Markdown is
navigation. Do not infer semantic token meaning, component intent, or product
behavior that the archive does not explicitly contain.

An archive marked `incomplete` can still be readable. Review
`diagnostics.json` before relying on it and do not invent missing resources.

## Privacy and limitations

- The manifest permanently sets `networkAccess.allowedDomains: ["none"]`.
- The plugin reads only information exposed by the public Figma Plugin API and
  never imports missing library resources.
- “Maximum fidelity” means maximum accessible Plugin API data. The archive is
  not a proprietary, lossless `.fig` backup.
- Large files can take time or reach safe capacity limits. A handled capacity
  failure requests no save; use **Current selection** for a smaller scope.
- Figma Desktop owns the native save dialog, so the plugin cannot confirm the
  final filesystem save.
- Never commit private Figma content, `.fig` files, exported archives,
  screenshots, or extracted design data to this repository.
