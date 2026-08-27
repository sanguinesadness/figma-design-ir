import {
  archivePaths,
  assertSafeArchivePath,
  utf8ByteLength,
  type SnapshotId,
} from "./archive";
import type { DiagnosticSummary } from "./diagnostics";
import type {
  AssetRefIR,
  ComponentDependencyIR,
  ComponentDefinitionIR,
  ComponentsIndexIR,
  DesignIrComponentDefinitionArtifact,
  DesignIrDocument,
  DesignIrPageIndex,
  DesignIrRootIndex,
  NodeIR,
  PreviewRefIR,
  ReactionIR,
  SourceRef,
  StyleIR,
  StylesIndexIR,
  VariableIR,
  VariablesIndexIR,
} from "./ir";
import { ensureOneFinalNewline, serializeCanonicalJson } from "./serialization";

/** The documented maximum is measured as UTF-8 bytes, not UTF-16 code units. */
export const MAX_MARKDOWN_BYTES = 1024 * 1024;

const MAX_DISPLAY_CHARS = 2048;
const MAX_BLOCK_BYTES = 48 * 1024;
const MAX_TREE_FACT_SAMPLES = 12;
const MARKDOWN_ESCAPABLE = new Set(
  Array.from("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"),
);

export interface MarkdownArtifact {
  readonly path: string;
  readonly text: string;
}

export class MinimalMarkdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinimalMarkdownError";
  }
}

