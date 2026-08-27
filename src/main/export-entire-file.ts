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
  type SafeTechnicalCause,
} from "../shared/diagnostics";
import {
  ARCHIVE_FORMAT_VERSION,
  DESIGN_IR_SCHEMA_VERSION,
  type ArtifactRef,
  type AssetRefIR,
  type CollectionCountIR,
  type ComponentDefinitionIR,
  type ComponentDependencyIR,
  type ComponentsIndexIR,
  type DesignIrComponentDefinitionArtifact,
  type DesignIrDocument,
  type DesignIrPageIndex,
  type NodeIR,
  type PreviewRefIR,
  type ReactionIR,
  type SourceRef,
} from "../shared/ir";
import {
  projectComponentMarkdown,
  projectGlobalMarkdown,
  projectPageMarkdown,
} from "../shared/minimal-markdown";
import { normalizeJsonSafeValue } from "../shared/normalization";
import {
  PROTOCOL_VERSION,
  type ArchiveEntryPayload,
  type ExportId,
  type ExportProgressPhase,
  type ExportProducerMessage,
} from "../shared/protocol";
import {
  serializeCanonicalJson,
  sortUnorderedComponentDefinitions,
  sortUnorderedComponentDependencies,
  sortUnorderedSourceRefs,
} from "../shared/serialization";
import {
  ExportCancellationToken,
  ExportCancelledError,
  yieldToFigma,
} from "./cancellation";
import {
  assertArchiveEntryFits,
  assertCanonicalJsonFits,
} from "./archive-entry-preflight";
import { AssetCollectionSession } from "./collect-assets";
import {
  ComponentCollectionSession,
  collectComponents,
  type CollectedComponents,
  type ComponentCollectionProgress,
} from "./collect-components";
import { collectNodeTree } from "./collect-node";
import { collectStyles, type CollectedStyles } from "./collect-styles";
import {
  collectVariables,
  type CollectedVariables,
  type VariableCollectorApi,
} from "./collect-variables";
import {
  exportNodePreview,
  selectEntireFilePreviewCandidates,
  type PreviewExportNode,
} from "./export-preview";

const EXPORTER_PACKAGE_VERSION = "0.1.0";

export interface RunEntireFileExportOptions {
  readonly exportId: ExportId;
  readonly requestId: string;
  readonly snapshotId: string;
  readonly cancellation: ExportCancellationToken;
  readonly postMessage: (
    message: ExportProducerMessage,
  ) => void | Promise<void>;
  readonly exportedAtUtc?: string;
  readonly api?: PluginAPI;
  readonly now?: () => number;
  readonly optionalArtifactByteLimit?: number;
  readonly pageArtifactByteLimit?: number;
  readonly onPageReleased?: (metrics: {
    readonly pageIndex: number;
    readonly rootCount: number;
    readonly nodeCount: number;
  }) => void;
}

interface ComponentDefinitionArtifactResult {
  readonly dependencyRefs: readonly SourceRef[];
  readonly styleUsage: ReadonlyMap<string, readonly SourceRef[]>;
  readonly diagnosticIds: readonly string[];
}

interface PageArtifactResult {
  readonly artifactRef?: ArtifactRef;
  readonly markdownPath?: string;
  readonly childNodeIds: readonly string[];
  readonly nodeCount: number;
}

interface SerializedPageArtifact {
  readonly artifact: DesignIrPageIndex;
  readonly text: string;
}

type PageLoadOutcome =
  | { readonly status: "loaded" }
  | {
      readonly status: "failed";
      readonly technicalCause: SafeTechnicalCause;
    };

type PagePreparationOutcome =
  | { readonly status: "ready" }
  | {
      readonly status: "load-failed";
      readonly technicalCause: SafeTechnicalCause;
    }
  | {
      readonly status: "raw-stabilization-failed";
      readonly technicalCause: SafeTechnicalCause;
    };

type RawStabilizationAttempt =
  | { readonly status: "stabilized" }
  | {
      readonly status: "failed";
      readonly technicalCause: SafeTechnicalCause;
    };

interface GlobalComponentState {
  readonly definitions: Map<string, ComponentDefinitionIR>;
  readonly dependencies: Map<string, ComponentDependencyIR>;
  readonly diagnosticIds: Set<string>;
  readonly emittedDefinitionIds: Set<string>;
  readonly dependencyRefs: Map<string, SourceRef>;
  readonly collectionSession: ComponentCollectionSession;
}

interface GlobalDiscoveryState {
  readonly components: GlobalComponentState;
  readonly dependencyRefs: Map<string, SourceRef>;
  readonly styleUsage: Map<string, SourceRef[]>;
  readonly localComponentIds: Set<string>;
  localComponentEnumerationComplete: boolean;
}

interface GlobalArtifacts {
  readonly components: ComponentsIndexIR;
  readonly styles: CollectedStyles;
  readonly variables: CollectedVariables;
}

function elapsedMs(start: number, now: () => number): number {
  const elapsed = now() - start;
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
}

function pageLabel(pageIndex: number, pageTotal: number): string {
  return `Page ${pageIndex + 1} of ${pageTotal}`;
}

function componentCollectionLabel(
  pageIndex: number,
  pageTotal: number,
  progress: ComponentCollectionProgress,
): string {
  const stage =
    progress.stage === "instance-lookup"
      ? "instance resolution"
      : progress.stage === "id-lookup"
        ? "dependency resolution"
        : progress.stage === "complete"
          ? "component graph complete"
          : "component graph";
  return `${pageLabel(pageIndex, pageTotal)}; ${stage}; ${progress.traversedNodes} nodes; ${progress.instanceLookupsCompleted}/${progress.instanceLookupsStarted} instance lookups; ${progress.idLookupsCompleted}/${progress.idLookupsStarted} dependency lookups; ${progress.definitionsDiscovered} definitions; ${progress.reusedDefinitionTraversals} reused; ${progress.duplicateDefinitionQueuesSkipped} duplicate queues skipped`;
}

function postProgress(
  options: RunEntireFileExportOptions,
  phase: ExportProgressPhase,
  completed: number,
  total?: number,
  currentLabel?: string,
  durationMs?: number,
): void {
  void options.postMessage({
    type: "progress",
    protocolVersion: PROTOCOL_VERSION,
    exportId: options.exportId,
    phase,
    completed,
    ...(total === undefined ? {} : { total }),
    ...(currentLabel === undefined ? {} : { currentLabel }),
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function sourceRefForPage(
  page: PageNode,
): SourceRef & { readonly kind: "page" } {
  return { kind: "page", id: page.id, name: page.name };
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
  options: RunEntireFileExportOptions,
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
        uncompressedByteLength: data.length,
      },
      data,
    }),
  );
  requirements.push(emittedRequirement(path));
  options.cancellation.throwIfCancelled();
}

function collectionCount(
  value: number,
  complete: boolean,
  reason: string,
): CollectionCountIR {
  return complete
    ? { status: "collected", value, coverage: "file-local" }
    : {
        status: "partial",
        value,
        coverage: "file-local",
        reason,
      };
}

