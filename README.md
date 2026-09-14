# Figma Design IR

Figma Design IR is a local Figma Desktop plugin that exports a selection or an
entire Figma Design file as an AI-readable ZIP. **IR** means **Intermediate
Representation**: structured data between Figma's Plugin API and an AI agent.

The plugin is read-only, uses no network services, and reports unavailable data
in the archive instead of silently omitting it.

## Install

1. Download and unpack this repository, or clone it.
2. Open a Figma Design file in Figma Desktop.
3. Open `Plugins > Development > Import plugin from manifest…`.
4. Select this repository's `manifest.json`.
5. Run **Figma Design IR** from `Plugins > Development`.

The built plugin is included, so installation does not require Node.js or a
build step. After updating the repository, reload the plugin. Re-import the
manifest if the folder moved or Figma still shows an older build.

## Export

1. Choose **Current selection** or **Entire file**.
2. Enter a snapshot ID and confirm that you are authorized to export the source.
3. Select **Export AI archive** and complete Figma Desktop's save flow.

The result is `<snapshot-id>.design-ir.zip`. Cancellation discards the current
run without requesting a partial save. Large entire-file exports can take time;
if one reaches a capacity limit, export a smaller current selection.

## Use the archive

Unpack the ZIP outside this repository and keep it out of Git. Direct an AI
agent to start at `<snapshot-id>/agent/index.md`.

- `manifest.json` describes scope, contents, and completeness. For
  current-selection exports its `scope.componentScope` records the component
  scope the archive was built with (`used` by default, `reachable` for "All
  reachable components"); `ir/document.json` repeats it as `componentScope`.
- `diagnostics.json` explains missing or failed data.
- `ir/` contains authoritative exact values.
- `assets/` and `previews/` contain local visual evidence.

Markdown is navigation; canonical JSON is authoritative. Review diagnostics for
an incomplete archive, and do not infer missing resources, semantic token
meaning, component intent, or product behavior.

## Development

Development requires Node.js 24 and npm 11:

```sh
nvm use
npm ci
npm run check
```

Use `npm run build` for a single rebuild or `npm run watch` while editing, then
reload the plugin in Figma Desktop.

## Limits

- The archive reflects only data available through the public Figma Plugin API;
  it is not a lossless `.fig` backup. Missing library resources are diagnosed,
  not imported.
- A current-selection export in the default `used` component scope includes
  component definitions instantiated by the selected roots (including nested
  instances, swap targets, and sibling variants reachable through CHANGE_TO
  interactions). Owning component sets are recorded as metadata-only
  definitions — property definitions, variant axes, and the default variant —
  without expanding their unused sibling variants. Definition trees keep exact
  vector geometry, text values, and image hashes; raster bytes come from the
  selected roots only, so images referenced exclusively by definitions are
  recorded by hash without bytes. Completeness is relative to this scope: the
  archive is `complete` when everything the scope promises was collected.
  On mature design-system files this keeps archives hundreds of times lighter
  and tens of times faster to build than a full traversal. Use an Entire file
  export for full file-local component coverage, or switch the component scope
  to "All reachable components" to expand every touched component set with
  definition and paint-style assets.
- Limits are 64 MiB per uncompressed entry, 384 MiB retained ZIP output, 65,535
  ZIP entries, and 1 MiB per generated Markdown file. Archive-wide capacity
  failures stop without requesting a partial save.
- Figma Desktop owns the native save flow, so the plugin cannot confirm whether
  the final file was saved or the dialog was canceled.
