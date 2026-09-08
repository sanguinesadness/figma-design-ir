import {
  ArchiveProducerSafetyError,
  archivePaths,
  requireSnapshotId,
  type ArchiveArtifactRequirement,
  type ArchiveEntryDescriptor,
  type ArchiveManifestDraft,
  type SnapshotId,
} from "../shared/archive";
import {
  createDiagnosticsArtifact,
  DIAGNOSTIC_CODES,
  DiagnosticBag,
  normalizeSafeTechnicalCause,
} from "../shared/diagnostics";
import {
  DESIGN_IR_SCHEMA_VERSION,
  ARCHIVE_FORMAT_VERSION,
  type ArtifactRef,
  type CollectionCountIR,
  type ComponentDefinitionIR,
  type DesignIrComponentDefinitionArtifact,
  type DesignIrDocument,
  type DesignIrRootIndex,
  type NodeIR,
  type SourceRef,
} from "../shared/ir";
import {
  projectComponentMarkdown,
  projectGlobalMarkdown,
  projectSelectionPageMarkdown,
} from "../shared/minimal-markdown";
import { normalizeJsonSafeValue } from "../shared/normalization";
import {
  PROTOCOL_VERSION,
  type ArchiveEntryPayload,
  type ExportId,
  type ExportProducerMessage,
} from "../shared/protocol";
import {
  resolveSelectionRoots,
  SelectionScopeError,
  type ScopeTreeNode,
} from "../shared/scope";
import { serializeCanonicalJson } from "../shared/serialization";
import {
  ExportCancellationToken,
  ExportCancelledError,
  yieldToFigma,
} from "./cancellation";
import { assertArchiveEntryFits } from "./archive-entry-preflight";
import { collectNodeTree } from "./collect-node";
import { AssetCollectionSession } from "./collect-assets";
import { exportSelectedRootPreview } from "./export-preview";
import {
  collectComponents,
  type CollectedComponents,
} from "./collect-components";
import { collectStyles, type CollectedStyles } from "./collect-styles";
import { collectVariables, type CollectedVariables } from "./collect-variables";

const EXPORTER_PACKAGE_VERSION = "0.2.0";

export interface RunSelectionExportOptions {
  readonly exportId: ExportId;
  readonly requestId: string;
  readonly snapshotId: string;
  readonly cancellation: ExportCancellationToken;
  readonly postMessage: (
    message: ExportProducerMessage,
  ) => void | Promise<void>;
  readonly exportedAtUtc?: string;
  readonly optionalArtifactByteLimit?: number;
}

interface RootArtifactResult {
  readonly artifact: DesignIrRootIndex;
  readonly artifactRef: ArtifactRef;
  readonly dependencyRefs: readonly SourceRef[];
  readonly styleUsage: ReadonlyMap<string, readonly SourceRef[]>;
}

interface ComponentDefinitionArtifactResult {
  readonly componentId: string;
  readonly artifactRef: ArtifactRef;
  readonly dependencyRefs: readonly SourceRef[];
  readonly styleUsage: ReadonlyMap<string, readonly SourceRef[]>;
  readonly diagnosticIds: readonly string[];
  readonly complete: boolean;
}

interface GlobalArtifacts {
  readonly components: CollectedComponents;
  readonly styles: CollectedStyles;
  readonly variables: CollectedVariables;
}

function directStyleReferences(node: NodeIR): readonly SourceRef[] {
  const references: SourceRef[] = [];
  for (const reference of [
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
      reference !== undefined &&
      reference !== null &&
      !("$type" in reference) &&
      reference.kind === "style"
    ) {
      references.push(reference);
    }
  }
  return references;
}

function styleUsageFromTree(
  tree: NodeIR,
): ReadonlyMap<string, readonly SourceRef[]> {
  const usage = new Map<string, SourceRef[]>();
  const work: NodeIR[] = [tree];
  while (work.length > 0) {
    const node = work.pop();
    if (node === undefined) {
      continue;
    }
    for (const reference of directStyleReferences(node)) {
      const sources = usage.get(reference.id) ?? [];
      if (!sources.some((source) => source.id === node.source.id)) {
        sources.push(node.source);
      }
      usage.set(reference.id, sources);
    }
    if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) {
          work.push(child);
        }
      }
    }
  }
  return usage;
}

