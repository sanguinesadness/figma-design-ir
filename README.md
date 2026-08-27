# Figma Design IR

Figma Design IR is a Figma Desktop plugin that exports a current selection or
an entire Figma Design file as a structured ZIP archive for AI-assisted
implementation. **IR** means **Intermediate Representation**: structured design
data between Figma's Plugin API and the AI agent that uses it.

The archive includes canonical JSON, navigation Markdown, source evidence,
assets, previews, a manifest, and explicit diagnostics for unavailable data.

## Install

1. Download this repository as a ZIP or clone it, then unpack it locally.
2. Open a Figma Design file in Figma Desktop.
3. Open `Plugins > Development > Import plugin from manifest…`.
4. Select `manifest.json` from the repository folder.
5. Run **Figma Design IR** from `Plugins > Development`.

The built plugin is included. Node.js, npm, and a build step are not required.
To update, download or pull the latest version and reload the plugin in Figma
Desktop. Re-import `manifest.json` if the folder moved or an older build still
appears.

## Export

1. Open the source file in Figma Desktop.
2. Choose **Current selection** or **Entire file**.
3. Enter a lowercase snapshot ID using letters, numbers, dots, dashes, or
   underscores.
4. Confirm that the source is current and that you are authorized to export it.
5. Select **Export AI archive** and complete Figma Desktop's save flow.

Canceling an active export discards it without requesting a partial ZIP save.
For very large files, use **Current selection** if an entire-file export reaches
a capacity limit.

## Use with an AI agent

Unpack `<snapshot-id>.design-ir.zip` outside this repository and direct the
agent to start with `agent/index.md`.

- `agent/index.md` provides the recommended reading order.
- `manifest.json` describes the archive scope, completeness, and contents.
- `diagnostics.json` records missing, inaccessible, unsupported, or failed data.
- `ir/` contains authoritative exact values.
- `assets/` and `previews/` contain local visual evidence.

Canonical JSON is authoritative; Markdown is navigation. Review diagnostics
before relying on an incomplete archive, and do not invent missing resources or
infer semantic token meaning, component intent, or product behavior.

## Privacy and limitations

- All processing happens in Figma Desktop. Network access is disabled by the
  plugin manifest, and the plugin includes no telemetry or cloud service.
- The archive contains information exposed by the public Figma Plugin API.
  “Maximum fidelity” does not mean a proprietary, lossless `.fig` backup.
- Missing library resources are reported rather than imported.
- Figma Desktop owns the native save dialog, so the plugin cannot confirm the
  final filesystem save.