function referenceKey(reference: SourceRef): string {
  return `${reference.kind}\u0000${reference.id}`;
}

function addReference(
  target: Map<string, SourceRef>,
  reference: SourceRef,
): void {
  const key = referenceKey(reference);
  const existing = target.get(key);
  if (
    existing === undefined ||
    (existing.name === undefined && reference.name !== undefined) ||
    (existing.key === undefined && reference.key !== undefined)
  ) {
    target.set(key, reference);
  }
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

async function mergeStyleUsageFromTree(
  tree: NodeIR,
  target: Map<string, SourceRef[]>,
  cancellation: ExportCancellationToken,
): Promise<void> {
  const work: NodeIR[] = [tree];
  let visited = 0;
  while (work.length > 0) {
    cancellation.throwIfCancelled();
    const node = work.pop();
    if (node === undefined) {
      continue;
    }
    for (const reference of directStyleReferences(node)) {
      const sources = target.get(reference.id) ?? [];
      if (!sources.some((source) => source.id === node.source.id)) {
        sources.push(node.source);
      }
      target.set(reference.id, sources);
    }
    if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) {
          work.push(child);
        }
      }
    }
    visited += 1;
    if (visited % 50 === 0) {
      await yieldToFigma();
      cancellation.throwIfCancelled();
    }
  }
}

function dependencyKey(dependency: ComponentDependencyIR): string {
  return `${referenceKey(dependency.from)}\u0000${referenceKey(
    dependency.to,
  )}\u0000${dependency.relationship}`;
}

function mergeComponents(
  collected: CollectedComponents,
  state: GlobalComponentState,
): void {
  for (const definition of collected.index.definitions) {
    if (!state.definitions.has(definition.source.id)) {
      state.definitions.set(definition.source.id, definition);
    }
  }
  for (const dependency of collected.index.dependencies) {
    state.dependencies.set(dependencyKey(dependency), dependency);
  }
  for (const diagnosticId of collected.index.diagnosticIds) {
    state.diagnosticIds.add(diagnosticId);
  }
  for (const reference of collected.dependencyRefs) {
    addReference(state.dependencyRefs, reference);
  }
}

function assetKey(asset: AssetRefIR): string {
  return `${asset.assetKind}\u0000${asset.source.id}\u0000${asset.archivePath}`;
}

function deduplicateAssets(
  assets: readonly AssetRefIR[],
): readonly AssetRefIR[] {
  const byKey = new Map<string, AssetRefIR>();
  for (const asset of assets) {
    byKey.set(assetKey(asset), asset);
  }
  return [...byKey.values()].sort((left, right) => {
    const leftKey = assetKey(left);
    const rightKey = assetKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

async function serializePageArtifact(
  artifact: DesignIrPageIndex,
  normalizedTrees: NodeIR[],
  pageDiagnosticStart: number,
  pagePath: string,
  diagnostics: DiagnosticBag,
  options: RunEntireFileExportOptions,
): Promise<SerializedPageArtifact> {
  const preflightOptions = {
    byteLimit: options.pageArtifactByteLimit,
    checkpoint: () => options.cancellation.throwIfCancelled(),
  };
  try {
    await assertCanonicalJsonFits(artifact, preflightOptions);
  } catch (error) {
    if (error instanceof ExportCancelledError) {
      throw error;
    }
    options.cancellation.throwIfCancelled();
    if (
      !(error instanceof ArchiveProducerSafetyError) ||
      error.code !== "archive-capacity-exceeded"
    ) {
      throw error;
    }

    diagnostics.add({
      code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
      severity: "error",
      message:
        "A canonical page's normalized trees exceeded the safe single-entry archive limit. The page index retains direct-root order, references, reactions, assets, previews, diagnostics, and any available raw fallback, but its normalized trees are absent.",
      phase: "serialization",
      source: artifact.source,
      artifactPath: pagePath,
      propertyPath: "$.normalizedTrees",
      causedDataLoss: true,
    });
    normalizedTrees.length = 0;
    await yieldToFigma();
    options.cancellation.throwIfCancelled();

    const fallback: DesignIrPageIndex = {
      ...artifact,
      normalizedTrees: [],
      coverage: {
        ...artifact.coverage,
        textSegments: {
          status: "partial",
          reason:
            "Normalized page trees were omitted after exceeding the safe single-entry archive limit, so styled text segments are not present in canonical node context.",
        },
        annotationsAndAccessibility: {
          status: "partial",
          reason:
            "Normalized page trees were omitted after exceeding the safe single-entry archive limit, so annotations are not present in canonical node context; the installed Plugin API exposes no accessibility/ARIA fields.",
        },
      },
      diagnosticIds: diagnostics
        .listSince(pageDiagnosticStart)
        .map((diagnostic) => diagnostic.id),
    };
    await assertCanonicalJsonFits(fallback, preflightOptions);
    options.cancellation.throwIfCancelled();
    const fallbackText = serializeCanonicalJson(fallback);
    options.cancellation.throwIfCancelled();
    await assertArchiveEntryFits(fallbackText, preflightOptions);
    return { artifact: fallback, text: fallbackText };
  }

  options.cancellation.throwIfCancelled();
  const text = serializeCanonicalJson(artifact);
  options.cancellation.throwIfCancelled();
  await assertArchiveEntryFits(text, preflightOptions);
  return { artifact, text };
}

function emptyComponents(diagnosticId?: string): CollectedComponents {
  return {
    index: {
      kind: "design-ir-components",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      definitions: [],
      dependencies: [],
      diagnosticIds: diagnosticId === undefined ? [] : [diagnosticId],
    },
    componentDataByNodeId: new Map(),
    instanceDataByNodeId: new Map(),
    componentPropertyReferencesByNodeId: new Map(),
    slotLimitViolationsByNodeId: new Map(),
    dependencyRefs: [],
    complete: diagnosticId === undefined,
    definitionNodesById: new Map(),
  };
}

function clearCollectedMap<TKey, TValue>(
  values: ReadonlyMap<TKey, TValue>,
): void {
  (values as Map<TKey, TValue>).clear();
}

function releaseCollectedComponents(components: CollectedComponents): void {
  (components.index.definitions as ComponentDefinitionIR[]).length = 0;
  (components.index.dependencies as ComponentDependencyIR[]).length = 0;
  (components.index.diagnosticIds as string[]).length = 0;
  (components.dependencyRefs as SourceRef[]).length = 0;
  clearCollectedMap(components.componentDataByNodeId);
  clearCollectedMap(components.instanceDataByNodeId);
  clearCollectedMap(components.componentPropertyReferencesByNodeId);
  clearCollectedMap(components.slotLimitViolationsByNodeId);
  clearCollectedMap(components.definitionNodesById);
}

function withRootMetadata(
  tree: NodeIR,
  rawArtifact: ArtifactRef | undefined,
  diagnosticIds: readonly string[],
): NodeIR {
  return {
    ...tree,
    ...(rawArtifact === undefined ? {} : { rawArtifact }),
    diagnosticIds,
  };
}

async function exportRaw(
  target: PageNode | SceneNode,
  source: SourceRef,
  path: string,
  api: PluginAPI,
  diagnostics: DiagnosticBag,
  cancellation: ExportCancellationToken,
  entryByteLimit?: number,
): Promise<
  | { readonly artifact: ArtifactRef; readonly text: string }
  | { readonly diagnosticId: string }
> {
  try {
    cancellation.throwIfCancelled();
    const raw = await target.exportAsync({ format: "JSON_REST_V1" });
    cancellation.throwIfCancelled();
    const normalized = normalizeJsonSafeValue(raw, {
      diagnostics,
      phase: "normalization",
      source,
      classifySpecialValue: (value) =>
        value === api.mixed ? { $type: "figma-mixed" } : undefined,
    }).value;
    cancellation.throwIfCancelled();
    const text = serializeCanonicalJson(normalized);
    cancellation.throwIfCancelled();
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
          source.kind === "page"
            ? "A page raw REST-like artifact exceeded the safe single-entry archive limit and is absent; normalized page IR continues."
            : "A component raw REST-like artifact exceeded the safe single-entry archive limit and is absent; normalized component IR continues.",
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
        source.kind === "page"
          ? "A page raw REST-like export failed; normalized page IR continues when available."
          : "A component raw REST-like export failed; normalized component IR continues when available.",
      phase: "raw",
      source,
      artifactPath: path,
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
    });
    return { diagnosticId: diagnostic.id };
  }
}

async function emitRawArtifact(
  target: PageNode | SceneNode,
  source: SourceRef,
  path: string,
  api: PluginAPI,
  diagnostics: DiagnosticBag,
  requirements: ArchiveArtifactRequirement[],
  options: RunEntireFileExportOptions,
): Promise<ArtifactRef | undefined> {
  const result = await exportRaw(
    target,
    source,
    path,
    api,
    diagnostics,
    options.cancellation,
    options.optionalArtifactByteLimit,
  );
  if ("text" in result) {
    await emitEntry(
      options,
      requirements,
      result.artifact.path,
      result.artifact.mediaType,
      "deflate",
      result.text,
    );
    return result.artifact;
  }
  requirements.push(unavailableRequirement(path, result.diagnosticId));
  return undefined;
}

function owningPageRefForNode(
  node: SceneNode,
): (SourceRef & { readonly kind: "page" }) | undefined {
  const visited = new Set<BaseNode>();
  let current: BaseNode | null = node;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    if (current.type === "PAGE") {
      return sourceRefForPage(current);
    }
    current = current.parent;
  }
  return undefined;
}