function mergeStyleUsage(
  results: readonly {
    readonly styleUsage: ReadonlyMap<string, readonly SourceRef[]>;
  }[],
): ReadonlyMap<string, readonly SourceRef[]> {
  const merged = new Map<string, SourceRef[]>();
  for (const result of results) {
    for (const [styleId, sources] of result.styleUsage) {
      const target = merged.get(styleId) ?? [];
      for (const source of sources) {
        if (!target.some((candidate) => candidate.id === source.id)) {
          target.push(source);
        }
      }
      merged.set(styleId, target);
    }
  }
  return merged;
}

function collectionCount(
  value: number,
  complete: boolean,
  coverage: "file-local" | "selected-reachable",
  reason: string,
): CollectionCountIR {
  return complete
    ? { status: "collected", value, coverage }
    : { status: "partial", value, coverage, reason };
}

function postProgress(
  options: RunSelectionExportOptions,
  phase:
    | "scope"
    | "collection"
    | "raw"
    | "asset"
    | "preview"
    | "serialization"
    | "archive",
  completed: number,
  total?: number,
  currentLabel?: string,
): void {
  void options.postMessage({
    type: "progress",
    protocolVersion: PROTOCOL_VERSION,
    exportId: options.exportId,
    phase,
    completed,
    ...(total === undefined ? {} : { total }),
    ...(currentLabel === undefined ? {} : { currentLabel }),
  });
}

function sourceRefForPage(
  page: PageNode,
): SourceRef & { readonly kind: "page" } {
  return {
    kind: "page",
    id: page.id,
    name: page.name,
  };
}

function owningPageRefForNode(
  node: SceneNode,
  source: SourceRef & { readonly kind: "component" },
  diagnostics: DiagnosticBag,
): (SourceRef & { readonly kind: "page" }) | undefined {
  const visited = new Set<object>();
  let current: object = node;
  while (!visited.has(current)) {
    visited.add(current);
    let parent: unknown;
    try {
      parent = Reflect.get(current, "parent");
    } catch (error) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
        severity: "warning",
        message:
          "The owning page for a reachable component definition could not be read.",
        phase: "collection",
        source,
        propertyPath: "$.parent.page",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
      });
      return undefined;
    }
    if (parent === null || typeof parent !== "object") {
      return undefined;
    }
    try {
      const type: unknown = Reflect.get(parent, "type");
      if (type === "PAGE") {
        const id: unknown = Reflect.get(parent, "id");
        const name: unknown = Reflect.get(parent, "name");
        if (typeof id === "string") {
          return {
            kind: "page",
            id,
            ...(typeof name === "string" ? { name } : {}),
          };
        }
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message:
            "The owning page for a reachable component definition has an unsupported identifier shape.",
          phase: "collection",
          source,
          propertyPath: "$.parent.page.id",
          causedDataLoss: true,
        });
        return undefined;
      }
      if (type === "DOCUMENT") {
        return undefined;
      }
    } catch (error) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
        severity: "warning",
        message:
          "The owning page metadata for a reachable component definition could not be read.",
        phase: "collection",
        source,
        propertyPath: "$.parent.page",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
      });
      return undefined;
    }
    current = parent;
  }
  diagnostics.add({
    code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
    severity: "warning",
    message:
      "The ancestor chain for a reachable component definition contains a cycle.",
    phase: "collection",
    source,
    propertyPath: "$.parent",
    causedDataLoss: true,
  });
  return undefined;
}

function emittedRequirement(path: string): ArchiveArtifactRequirement {
  return { path, status: "emitted" };
}

function unavailableRequirement(
  path: string,
  diagnosticId: string,
): ArchiveArtifactRequirement {
  return { path, status: "unavailable", diagnosticId };
}

function entryMessage(
  exportId: ExportId,
  descriptor: ArchiveEntryDescriptor,
): ArchiveEntryPayload {
  return {
    type: "archive-entry",
    protocolVersion: PROTOCOL_VERSION,
    exportId,
    path: descriptor.metadata.path,
    mediaType: descriptor.metadata.mediaType,
    compression: descriptor.metadata.compression,
    data: descriptor.data,
  };
}

async function emitEntry(
  options: RunSelectionExportOptions,
  requirements: ArchiveArtifactRequirement[],
  path: string,
  mediaType: string,
  compression: "deflate" | "store",
  data: string | Uint8Array,
): Promise<void> {
  options.cancellation.throwIfCancelled();
  await options.postMessage(
    entryMessage(options.exportId, {
      metadata: {
        path,
        mediaType,
        compression,
        uncompressedByteLength:
          typeof data === "string" ? data.length : data.length,
      },
      data,
    }),
  );
  requirements.push(emittedRequirement(path));
  options.cancellation.throwIfCancelled();
}