function relativePath(fromPath: string, toPath: string): string {
  assertSafeArchivePath(fromPath);
  assertSafeArchivePath(toPath);
  const from = fromPath.split("/");
  const to = toPath.split("/");
  if (from[0] !== to[0]) {
    throw new MinimalMarkdownError(
      "A Markdown link target belongs to a different snapshot.",
    );
  }
  from.pop();
  while (from.length > 0 && to.length > 0 && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return `${"../".repeat(from.length)}${to.join("/")}`;
}

function link(fromPath: string, toPath: string, label: string): string {
  return `[${escapeMarkdown(label)}](<${relativePath(fromPath, toPath)}>)`;
}

/** User content is text, never Markdown syntax or an executable link target. */
export function escapeMarkdown(value: string): string {
  return Array.from(value)
    .map((character) => {
      const code = character.charCodeAt(0);
      if (
        (code >= 0 && code <= 8) ||
        (code >= 11 && code <= 12) ||
        (code >= 14 && code <= 31) ||
        code === 127
      ) {
        return "�";
      }
      if (character === "\r" || character === "\n") return " ";
      return MARKDOWN_ESCAPABLE.has(character) ? `\\${character}` : character;
    })
    .join("");
}

function boundedText(value: string, maximum = MAX_DISPLAY_CHARS): string {
  const scalarValues = Array.from(value);
  if (scalarValues.length <= maximum) return value;
  return `${scalarValues.slice(0, maximum).join("")}… (truncated; follow canonical JSON)`;
}

function displayValue(value: unknown): string {
  return escapeMarkdown(boundedText(serializeCanonicalJson(value).trim()));
}

function sourceLabel(source: SourceRef): string {
  return escapeMarkdown(
    boundedText(source.name === undefined ? source.id : source.name),
  );
}

function sourceIdentity(source: SourceRef): string {
  return escapeMarkdown(boundedText(source.id));
}

function formatBounds(node: NodeIR): string {
  const bounds =
    node.geometry?.absoluteBounds ?? node.geometry?.localBounds ?? undefined;
  if (bounds === undefined || bounds === null) return "dimensions unavailable";
  return `${String(bounds.width)} × ${String(bounds.height)} at ${String(bounds.x)}, ${String(bounds.y)}`;
}

function partPath(path: string, part: number): string {
  const extensionIndex = path.lastIndexOf(".");
  if (extensionIndex < 0) {
    throw new MinimalMarkdownError(
      "A Markdown artifact path lacks an extension.",
    );
  }
  const result = `${path.slice(0, extensionIndex)}.part-${String(part)}${path.slice(extensionIndex)}`;
  assertSafeArchivePath(result);
  return result;
}

function splitBoundedBlock(value: string): readonly string[] {
  if (utf8ByteLength(value) <= MAX_BLOCK_BYTES) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (utf8ByteLength(remaining) > MAX_BLOCK_BYTES) {
    let currentBytes = 0;
    let scalarEnd = 0;
    let preferredEnd = -1;
    for (const scalar of Array.from(remaining)) {
      const scalarBytes = utf8ByteLength(scalar);
      if (currentBytes + scalarBytes > MAX_BLOCK_BYTES) break;
      scalarEnd += scalar.length;
      currentBytes += scalarBytes;
      if (scalar === "\n") preferredEnd = scalarEnd;
    }
    const chunkEnd = preferredEnd > 0 ? preferredEnd : scalarEnd;
    if (chunkEnd <= 0) {
      throw new MinimalMarkdownError(
        "A Markdown block could not be split at a UTF-8 boundary.",
      );
    }
    chunks.push(remaining.slice(0, chunkEnd));
    remaining = remaining.slice(chunkEnd);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function splitBlocks(blocks: readonly string[]): readonly string[] {
  const chunks: string[] = [];
  for (const block of blocks) {
    chunks.push(...splitBoundedBlock(block));
  }
  return chunks;
}

/** Splits generated blocks deterministically and preserves a stable entry path. */
export function splitMarkdownArtifact(
  path: string,
  title: string,
  blocks: readonly string[],
): readonly MarkdownArtifact[] {
  const complete = ensureOneFinalNewline(blocks.join("\n\n"));
  if (utf8ByteLength(complete) <= MAX_MARKDOWN_BYTES)
    return [{ path, text: complete }];

  const normalizedBlocks = splitBlocks(blocks);
  const partLimit = MAX_MARKDOWN_BYTES - 32 * 1024;
  const parts: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const block of normalizedBlocks) {
    const separatorBytes = current.length === 0 ? 0 : 2;
    const blockBytes = utf8ByteLength(block);
    if (
      current.length > 0 &&
      currentBytes + separatorBytes + blockBytes > partLimit
    ) {
      parts.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(block);
    currentBytes += (current.length === 1 ? 0 : 2) + blockBytes;
  }
  if (current.length > 0) parts.push(current);
  if (parts.length < 2) {
    throw new MinimalMarkdownError(
      "A bounded Markdown artifact could not be split.",
    );
  }
  const partArtifacts = parts.map((part, index) => {
    const text = ensureOneFinalNewline(
      `# ${title} — part ${String(index + 1)} of ${String(parts.length)}\n\n${part.join("\n\n")}`,
    );
    if (utf8ByteLength(text) > MAX_MARKDOWN_BYTES) {
      throw new MinimalMarkdownError(
        "A Markdown part exceeds the documented byte limit.",
      );
    }
    return { path: partPath(path, index + 1), text };
  });
  const index = ensureOneFinalNewline(
    [
      `# ${title}`,
      "",
      "This bounded Markdown artifact is split deterministically. Read the parts in order; canonical JSON remains authoritative for exact values.",
      "",
      ...partArtifacts.map(
        (part, index) =>
          `- ${link(path, part.path, `Part ${String(index + 1)}`)}`,
      ),
    ].join("\n"),
  );
  if (utf8ByteLength(index) > MAX_MARKDOWN_BYTES) {
    throw new MinimalMarkdownError(
      "A Markdown split index exceeds the byte limit.",
    );
  }
  return [{ path, text: index }, ...partArtifacts];
}

function nodeStyleReferences(node: NodeIR): readonly SourceRef[] {
  const references: SourceRef[] = [];
  for (const candidate of [
    node.visual?.fillStyle,
    node.visual?.strokeStyle,
    node.visual?.effectStyle,
    node.visual?.gridStyle,
    node.visual?.backgroundStyle,
    ...(node.family === "text"
      ? [
          node.text.textStyle,
          ...node.text.segments.flatMap((segment) => [
            segment.textStyle,
            segment.fillStyle,
          ]),
        ]
      : []),
  ]) {
    if (
      candidate !== undefined &&
      candidate !== null &&
      !("$type" in candidate) &&
      candidate.kind === "style"
    ) {
      references.push(candidate);
    }
  }
  return references;
}

interface TreeFacts {
  readonly nodeCount: number;
  readonly styleRefs: readonly SourceRef[];
  readonly variableRefs: readonly SourceRef[];
  readonly instanceRefs: readonly SourceRef[];
  readonly layoutCount: number;
  readonly layoutSamples: readonly string[];
  readonly typographyCount: number;
  readonly typographySamples: readonly string[];
  readonly paintCount: number;
  readonly paintSamples: readonly string[];
  readonly effectCount: number;
  readonly effectSamples: readonly string[];
}

function definedRecord(
  entries: readonly (readonly [string, unknown])[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function addCanonicalSample(
  samples: string[],
  seen: Set<string>,
  value: unknown,
): void {
  if (samples.length >= MAX_TREE_FACT_SAMPLES) return;
  const serialized = serializeCanonicalJson(value).trim();
  if (seen.has(serialized)) return;
  seen.add(serialized);
  samples.push(serialized);
}

function displayCanonicalSample(value: string): string {
  return escapeMarkdown(boundedText(value));
}

function collectTreeFacts(tree: NodeIR): TreeFacts {
  const styleRefs = new Map<string, SourceRef>();
  const variableRefs = new Map<string, SourceRef>();
  const instanceRefs = new Map<string, SourceRef>();
  const layoutSamples: string[] = [];
  const typographySamples: string[] = [];
  const paintSamples: string[] = [];
  const effectSamples: string[] = [];
  const seenLayouts = new Set<string>();
  const seenTypography = new Set<string>();
  const seenPaints = new Set<string>();
  const seenEffects = new Set<string>();
  const work = [tree];
  let nodeCount = 0;
  let layoutCount = 0;
  let typographyCount = 0;
  let paintCount = 0;
  let effectCount = 0;
  const addBindings = (
    bindings: readonly { readonly variable: SourceRef }[] | null | undefined,
  ): void => {
    for (const binding of bindings ?? []) {
      variableRefs.set(binding.variable.id, binding.variable);
    }
  };
  while (work.length > 0) {
    const node = work.pop();
    if (node === undefined) continue;
    nodeCount += 1;
    for (const reference of nodeStyleReferences(node))
      styleRefs.set(reference.id, reference);
    addBindings(node.variableBindings);
    if (node.layout !== undefined) {
      layoutCount += 1;
      addCanonicalSample(layoutSamples, seenLayouts, {
        nodeId: node.source.id,
        layout: node.layout,
      });
      const grids = node.layout.grids;
      if (Array.isArray(grids)) {
        const gridRecords = grids as readonly {
          readonly boundVariables?: readonly {
            readonly variable: SourceRef;
          }[];
        }[];
        for (const grid of gridRecords) addBindings(grid.boundVariables);
      }
    }
    const recordPaints = (property: string, value: unknown): void => {
      if (value === undefined) return;
      const records: readonly unknown[] = Array.isArray(value)
        ? (value as readonly unknown[])
        : [value];
      paintCount += records.length;
      for (const record of records) {
        addCanonicalSample(paintSamples, seenPaints, {
          nodeId: node.source.id,
          property,
          value: record,
        });
        if (record !== null && typeof record === "object") {
          const paint = record as {
            readonly boundVariables?: readonly {
              readonly variable: SourceRef;
            }[];
            readonly gradientStops?: readonly {
              readonly boundVariables?: readonly {
                readonly variable: SourceRef;
              }[];
            }[];
          };
          addBindings(paint.boundVariables);
          for (const stop of paint.gradientStops ?? []) {
            addBindings(stop.boundVariables);
          }
        }
      }
    };
    recordPaints("fills", node.visual?.fills);
    recordPaints("strokes", node.visual?.strokes);
    recordPaints("backgrounds", node.visual?.backgrounds);
    const effects = node.visual?.effects;
    if (effects !== undefined) {
      const records: readonly unknown[] = Array.isArray(effects)
        ? (effects as readonly unknown[])
        : [effects];
      effectCount += records.length;
      for (const effect of records) {
        addCanonicalSample(effectSamples, seenEffects, {
          nodeId: node.source.id,
          effect,
        });
        if (effect !== null && typeof effect === "object") {
          addBindings(
            (
              effect as {
                readonly boundVariables?: readonly {
                  readonly variable: SourceRef;
                }[];
              }
            ).boundVariables,
          );
        }
      }
    }
    if (node.family === "text") {
      typographyCount += 1;
      addCanonicalSample(
        typographySamples,
        seenTypography,
        definedRecord([
          ["nodeId", node.source.id],
          ["scope", "node"],
          ["fontName", node.text.fontName],
          ["fontSize", node.text.fontSize],
          ["fontWeight", node.text.fontWeight],
          ["textCase", node.text.textCase],
          ["textDecoration", node.text.textDecoration],
          ["letterSpacing", node.text.letterSpacing],
          ["lineHeight", node.text.lineHeight],
          ["leadingTrim", node.text.leadingTrim],
        ]),
      );
      for (const segment of node.text.segments) {
        typographyCount += 1;
        addCanonicalSample(
          typographySamples,
          seenTypography,
          definedRecord([
            ["nodeId", node.source.id],
            ["scope", "segment"],
            ["start", segment.start],
            ["end", segment.end],
            ["fontName", segment.fontName],
            ["fontSize", segment.fontSize],
            ["fontWeight", segment.fontWeight],
            ["fontStyle", segment.fontStyle],
            ["textCase", segment.textCase],
            ["textDecoration", segment.textDecoration],
            ["letterSpacing", segment.letterSpacing],
            ["lineHeight", segment.lineHeight],
          ]),
        );
        addBindings(segment.variableBindings);
        recordPaints("text-segment-fills", segment.fills);
      }
    }
    if (
      node.family === "instance" &&
      node.instanceData.mainComponent !== undefined
    ) {
      instanceRefs.set(
        node.instanceData.mainComponent.id,
        node.instanceData.mainComponent,
      );
    }
    if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) work.push(child);
      }
    }
  }
  const sort = (left: SourceRef, right: SourceRef): number =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return {
    nodeCount,
    styleRefs: [...styleRefs.values()].sort(sort),
    variableRefs: [...variableRefs.values()].sort(sort),
    instanceRefs: [...instanceRefs.values()].sort(sort),
    layoutCount,
    layoutSamples,
    typographyCount,
    typographySamples,
    paintCount,
    paintSamples,
    effectCount,
    effectSamples,
  };
}

function markdownList(
  values: readonly string[],
  none = "None recorded.",
): string[] {
  return values.length === 0
    ? [`- ${none}`]
    : values.map((value) => `- ${value}`);
}

function assetLinks(
  fromPath: string,
  assets: readonly AssetRefIR[],
): readonly string[] {
  return assets.map((asset) =>
    link(
      fromPath,
      asset.archivePath,
      `${asset.assetKind}: ${asset.source.name ?? asset.source.id}`,
    ),
  );
}

function previewLinks(
  fromPath: string,
  previews: readonly PreviewRefIR[],
): readonly string[] {
  return previews.map((preview) =>
    link(
      fromPath,
      preview.archivePath,
      preview.sourceNode.name ?? preview.sourceNode.id,
    ),
  );
}

function interactionLines(reactions: readonly ReactionIR[]): readonly string[] {
  return reactions.map((reaction) => {
    const actions = reaction.actions
      .map((action) => action.actionType)
      .join(", ");
    return `${escapeMarkdown(reaction.id)} — trigger ${escapeMarkdown(reaction.trigger?.triggerType ?? "none")}; actions: ${escapeMarkdown(actions || "none")}`;
  });
}

function componentSummaryPath(
  snapshotId: SnapshotId,
  componentId: string,
): string {
  return archivePaths.agentComponent(snapshotId, componentId);
}

export interface ComponentMarkdownContext {
  readonly dependencies?: readonly ComponentDependencyIR[];
  readonly componentSummaryIds?: ReadonlySet<string>;
}

function componentReferenceLink(
  fromPath: string,
  snapshotId: SnapshotId,
  reference: SourceRef,
  componentSummaryIds: ReadonlySet<string> | undefined,
): string {
  return componentSummaryIds?.has(reference.id) === true
    ? link(
        fromPath,
        componentSummaryPath(snapshotId, reference.id),
        "component summary",
      )
    : link(
        fromPath,
        archivePaths.agentComponentIndex(snapshotId),
        "component index",
      );
}

export function projectComponentMarkdown(
  snapshotId: SnapshotId,
  definition: ComponentDefinitionIR,
  artifact: DesignIrComponentDefinitionArtifact | undefined,
  context: ComponentMarkdownContext = {},
): readonly MarkdownArtifact[] {
  const path = componentSummaryPath(snapshotId, definition.source.id);
  const canonicalIndex = archivePaths.irComponents(snapshotId);
  const canonicalDefinition =
    artifact === undefined ? undefined : definition.definitionArtifact?.path;
  const facts =
    artifact === undefined
      ? undefined
      : collectTreeFacts(artifact.normalizedTree);
  const componentDependencies = (context.dependencies ?? []).filter(
    (dependency) => dependency.from.id === definition.source.id,
  );
  const diagnostics = [
    ...new Set([
      ...definition.diagnosticIds,
      ...(artifact?.diagnosticIds ?? []),
    ]),
  ];
  const blocks = [
    `# Component: ${sourceLabel(definition.source)}\n\nThis is a navigational projection. ${link(path, canonicalIndex, "Canonical component index")} is authoritative for metadata${canonicalDefinition === undefined ? "." : `; ${link(path, canonicalDefinition, "canonical component definition")} is authoritative for the exact tree.`}`,
    `## Identity\n\n- Source ID: ${sourceIdentity(definition.source)}\n- Kind: ${escapeMarkdown(definition.componentKind)}\n- Definition node ID: ${escapeMarkdown(definition.nodeId ?? "unavailable")}\n- Component set ID: ${escapeMarkdown(definition.componentSetId ?? "none")}\n- Default variant ID: ${escapeMarkdown(definition.defaultVariantId ?? "none")}\n- Description: ${escapeMarkdown(boundedText(definition.description ?? "none"))}\n- Documentation references: ${(definition.documentationLinks ?? []).map((value) => escapeMarkdown(boundedText(value))).join(", ") || "none"}`,
    `## Variants and properties\n\n### Variant axes\n${markdownList((definition.variantAxes ?? []).map((axis) => `${escapeMarkdown(axis.name)}: ${axis.values.map((value) => escapeMarkdown(boundedText(value))).join(", ")}`)).join("\n")}\n\n### This definition's variant properties\n${markdownList(
      (definition.variantProperties ?? []).map(
        (property) =>
          `${escapeMarkdown(property.property)}: ${escapeMarkdown(boundedText(property.value))}`,
      ),
      "No variant properties recorded.",
    ).join("\n")}\n\n### Property definitions\n${markdownList(
      (definition.propertyDefinitions ?? []).map(
        (property) =>
          `${escapeMarkdown(property.name)} (${escapeMarkdown(property.propertyType)}): default ${displayValue(property.defaultValue)}; variant options ${property.variantOptions?.map((value) => escapeMarkdown(boundedText(value))).join(", ") || "none"}; preferred values ${property.preferredValues.map((value) => `${escapeMarkdown(value.type)} ${escapeMarkdown(value.key)}`).join(", ") || "none"}; variable bindings ${property.variableBindings.map((binding) => `${escapeMarkdown(binding.propertyPath)} → ${sourceIdentity(binding.variable)}`).join(", ") || "none"}; slot settings ${property.slotSettings === undefined ? "none" : displayValue(property.slotSettings)}`,
      ),
      "No property definitions recorded.",
    ).join("\n")}`,
    `## Layout, typography, colors, effects, and bindings\n\n${artifact === undefined || facts === undefined ? "Canonical definition tree unavailable; follow diagnostics and canonical component index." : `- Nodes in canonical definition tree: ${String(facts.nodeCount)}\n- Root dimensions: ${escapeMarkdown(formatBounds(artifact.normalizedTree))}\n- Recorded layout objects: ${String(facts.layoutCount)}\n- Recorded typography objects/runs: ${String(facts.typographyCount)}\n- Recorded paint/color objects: ${String(facts.paintCount)}\n- Recorded effect objects: ${String(facts.effectCount)}\n\n### Layout values (first ${String(MAX_TREE_FACT_SAMPLES)} distinct records in canonical traversal order)\n${markdownList(facts.layoutSamples.map(displayCanonicalSample)).join("\n")}\n\n### Typography values (first ${String(MAX_TREE_FACT_SAMPLES)} distinct records in canonical traversal order)\n${markdownList(facts.typographySamples.map(displayCanonicalSample)).join("\n")}\n\n### Paint and color values (first ${String(MAX_TREE_FACT_SAMPLES)} distinct records in canonical traversal order)\n${markdownList(facts.paintSamples.map(displayCanonicalSample)).join("\n")}\n\n### Effect values (first ${String(MAX_TREE_FACT_SAMPLES)} distinct records in canonical traversal order)\n${markdownList(facts.effectSamples.map(displayCanonicalSample)).join("\n")}\n\n### Style bindings\n${markdownList(facts.styleRefs.map((reference) => `${sourceLabel(reference)} (${sourceIdentity(reference)}) — ${link(path, archivePaths.agentStyles(snapshotId), "style index")}`)).join("\n")}\n\n### Variable bindings\n${markdownList(facts.variableRefs.map((reference) => `${sourceLabel(reference)} (${sourceIdentity(reference)}) — ${link(path, archivePaths.agentTokens(snapshotId), "token index")}`)).join("\n")}`}`,
    `## Dependencies and instance relationships\n\n### Canonical dependency references\n${markdownList(
      (artifact?.dependencyRefs ?? []).map((reference) =>
        reference.kind === "component"
          ? `${sourceLabel(reference)} (${sourceIdentity(reference)}) — ${componentReferenceLink(path, snapshotId, reference, context.componentSummaryIds)}`
          : `${escapeMarkdown(reference.kind)} ${sourceLabel(reference)} (${sourceIdentity(reference)})`,
      ),
    ).join("\n")}\n\n### Component dependency edges\n${markdownList(
      componentDependencies.map(
        (dependency) =>
          `${escapeMarkdown(dependency.relationship)} → ${sourceLabel(dependency.to)} (${sourceIdentity(dependency.to)}) — ${componentReferenceLink(path, snapshotId, dependency.to, context.componentSummaryIds)}`,
      ),
      "No outgoing component dependency edges recorded.",
    ).join(
      "\n",
    )}\n\n### Nested instance relationships\n${artifact === undefined || facts === undefined ? "- No readable definition tree was available for this projection." : markdownList(facts.instanceRefs.map((reference) => `${sourceLabel(reference)} (${sourceIdentity(reference)}) — ${componentReferenceLink(path, snapshotId, reference, context.componentSummaryIds)}`)).join("\n")}\n\n${definition.exposedInstanceIds === undefined ? "Exposed-instance metadata unavailable." : `Exposed instance IDs: ${definition.exposedInstanceIds.map((id) => escapeMarkdown(id)).join(", ") || "none"}.`}`,
    `## Interactions, assets, previews, and diagnostics\n\n### Interactions\n${markdownList(artifact === undefined ? [] : interactionLines(artifact.reactions)).join("\n")}\n\n### Assets\n${markdownList(artifact === undefined ? [] : assetLinks(path, artifact.assets)).join("\n")}\n\n### Previews\n- Dedicated component previews are not generated; use the ${link(path, archivePaths.agentPageIndex(snapshotId), "page index")} to locate exported page-level previews.\n\n### Diagnostics\n${diagnostics.length === 0 ? "- None recorded on this component artifact." : `- ${link(path, archivePaths.diagnostics(snapshotId), "Diagnostics")}: ${diagnostics.map((id) => escapeMarkdown(id)).join(", ")}`}`,
  ];
  return splitMarkdownArtifact(
    path,
    `Component: ${sourceLabel(definition.source)}`,
    blocks,
  );
}

function projectPageLikeMarkdown(
  snapshotId: SnapshotId,
  path: string,
  page: SourceRef,
  overviewCanonicalPath: string,
  canonicalPaths: readonly string[],
  trees: readonly NodeIR[],
  dependencyRefs: readonly SourceRef[],
  reactions: readonly ReactionIR[],
  assets: readonly AssetRefIR[],
  previews: readonly PreviewRefIR[],
  diagnosticIds: readonly string[],
  componentSummaryIds: ReadonlySet<string> | undefined,
): readonly MarkdownArtifact[] {
  const rootLines = trees.map((tree, index) => {
    const canonicalPath = canonicalPaths[index] ?? overviewCanonicalPath;
    return `${escapeMarkdown(tree.nodeType)} ${sourceLabel(tree.source)} (${escapeMarkdown(formatBounds(tree))}) — ${link(path, canonicalPath, "exact canonical data")}`;
  });
  const facts = trees.map(collectTreeFacts);
  const componentRefs = dependencyRefs.filter(
    (reference) => reference.kind === "component",
  );
  const exactCanonicalPaths = [...new Set(canonicalPaths)];
  const blocks = [
    `# Page: ${sourceLabel(page)}\n\nThis is an agent-reading projection. ${link(path, overviewCanonicalPath, "Canonical page/root IR")} wins over this Markdown for exact values.`,
    `## Hierarchy and screen roots\n\n${markdownList(rootLines, "No normalized screen roots are available; inspect canonical coverage and diagnostics.").join("\n")}`,
    `## Dependencies and component summaries\n\n${markdownList(
      componentRefs.map(
        (reference) =>
          `${sourceLabel(reference)} (${sourceIdentity(reference)}) — ${componentReferenceLink(path, snapshotId, reference, componentSummaryIds)}`,
      ),
      "No component dependencies recorded.",
    ).join("\n")}\n\nOther dependency references: ${
      dependencyRefs
        .filter((reference) => reference.kind !== "component")
        .map(sourceIdentity)
        .join(", ") || "none"
    }.`,
    `## Interactions\n\n${markdownList(interactionLines(reactions)).join("\n")}`,
    `## Assets and previews\n\n### Assets\n${markdownList(assetLinks(path, assets)).join("\n")}\n\n### Previews\n${markdownList(previewLinks(path, previews)).join("\n")}`,
    `## Exact canonical recovery\n\n${markdownList(exactCanonicalPaths.map((canonicalPath, index) => link(path, canonicalPath, `Canonical IR artifact ${String(index + 1)}`))).join("\n")}\n- ${link(path, archivePaths.diagnostics(snapshotId), "Diagnostics")}\n- Normalized node count represented here: ${String(facts.reduce((total, item) => total + item.nodeCount, 0))}\n- Diagnostic IDs: ${diagnosticIds.length === 0 ? "none" : diagnosticIds.map((id) => escapeMarkdown(id)).join(", ")}`,
  ];
  return splitMarkdownArtifact(path, `Page: ${sourceLabel(page)}`, blocks);
}

export function projectPageMarkdown(
  snapshotId: SnapshotId,
  page: DesignIrPageIndex,
  componentSummaryIds?: ReadonlySet<string>,
): readonly MarkdownArtifact[] {
  const canonicalPath = archivePaths.irNodePage(snapshotId, page.source.id);
  return projectPageLikeMarkdown(
    snapshotId,
    archivePaths.agentPage(snapshotId, page.source.id),
    page.source,
    canonicalPath,
    page.normalizedTrees.map(() => canonicalPath),
    page.normalizedTrees,
    page.dependencyRefs,
    page.reactions,
    page.assets,
    page.previews,
    page.diagnosticIds,
    componentSummaryIds,
  );
}

export function projectSelectionPageMarkdown(
  snapshotId: SnapshotId,
  page: SourceRef,
  roots: readonly DesignIrRootIndex[],
  componentSummaryIds?: ReadonlySet<string>,
): readonly MarkdownArtifact[] {
  const canonicalPaths = roots.map((root) =>
    archivePaths.irNodeRoot(snapshotId, root.source.id),
  );
  return projectPageLikeMarkdown(
    snapshotId,
    archivePaths.agentPage(snapshotId, page.id),
    page,
    roots.length === 1
      ? canonicalPaths[0]!
      : archivePaths.irDocument(snapshotId),
    canonicalPaths,
    roots.map((root) => root.normalizedTree),
    roots.flatMap((root) => root.dependencyRefs),
    roots.flatMap((root) => root.reactions),
    roots.flatMap((root) => root.assets),
    roots.flatMap((root) => root.previews),
    roots.flatMap((root) => root.diagnosticIds),
    componentSummaryIds,
  );
}

function variableBlock(variable: VariableIR): string {
  return `## ${sourceLabel(variable.source)}\n\n- Source ID: ${sourceIdentity(variable.source)}\n- Type: ${escapeMarkdown(variable.resolvedType)}\n- Collection ID: ${escapeMarkdown(variable.collectionId)}\n- Description: ${escapeMarkdown(boundedText(variable.description ?? "none"))}\n- Scopes: ${variable.scopes.map((scope) => escapeMarkdown(scope)).join(", ") || "none"}\n- Code syntax: ${displayValue(variable.codeSyntax)}\n- Diagnostic IDs: ${variable.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ") || "none"}\n\n${markdownList(
    variable.values.map(
      (value) =>
        `Mode ${escapeMarkdown(value.modeId)} — raw: ${displayValue(value.raw)}; resolution: ${escapeMarkdown(value.status)}${value.resolved === undefined ? "" : `; resolved: ${displayValue(value.resolved)}`}; alias chain: ${value.aliasChain.map((item) => escapeMarkdown(item)).join(" → ") || "none"}; resolution context: ${displayValue(value.resolutionContext)}`,
    ),
    "No mode values recorded.",
  ).join("\n")}`;
}

function styleBlock(style: StyleIR, fromPath: string): string {
  const details =
    style.styleType === "paint"
      ? `Paint records: ${String(style.paints.length)}; first ${String(MAX_TREE_FACT_SAMPLES)}: ${displayValue(style.paints.slice(0, MAX_TREE_FACT_SAMPLES))}\n- Raster asset links: ${assetLinks(fromPath, style.assetRefs).join(", ") || "none"}`
      : style.styleType === "text"
        ? `Text properties: ${displayValue(style.properties)}`
        : style.styleType === "effect"
          ? `Effect records: ${String(style.effects.length)}; first ${String(MAX_TREE_FACT_SAMPLES)}: ${displayValue(style.effects.slice(0, MAX_TREE_FACT_SAMPLES))}`
          : style.styleType === "grid"
            ? `Grid records: ${String(style.grids.length)}; first ${String(MAX_TREE_FACT_SAMPLES)}: ${displayValue(style.grids.slice(0, MAX_TREE_FACT_SAMPLES))}`
            : `Unknown style record: ${displayValue(style.raw)}`;
  return `## ${sourceLabel(style.source)}\n\n- Source ID: ${sourceIdentity(style.source)}\n- Type: ${escapeMarkdown(style.styleType)}\n- Description: ${escapeMarkdown(boundedText(style.description ?? "none"))}\n- ${details}\n- Variable bindings: ${style.variableBindings.map((binding) => `${escapeMarkdown(binding.propertyPath)} → ${sourceIdentity(binding.variable)}`).join(", ") || "none"}\n- Referenced by: ${style.referencedBy.map(sourceIdentity).join(", ") || "none"}\n- Diagnostic IDs: ${style.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ") || "none"}`;
}

function collectionCountLabel(
  count: DesignIrDocument["counts"][keyof DesignIrDocument["counts"]],
): string {
  if (count.status === "not-collected") {
    return `not collected (${escapeMarkdown(boundedText(count.reason, 512))})`;
  }
  const coverage = count.coverage === undefined ? "" : `, ${count.coverage}`;
  return `${String(count.value)} (${count.status}${escapeMarkdown(coverage)})`;
}

export function projectGlobalMarkdown(
  snapshotId: SnapshotId,
  document: DesignIrDocument,
  variables: VariablesIndexIR,
  styles: StylesIndexIR,
  components: ComponentsIndexIR,
  pageSummaryPaths: readonly (string | undefined)[],
  diagnosticSummary: DiagnosticSummary,
): readonly MarkdownArtifact[] {
  const indexPath = archivePaths.agentIndex(snapshotId);
  const tokenPath = archivePaths.agentTokens(snapshotId);
  const stylesPath = archivePaths.agentStyles(snapshotId);
  const componentIndexPath = archivePaths.agentComponentIndex(snapshotId);
  const pageIndexPath = archivePaths.agentPageIndex(snapshotId);
  const availablePageSummaries = pageSummaryPaths.filter(
    (path) => path !== undefined,
  ).length;
  const availableComponentSummaries = components.definitions.filter(
    (definition) => definition.definitionArtifact !== undefined,
  ).length;
  const indexBlocks = [
    "# Figma Design IR\n\nThis archive is local-only. Markdown is a bounded navigation layer; canonical JSON always wins for exact values.",
    `## Snapshot identity and completeness\n\n- Snapshot ID: ${escapeMarkdown(snapshotId)}\n- Source document ID: ${sourceIdentity(document.source)}\n- Completeness: ${escapeMarkdown(diagnosticSummary.completeness)}\n- Diagnostics: info ${String(diagnosticSummary.counts.info)}, warning ${String(diagnosticSummary.counts.warning)}, error ${String(diagnosticSummary.counts.error)}, fatal ${String(diagnosticSummary.counts.fatal)}`,
    `## Reading strategy\n\n1. Read ${link(indexPath, archivePaths.manifest(snapshotId), "manifest.json")} for scope, archive paths, integrity, and final completeness.\n2. Read ${link(indexPath, archivePaths.diagnostics(snapshotId), "diagnostics.json")} before relying on unavailable or partial data.\n3. Return here and choose the token/style, component, or page index below.\n4. Open the targeted summary needed for the task.\n5. Follow that summary's canonical JSON link for exact values, complete trees, raw REST-like evidence, and coverage.\n6. Follow asset and preview links only when visual evidence is needed; do not infer semantics from appearance.`,
    `## Archive overview and indexes\n\n- ${link(indexPath, tokenPath, `Tokens and variables (${String(variables.variables.length)})`)}\n- ${link(indexPath, stylesPath, `Styles (${String(styles.styles.length)})`)}\n- ${link(indexPath, componentIndexPath, `Components (${String(components.definitions.length)} indexed; ${String(availableComponentSummaries)} linked summaries)`)}\n- ${link(indexPath, pageIndexPath, `Pages (${String(document.pages.length)} indexed; ${String(availablePageSummaries)} summaries)`)}\n- ${link(indexPath, archivePaths.irDocument(snapshotId), "Canonical document index")}\n- Selected roots recorded: ${String(document.selectedRootIds.length)}\n- Canonical node artifacts recorded: ${String(document.artifacts.nodeArtifacts.length)}\n- Local variables: ${collectionCountLabel(document.counts.localVariables)}\n- Local styles: ${collectionCountLabel(document.counts.localStyles)}\n- Local components: ${collectionCountLabel(document.counts.localComponents)}`,
    `## Scope, limitations, and diagnostics\n\n- Capabilities: ${document.capabilities.map((capability) => escapeMarkdown(capability)).join(", ") || "none"}\n- Limitations: ${document.limitations.map((limitation) => escapeMarkdown(boundedText(limitation, 512))).join("; ") || "none"}\n- Document diagnostic IDs: ${document.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ") || "none"}\n- ${link(indexPath, archivePaths.diagnostics(snapshotId), "Open the complete diagnostic list")}`,
  ];
  const componentBlocks = [
    "# Component index\n\nEach component summary links back to canonical component data. No component intent is inferred.",
    ...components.definitions.map(
      (definition) =>
        `- ${definition.definitionArtifact === undefined ? sourceLabel(definition.source) : link(componentIndexPath, componentSummaryPath(snapshotId, definition.source.id), definition.source.name ?? definition.source.id)} — ${escapeMarkdown(definition.componentKind)}; canonical: ${link(componentIndexPath, archivePaths.irComponents(snapshotId), "index")}`,
    ),
    `## Exact canonical recovery\n\n- ${link(componentIndexPath, archivePaths.irComponents(snapshotId), "ir/components.json")}\n- Component-index diagnostics: ${components.diagnosticIds.length === 0 ? "none" : components.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ")}`,
  ];
  const pageBlocks = [
    "# Page index\n\nPage summaries are bounded projections. Follow their canonical links for full node trees and exact dimensions.",
    ...document.pages.map((page, index) => {
      const summaryPath = pageSummaryPaths[index];
      return summaryPath === undefined
        ? `- ${sourceLabel(page)} — source ID ${sourceIdentity(page)}; canonical page summary unavailable, see ${link(pageIndexPath, archivePaths.diagnostics(snapshotId), "diagnostics")}.`
        : `- ${link(pageIndexPath, summaryPath, page.name ?? page.id)} — source ID ${sourceIdentity(page)}`;
    }),
    `## Exact canonical recovery\n\n- ${link(pageIndexPath, archivePaths.irDocument(snapshotId), "ir/document.json")}\n- ${link(pageIndexPath, archivePaths.diagnostics(snapshotId), "diagnostics.json")}`,
  ];
  const variableBlocks = [
    "# Tokens and variables\n\nThis index is a projection of canonical variables. Raw aliases and values are shown for navigation only; use canonical JSON for exact recovery.",
    `## Collections\n\n${markdownList(variables.collections.map((collection) => `${sourceLabel(collection.source)} — modes: ${collection.modes.map((mode) => `${escapeMarkdown(mode.name)} (${escapeMarkdown(mode.id)})`).join(", ")}; default: ${escapeMarkdown(collection.defaultModeId)}`)).join("\n")}`,
    ...variables.variables.map(variableBlock),
    `## Exact canonical recovery\n\n- ${link(tokenPath, archivePaths.irVariables(snapshotId), "ir/variables.json")}\n- Variable-index diagnostics: ${variables.diagnosticIds.length === 0 ? "none" : variables.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ")}`,
  ];
  return [
    ...splitMarkdownArtifact(indexPath, "Figma Design IR", indexBlocks),
    ...splitMarkdownArtifact(tokenPath, "Tokens and variables", variableBlocks),
    ...splitMarkdownArtifact(stylesPath, "Styles", [
      "# Styles\n\nStyles are projected from canonical IR; do not infer semantic roles.",
      ...styles.styles.map((style) => styleBlock(style, stylesPath)),
      `## Exact canonical recovery\n\n- ${link(stylesPath, archivePaths.irStyles(snapshotId), "ir/styles.json")}\n- Style-index diagnostics: ${styles.diagnosticIds.length === 0 ? "none" : styles.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ")}`,
    ]),
    ...splitMarkdownArtifact(
      componentIndexPath,
      "Component index",
      componentBlocks,
    ),
    ...splitMarkdownArtifact(pageIndexPath, "Page index", pageBlocks),
  ];
}

/** Compatibility export retained for earlier focused tests. */
export function projectMinimalAgentIndex(
  snapshotId: SnapshotId,
  document: DesignIrDocument,
): string {
  const path = archivePaths.agentIndex(snapshotId);
  return splitMarkdownArtifact(path, "Figma Design IR", [
    "# Figma Design IR\n\nCanonical JSON is authoritative for exact values.",
    `- ${link(path, archivePaths.manifest(snapshotId), "manifest.json")}\n- ${link(path, archivePaths.diagnostics(snapshotId), "diagnostics.json")}\n- ${link(path, archivePaths.irDocument(snapshotId), "ir/document.json")}`,
    `Pages: ${String(document.pages.length)}. Selected roots: ${String(document.selectedRootIds.length)}.`,
  ])[0]!.text;
}