async function emitComponentDefinition(
  definition: ComponentDefinitionIR,
  node: SceneNode | undefined,
  components: CollectedComponents,
  componentSummaryIds: ReadonlySet<string>,
  snapshotId: SnapshotId,
  api: PluginAPI,
  diagnostics: DiagnosticBag,
  requirements: ArchiveArtifactRequirement[],
  assets: AssetCollectionSession,
  options: RunEntireFileExportOptions,
): Promise<ComponentDefinitionArtifactResult> {
  const path = archivePaths.irComponentDefinition(
    snapshotId,
    definition.source.id,
  );
  const rawPath = archivePaths.rawRestComponent(
    snapshotId,
    definition.source.id,
  );
  const diagnosticStart = diagnostics.size();
  if (node === undefined) {
    const irDiagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.componentDefinitionExportFailed,
      severity: "error",
      message:
        "An indexed component definition has no accessible node for canonical export.",
      phase: "collection",
      source: definition.source,
      artifactPath: path,
      causedDataLoss: true,
    });
    const rawDiagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.rawExportFailed,
      severity: "error",
      message:
        "An indexed component definition has no accessible node for its raw REST-like fallback.",
      phase: "raw",
      source: definition.source,
      artifactPath: rawPath,
      causedDataLoss: true,
    });
    requirements.push(
      unavailableRequirement(path, irDiagnostic.id),
      unavailableRequirement(rawPath, rawDiagnostic.id),
    );
    for (const markdown of projectComponentMarkdown(
      snapshotId,
      {
        ...definition,
        diagnosticIds: [
          ...definition.diagnosticIds,
          irDiagnostic.id,
          rawDiagnostic.id,
        ],
      },
      undefined,
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
    return {
      dependencyRefs: [],
      styleUsage: new Map(),
      diagnosticIds: [irDiagnostic.id, rawDiagnostic.id],
    };
  }

  const rawArtifact = await emitRawArtifact(
    node,
    definition.source,
    rawPath,
    api,
    diagnostics,
    requirements,
    options,
  );

  try {
    options.cancellation.throwIfCancelled();
    const collected = await collectNodeTree(
      node,
      owningPageRefForNode(node),
      diagnostics,
      options.cancellation,
      components,
    );
    options.cancellation.throwIfCancelled();
    const collectedAssets = await assets.collectTree(
      collected.tree,
      collected.nodesById,
    );
    options.cancellation.throwIfCancelled();
    const styleUsage = new Map<string, SourceRef[]>();
    try {
      await mergeStyleUsageFromTree(
        collectedAssets.tree,
        styleUsage,
        options.cancellation,
      );
    } catch (error) {
      if (
        error instanceof ExportCancelledError ||
        error instanceof ArchiveProducerSafetyError
      ) {
        throw error;
      }
      options.cancellation.throwIfCancelled();
      diagnostics.add({
        code: DIAGNOSTIC_CODES.componentDefinitionExportFailed,
        severity: "error",
        message:
          "A component definition's style-usage index could not be completed; its canonical definition remains available.",
        phase: "collection",
        source: definition.source,
        artifactPath: path,
        propertyPath: "$.styleUsage",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
      });
    }
    const diagnosticIds = [
      ...new Set([
        ...diagnostics
          .listSince(diagnosticStart)
          .map((diagnostic) => diagnostic.id),
        ...collectedAssets.diagnosticIds,
      ]),
    ];
    const normalizedTree = withRootMetadata(
      collectedAssets.tree,
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
      assets: collectedAssets.assets,
      coverage: {
        dependencies: collected.coverage.dependencyRefsComplete
          ? { status: "collected" }
          : {
              status: "partial",
              reason: "Some component dependency references were inaccessible.",
            },
        reactions: collected.coverage.interactionsComplete
          ? { status: "collected" }
          : {
              status: "partial",
              reason: "Some component reactions were inaccessible.",
            },
        assets: collectedAssets.complete
          ? { status: "collected" }
          : {
              status: "partial",
              reason:
                "One or more component raster or vector assets were unavailable.",
            },
        textSegments: collected.coverage.textSegmentsComplete
          ? { status: "collected" }
          : {
              status: "partial",
              reason: "Some component text segments were inaccessible.",
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
    options.cancellation.throwIfCancelled();
    const text = serializeCanonicalJson(artifact);
    options.cancellation.throwIfCancelled();
    await emitEntry(
      options,
      requirements,
      path,
      "application/json",
      "deflate",
      text,
    );
    for (const markdown of projectComponentMarkdown(
      snapshotId,
      definition,
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
    return {
      dependencyRefs: collected.dependencyRefs,
      styleUsage,
      diagnosticIds,
    };
  } catch (error) {
    if (
      error instanceof ExportCancelledError ||
      error instanceof ArchiveProducerSafetyError
    ) {
      throw error;
    }
    options.cancellation.throwIfCancelled();
    const diagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.componentDefinitionExportFailed,
      severity: "error",
      message:
        "A component definition could not be normalized; its raw fallback remains available when export succeeded.",
      phase: "collection",
      source: definition.source,
      artifactPath: path,
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
    });
    requirements.push(unavailableRequirement(path, diagnostic.id));
    const failureDiagnosticIds = diagnostics
      .listSince(diagnosticStart)
      .map((item) => item.id);
    for (const markdown of projectComponentMarkdown(
      snapshotId,
      {
        ...definition,
        diagnosticIds: [
          ...new Set([...definition.diagnosticIds, ...failureDiagnosticIds]),
        ],
      },
      undefined,
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
    return {
      dependencyRefs: [],
      styleUsage: new Map(),
      diagnosticIds: failureDiagnosticIds,
    };
  }
}

async function mergeLocalComponentCount(
  nodesById: ReadonlyMap<string, SceneNode>,
  state: GlobalDiscoveryState,
  diagnostics: DiagnosticBag,
  cancellation: ExportCancellationToken,
): Promise<void> {
  let visited = 0;
  for (const [nodeId, node] of nodesById) {
    cancellation.throwIfCancelled();
    try {
      if (
        (node.type === "COMPONENT" || node.type === "COMPONENT_SET") &&
        node.remote === false
      ) {
        state.localComponentIds.add(nodeId);
      }
    } catch (error) {
      state.localComponentEnumerationComplete = false;
      diagnostics.add({
        code: DIAGNOSTIC_CODES.pageCollectionFailed,
        severity: "error",
        message:
          "A page-local component could not be classified for the exact file-wide count.",
        phase: "collection",
        source: { kind: "node", id: nodeId },
        propertyPath: "$.type|$.remote",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
      });
    }
    visited += 1;
    if (visited % 50 === 0) {
      await yieldToFigma();
      cancellation.throwIfCancelled();
    }
  }
}

function mergeStyleUsage(
  target: Map<string, SourceRef[]>,
  incoming: ReadonlyMap<string, readonly SourceRef[]>,
): void {
  for (const [styleId, sources] of incoming) {
    const retained = target.get(styleId) ?? [];
    for (const source of sources) {
      if (!retained.some((candidate) => candidate.id === source.id)) {
        retained.push(source);
      }
    }
    target.set(styleId, retained);
  }
}

async function stabilizePageLoads(
  pages: readonly PageNode[],
  options: RunEntireFileExportOptions,
): Promise<readonly PageLoadOutcome[]> {
  const now = options.now ?? Date.now;
  const loadResults: ("loaded" | "retry")[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    options.cancellation.throwIfCancelled();
    postProgress(
      options,
      "page-loading",
      pageIndex,
      pages.length,
      pageLabel(pageIndex, pages.length),
    );
    const loadStarted = now();
    try {
      await page.loadAsync();
      options.cancellation.throwIfCancelled();
      loadResults.push("loaded");
    } catch (error) {
      if (
        error instanceof ExportCancelledError ||
        error instanceof ArchiveProducerSafetyError
      ) {
        throw error;
      }
      options.cancellation.throwIfCancelled();
      loadResults.push("retry");
    }
    postProgress(
      options,
      "page-loading",
      pageIndex + 1,
      pages.length,
      pageLabel(pageIndex, pages.length),
      elapsedMs(loadStarted, now),
    );
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  const retryPageIndexes = loadResults.flatMap((status, pageIndex) =>
    status === "retry" ? [pageIndex] : [],
  );
  const outcomes: (PageLoadOutcome | undefined)[] = loadResults.map((status) =>
    status === "loaded" ? { status } : undefined,
  );
  for (const [retryIndex, pageIndex] of retryPageIndexes.entries()) {
    const page = pages[pageIndex];
    if (page === undefined) {
      throw new Error("A page retry target was not recorded.");
    }
    options.cancellation.throwIfCancelled();
    postProgress(
      options,
      "page-loading",
      retryIndex,
      retryPageIndexes.length,
      `${pageLabel(pageIndex, pages.length)}; retry`,
    );
    const retryStarted = now();
    try {
      await page.loadAsync();
      options.cancellation.throwIfCancelled();
      outcomes[pageIndex] = { status: "loaded" };
    } catch (error) {
      if (
        error instanceof ExportCancelledError ||
        error instanceof ArchiveProducerSafetyError
      ) {
        throw error;
      }
      options.cancellation.throwIfCancelled();
      outcomes[pageIndex] = {
        status: "failed",
        technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
      };
    }
    postProgress(
      options,
      "page-loading",
      retryIndex + 1,
      retryPageIndexes.length,
      `${pageLabel(pageIndex, pages.length)}; retry`,
      elapsedMs(retryStarted, now),
    );
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  return outcomes.map((outcome) => {
    if (outcome === undefined) {
      throw new Error("A final page load outcome was not recorded.");
    }
    return outcome;
  });
}

function materializeDirectPageChildrenBestEffort(
  page: PageNode,
  cancellation: ExportCancellationToken,
): void {
  cancellation.throwIfCancelled();
  try {
    const directChildren = page.children;
    void directChildren.length;
  } catch {
    cancellation.throwIfCancelled();
    return;
  }
  cancellation.throwIfCancelled();
}

async function attemptRawPageStabilization(
  page: PageNode,
  options: RunEntireFileExportOptions,
): Promise<RawStabilizationAttempt> {
  await yieldToFigma();
  options.cancellation.throwIfCancelled();
  materializeDirectPageChildrenBestEffort(page, options.cancellation);
  options.cancellation.throwIfCancelled();

  let outcome: RawStabilizationAttempt;
  try {
    await page.exportAsync({ format: "JSON_REST_V1" });
    options.cancellation.throwIfCancelled();
    outcome = { status: "stabilized" };
  } catch (error) {
    if (error instanceof ExportCancelledError) {
      throw error;
    }
    options.cancellation.throwIfCancelled();
    outcome = {
      status: "failed",
      technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
    };
  }

  await yieldToFigma();
  options.cancellation.throwIfCancelled();
  return outcome;
}

async function stabilizePageRawExports(
  pages: readonly PageNode[],
  loadOutcomes: readonly PageLoadOutcome[],
  options: RunEntireFileExportOptions,
): Promise<readonly PagePreparationOutcome[]> {
  if (pages.length !== loadOutcomes.length) {
    throw new Error("Page load outcomes do not match the document page count.");
  }

  const now = options.now ?? Date.now;
  const firstAttempts: (RawStabilizationAttempt | undefined)[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    options.cancellation.throwIfCancelled();
    postProgress(
      options,
      "raw",
      pageIndex,
      pages.length,
      `${pageLabel(pageIndex, pages.length)}; stabilization`,
    );
    const attemptStarted = now();
    const loadOutcome = loadOutcomes[pageIndex];
    if (loadOutcome === undefined) {
      throw new Error("A page load outcome was not recorded.");
    }
    if (loadOutcome.status === "failed") {
      firstAttempts.push(undefined);
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    } else {
      firstAttempts.push(await attemptRawPageStabilization(page, options));
    }
    postProgress(
      options,
      "raw",
      pageIndex + 1,
      pages.length,
      `${pageLabel(pageIndex, pages.length)}; stabilization`,
      elapsedMs(attemptStarted, now),
    );
  }

  const retryPageIndexes = firstAttempts.flatMap((outcome, pageIndex) =>
    outcome?.status === "failed" ? [pageIndex] : [],
  );
  const outcomes: (PagePreparationOutcome | undefined)[] = loadOutcomes.map(
    (loadOutcome, pageIndex) => {
      if (loadOutcome.status === "failed") {
        return {
          status: "load-failed",
          technicalCause: loadOutcome.technicalCause,
        };
      }
      return firstAttempts[pageIndex]?.status === "stabilized"
        ? { status: "ready" }
        : undefined;
    },
  );

  for (const [retryIndex, pageIndex] of retryPageIndexes.entries()) {
    const page = pages[pageIndex];
    if (page === undefined) {
      throw new Error("A raw stabilization retry target was not recorded.");
    }
    options.cancellation.throwIfCancelled();
    postProgress(
      options,
      "raw",
      retryIndex,
      retryPageIndexes.length,
      `${pageLabel(pageIndex, pages.length)}; stabilization retry`,
    );
    const retryStarted = now();
    const retry = await attemptRawPageStabilization(page, options);
    outcomes[pageIndex] =
      retry.status === "stabilized"
        ? { status: "ready" }
        : {
            status: "raw-stabilization-failed",
            technicalCause: retry.technicalCause,
          };
    postProgress(
      options,
      "raw",
      retryIndex + 1,
      retryPageIndexes.length,
      `${pageLabel(pageIndex, pages.length)}; stabilization retry`,
      elapsedMs(retryStarted, now),
    );
  }

  return outcomes.map((outcome) => {
    if (outcome === undefined) {
      throw new Error("A final page preparation outcome was not recorded.");
    }
    return outcome;
  });
}

async function processPage(
  page: PageNode,
  pageIndex: number,
  pageTotal: number,
  preparationOutcome: PagePreparationOutcome,
  snapshotId: SnapshotId,
  api: PluginAPI,
  discovery: GlobalDiscoveryState,
  diagnostics: DiagnosticBag,
  requirements: ArchiveArtifactRequirement[],
  assets: AssetCollectionSession,
  options: RunEntireFileExportOptions,
): Promise<PageArtifactResult> {
  const now = options.now ?? Date.now;
  const pageStarted = now();
  const pageDiagnosticStart = diagnostics.size();
  const initialAssetStats = assets.stats();
  const source = sourceRefForPage(page);
  const rawPath = archivePaths.rawRestPage(snapshotId, page.id);
  const pagePath = archivePaths.irNodePage(snapshotId, page.id);
  if (preparationOutcome.status === "load-failed") {
    discovery.localComponentEnumerationComplete = false;
    const rawDiagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.pageLoadFailed,
      severity: "error",
      message:
        "A page could not be loaded, so its raw REST-like artifact is unavailable.",
      phase: "page-loading",
      source,
      artifactPath: rawPath,
      causedDataLoss: true,
      technicalCause: preparationOutcome.technicalCause,
    });
    const irDiagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.pageLoadFailed,
      severity: "error",
      message:
        "A page could not be loaded, so its canonical trees, roots, assets, previews, and component count contribution are unavailable.",
      phase: "page-loading",
      source,
      artifactPath: pagePath,
      causedDataLoss: true,
      technicalCause: preparationOutcome.technicalCause,
    });
    requirements.push(
      unavailableRequirement(rawPath, rawDiagnostic.id),
      unavailableRequirement(pagePath, irDiagnostic.id),
    );
    return { childNodeIds: [], nodeCount: 0 };
  }

  let roots: SceneNode[] | undefined;
  try {
    options.cancellation.throwIfCancelled();
    roots = [...page.children];
    options.cancellation.throwIfCancelled();
  } catch (error) {
    if (
      error instanceof ExportCancelledError ||
      error instanceof ArchiveProducerSafetyError
    ) {
      throw error;
    }
    options.cancellation.throwIfCancelled();
    discovery.localComponentEnumerationComplete = false;
    const diagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.pageCollectionFailed,
      severity: "error",
      message:
        "A loaded page's direct children could not be read, so its canonical page artifact is unavailable.",
      phase: "collection",
      source,
      artifactPath: pagePath,
      propertyPath: "$.children",
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    requirements.push(unavailableRequirement(pagePath, diagnostic.id));
  }

  const emitPageRaw = async (): Promise<ArtifactRef | undefined> => {
    postProgress(
      options,
      "raw",
      pageIndex,
      pageTotal,
      pageLabel(pageIndex, pageTotal),
    );
    const rawStarted = now();
    let rawArtifact: ArtifactRef | undefined;
    if (preparationOutcome.status === "raw-stabilization-failed") {
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.rawExportFailed,
        severity: "error",
        message:
          "A page raw REST-like export could not be stabilized and is unavailable; normalized page IR continues when available.",
        phase: "raw",
        source,
        artifactPath: rawPath,
        causedDataLoss: true,
        technicalCause: preparationOutcome.technicalCause,
      });
      requirements.push(unavailableRequirement(rawPath, diagnostic.id));
    } else {
      rawArtifact = await emitRawArtifact(
        page,
        source,
        rawPath,
        api,
        diagnostics,
        requirements,
        options,
      );
    }
    postProgress(
      options,
      "raw",
      pageIndex + 1,
      pageTotal,
      pageLabel(pageIndex, pageTotal),
      elapsedMs(rawStarted, now),
    );
    return rawArtifact;
  };
  if (roots === undefined) {
    await emitPageRaw();
    return { childNodeIds: [], nodeCount: 0 };
  }
  const childNodeIds = roots.map((root) => root.id);

  const componentCollectionStarted = now();
  let pageComponents: CollectedComponents;
  try {
    pageComponents = await collectComponents({
      roots,
      adapter: {
        getNodeByIdAsync: async (id) => {
          options.cancellation.throwIfCancelled();
          const node = await api.getNodeByIdAsync(id);
          options.cancellation.throwIfCancelled();
          return node as SceneNode | null;
        },
      },
      diagnostics,
      cancellation: options.cancellation,
      session: discovery.components.collectionSession,
      onProgress: (progress) => {
        postProgress(
          options,
          "collection",
          progress.traversedNodes +
            progress.instanceLookupsCompleted +
            progress.idLookupsCompleted,
          undefined,
          componentCollectionLabel(pageIndex, pageTotal, progress),
          elapsedMs(componentCollectionStarted, now),
        );
      },
    });
  } catch (error) {
    if (
      error instanceof ExportCancelledError ||
      error instanceof ArchiveProducerSafetyError
    ) {
      throw error;
    }
    options.cancellation.throwIfCancelled();
    const diagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.pageCollectionFailed,
      severity: "error",
      message:
        "Page component metadata collection failed; structural collection continues without invented metadata.",
      phase: "collection",
      source,
      propertyPath: "$.components",
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
    });
    pageComponents = emptyComponents(diagnostic.id);
  }
  mergeComponents(pageComponents, discovery.components);

  const definitionsToEmit: {
    readonly definition: ComponentDefinitionIR;
    readonly node: SceneNode | undefined;
  }[] = [];
  for (const definition of pageComponents.index.definitions) {
    options.cancellation.throwIfCancelled();
    const definitionPath = archivePaths.irComponentDefinition(
      snapshotId,
      definition.source.id,
    );
    const definitionWithArtifact: ComponentDefinitionIR = {
      ...definition,
      definitionArtifact: {
        path: definitionPath,
        mediaType: "application/json",
      },
    };
    const existing = discovery.components.definitions.get(definition.source.id);
    discovery.components.definitions.set(
      definition.source.id,
      existing === undefined
        ? definitionWithArtifact
        : {
            ...existing,
            definitionArtifact: {
              path: definitionPath,
              mediaType: "application/json",
            },
          },
    );
    if (discovery.components.emittedDefinitionIds.has(definition.source.id)) {
      continue;
    }
    discovery.components.emittedDefinitionIds.add(definition.source.id);
    definitionsToEmit.push({
      definition: definitionWithArtifact,
      node: pageComponents.definitionNodesById.get(definition.source.id),
    });
  }

  const definitionProgressLabel = `${pageLabel(pageIndex, pageTotal)}; component artifacts`;
  postProgress(
    options,
    "collection",
    0,
    definitionsToEmit.length,
    definitionProgressLabel,
  );
  for (const [definitionIndex, item] of definitionsToEmit.entries()) {
    options.cancellation.throwIfCancelled();
    const definitionStarted = now();
    const result = await emitComponentDefinition(
      item.definition,
      item.node,
      pageComponents,
      discovery.components.emittedDefinitionIds,
      snapshotId,
      api,
      diagnostics,
      requirements,
      assets,
      options,
    );
    for (const reference of result.dependencyRefs) {
      addReference(discovery.dependencyRefs, reference);
    }
    mergeStyleUsage(discovery.styleUsage, result.styleUsage);
    for (const diagnosticId of result.diagnosticIds) {
      discovery.components.diagnosticIds.add(diagnosticId);
    }
    postProgress(
      options,
      "collection",
      definitionIndex + 1,
      definitionsToEmit.length,
      definitionProgressLabel,
      elapsedMs(definitionStarted, now),
    );
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  const normalizedTrees: NodeIR[] = [];
  const dependencyRefs = new Map<string, SourceRef>();
  const reactions: ReactionIR[] = [];
  const pageAssets: AssetRefIR[] = [];
  let nodeCount = 0;
  let dependenciesComplete = pageComponents.complete;
  let reactionsComplete = true;
  let assetsComplete = true;
  let textSegmentsComplete = true;
  let annotationsComplete = true;
  if (roots.length === 0) {
    postProgress(options, "asset", 0, 0, pageLabel(pageIndex, pageTotal));
  }

  for (const [rootIndex, root] of roots.entries()) {
    options.cancellation.throwIfCancelled();
    const rootDiagnosticStart = diagnostics.size();
    let componentCountCaptured = false;
    postProgress(
      options,
      "collection",
      rootIndex,
      roots.length,
      `${pageLabel(pageIndex, pageTotal)}; root ${rootIndex + 1} of ${roots.length}`,
    );
    try {
      const collected = await collectNodeTree(
        root,
        source,
        diagnostics,
        options.cancellation,
        pageComponents,
      );
      nodeCount += collected.nodeCount;
      await mergeLocalComponentCount(
        collected.nodesById,
        discovery,
        diagnostics,
        options.cancellation,
      );
      if (!collected.coverage.childrenComplete) {
        discovery.localComponentEnumerationComplete = false;
      }
      componentCountCaptured = true;
      postProgress(
        options,
        "asset",
        rootIndex,
        roots.length,
        `${pageLabel(pageIndex, pageTotal)}; root ${rootIndex + 1} of ${roots.length}`,
      );
      const collectedAssets = await assets.collectTree(
        collected.tree,
        collected.nodesById,
      );
      let styleUsageComplete = true;
      try {
        await mergeStyleUsageFromTree(
          collectedAssets.tree,
          discovery.styleUsage,
          options.cancellation,
        );
      } catch (error) {
        if (
          error instanceof ExportCancelledError ||
          error instanceof ArchiveProducerSafetyError
        ) {
          throw error;
        }
        options.cancellation.throwIfCancelled();
        styleUsageComplete = false;
        diagnostics.add({
          code: DIAGNOSTIC_CODES.pageCollectionFailed,
          severity: "error",
          message:
            "Style-usage indexing for a normalized page root failed; the canonical root and emitted assets remain available.",
          phase: "collection",
          source: { kind: "node", id: root.id },
          propertyPath: "$.styleUsage",
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
        });
      }
      const diagnosticIds = [
        ...new Set([
          ...diagnostics
            .listSince(rootDiagnosticStart)
            .map((diagnostic) => diagnostic.id),
          ...collectedAssets.diagnosticIds,
        ]),
      ];
      const tree = withRootMetadata(
        collectedAssets.tree,
        undefined,
        diagnosticIds,
      );
      normalizedTrees.push(tree);
      for (const reference of collected.dependencyRefs) {
        addReference(dependencyRefs, reference);
        addReference(discovery.dependencyRefs, reference);
      }
      reactions.push(...collected.reactions);
      pageAssets.push(...collectedAssets.assets);
      dependenciesComplete &&=
        collected.coverage.dependencyRefsComplete && styleUsageComplete;
      reactionsComplete &&= collected.coverage.interactionsComplete;
      assetsComplete &&= collectedAssets.complete;
      textSegmentsComplete &&= collected.coverage.textSegmentsComplete;
      annotationsComplete &&= collected.coverage.interactionsComplete;
    } catch (error) {
      if (
        error instanceof ExportCancelledError ||
        error instanceof ArchiveProducerSafetyError
      ) {
        throw error;
      }
      options.cancellation.throwIfCancelled();
      if (!componentCountCaptured) {
        discovery.localComponentEnumerationComplete = false;
      }
      diagnostics.add({
        code: DIAGNOSTIC_CODES.pageCollectionFailed,
        severity: "error",
        message:
          "A direct page root could not be normalized; other page roots and the page raw fallback continue.",
        phase: "collection",
        source: { kind: "node", id: root.id },
        propertyPath: "$.normalizedTrees",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "unknown"),
      });
      dependenciesComplete = false;
      reactionsComplete = false;
      assetsComplete = false;
      textSegmentsComplete = false;
      annotationsComplete = false;
    }
    postProgress(
      options,
      "collection",
      rootIndex + 1,
      roots.length,
      pageLabel(pageIndex, pageTotal),
    );
    postProgress(
      options,
      "asset",
      rootIndex + 1,
      roots.length,
      pageLabel(pageIndex, pageTotal),
    );
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  let previewNodes: readonly PreviewExportNode[] = [];
  try {
    previewNodes = selectEntireFilePreviewCandidates({
      children: roots,
    });
  } catch (error) {
    options.cancellation.throwIfCancelled();
    diagnostics.add({
      code: DIAGNOSTIC_CODES.pageCollectionFailed,
      severity: "error",
      message:
        "Entire-file preview eligibility could not be determined for a loaded page.",
      phase: "preview",
      source,
      propertyPath: "$.previews",
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
  }
  const previews: PreviewRefIR[] = [];
  if (previewNodes.length === 0) {
    postProgress(options, "preview", 0, 0, pageLabel(pageIndex, pageTotal));
  }
  for (const [previewIndex, previewNode] of previewNodes.entries()) {
    options.cancellation.throwIfCancelled();
    postProgress(
      options,
      "preview",
      previewIndex,
      previewNodes.length,
      `${pageLabel(pageIndex, pageTotal)}; preview ${previewIndex + 1} of ${previewNodes.length}`,
    );
    const preview = await exportNodePreview(
      previewNode,
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
      previews.push(preview.preview);
    } else {
      requirements.push(
        unavailableRequirement(
          archivePaths.preview(snapshotId, previewNode.id),
          preview.diagnosticId,
        ),
      );
    }
    postProgress(
      options,
      "preview",
      previewIndex + 1,
      previewNodes.length,
      pageLabel(pageIndex, pageTotal),
    );
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  const rootCount = roots.length;
  roots.length = 0;
  (previewNodes as PreviewExportNode[]).length = 0;
  releaseCollectedComponents(pageComponents);
  await yieldToFigma();
  options.cancellation.throwIfCancelled();

  const rawArtifact = await emitPageRaw();
  // The UI acknowledgment awaited by emitRawArtifact completes ingestion of
  // the raw text. Only its lightweight ArtifactRef remains here, so give the
  // discarded raw object, normalized clone, and serialized text an event-loop
  // boundary to become unreachable before canonical page serialization.
  await yieldToFigma();
  options.cancellation.throwIfCancelled();

  const pageDiagnosticIds = diagnostics
    .listSince(pageDiagnosticStart)
    .map((diagnostic) => diagnostic.id);
  const pageDependencyRefs = [
    ...sortUnorderedSourceRefs([...dependencyRefs.values()]),
  ];
  const deduplicatedPageAssets = [...deduplicateAssets(pageAssets)];
  const artifact: DesignIrPageIndex = {
    kind: "design-ir-page-index",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    source,
    childNodeIds,
    dependencyRefs: pageDependencyRefs,
    normalizedTrees,
    reactions,
    assets: deduplicatedPageAssets,
    previews,
    coverage: {
      dependencies: dependenciesComplete
        ? { status: "collected" }
        : {
            status: "partial",
            reason:
              "One or more page roots or dependency references were unavailable.",
          },
      reactions: reactionsComplete
        ? { status: "collected" }
        : {
            status: "partial",
            reason: "One or more page reactions were unavailable.",
          },
      assets: assetsComplete
        ? { status: "collected" }
        : {
            status: "partial",
            reason:
              "One or more page raster or vector assets were unavailable.",
          },
      textSegments: textSegmentsComplete
        ? { status: "collected" }
        : {
            status: "partial",
            reason: "One or more page text segments were unavailable.",
          },
      annotationsAndAccessibility: annotationsComplete
        ? { status: "collected" }
        : {
            status: "partial",
            reason:
              "Some annotations were inaccessible; the installed Plugin API exposes no accessibility/ARIA fields.",
          },
    },
    ...(rawArtifact === undefined ? {} : { rawArtifact }),
    diagnosticIds: pageDiagnosticIds,
  };
  options.cancellation.throwIfCancelled();
  postProgress(
    options,
    "serialization",
    pageIndex,
    pageTotal,
    pageLabel(pageIndex, pageTotal),
  );
  const serializedPage = await serializePageArtifact(
    artifact,
    normalizedTrees,
    pageDiagnosticStart,
    pagePath,
    diagnostics,
    options,
  );
  const pageMarkdown = projectPageMarkdown(
    snapshotId,
    serializedPage.artifact,
    discovery.components.emittedDefinitionIds,
  );
  options.cancellation.throwIfCancelled();
  normalizedTrees.length = 0;
  reactions.length = 0;
  pageAssets.length = 0;
  previews.length = 0;
  pageDependencyRefs.length = 0;
  deduplicatedPageAssets.length = 0;
  dependencyRefs.clear();
  await yieldToFigma();
  options.cancellation.throwIfCancelled();
  const artifactRef: ArtifactRef = {
    path: pagePath,
    mediaType: "application/json",
  };
  await emitEntry(
    options,
    requirements,
    pagePath,
    artifactRef.mediaType,
    "deflate",
    serializedPage.text,
  );
  for (const markdown of pageMarkdown) {
    await emitEntry(
      options,
      requirements,
      markdown.path,
      "text/markdown",
      "deflate",
      markdown.text,
    );
  }
  const stats = assets.stats();
  const newAssetCount =
    stats.rasterContents -
    initialAssetStats.rasterContents +
    (stats.vectorNodes - initialAssetStats.vectorNodes);
  postProgress(
    options,
    "serialization",
    pageIndex + 1,
    pageTotal,
    `${pageLabel(pageIndex, pageTotal)}; ${rootCount} roots; ${nodeCount} nodes; ${newAssetCount} new assets`,
    elapsedMs(pageStarted, now),
  );
  return {
    artifactRef,
    markdownPath: archivePaths.agentPage(snapshotId, page.id),
    childNodeIds,
    nodeCount,
  };
}

function createDocument(
  snapshotId: SnapshotId,
  api: PluginAPI,
  pages: readonly PageNode[],
  currentPageId: string,
  pageArtifacts: readonly ArtifactRef[],
  globalArtifacts: GlobalArtifacts,
  discovery: GlobalDiscoveryState,
  diagnostics: DiagnosticBag,
): DesignIrDocument {
  return {
    kind: "design-ir-document",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    source: { kind: "document", id: api.root.id, name: api.root.name },
    name: api.root.name,
    pages: pages.map(sourceRefForPage),
    currentPageId,
    selectedRootIds: [],
    counts: {
      localVariables: collectionCount(
        globalArtifacts.variables.localCount,
        globalArtifacts.variables.localEnumerationComplete,
        "Local variable enumeration was incomplete.",
      ),
      localStyles: collectionCount(
        globalArtifacts.styles.localCount,
        globalArtifacts.styles.localEnumerationComplete,
        "Local style enumeration was incomplete.",
      ),
      localComponents: collectionCount(
        discovery.localComponentIds.size,
        discovery.localComponentEnumerationComplete,
        "One or more pages could not contribute to the exact file-local component count.",
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
      nodeArtifacts: pageArtifacts,
    },
    capabilities: [
      "entire-file",
      "sequential-page-loading",
      "common-node-ir",
      "raw-rest-v1",
      "entire-file-previews",
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
      "Pages receive sequential PageNode.loadAsync() and discarded raw-export stabilization passes before incremental page processing; the Plugin API exposes no method to unload a page after it has been loaded, while each stabilization result and exporter-owned page tree or buffer is released as soon as its phase permits.",
      "The installed @figma/plugin-typings@1.133.0 surface exposes annotations but no accessibility or ARIA node properties.",
      "Inaccessible referenced definitions remain unresolved with diagnostics and are never imported.",
      "Raster bytes are limited to image fills reachable through loaded pages, accessible component definitions, and paint styles.",
      "If a canonical page's normalized trees exceed the safe single-entry archive limit, its page artifact remains as a partial index with exact direct-root order, references, reactions, assets, previews, diagnostics, and any available raw fallback; ARCHIVE_ENTRY_TOO_LARGE identifies the omitted trees.",
      `Raw, canonical, raster, SVG, and preview artifacts that fail are absent only with source-attributed diagnostics under ${snapshotId}.`,
    ],
    diagnosticIds: diagnostics.list().map((diagnostic) => diagnostic.id),
  };
}

export async function runEntireFileExport(
  options: RunEntireFileExportOptions,
): Promise<void> {
  const api = options.api ?? figma;
  const snapshotId = requireSnapshotId(options.snapshotId);
  const diagnostics = new DiagnosticBag("diagnostic");
  const requirements: ArchiveArtifactRequirement[] = [];
  const pages = [...api.root.children];
  const currentPageId = api.currentPage.id;
  const discovery: GlobalDiscoveryState = {
    components: {
      definitions: new Map(),
      dependencies: new Map(),
      diagnosticIds: new Set(),
      emittedDefinitionIds: new Set(),
      dependencyRefs: new Map(),
      collectionSession: new ComponentCollectionSession(),
    },
    dependencyRefs: new Map(),
    styleUsage: new Map(),
    localComponentIds: new Set(),
    localComponentEnumerationComplete: true,
  };
  const assets = new AssetCollectionSession({
    snapshotId,
    diagnostics,
    cancellation: options.cancellation,
    api,
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
  postProgress(options, "scope", 0, pages.length);
  void options.postMessage({
    type: "export-started",
    protocolVersion: PROTOCOL_VERSION,
    requestId: options.requestId,
    exportId: options.exportId,
    scopeSummary: { kind: "entire-file", pageCount: pages.length },
  });
  postProgress(options, "scope", pages.length, pages.length);

  const pagePreparationOutcomes = await stabilizePageRawExports(
    pages,
    await stabilizePageLoads(pages, options),
    options,
  );

  const pageArtifacts: ArtifactRef[] = [];
  const pageMarkdownPaths: (string | undefined)[] = [];
  const orderedRootIds: string[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    options.cancellation.throwIfCancelled();
    const preparationOutcome = pagePreparationOutcomes[pageIndex];
    if (preparationOutcome === undefined) {
      throw new Error("A page preparation outcome was not recorded.");
    }
    const result = await processPage(
      page,
      pageIndex,
      pages.length,
      preparationOutcome,
      snapshotId,
      api,
      discovery,
      diagnostics,
      requirements,
      assets,
      options,
    );
    orderedRootIds.push(...result.childNodeIds);
    pageMarkdownPaths.push(result.markdownPath);
    if (result.artifactRef !== undefined) {
      pageArtifacts.push(result.artifactRef);
    }
    options.onPageReleased?.({
      pageIndex,
      rootCount: result.childNodeIds.length,
      nodeCount: result.nodeCount,
    });
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  const componentIndex: ComponentsIndexIR = {
    kind: "design-ir-components",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    definitions: sortUnorderedComponentDefinitions([
      ...discovery.components.definitions.values(),
    ]),
    dependencies: sortUnorderedComponentDependencies([
      ...discovery.components.dependencies.values(),
    ]),
    diagnosticIds: [...discovery.components.diagnosticIds].sort(),
  };
  for (const reference of discovery.components.dependencyRefs.values()) {
    addReference(discovery.dependencyRefs, reference);
  }

  postProgress(options, "collection", 0, 2, "Global styles");
  const stylesCollected = await collectStyles({
    referencedStyleIds: [...discovery.dependencyRefs.values()]
      .filter((reference) => reference.kind === "style")
      .map((reference) => reference.id),
    referencedByByStyleId: discovery.styleUsage,
    diagnostics,
    cancellation: options.cancellation,
    api,
  });
  postProgress(options, "asset", 0, 1, "Global styles");
  const styleAssets = await assets.collectStyles(stylesCollected.artifact);
  const styles: CollectedStyles = {
    ...stylesCollected,
    artifact: styleAssets.artifact,
  };
  postProgress(options, "asset", 1, 1, "Global styles");
  postProgress(options, "collection", 1, 2, "Global variables");
  const variables = await collectVariables({
    referencedVariableIds: [...discovery.dependencyRefs.values()]
      .filter((reference) => reference.kind === "variable")
      .map((reference) => reference.id)
      .concat(styles.referencedVariableIds),
    referencedCollectionIds: [...discovery.dependencyRefs.values()]
      .filter((reference) => reference.kind === "collection")
      .map((reference) => reference.id),
    diagnostics,
    cancellation: options.cancellation,
    api: api.variables as unknown as VariableCollectorApi,
  });
  postProgress(options, "collection", 2, 2, "Global variables");
  const globalArtifacts: GlobalArtifacts = {
    components: componentIndex,
    styles,
    variables,
  };

  for (const [path, artifact] of [
    [archivePaths.irComponents(snapshotId), componentIndex],
    [archivePaths.irStyles(snapshotId), styles.artifact],
    [archivePaths.irVariables(snapshotId), variables.artifact],
  ] as const) {
    options.cancellation.throwIfCancelled();
    const text = serializeCanonicalJson(artifact);
    options.cancellation.throwIfCancelled();
    await emitEntry(
      options,
      requirements,
      path,
      "application/json",
      "deflate",
      text,
    );
  }

  postProgress(options, "serialization", 0, 3, "Document index");
  const document = createDocument(
    snapshotId,
    api,
    pages,
    currentPageId,
    pageArtifacts,
    globalArtifacts,
    discovery,
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
  postProgress(options, "serialization", 1, 3, "Diagnostics");

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
  postProgress(options, "serialization", 2, 3, "Agent indexes");

  for (const markdown of projectGlobalMarkdown(
    snapshotId,
    document,
    variables.artifact,
    styles.artifact,
    componentIndex,
    pageMarkdownPaths,
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
    document: { name: api.root.name },
    scope: { kind: "entire-file", orderedRootIds },
    ownerConfirmedCurrent: true,
    counts: {
      pages: pages.length,
      roots: orderedRootIds.length,
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

export function classifyEntireFileExportFailure(
  error: unknown,
): "collection-failed" | "scope-invalid" {
  void error;
  return "collection-failed";
}