async function exportRawRoot(
  root: SceneNode,
  snapshotId: SnapshotId,
  diagnostics: DiagnosticBag,
  cancellation: ExportCancellationToken,
  entryByteLimit?: number,
): Promise<
  | {
      readonly artifact: ArtifactRef;
      readonly text: string;
    }
  | {
      readonly diagnosticId: string;
    }
> {
  const path = archivePaths.rawRestRoot(snapshotId, root.id);
  try {
    cancellation.throwIfCancelled();
    const raw = await root.exportAsync({ format: "JSON_REST_V1" });
    cancellation.throwIfCancelled();
    const normalized = normalizeJsonSafeValue(raw, {
      diagnostics,
      phase: "normalization",
      source: { kind: "node", id: root.id, name: root.name },
      classifySpecialValue: (value) =>
        value === figma.mixed ? { $type: "figma-mixed" } : undefined,
    }).value;
    const text = serializeCanonicalJson(normalized);
    await assertArchiveEntryFits(text, {
      byteLimit: entryByteLimit,
      checkpoint: () => cancellation.throwIfCancelled(),
    });
    return {
      artifact: { path, mediaType: "application/json" },
      text,
    };
  } catch (error) {
    if (error instanceof ExportCancelledError) {
      throw error;
    }
    cancellation.throwIfCancelled();
    if (
      error instanceof ArchiveProducerSafetyError &&
      error.code === "archive-capacity-exceeded"
    ) {
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
        severity: "error",
        message:
          "The selected root raw REST-like artifact exceeded the safe single-entry archive limit and is absent; normalized IR continues.",
        phase: "raw",
        source: { kind: "node", id: root.id, name: root.name },
        artifactPath: path,
        causedDataLoss: true,
      });
      return { diagnosticId: diagnostic.id };
    }
    if (error instanceof ArchiveProducerSafetyError) {
      throw error;
    }
    const diagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.rawExportFailed,
      severity: "error",
      message:
        "The selected root raw REST-like export failed; normalized IR continues without that fallback.",
      phase: "collection",
      source: { kind: "node", id: root.id, name: root.name },
      artifactPath: path,
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
    });
    return { diagnosticId: diagnostic.id };
  }
}

async function exportRawComponent(
  node: SceneNode,
  source: SourceRef & { readonly kind: "component" },
  snapshotId: SnapshotId,
  diagnostics: DiagnosticBag,
  cancellation: ExportCancellationToken,
  entryByteLimit?: number,
): Promise<
  | { readonly artifact: ArtifactRef; readonly text: string }
  | { readonly diagnosticId: string }
> {
  const path = archivePaths.rawRestComponent(snapshotId, source.id);
  try {
    cancellation.throwIfCancelled();
    const raw = await node.exportAsync({ format: "JSON_REST_V1" });
    cancellation.throwIfCancelled();
    const normalized = normalizeJsonSafeValue(raw, {
      diagnostics,
      phase: "normalization",
      source,
      classifySpecialValue: (value) =>
        value === figma.mixed ? { $type: "figma-mixed" } : undefined,
    }).value;
    const text = serializeCanonicalJson(normalized);
    await assertArchiveEntryFits(text, {
      byteLimit: entryByteLimit,
      checkpoint: () => cancellation.throwIfCancelled(),
    });
    return {
      artifact: { path, mediaType: "application/json" },
      text,
    };
  } catch (error) {
    if (error instanceof ExportCancelledError) {
      throw error;
    }
    cancellation.throwIfCancelled();
    if (
      error instanceof ArchiveProducerSafetyError &&
      error.code === "archive-capacity-exceeded"
    ) {
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
        severity: "error",
        message:
          "A reachable component raw REST-like artifact exceeded the safe single-entry archive limit and is absent; normalized component IR continues.",
        phase: "raw",
        source,
        artifactPath: path,
        causedDataLoss: true,
      });
      return { diagnosticId: diagnostic.id };
    }
    if (error instanceof ArchiveProducerSafetyError) {
      throw error;
    }
    const diagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.rawExportFailed,
      severity: "error",
      message:
        "A reachable component raw REST-like fallback could not be exported; normalized component IR remains available but the archive is incomplete.",
      phase: "collection",
      source,
      artifactPath: path,
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
    });
    return { diagnosticId: diagnostic.id };
  }
}

async function collectComponentDefinitionArtifacts(
  components: CollectedComponents,
  snapshotId: SnapshotId,
  diagnostics: DiagnosticBag,
  requirements: ArchiveArtifactRequirement[],
  options: RunSelectionExportOptions,
): Promise<ComponentDefinitionArtifactResult[]> {
  const results: ComponentDefinitionArtifactResult[] = [];
  const componentSummaryIds = new Set(
    components.index.definitions
      .filter((definition) =>
        components.definitionNodesById.has(definition.source.id),
      )
      .map((definition) => definition.source.id),
  );
  for (const definition of components.index.definitions) {
    const node = components.definitionNodesById.get(definition.source.id);
    if (node === undefined) {
      continue;
    }
    const diagnosticStart = diagnostics.size();
    const page = owningPageRefForNode(node, definition.source, diagnostics);
    const collected = await collectNodeTree(
      node,
      page,
      diagnostics,
      options.cancellation,
      components,
    );
    postProgress(
      options,
      "asset",
      results.length,
      components.index.definitions.length,
    );
    const raw = await exportRawComponent(
      node,
      definition.source,
      snapshotId,
      diagnostics,
      options.cancellation,
      options.optionalArtifactByteLimit,
    );
    if ("text" in raw) {
      await emitEntry(
        options,
        requirements,
        raw.artifact.path,
        raw.artifact.mediaType,
        "deflate",
        raw.text,
      );
    } else {
      requirements.push(
        unavailableRequirement(
          archivePaths.rawRestComponent(snapshotId, definition.source.id),
          raw.diagnosticId,
        ),
      );
    }
    const diagnosticIds = [
      ...new Set([
        ...diagnostics
          .listSince(diagnosticStart)
          .map((diagnostic) => diagnostic.id),
      ]),
    ];
    const rawArtifact = "artifact" in raw ? raw.artifact : undefined;
    const normalizedTree = withRootMetadata(
      collected.tree,
      rawArtifact,
      diagnosticIds,
    );
    const artifact: DesignIrComponentDefinitionArtifact = {
      kind: "design-ir-component-definition",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      source: definition.source,
      dependencyRefs: collected.dependencyRefs,
      normalizedTree,
      reactions: collected.reactions,
      assets: [],
      coverage: {
        dependencies: collected.coverage.dependencyRefsComplete
          ? { status: "collected" }
          : {
              status: "partial",
              reason:
                "Some dependency references were inaccessible while collecting the reachable component definition.",
            },
        reactions: collected.coverage.interactionsComplete
          ? { status: "collected" }
          : {
              status: "partial",
              reason:
                "Some reactions were inaccessible while collecting the reachable component definition.",
            },
        assets: {
          status: "not-collected",
          reason:
            "Binary assets are exported only for selected roots; component trees keep exact vector geometry and text values instead.",
        },
        textSegments: collected.coverage.textSegmentsComplete
          ? { status: "collected" }
          : {
              status: "partial",
              reason:
                "Some styled text segments were inaccessible while collecting the reachable component definition.",
            },
        annotationsAndAccessibility: collected.coverage.interactionsComplete
          ? { status: "collected" }
          : {
              status: "partial",
              reason:
                "Some annotations were inaccessible; the installed Plugin API exposes no accessibility/ARIA fields.",
            },
      },
      ...(rawArtifact === undefined ? {} : { rawArtifact }),
      diagnosticIds,
    };
    const path = archivePaths.irComponentDefinition(
      snapshotId,
      definition.source.id,
    );
    const definitionWithArtifact: ComponentDefinitionIR = {
      ...definition,
      definitionArtifact: { path, mediaType: "application/json" },
    };
    await emitEntry(
      options,
      requirements,
      path,
      "application/json",
      "deflate",
      serializeCanonicalJson(artifact),
    );
    for (const markdown of projectComponentMarkdown(
      snapshotId,
      definitionWithArtifact,
      artifact,
      {
        dependencies: components.index.dependencies,
        componentSummaryIds,
      },
    )) {
      await emitEntry(
        options,
        requirements,
        markdown.path,
        "text/markdown",
        "deflate",
        markdown.text,
      );
    }
    results.push({
      componentId: definition.source.id,
      artifactRef: { path, mediaType: "application/json" },
      dependencyRefs: collected.dependencyRefs,
      styleUsage: styleUsageFromTree(collected.tree),
      diagnosticIds,
      complete:
        collected.coverage.dependencyRefsComplete &&
        collected.coverage.interactionsComplete &&
        collected.coverage.textSegmentsComplete,
    });
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }
  return results;
}

function withRootMetadata(
  tree: DesignIrRootIndex["normalizedTree"],
  rawArtifact: ArtifactRef | undefined,
  diagnosticIds: readonly string[],
): DesignIrRootIndex["normalizedTree"] {
  return {
    ...tree,
    ...(rawArtifact === undefined ? {} : { rawArtifact }),
    diagnosticIds,
  };
}

async function collectRootArtifact(
  root: SceneNode,
  rootIndex: number,
  rootTotal: number,
  page: SourceRef & { readonly kind: "page" },
  snapshotId: SnapshotId,
  diagnostics: DiagnosticBag,
  requirements: ArchiveArtifactRequirement[],
  components: CollectedComponents,
  assets: AssetCollectionSession,
  options: RunSelectionExportOptions,
): Promise<RootArtifactResult> {
  const rootDiagnosticStart = diagnostics.size();
  options.cancellation.throwIfCancelled();
  postProgress(
    options,
    "collection",
    rootIndex,
    rootTotal,
    `Root ${rootIndex + 1} of ${rootTotal}`,
  );
  const collected = await collectNodeTree(
    root,
    page,
    diagnostics,
    options.cancellation,
    components,
  );

  postProgress(options, "asset", rootIndex, rootTotal);
  const collectedAssets = await assets.collectTree(
    collected.tree,
    collected.nodesById,
  );

  postProgress(options, "raw", rootIndex, rootTotal);
  const raw = await exportRawRoot(
    root,
    snapshotId,
    diagnostics,
    options.cancellation,
    options.optionalArtifactByteLimit,
  );
  if ("text" in raw) {
    await emitEntry(
      options,
      requirements,
      raw.artifact.path,
      raw.artifact.mediaType,
      "deflate",
      raw.text,
    );
  } else {
    requirements.push(
      unavailableRequirement(
        archivePaths.rawRestRoot(snapshotId, root.id),
        raw.diagnosticId,
      ),
    );
  }

  postProgress(options, "preview", rootIndex, rootTotal);
  const preview = await exportSelectedRootPreview(
    root,
    snapshotId,
    diagnostics,
    options.cancellation,
    options.optionalArtifactByteLimit,
  );
  if ("bytes" in preview) {
    await emitEntry(
      options,
      requirements,
      preview.preview.archivePath,
      preview.preview.mediaType,
      "store",
      preview.bytes,
    );
  } else {
    requirements.push(
      unavailableRequirement(
        archivePaths.preview(snapshotId, root.id),
        preview.diagnosticId,
      ),
    );
  }

  const rootDiagnosticIds = [
    ...new Set([
      ...diagnostics
        .listSince(rootDiagnosticStart)
        .map((diagnostic) => diagnostic.id),
      ...collectedAssets.diagnosticIds,
    ]),
  ];
  const rawArtifact = "artifact" in raw ? raw.artifact : undefined;
  const normalizedTree = withRootMetadata(
    collectedAssets.tree,
    rawArtifact,
    rootDiagnosticIds,
  );
  const artifact: DesignIrRootIndex = {
    kind: "design-ir-root-index",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    source: { kind: "node", id: root.id, name: root.name },
    dependencyRefs: collected.dependencyRefs,
    normalizedTree,
    reactions: collected.reactions,
    assets: collectedAssets.assets,
    previews: "preview" in preview ? [preview.preview] : [],
    coverage: {
      dependencies: collected.coverage.dependencyRefsComplete
        ? { status: "collected" }
        : {
            status: "partial",
            reason:
              "Some supported dependency references were inaccessible during root collection.",
          },
      reactions: collected.coverage.interactionsComplete
        ? { status: "collected" }
        : {
            status: "partial",
            reason:
              "Some supported reactions were inaccessible during collection.",
          },
      assets: collectedAssets.complete
        ? { status: "collected" }
        : {
            status: "partial",
            reason:
              "One or more reachable raster or standalone vector assets could not be exported.",
          },
      textSegments: collected.coverage.textSegmentsComplete
        ? { status: "collected" }
        : {
            status: "partial",
            reason:
              "Some styled text segments were inaccessible during collection.",
          },
      annotationsAndAccessibility: collected.coverage.interactionsComplete
        ? { status: "collected" }
        : {
            status: "partial",
            reason:
              "Some annotations were inaccessible; the installed Plugin API exposes no accessibility/ARIA fields.",
          },
    },
    ...(rawArtifact === undefined ? {} : { rawArtifact }),
    diagnosticIds: rootDiagnosticIds,
  };
  const artifactRef: ArtifactRef = {
    path: archivePaths.irNodeRoot(snapshotId, root.id),
    mediaType: "application/json",
  };
  await emitEntry(
    options,
    requirements,
    artifactRef.path,
    artifactRef.mediaType,
    "deflate",
    serializeCanonicalJson(artifact),
  );
  postProgress(options, "collection", rootIndex + 1, rootTotal);
  await yieldToFigma();
  options.cancellation.throwIfCancelled();
  return {
    artifact,
    artifactRef,
    dependencyRefs: collected.dependencyRefs,
    styleUsage: styleUsageFromTree(collectedAssets.tree),
  };
}

function createDocument(
  snapshotId: SnapshotId,
  page: PageNode,
  roots: readonly SceneNode[],
  rootResults: readonly RootArtifactResult[],
  globalArtifacts: GlobalArtifacts,
  diagnostics: DiagnosticBag,
): DesignIrDocument {
  return {
    kind: "design-ir-document",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    source: { kind: "document", id: figma.root.id, name: figma.root.name },
    name: figma.root.name,
    pages: [sourceRefForPage(page)],
    currentPageId: page.id,
    selectedRootIds: roots.map((root) => root.id),
    counts: {
      localVariables: collectionCount(
        globalArtifacts.variables.localCount,
        globalArtifacts.variables.localEnumerationComplete,
        "file-local",
        "Local variable enumeration was incomplete.",
      ),
      localStyles: collectionCount(
        globalArtifacts.styles.localCount,
        globalArtifacts.styles.localEnumerationComplete,
        "file-local",
        "Local style enumeration was incomplete.",
      ),
      localComponents: collectionCount(
        globalArtifacts.components.index.definitions.filter(
          (definition) => definition.source.remote === false,
        ).length,
        globalArtifacts.components.complete,
        "selected-reachable",
        "Some selected or reachable component metadata was inaccessible.",
      ),
    },
    artifacts: {
      variables: {
        path: archivePaths.irVariables(snapshotId),
        mediaType: "application/json",
      },
      styles: {
        path: archivePaths.irStyles(snapshotId),
        mediaType: "application/json",
      },
      components: {
        path: archivePaths.irComponents(snapshotId),
        mediaType: "application/json",
      },
      nodeArtifacts: rootResults.map((result) => result.artifactRef),
    },
    capabilities: [
      "current-selection",
      "common-node-ir",
      "raw-rest-v1",
      "selected-root-previews",
      "original-raster-assets",
      "standalone-svg-assets",
      "agent-readable-markdown",
      "variables",
      "styles",
      "components",
      "mixed-text-segments",
      "reactions",
      "annotations",
    ],
    limitations: [
      "Selection roots use deterministic document/canvas order because Plugin API selection order is unspecified.",
      "The installed @figma/plugin-typings@1.133.0 surface exposes annotations but no accessibility or ARIA node properties.",
      "Component counts and per-definition IR cover only definitions instantiated by the selected roots (including nested instances and swap targets); sibling variants and owning component sets are not exported, and exact file-wide local component counts require an Entire file export.",
      "Inaccessible referenced definitions remain unresolved with diagnostics and are never imported.",
      "Raster and standalone-SVG bytes are exported only for image fills and vector nodes reachable through the selected roots; raster bytes referenced exclusively by component definitions or paint styles are omitted.",
      `Raw, raster, SVG, and preview artifacts that fail are absent only with source-attributed diagnostics under ${snapshotId}.`,
    ],
    diagnosticIds: diagnostics.list().map((diagnostic) => diagnostic.id),
  };
}

export async function runSelectionExport(
  options: RunSelectionExportOptions,
): Promise<void> {
  const snapshotId = requireSnapshotId(options.snapshotId);
  const diagnostics = new DiagnosticBag("diagnostic");
  const requirements: ArchiveArtifactRequirement[] = [];
  const assetSession = new AssetCollectionSession({
    snapshotId,
    diagnostics,
    cancellation: options.cancellation,
    entryByteLimit: options.optionalArtifactByteLimit,
    emitter: {
      emit: async (path, mediaType, compression, data) => {
        await emitEntry(
          options,
          requirements,
          path,
          mediaType,
          compression,
          data,
        );
      },
      unavailable: (path, diagnosticId) => {
        requirements.push(unavailableRequirement(path, diagnosticId));
      },
    },
  });
  options.cancellation.throwIfCancelled();
  postProgress(options, "scope", 0);

  const originalSelection = [...figma.currentPage.selection];
  const resolution = resolveSelectionRoots(
    originalSelection as unknown as readonly (SceneNode & ScopeTreeNode)[],
    diagnostics,
  );
  const roots = resolution.roots as readonly SceneNode[];
  void options.postMessage({
    type: "export-started",
    protocolVersion: PROTOCOL_VERSION,
    requestId: options.requestId,
    exportId: options.exportId,
    scopeSummary: {
      kind: "current-selection",
      rootCount: roots.length,
    },
  });
  postProgress(options, "scope", roots.length, roots.length);

  const page = figma.currentPage;
  const pageRef = sourceRefForPage(page);
  postProgress(options, "collection", 0, roots.length + 3, "Components");
  const collectedComponents = await collectComponents({
    roots,
    adapter: {
      getNodeByIdAsync: async (id) => {
        options.cancellation.throwIfCancelled();
        const node = await figma.getNodeByIdAsync(id);
        options.cancellation.throwIfCancelled();
        return node as SceneNode | null;
      },
    },
    diagnostics,
    cancellation: options.cancellation,
    componentScope: "used",
  });
  const componentDefinitionResults = await collectComponentDefinitionArtifacts(
    collectedComponents,
    snapshotId,
    diagnostics,
    requirements,
    options,
  );
  const definitionArtifactById = new Map(
    componentDefinitionResults.map((result) => [
      result.componentId,
      result.artifactRef,
    ]),
  );
  const components: CollectedComponents = {
    ...collectedComponents,
    index: {
      ...collectedComponents.index,
      definitions: collectedComponents.index.definitions.map((definition) => {
        const definitionArtifact = definitionArtifactById.get(
          definition.source.id,
        );
        return definitionArtifact === undefined
          ? definition
          : { ...definition, definitionArtifact };
      }),
      diagnosticIds: [
        ...new Set([
          ...collectedComponents.index.diagnosticIds,
          ...componentDefinitionResults.flatMap(
            (result) => result.diagnosticIds,
          ),
        ]),
      ],
    },
  };
  const rootResults: RootArtifactResult[] = [];
  for (const [index, root] of roots.entries()) {
    options.cancellation.throwIfCancelled();
    if (root.removed) {
      for (const path of [
        archivePaths.rawRestRoot(snapshotId, root.id),
        archivePaths.irNodeRoot(snapshotId, root.id),
        archivePaths.preview(snapshotId, root.id),
      ]) {
        const diagnostic = diagnostics.add({
          code: DIAGNOSTIC_CODES.scopeRootRemoved,
          severity: "error",
          message:
            "A required selected-root artifact is unavailable because the root was removed before collection.",
          phase: "scope",
          source: { kind: "node", id: root.id },
          artifactPath: path,
          causedDataLoss: true,
        });
        requirements.push(unavailableRequirement(path, diagnostic.id));
      }
      continue;
    }
    rootResults.push(
      await collectRootArtifact(
        root,
        index,
        roots.length,
        pageRef,
        snapshotId,
        diagnostics,
        requirements,
        components,
        assetSession,
        options,
      ),
    );
  }

  const scopeDependencies = [
    ...rootResults.flatMap((result) => result.dependencyRefs),
    ...componentDefinitionResults.flatMap((result) => result.dependencyRefs),
  ];
  const styleUsage = mergeStyleUsage([
    ...rootResults,
    ...componentDefinitionResults,
  ]);
  postProgress(
    options,
    "collection",
    roots.length + 1,
    roots.length + 3,
    "Styles",
  );
  const collectedStyles = await collectStyles({
    referencedStyleIds: scopeDependencies
      .filter((reference) => reference.kind === "style")
      .map((reference) => reference.id),
    referencedByByStyleId: styleUsage,
    diagnostics,
    cancellation: options.cancellation,
  });
  postProgress(options, "asset", roots.length + 1, roots.length + 2, "Styles");
  const styles: CollectedStyles = collectedStyles;
  postProgress(
    options,
    "collection",
    roots.length + 2,
    roots.length + 3,
    "Variables",
  );
  const variables = await collectVariables({
    referencedVariableIds: [...scopeDependencies, ...components.dependencyRefs]
      .filter((reference) => reference.kind === "variable")
      .map((reference) => reference.id)
      .concat(styles.referencedVariableIds),
    referencedCollectionIds: scopeDependencies
      .filter((reference) => reference.kind === "collection")
      .map((reference) => reference.id),
    diagnostics,
    cancellation: options.cancellation,
  });
  const globalArtifacts: GlobalArtifacts = { components, styles, variables };

  for (const [path, artifact] of [
    [archivePaths.irComponents(snapshotId), components.index],
    [archivePaths.irStyles(snapshotId), styles.artifact],
    [archivePaths.irVariables(snapshotId), variables.artifact],
  ] as const) {
    await emitEntry(
      options,
      requirements,
      path,
      "application/json",
      "deflate",
      serializeCanonicalJson(artifact),
    );
  }
  postProgress(options, "collection", roots.length + 3, roots.length + 3);

  options.cancellation.throwIfCancelled();
  postProgress(options, "serialization", 0, 3);
  const document = createDocument(
    snapshotId,
    page,
    roots,
    rootResults,
    globalArtifacts,
    diagnostics,
  );
  const documentPath = archivePaths.irDocument(snapshotId);
  await emitEntry(
    options,
    requirements,
    documentPath,
    "application/json",
    "deflate",
    serializeCanonicalJson(document),
  );
  postProgress(options, "serialization", 1, 3);

  const diagnosticsArtifact = createDiagnosticsArtifact(diagnostics.list());
  const summary = diagnosticsArtifact.summary;
  const diagnosticsPath = archivePaths.diagnostics(snapshotId);
  await emitEntry(
    options,
    requirements,
    diagnosticsPath,
    "application/json",
    "deflate",
    serializeCanonicalJson(diagnosticsArtifact),
  );
  postProgress(options, "serialization", 2, 3, "Agent summaries");

  for (const markdown of projectSelectionPageMarkdown(
    snapshotId,
    pageRef,
    rootResults.map((result) => result.artifact),
    new Set(componentDefinitionResults.map((result) => result.componentId)),
  )) {
    await emitEntry(
      options,
      requirements,
      markdown.path,
      "text/markdown",
      "deflate",
      markdown.text,
    );
  }
  for (const markdown of projectGlobalMarkdown(
    snapshotId,
    document,
    variables.artifact,
    styles.artifact,
    components.index,
    [archivePaths.agentPage(snapshotId, pageRef.id)],
    summary,
  )) {
    await emitEntry(
      options,
      requirements,
      markdown.path,
      "text/markdown",
      "deflate",
      markdown.text,
    );
  }
  postProgress(options, "serialization", 3, 3, "Agent indexes");

  void options.postMessage({
    type: "diagnostic-summary",
    protocolVersion: PROTOCOL_VERSION,
    exportId: options.exportId,
    counts: summary.counts,
    completeness: summary.completeness,
  });

  await yieldToFigma();
  options.cancellation.throwIfCancelled();
  const manifestDraft: ArchiveManifestDraft = {
    archiveVersion: ARCHIVE_FORMAT_VERSION,
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    exporter: {
      packageName: "figma-design-ir",
      packageVersion: EXPORTER_PACKAGE_VERSION,
    },
    snapshotId,
    exportedAtUtc: options.exportedAtUtc ?? new Date().toISOString(),
    editorType: "figma",
    document: { name: figma.root.name },
    scope: {
      kind: "current-selection",
      orderedRootIds: roots.map((root) => root.id),
    },
    ownerConfirmedCurrent: true,
    counts: {
      pages: 1,
      roots: roots.length,
      artifacts: requirements.filter(
        (requirement) => requirement.status === "emitted",
      ).length,
    },
    diagnosticCounts: summary.counts,
    completeness: summary.completeness,
    capabilities: document.capabilities,
    pluginApiLimitations: document.limitations,
  };
  postProgress(options, "archive", 0, undefined, "Finalizing locally");
  void options.postMessage({
    type: "export-ready",
    protocolVersion: PROTOCOL_VERSION,
    exportId: options.exportId,
    manifestDraft,
    artifacts: requirements,
  });
}

export function classifySelectionExportFailure(
  error: unknown,
): "scope-empty" | "scope-invalid" | "collection-failed" {
  if (error instanceof SelectionScopeError) {
    return error.message === "Current selection is empty."
      ? "scope-empty"
      : "scope-invalid";
  }
  return "collection-failed";
}
