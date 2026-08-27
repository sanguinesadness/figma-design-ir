import { Zip, ZipDeflate, ZipPassThrough } from "fflate";

import {
  ArchiveEntryRegistry,
  ArchivePathError,
  DuplicateArchivePathError,
  ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT,
  ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT,
  ARCHIVE_TOTAL_LIVE_BYTE_LIMIT,
  archivePaths,
  assertSafeArchivePath,
  utf8ByteLength,
  type ArchiveArtifactRequirement,
  type ArchiveCompression,
  type ArchiveEntryDescriptor,
  type ArchiveManifest,
  type ArchiveManifestDraft,
  type SnapshotId,
} from "./archive";
import { DIAGNOSTIC_CODES } from "./diagnostics";
import { serializeCanonicalJson } from "./serialization";

export type ArchiveAssemblyErrorCode =
  | "archive-capacity-exceeded"
  | "archive-entry-limit-exceeded"
  | "cancelled"
  | "duplicate-entry"
  | "hash-failed"
  | "invalid-entry"
  | "invalid-json"
  | "invalid-manifest"
  | "invalid-text"
  | "missing-required-artifact"
  | "zip-failed";

export class ArchiveAssemblyError extends Error {
  readonly code: ArchiveAssemblyErrorCode;

  constructor(code: ArchiveAssemblyErrorCode, message: string) {
    super(message);
    this.name = "ArchiveAssemblyError";
    this.code = code;
  }
}

export interface ArchiveBuilderRuntime {
  readonly encodeUtf8: (text: string) => Uint8Array;
  readonly decodeUtf8: (bytes: Uint8Array) => string;
  readonly sha256: (bytes: Uint8Array) => Promise<string>;
}

export interface ArchiveCapacityLimits {
  readonly totalLiveByteLimit: number;
  readonly singleEntryByteLimit: number;
  readonly preManifestEntryCountLimit: number;
}

// A renderer exhaustion observed during a high-volume preview export showed that
// archive growth needs a hard stop. Keep retained ZIP output below 384 MiB so
// final Blob construction has headroom for its temporary duplicate, and cap one
// uncompressed entry at 64 MiB so source/output overlap cannot consume the budget.
export {
  ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT,
  ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT,
  ARCHIVE_TOTAL_LIVE_BYTE_LIMIT,
} from "./archive";

const DEFAULT_ARCHIVE_CAPACITY_LIMITS: ArchiveCapacityLimits = {
  totalLiveByteLimit: ARCHIVE_TOTAL_LIVE_BYTE_LIMIT,
  singleEntryByteLimit: ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT,
  preManifestEntryCountLimit: ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT,
};

export interface CompletedArchive {
  readonly filename: string;
  readonly chunks: readonly Uint8Array[];
  readonly manifest: ArchiveManifest;
}

interface DiagnosticsJsonShape {
  readonly summary: {
    readonly counts: {
      readonly info: number;
      readonly warning: number;
      readonly error: number;
      readonly fatal: number;
    };
    readonly completeness: string;
  };
  readonly diagnostics: readonly {
    readonly id: string;
    readonly code?: unknown;
    readonly severity: string;
    readonly causedDataLoss: boolean;
    readonly artifactPath?: string;
    readonly propertyPath?: string;
    readonly source?: unknown;
  }[];
}

interface PageArtifactSummary {
  readonly path: string;
  readonly kind: unknown;
  readonly schemaVersion: unknown;
  readonly sourceId?: string;
  readonly childNodeIds: readonly string[];
  readonly normalizedRootIds: readonly string[];
  readonly diagnosticIds: readonly string[];
  readonly rawArtifactPath?: string;
  readonly rawArtifactMediaType?: string;
  readonly validShape: boolean;
}

interface ComponentDefinitionArtifactSummary {
  readonly sourceId?: string;
  readonly path?: string;
  readonly mediaType?: string;
  readonly validShape: boolean;
}

interface ComponentsJsonSummary {
  readonly kind: unknown;
  readonly schemaVersion: unknown;
  readonly definitionsValid: boolean;
  readonly definitionArtifacts: readonly ComponentDefinitionArtifactSummary[];
}

interface BinaryReferenceSummary {
  readonly kind: "raster" | "vector" | "preview";
  readonly path?: string;
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly contentSha256?: string;
  readonly canonicalPath?: string;
  readonly validShape: boolean;
}

interface BinaryReferenceScan {
  readonly references: readonly BinaryReferenceSummary[];
  readonly malformed: boolean;
}

function isExactJsonArtifactRef(value: unknown, expectedPath: string): boolean {
  return (
    isRecord(value) &&
    value.path === expectedPath &&
    value.mediaType === "application/json"
  );
}

const FIXED_ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteRect(value: unknown, positiveSize: boolean): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const components = [value.x, value.y, value.width, value.height];
  return (
    components.every(
      (component) =>
        typeof component === "number" && Number.isFinite(component),
    ) &&
    (!positiveSize ||
      (typeof value.width === "number" &&
        typeof value.height === "number" &&
        value.width > 0 &&
        value.height > 0))
  );
}

function expectedPreviewScale(value: unknown): number | undefined {
  if (
    !isFiniteRect(value, true) ||
    !isRecord(value) ||
    typeof value.width !== "number" ||
    typeof value.height !== "number"
  ) {
    return undefined;
  }
  return Math.min(1, 4096 / Math.max(value.width, value.height));
}

function canonicalRasterPath(
  snapshotId: SnapshotId,
  imageHash: unknown,
  contentSha256: unknown,
  mediaType: unknown,
): string | undefined {
  if (
    typeof imageHash !== "string" ||
    imageHash.length === 0 ||
    typeof contentSha256 !== "string" ||
    !CONTENT_HASH_PATTERN.test(contentSha256)
  ) {
    return undefined;
  }
  const extension =
    mediaType === "image/png"
      ? "png"
      : mediaType === "image/jpeg"
        ? "jpg"
        : mediaType === "image/gif"
          ? "gif"
          : mediaType === "image/webp"
            ? "webp"
            : mediaType === "application/octet-stream"
              ? "bin"
              : undefined;
  return extension === undefined
    ? undefined
    : archivePaths.rasterAsset(snapshotId, contentSha256, extension);
}

function binaryReferenceScan(
  value: unknown,
  snapshotId: SnapshotId,
): BinaryReferenceScan {
  const references: BinaryReferenceSummary[] = [];
  let malformed = false;
  const work: unknown[] = [value];
  while (work.length > 0) {
    const current = work.pop();
    if (Array.isArray(current)) {
      for (const item of current) {
        work.push(item);
      }
      continue;
    }
    if (!isRecord(current)) {
      continue;
    }

    if (current.assetKind === "raster") {
      const source = current.source;
      const canonicalPath = canonicalRasterPath(
        snapshotId,
        current.imageHash,
        current.contentSha256,
        current.mediaType,
      );
      const validShape =
        isRecord(source) &&
        source.kind === "asset" &&
        typeof current.archivePath === "string" &&
        current.archivePath === canonicalPath &&
        typeof current.mediaType === "string" &&
        Number.isSafeInteger(current.byteLength) &&
        typeof current.byteLength === "number" &&
        current.byteLength >= 0 &&
        typeof current.contentSha256 === "string" &&
        CONTENT_HASH_PATTERN.test(current.contentSha256);
      references.push({
        kind: "raster",
        ...(typeof current.archivePath === "string"
          ? { path: current.archivePath }
          : {}),
        ...(typeof current.mediaType === "string"
          ? { mediaType: current.mediaType }
          : {}),
        ...(typeof current.byteLength === "number"
          ? { byteLength: current.byteLength }
          : {}),
        ...(typeof current.contentSha256 === "string"
          ? { contentSha256: current.contentSha256 }
          : {}),
        ...(canonicalPath === undefined ? {} : { canonicalPath }),
        validShape,
      });
      malformed ||= !validShape;
      continue;
    }

    if (current.assetKind === "vector") {
      const node = current.node;
      let canonicalPath: string | undefined;
      if (isRecord(node) && typeof node.id === "string" && node.id.length > 0) {
        try {
          canonicalPath = archivePaths.vectorAsset(snapshotId, node.id);
        } catch {
          canonicalPath = undefined;
        }
      }
      const validShape =
        isRecord(current.source) &&
        current.source.kind === "asset" &&
        isRecord(node) &&
        node.kind === "node" &&
        typeof node.id === "string" &&
        typeof current.archivePath === "string" &&
        current.archivePath === canonicalPath &&
        current.mediaType === "image/svg+xml" &&
        Number.isSafeInteger(current.byteLength) &&
        typeof current.byteLength === "number" &&
        current.byteLength > 0 &&
        typeof current.contentSha256 === "string" &&
        CONTENT_HASH_PATTERN.test(current.contentSha256) &&
        (current.eligibility === "explicit-svg-setting" ||
          current.eligibility === "top-level-vector-root") &&
        isRecord(current.exportSettings) &&
        current.exportSettings.format === "SVG_STRING";
      references.push({
        kind: "vector",
        ...(typeof current.archivePath === "string"
          ? { path: current.archivePath }
          : {}),
        ...(typeof current.mediaType === "string"
          ? { mediaType: current.mediaType }
          : {}),
        ...(typeof current.byteLength === "number"
          ? { byteLength: current.byteLength }
          : {}),
        ...(typeof current.contentSha256 === "string"
          ? { contentSha256: current.contentSha256 }
          : {}),
        ...(canonicalPath === undefined ? {} : { canonicalPath }),
        validShape,
      });
      malformed ||= !validShape;
      continue;
    }

    if (
      current.mediaType === "image/png" &&
      "sourceNode" in current &&
      "sourceBounds" in current &&
      "exportedBounds" in current &&
      "scale" in current
    ) {
      const sourceNode = current.sourceNode;
      let canonicalPath: string | undefined;
      if (
        isRecord(sourceNode) &&
        typeof sourceNode.id === "string" &&
        sourceNode.id.length > 0
      ) {
        try {
          canonicalPath = archivePaths.preview(snapshotId, sourceNode.id);
        } catch {
          canonicalPath = undefined;
        }
      }
      const validShape =
        isRecord(sourceNode) &&
        sourceNode.kind === "node" &&
        typeof current.archivePath === "string" &&
        current.archivePath === canonicalPath &&
        isFiniteRect(current.sourceBounds, true) &&
        isFiniteRect(current.exportedBounds, true) &&
        isRecord(current.exportedBounds) &&
        typeof current.exportedBounds.width === "number" &&
        typeof current.exportedBounds.height === "number" &&
        Number.isSafeInteger(current.exportedBounds.width) &&
        Number.isSafeInteger(current.exportedBounds.height) &&
        current.exportedBounds.width <= 4096 &&
        current.exportedBounds.height <= 4096 &&
        Number.isSafeInteger(current.byteLength) &&
        typeof current.byteLength === "number" &&
        current.byteLength > 0 &&
        typeof current.contentSha256 === "string" &&
        CONTENT_HASH_PATTERN.test(current.contentSha256) &&
        typeof current.scale === "number" &&
        Number.isFinite(current.scale) &&
        current.scale === expectedPreviewScale(current.sourceBounds);
      references.push({
        kind: "preview",
        ...(typeof current.archivePath === "string"
          ? { path: current.archivePath }
          : {}),
        mediaType: "image/png",
        ...(typeof current.byteLength === "number"
          ? { byteLength: current.byteLength }
          : {}),
        ...(typeof current.contentSha256 === "string"
          ? { contentSha256: current.contentSha256 }
          : {}),
        ...(canonicalPath === undefined ? {} : { canonicalPath }),
        validShape,
      });
      malformed ||= !validShape;
      continue;
    }

    for (const nested of Object.values(current)) {
      work.push(nested);
    }
  }
  return { references, malformed };
}

function summarizeComponentsJson(value: unknown): ComponentsJsonSummary {
  if (!isRecord(value) || !Array.isArray(value.definitions)) {
    return {
      kind: isRecord(value) ? value.kind : undefined,
      schemaVersion: isRecord(value) ? value.schemaVersion : undefined,
      definitionsValid: false,
      definitionArtifacts: [],
    };
  }

  return {
    kind: value.kind,
    schemaVersion: value.schemaVersion,
    definitionsValid: true,
    definitionArtifacts: value.definitions.map((definition) => {
      const source = isRecord(definition) ? definition.source : undefined;
      const artifact = isRecord(definition)
        ? definition.definitionArtifact
        : undefined;
      const sourceId = isRecord(source) ? source.id : undefined;
      const path = isRecord(artifact) ? artifact.path : undefined;
      const mediaType = isRecord(artifact) ? artifact.mediaType : undefined;
      return {
        ...(typeof sourceId === "string" ? { sourceId } : {}),
        ...(typeof path === "string" ? { path } : {}),
        ...(typeof mediaType === "string" ? { mediaType } : {}),
        validShape:
          typeof sourceId === "string" &&
          sourceId.length > 0 &&
          typeof path === "string" &&
          typeof mediaType === "string",
      };
    }),
  };
}

function isUniqueNonEmptyStringArray(
  value: unknown,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length
  );
}

function summarizePageArtifact(
  value: unknown,
  path: string,
  snapshotId: SnapshotId,
): PageArtifactSummary {
  const record = isRecord(value) ? value : undefined;
  const source = record === undefined ? undefined : record.source;
  const sourceId = isRecord(source) ? source.id : undefined;
  const childNodeIds = record?.childNodeIds;
  const normalizedTrees = record?.normalizedTrees;
  const diagnosticIds = record?.diagnosticIds;
  const rawArtifact = record?.rawArtifact;
  const normalizedRootIds = Array.isArray(normalizedTrees)
    ? normalizedTrees.map((tree) => {
        const treeSource = isRecord(tree) ? tree.source : undefined;
        return isRecord(treeSource) ? treeSource.id : undefined;
      })
    : [];

  let canonicalPath: string | undefined;
  let canonicalRawPath: string | undefined;
  if (typeof sourceId === "string" && sourceId.length > 0) {
    try {
      canonicalPath = archivePaths.irNodePage(snapshotId, sourceId);
      canonicalRawPath = archivePaths.rawRestPage(snapshotId, sourceId);
    } catch {
      canonicalPath = undefined;
      canonicalRawPath = undefined;
    }
  }

  const rawArtifactPath = isRecord(rawArtifact) ? rawArtifact.path : undefined;
  const rawArtifactMediaType = isRecord(rawArtifact)
    ? rawArtifact.mediaType
    : undefined;
  const rawArtifactValid =
    rawArtifact === undefined ||
    (canonicalRawPath !== undefined &&
      isExactJsonArtifactRef(rawArtifact, canonicalRawPath));
  const normalizedRootsValid =
    Array.isArray(normalizedTrees) &&
    normalizedTrees.every((tree) => {
      const treeSource = isRecord(tree) ? tree.source : undefined;
      return (
        isRecord(treeSource) &&
        treeSource.kind === "node" &&
        typeof treeSource.id === "string" &&
        treeSource.id.length > 0
      );
    }) &&
    isUniqueNonEmptyStringArray(normalizedRootIds);

  return {
    path,
    kind: record?.kind,
    schemaVersion: record?.schemaVersion,
    ...(typeof sourceId === "string" ? { sourceId } : {}),
    childNodeIds: isUniqueNonEmptyStringArray(childNodeIds)
      ? [...childNodeIds]
      : [],
    normalizedRootIds: normalizedRootsValid ? normalizedRootIds : [],
    diagnosticIds: isUniqueNonEmptyStringArray(diagnosticIds)
      ? [...diagnosticIds]
      : [],
    ...(typeof rawArtifactPath === "string" ? { rawArtifactPath } : {}),
    ...(typeof rawArtifactMediaType === "string"
      ? { rawArtifactMediaType }
      : {}),
    validShape:
      record !== undefined &&
      record.kind === "design-ir-page-index" &&
      isRecord(source) &&
      source.kind === "page" &&
      typeof sourceId === "string" &&
      sourceId.length > 0 &&
      path === canonicalPath &&
      isUniqueNonEmptyStringArray(childNodeIds) &&
      normalizedRootsValid &&
      isUniqueNonEmptyStringArray(diagnosticIds) &&
      rawArtifactValid,
  };
}

function isDiagnosticsJson(value: unknown): value is DiagnosticsJsonShape {
  if (
    !isRecord(value) ||
    !isRecord(value.summary) ||
    !isRecord(value.summary.counts) ||
    !Array.isArray(value.diagnostics)
  ) {
    return false;
  }
  const counts = value.summary.counts;
  const countValues = [counts.info, counts.warning, counts.error, counts.fatal];
  const severities = ["info", "warning", "error", "fatal"];
  const completenessValues = [
    "complete",
    "complete-with-warnings",
    "incomplete",
  ];
  return (
    countValues.every(
      (count) =>
        Number.isSafeInteger(count) && typeof count === "number" && count >= 0,
    ) &&
    typeof value.summary.completeness === "string" &&
    completenessValues.includes(value.summary.completeness) &&
    value.diagnostics.every(
      (diagnostic) =>
        isRecord(diagnostic) &&
        typeof diagnostic.id === "string" &&
        typeof diagnostic.severity === "string" &&
        severities.includes(diagnostic.severity) &&
        typeof diagnostic.causedDataLoss === "boolean" &&
        (diagnostic.artifactPath === undefined ||
          typeof diagnostic.artifactPath === "string") &&
        (diagnostic.propertyPath === undefined ||
          typeof diagnostic.propertyPath === "string"),
    )
  );
}

function summarizeDiagnosticsJson(
  diagnostics: DiagnosticsJsonShape["diagnostics"],
): DiagnosticsJsonShape["summary"] {
  const counts = { info: 0, warning: 0, error: 0, fatal: 0 };
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity as keyof typeof counts] += 1;
  }
  return {
    counts,
    completeness:
      counts.error > 0 || counts.fatal > 0
        ? "incomplete"
        : counts.warning > 0
          ? "complete-with-warnings"
          : "complete",
  };
}

function equalCounts(
  left: DiagnosticsJsonShape["summary"]["counts"],
  right: DiagnosticsJsonShape["summary"]["counts"],
): boolean {
  return (
    left.info === right.info &&
    left.warning === right.warning &&
    left.error === right.error &&
    left.fatal === right.fatal
  );
}

function expectedCompression(mediaType: string): ArchiveCompression | null {
  if (
    mediaType === "application/json" ||
    mediaType === "text/markdown" ||
    mediaType === "image/svg+xml"
  ) {
    return "deflate";
  }
  if (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/gif" ||
    mediaType === "image/webp" ||
    mediaType === "application/octet-stream"
  ) {
    return "store";
  }
  return null;
}

function expectedPathSuffixes(mediaType: string): readonly string[] {
  switch (mediaType) {
    case "application/json":
      return [".json"];
    case "text/markdown":
      return [".md"];
    case "image/svg+xml":
      return [".svg"];
    case "image/png":
      return [".png"];
    case "image/jpeg":
      return [".jpg", ".jpeg"];
    case "image/gif":
      return [".gif"];
    case "image/webp":
      return [".webp"];
    case "application/octet-stream":
      return [".bin"];
    default:
      return [];
  }
}

export class StreamingArchiveBuilder {
  readonly #snapshotId: SnapshotId;
  readonly #runtime: ArchiveBuilderRuntime;
  readonly #capacityLimits: ArchiveCapacityLimits;
  readonly #registry = new ArchiveEntryRegistry();
  readonly #parsedJson = new Map<string, unknown>();
  readonly #pageSummaries = new Map<string, PageArtifactSummary>();
  readonly #rawPagePaths: string[] = [];
  readonly #binaryReferences = new Map<string, BinaryReferenceSummary>();
  #malformedBinaryReference = false;
  readonly #zip: Zip;
  readonly #completion: Promise<void>;
  readonly #chunks: Uint8Array[] = [];
  #resolveCompletion: (() => void) | undefined;
  #rejectCompletion: ((error: ArchiveAssemblyError) => void) | undefined;
  #zipFailure: ArchiveAssemblyError | undefined;
  #acceptedEntryCount = 0;
  #retainedZipByteLength = 0;
  #activeEntryByteLength = 0;
  #state: "active" | "cancelled" | "finalized" = "active";

  constructor(
    snapshotId: SnapshotId,
    runtime: ArchiveBuilderRuntime,
    capacityLimits: ArchiveCapacityLimits = DEFAULT_ARCHIVE_CAPACITY_LIMITS,
  ) {
    if (
      !Number.isSafeInteger(capacityLimits.totalLiveByteLimit) ||
      capacityLimits.totalLiveByteLimit <= 0 ||
      !Number.isSafeInteger(capacityLimits.singleEntryByteLimit) ||
      capacityLimits.singleEntryByteLimit <= 0 ||
      capacityLimits.singleEntryByteLimit > capacityLimits.totalLiveByteLimit ||
      !Number.isSafeInteger(capacityLimits.preManifestEntryCountLimit) ||
      capacityLimits.preManifestEntryCountLimit <= 0 ||
      capacityLimits.totalLiveByteLimit > ARCHIVE_TOTAL_LIVE_BYTE_LIMIT ||
      capacityLimits.singleEntryByteLimit > ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT ||
      capacityLimits.preManifestEntryCountLimit >
        ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT
    ) {
      throw new ArchiveAssemblyError(
        "invalid-entry",
        "Archive capacity limits are invalid.",
      );
    }
    this.#snapshotId = snapshotId;
    this.#runtime = runtime;
    this.#capacityLimits = { ...capacityLimits };
    this.#completion = new Promise<void>((resolve, reject) => {
      this.#resolveCompletion = resolve;
      this.#rejectCompletion = reject;
    });
    void this.#completion.catch(() => undefined);
    this.#zip = new Zip((error, chunk, final) => {
      if (this.#state === "cancelled" || this.#zipFailure !== undefined) {
        return;
      }
      if (error !== null) {
        this.#failArchive(
          new ArchiveAssemblyError(
            "zip-failed",
            "The local ZIP stream failed.",
          ),
        );
        return;
      }
      if (chunk !== null) {
        const nextRetainedByteLength =
          this.#retainedZipByteLength + chunk.byteLength;
        if (
          nextRetainedByteLength > this.#capacityLimits.totalLiveByteLimit ||
          this.#activeEntryByteLength >
            this.#capacityLimits.totalLiveByteLimit - nextRetainedByteLength
        ) {
          this.#failArchive(
            new ArchiveAssemblyError(
              "archive-capacity-exceeded",
              "The archive exceeded the safe local memory capacity.",
            ),
          );
          return;
        }
        this.#chunks.push(new Uint8Array(chunk));
        this.#retainedZipByteLength = nextRetainedByteLength;
      }
      if (final) {
        this.#resolveCompletion?.();
      }
    });
  }

  get state(): "active" | "cancelled" | "finalized" {
    return this.#state;
  }

  get entryCount(): number {
    return this.#acceptedEntryCount;
  }

  get acceptedEntryCount(): number {
    return this.#acceptedEntryCount;
  }

  get retainedZipByteLength(): number {
    return this.#retainedZipByteLength;
  }

  #clearRetainedState(): void {
    this.#chunks.length = 0;
    this.#registry.clear();
    this.#parsedJson.clear();
    this.#pageSummaries.clear();
    this.#rawPagePaths.length = 0;
    this.#binaryReferences.clear();
    this.#malformedBinaryReference = false;
    this.#acceptedEntryCount = 0;
    this.#retainedZipByteLength = 0;
    this.#activeEntryByteLength = 0;
  }

  #failArchive(error: ArchiveAssemblyError): ArchiveAssemblyError {
    if (this.#zipFailure === undefined) {
      this.#zipFailure = error;
      this.#rejectCompletion?.(error);
      try {
        this.#zip.terminate();
      } catch {
        // The original safe failure remains authoritative.
      }
      this.#clearRetainedState();
    }
    return this.#zipFailure;
  }

  #assertEntryCapacity(byteLength: number): void {
    if (
      byteLength > this.#capacityLimits.singleEntryByteLimit ||
      byteLength >
        this.#capacityLimits.totalLiveByteLimit - this.#retainedZipByteLength
    ) {
      throw this.#failArchive(
        new ArchiveAssemblyError(
          "archive-capacity-exceeded",
          "The archive exceeded the safe local memory capacity.",
        ),
      );
    }
  }

  #assertPreManifestEntryCapacity(): void {
    if (
      this.#acceptedEntryCount >=
      this.#capacityLimits.preManifestEntryCountLimit
    ) {
      throw this.#failArchive(
        new ArchiveAssemblyError(
          "archive-entry-limit-exceeded",
          "The archive exceeded the safe classic-ZIP entry limit.",
        ),
      );
    }
  }

  #assertActive(): void {
    if (this.#state === "cancelled") {
      throw new ArchiveAssemblyError(
        "cancelled",
        "The archive session was cancelled.",
      );
    }
    if (this.#state === "finalized") {
      throw new ArchiveAssemblyError(
        "invalid-entry",
        "The archive session is already finalized.",
      );
    }
    if (this.#zipFailure !== undefined) {
      throw this.#zipFailure;
    }
  }

  #assertActiveSnapshotPath(path: string): void {
    try {
      assertSafeArchivePath(path);
    } catch {
      throw new ArchiveAssemblyError(
        "invalid-entry",
        "An archive entry path is unsafe.",
      );
    }
    if (!path.startsWith(`${this.#snapshotId}/`)) {
      throw new ArchiveAssemblyError(
        "invalid-entry",
        "An archive entry belongs to a different snapshot.",
      );
    }
  }

  #addZipFile(
    path: string,
    compression: ArchiveCompression,
    bytes: Uint8Array,
  ): void {
    this.#assertEntryCapacity(bytes.byteLength);
    this.#activeEntryByteLength = bytes.byteLength;
    try {
      const file =
        compression === "deflate"
          ? new ZipDeflate(path, { level: 6 })
          : new ZipPassThrough(path);
      file.mtime = FIXED_ZIP_MTIME;
      this.#zip.add(file);
      file.push(bytes, true);
      if (this.#zipFailure !== undefined) {
        throw this.#zipFailure;
      }
    } catch {
      if (this.#zipFailure !== undefined) {
        throw this.#zipFailure;
      }
      throw this.#failArchive(
        new ArchiveAssemblyError("zip-failed", "The local ZIP stream failed."),
      );
    } finally {
      this.#activeEntryByteLength = 0;
    }
  }

  async addEntry(descriptor: ArchiveEntryDescriptor): Promise<void> {
    this.#assertActive();
    const { metadata, data } = descriptor;
    this.#assertActiveSnapshotPath(metadata.path);
    this.#assertPreManifestEntryCapacity();

    const requiredCompression = expectedCompression(metadata.mediaType);
    if (
      requiredCompression === null ||
      requiredCompression !== metadata.compression
    ) {
      throw new ArchiveAssemblyError(
        "invalid-entry",
        "An archive entry uses the wrong compression policy.",
      );
    }

    const textualMedia =
      metadata.mediaType === "application/json" ||
      metadata.mediaType === "text/markdown" ||
      metadata.mediaType === "image/svg+xml";
    const expectedSuffixes = expectedPathSuffixes(metadata.mediaType);
    if (
      !expectedSuffixes.some((suffix) => metadata.path.endsWith(suffix)) ||
      textualMedia !== (typeof data === "string")
    ) {
      throw new ArchiveAssemblyError(
        "invalid-entry",
        "Archive media, path extension, and data representation disagree.",
      );
    }

    let bytes: Uint8Array;
    let pageSummary: PageArtifactSummary | undefined;
    if (typeof data === "string") {
      if (
        metadata.mediaType !== "application/json" &&
        metadata.mediaType !== "text/markdown" &&
        metadata.mediaType !== "image/svg+xml"
      ) {
        throw new ArchiveAssemblyError(
          "invalid-entry",
          "Only textual archive media may use string data.",
        );
      }
      try {
        const expectedByteLength = utf8ByteLength(data);
        this.#assertEntryCapacity(expectedByteLength);
        bytes = new Uint8Array(this.#runtime.encodeUtf8(data));
        if (bytes.byteLength !== expectedByteLength) {
          throw new ArchiveAssemblyError(
            "invalid-text",
            "UTF-8 text length did not match the exact preflight count.",
          );
        }
        if (this.#runtime.decodeUtf8(bytes) !== data) {
          throw new ArchiveAssemblyError(
            "invalid-text",
            "UTF-8 text did not round-trip exactly.",
          );
        }
      } catch (error) {
        if (error instanceof ArchiveAssemblyError) {
          throw error;
        }
        throw new ArchiveAssemblyError(
          "invalid-text",
          "UTF-8 text could not be validated.",
        );
      }

      if (metadata.path.endsWith(".json")) {
        try {
          const parsed = JSON.parse(data) as unknown;
          if (metadata.path.startsWith(`${this.#snapshotId}/ir/`)) {
            const scan = binaryReferenceScan(parsed, this.#snapshotId);
            for (const reference of scan.references) {
              if (!reference.validShape || reference.path === undefined) {
                this.#malformedBinaryReference = true;
                continue;
              }
              const existing = this.#binaryReferences.get(reference.path);
              if (existing === undefined) {
                this.#binaryReferences.set(reference.path, reference);
                continue;
              }
              this.#malformedBinaryReference ||=
                existing.kind !== reference.kind ||
                existing.mediaType !== reference.mediaType ||
                existing.byteLength !== reference.byteLength ||
                existing.contentSha256 !== reference.contentSha256 ||
                existing.canonicalPath !== reference.canonicalPath;
            }
            this.#malformedBinaryReference ||= scan.malformed;
          }
          if (metadata.path.startsWith(`${this.#snapshotId}/ir/nodes/pages/`)) {
            pageSummary = summarizePageArtifact(
              parsed,
              metadata.path,
              this.#snapshotId,
            );
          }
          if (
            metadata.path === archivePaths.diagnostics(this.#snapshotId) ||
            metadata.path === archivePaths.irDocument(this.#snapshotId)
          ) {
            this.#parsedJson.set(metadata.path, parsed);
          } else if (
            metadata.path === archivePaths.irComponents(this.#snapshotId)
          ) {
            this.#parsedJson.set(
              metadata.path,
              summarizeComponentsJson(parsed),
            );
          } else if (
            metadata.path === archivePaths.irVariables(this.#snapshotId) ||
            metadata.path === archivePaths.irStyles(this.#snapshotId)
          ) {
            this.#parsedJson.set(
              metadata.path,
              isRecord(parsed)
                ? { kind: parsed.kind, schemaVersion: parsed.schemaVersion }
                : parsed,
            );
          }
        } catch {
          throw new ArchiveAssemblyError(
            "invalid-json",
            "A JSON archive entry is not parseable.",
          );
        }
      }
    } else {
      this.#assertEntryCapacity(data.byteLength);
      bytes = data;
    }

    let contentSha256: string;
    try {
      contentSha256 = await this.#runtime.sha256(bytes);
    } catch {
      throw new ArchiveAssemblyError(
        "hash-failed",
        "An archive entry could not be hashed locally.",
      );
    }
    this.#assertActive();
    if (!CONTENT_HASH_PATTERN.test(contentSha256)) {
      throw new ArchiveAssemblyError(
        "hash-failed",
        "An archive entry hash is not canonical SHA-256.",
      );
    }

    try {
      this.#registry.register({
        path: metadata.path,
        mediaType: metadata.mediaType,
        compression: metadata.compression,
        uncompressedByteLength: bytes.length,
        contentSha256,
      });
    } catch (error) {
      if (!(error instanceof DuplicateArchivePathError)) {
        throw new ArchiveAssemblyError(
          error instanceof ArchivePathError ? "invalid-entry" : "invalid-entry",
          "Archive entry metadata is invalid.",
        );
      }
      throw new ArchiveAssemblyError(
        "duplicate-entry",
        "An archive entry path was rejected before overwrite.",
      );
    }
    this.#addZipFile(metadata.path, metadata.compression, bytes);
    this.#acceptedEntryCount += 1;
    if (pageSummary !== undefined) {
      this.#pageSummaries.set(metadata.path, pageSummary);
    }
    if (metadata.path.startsWith(`${this.#snapshotId}/raw/rest-v1/pages/`)) {
      this.#rawPagePaths.push(metadata.path);
    }
  }

  #entireFilePageIds(
    draft: ArchiveManifestDraft,
    documentValue: Record<string, unknown>,
  ): readonly string[] {
    const pages = documentValue.pages;
    const pageIds = Array.isArray(pages)
      ? pages.map((page) => {
          const source = isRecord(page) ? page : undefined;
          return source?.kind === "page" ? source.id : undefined;
        })
      : [];
    if (
      documentValue.schemaVersion !== draft.schemaVersion ||
      !Array.isArray(pages) ||
      !isUniqueNonEmptyStringArray(pageIds) ||
      !Array.isArray(documentValue.selectedRootIds) ||
      documentValue.selectedRootIds.length !== 0 ||
      draft.counts.pages !== pageIds.length
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "Entire-file document pages, selected roots, schema, and manifest page count disagree.",
      );
    }
    return pageIds;
  }

  #validateEntireFileArtifacts(
    draft: ArchiveManifestDraft,
    documentValue: Record<string, unknown>,
    diagnosticsValue: DiagnosticsJsonShape,
    pageIds: readonly string[],
    requirementsByPath: ReadonlyMap<string, ArchiveArtifactRequirement>,
    entryPaths: readonly string[],
  ): void {
    if (draft.scope.kind !== "entire-file") {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "Entire-file validation received a different export scope.",
      );
    }
    const rawPagePaths = pageIds.map((pageId) =>
      archivePaths.rawRestPage(this.#snapshotId, pageId),
    );
    const pageArtifactPaths = pageIds.map((pageId) =>
      archivePaths.irNodePage(this.#snapshotId, pageId),
    );
    const expectedRawPaths = new Set(rawPagePaths);
    const expectedPageArtifactPaths = new Set(pageArtifactPaths);
    const rawPagePrefix = `${this.#snapshotId}/raw/rest-v1/pages/`;
    const pageArtifactPrefix = `${this.#snapshotId}/ir/nodes/pages/`;
    const isPageScopedPath = (path: string): boolean =>
      path.startsWith(rawPagePrefix) || path.startsWith(pageArtifactPrefix);

    const hasOrphanPagePath = (path: string): boolean =>
      (path.startsWith(rawPagePrefix) && !expectedRawPaths.has(path)) ||
      (path.startsWith(pageArtifactPrefix) &&
        !expectedPageArtifactPaths.has(path));
    if (
      entryPaths.some(hasOrphanPagePath) ||
      [...requirementsByPath.keys()].some(hasOrphanPagePath) ||
      [...requirementsByPath.keys()].filter(isPageScopedPath).length !==
        pageIds.length * 2
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "Entire-file page entries and requirements contain an orphan or omit a page artifact contract.",
      );
    }

    const emittedRawPaths = rawPagePaths.filter(
      (path) => this.#registry.get(path) !== undefined,
    );
    const emittedPageArtifactPaths = pageArtifactPaths.filter(
      (path) => this.#registry.get(path) !== undefined,
    );
    if (
      this.#rawPagePaths.length !== emittedRawPaths.length ||
      this.#rawPagePaths.some(
        (path, index) => path !== emittedRawPaths[index],
      ) ||
      this.#pageSummaries.size !== emittedPageArtifactPaths.length ||
      [...this.#pageSummaries.keys()].some(
        (path, index) => path !== emittedPageArtifactPaths[index],
      )
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "Entire-file raw and canonical page entries were not emitted in document order.",
      );
    }

    const diagnosticsById = new Map(
      diagnosticsValue.diagnostics.map((diagnostic) => [
        diagnostic.id,
        diagnostic,
      ]),
    );
    const flattenedRootIds: string[] = [];
    for (let pageIndex = 0; pageIndex < pageIds.length; pageIndex += 1) {
      const pageId = pageIds[pageIndex];
      const rawPath = rawPagePaths[pageIndex];
      const pageArtifactPath = pageArtifactPaths[pageIndex];
      if (
        pageId === undefined ||
        rawPath === undefined ||
        pageArtifactPath === undefined
      ) {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "Entire-file page path construction failed.",
        );
      }
      const rawRequirement = requirementsByPath.get(rawPath);
      const pageRequirement = requirementsByPath.get(pageArtifactPath);
      if (rawRequirement === undefined || pageRequirement === undefined) {
        throw new ArchiveAssemblyError(
          "missing-required-artifact",
          "An entire-file page lacks its raw or canonical artifact requirement.",
        );
      }
      if (pageRequirement.status === "unavailable") {
        if (this.#pageSummaries.has(pageArtifactPath)) {
          throw new ArchiveAssemblyError(
            "invalid-manifest",
            "An unavailable page artifact retained an emitted page summary.",
          );
        }
        continue;
      }

      const summary = this.#pageSummaries.get(pageArtifactPath);
      if (
        summary === undefined ||
        !summary.validShape ||
        summary.kind !== "design-ir-page-index" ||
        summary.schemaVersion !== documentValue.schemaVersion ||
        summary.sourceId !== pageId
      ) {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "An emitted canonical page artifact has an invalid kind, schema, source, or path.",
        );
      }

      const pageDiagnosticIds = new Set(summary.diagnosticIds);
      if (
        summary.diagnosticIds.some(
          (diagnosticId) => !diagnosticsById.has(diagnosticId),
        )
      ) {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "A canonical page artifact references an unknown diagnostic.",
        );
      }

      let childCursor = 0;
      for (const normalizedRootId of summary.normalizedRootIds) {
        while (
          childCursor < summary.childNodeIds.length &&
          summary.childNodeIds[childCursor] !== normalizedRootId
        ) {
          childCursor += 1;
        }
        if (childCursor >= summary.childNodeIds.length) {
          throw new ArchiveAssemblyError(
            "invalid-manifest",
            "Canonical page trees are not an ordered subset of direct page children.",
          );
        }
        childCursor += 1;
      }

      const normalizedRootIds = new Set(summary.normalizedRootIds);
      for (const missingRootId of summary.childNodeIds.filter(
        (childNodeId) => !normalizedRootIds.has(childNodeId),
      )) {
        const hasTruthfulLossDiagnostic = [...pageDiagnosticIds].some(
          (diagnosticId) => {
            const diagnostic = diagnosticsById.get(diagnosticId);
            if (
              diagnostic === undefined ||
              diagnostic.severity !== "error" ||
              diagnostic.causedDataLoss !== true
            ) {
              return false;
            }
            const source = diagnostic.source;
            const nodeSpecific =
              isRecord(source) &&
              source.kind === "node" &&
              source.id === missingRootId;
            const pageWide =
              (diagnostic.code === DIAGNOSTIC_CODES.pageCollectionFailed &&
                ((isRecord(source) &&
                  source.kind === "page" &&
                  source.id === pageId) ||
                  (source === undefined &&
                    diagnostic.artifactPath === pageArtifactPath))) ||
              (diagnostic.code === DIAGNOSTIC_CODES.archiveEntryTooLarge &&
                isRecord(source) &&
                source.kind === "page" &&
                source.id === pageId &&
                diagnostic.artifactPath === pageArtifactPath &&
                diagnostic.propertyPath === "$.normalizedTrees");
            return nodeSpecific || pageWide;
          },
        );
        if (!hasTruthfulLossDiagnostic) {
          throw new ArchiveAssemblyError(
            "missing-required-artifact",
            "A missing normalized page root lacks a source-attributed loss diagnostic.",
          );
        }
      }

      if (
        rawRequirement.status === "emitted"
          ? summary.rawArtifactPath !== rawPath ||
            summary.rawArtifactMediaType !== "application/json"
          : summary.rawArtifactPath !== undefined ||
            summary.rawArtifactMediaType !== undefined
      ) {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "A canonical page raw-artifact reference does not match raw page availability.",
        );
      }
      flattenedRootIds.push(...summary.childNodeIds);
    }

    if (
      !isUniqueNonEmptyStringArray(flattenedRootIds) ||
      draft.scope.orderedRootIds.length !== flattenedRootIds.length ||
      draft.scope.orderedRootIds.some(
        (rootId, index) => rootId !== flattenedRootIds[index],
      ) ||
      draft.counts.roots !== flattenedRootIds.length
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "Entire-file manifest roots do not equal ordered direct page children from emitted page artifacts.",
      );
    }

    const documentArtifacts = documentValue.artifacts;
    const nodeArtifacts = isRecord(documentArtifacts)
      ? documentArtifacts.nodeArtifacts
      : undefined;
    if (
      !Array.isArray(nodeArtifacts) ||
      nodeArtifacts.length !== emittedPageArtifactPaths.length ||
      nodeArtifacts.some((artifact, index) => {
        const expectedPath = emittedPageArtifactPaths[index];
        return (
          expectedPath === undefined ||
          !isExactJsonArtifactRef(artifact, expectedPath)
        );
      })
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The document IR page artifact references do not exactly match emitted pages in document order.",
      );
    }
  }

  #validateRequirements(
    draft: ArchiveManifestDraft,
    requirements: readonly ArchiveArtifactRequirement[],
  ): void {
    const seen = new Set<string>();
    const emittedRequirements = new Set<string>();
    const requirementsByPath = new Map<string, ArchiveArtifactRequirement>();
    const globalIrPaths = [
      archivePaths.irVariables(this.#snapshotId),
      archivePaths.irStyles(this.#snapshotId),
      archivePaths.irComponents(this.#snapshotId),
    ] as const;
    const mandatoryEmittedPaths = [
      archivePaths.diagnostics(this.#snapshotId),
      archivePaths.irDocument(this.#snapshotId),
      archivePaths.agentIndex(this.#snapshotId),
      ...globalIrPaths,
    ] as const;
    const mandatoryPaths = new Set<string>(mandatoryEmittedPaths);
    if (draft.scope.kind === "current-selection") {
      for (const rootId of draft.scope.orderedRootIds) {
        mandatoryPaths.add(archivePaths.rawRestRoot(this.#snapshotId, rootId));
        mandatoryPaths.add(archivePaths.irNodeRoot(this.#snapshotId, rootId));
        mandatoryPaths.add(archivePaths.preview(this.#snapshotId, rootId));
      }
      if (
        draft.counts.pages !== 1 ||
        draft.counts.roots !== draft.scope.orderedRootIds.length ||
        draft.scope.orderedRootIds.some((rootId) => rootId.length === 0) ||
        new Set(draft.scope.orderedRootIds).size !==
          draft.scope.orderedRootIds.length
      ) {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "Current-selection scope counts and ordered roots disagree.",
        );
      }
    }
    const diagnosticsValue = this.#parsedJson.get(
      archivePaths.diagnostics(this.#snapshotId),
    );
    if (!isDiagnosticsJson(diagnosticsValue)) {
      throw new ArchiveAssemblyError(
        "missing-required-artifact",
        "The diagnostics artifact is missing or invalid.",
      );
    }
    const documentValue = this.#parsedJson.get(
      archivePaths.irDocument(this.#snapshotId),
    );
    if (
      !isRecord(documentValue) ||
      documentValue.kind !== "design-ir-document"
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The document IR has the wrong schema discriminator.",
      );
    }
    if (
      draft.scope.kind === "current-selection" &&
      (!Array.isArray(documentValue.selectedRootIds) ||
        documentValue.selectedRootIds.length !==
          draft.scope.orderedRootIds.length ||
        documentValue.selectedRootIds.some(
          (rootId, index) => rootId !== draft.scope.orderedRootIds[index],
        ))
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The document IR and manifest selected-root scope disagree.",
      );
    }
    const entireFilePageIds =
      draft.scope.kind === "entire-file"
        ? this.#entireFilePageIds(draft, documentValue)
        : undefined;
    if (entireFilePageIds !== undefined) {
      for (const pageId of entireFilePageIds) {
        mandatoryPaths.add(archivePaths.rawRestPage(this.#snapshotId, pageId));
        mandatoryPaths.add(archivePaths.irNodePage(this.#snapshotId, pageId));
      }
    }
    const documentArtifacts = documentValue.artifacts;
    if (
      !isRecord(documentArtifacts) ||
      !isExactJsonArtifactRef(documentArtifacts.variables, globalIrPaths[0]) ||
      !isExactJsonArtifactRef(documentArtifacts.styles, globalIrPaths[1]) ||
      !isExactJsonArtifactRef(documentArtifacts.components, globalIrPaths[2])
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The document IR does not reference the exact mandatory global artifact paths.",
      );
    }
    for (const [path, expectedKind] of [
      [globalIrPaths[0], "design-ir-variables"],
      [globalIrPaths[1], "design-ir-styles"],
      [globalIrPaths[2], "design-ir-components"],
    ] as const) {
      const value = this.#parsedJson.get(path);
      if (
        !isRecord(value) ||
        value.kind !== expectedKind ||
        value.schemaVersion !== documentValue.schemaVersion
      ) {
        throw new ArchiveAssemblyError(
          "missing-required-artifact",
          "A mandatory global artifact has the wrong schema discriminator or version.",
        );
      }
    }
    const componentsValue = this.#parsedJson.get(globalIrPaths[2]) as
      ComponentsJsonSummary | undefined;
    if (componentsValue === undefined || !componentsValue.definitionsValid) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The components index does not contain a valid definitions array.",
      );
    }
    const componentDefinitionPaths = new Set<string>();
    const componentSourceIds = new Set<string>();
    for (const reference of componentsValue.definitionArtifacts) {
      if (
        !reference.validShape ||
        reference.sourceId === undefined ||
        reference.path === undefined ||
        reference.mediaType !== "application/json"
      ) {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "A component definition does not contain an exact JSON artifact reference.",
        );
      }
      let expectedPath: string;
      try {
        expectedPath = archivePaths.irComponentDefinition(
          this.#snapshotId,
          reference.sourceId,
        );
      } catch {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "A component definition source ID cannot form a canonical archive path.",
        );
      }
      if (
        reference.path !== expectedPath ||
        componentSourceIds.has(reference.sourceId) ||
        componentDefinitionPaths.has(reference.path)
      ) {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "Component definition artifact references are not unique canonical paths.",
        );
      }
      componentSourceIds.add(reference.sourceId);
      componentDefinitionPaths.add(reference.path);
      mandatoryPaths.add(reference.path);
    }
    const recomputedSummary = summarizeDiagnosticsJson(
      diagnosticsValue.diagnostics,
    );
    if (
      !equalCounts(diagnosticsValue.summary.counts, recomputedSummary.counts) ||
      diagnosticsValue.summary.completeness !== recomputedSummary.completeness
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The diagnostics summary does not match its diagnostic records.",
      );
    }
    if (recomputedSummary.counts.fatal > 0) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "A fatal diagnostic forbids a normal archive download.",
      );
    }

    for (const requirement of requirements) {
      this.#assertActiveSnapshotPath(requirement.path);
      if (seen.has(requirement.path)) {
        throw new ArchiveAssemblyError(
          "missing-required-artifact",
          "An artifact requirement is duplicated.",
        );
      }
      seen.add(requirement.path);
      requirementsByPath.set(requirement.path, requirement);

      if (requirement.status === "emitted") {
        if (this.#registry.get(requirement.path) === undefined) {
          throw new ArchiveAssemblyError(
            "missing-required-artifact",
            "A required archive artifact was not emitted.",
          );
        }
        emittedRequirements.add(requirement.path);
        continue;
      }

      if (this.#registry.get(requirement.path) !== undefined) {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "An unavailable artifact was also emitted.",
        );
      }
      const diagnostic = diagnosticsValue.diagnostics.find(
        (item) => item.id === requirement.diagnosticId,
      );
      if (
        diagnostic === undefined ||
        (diagnostic.severity !== "error" && diagnostic.severity !== "fatal") ||
        diagnostic.causedDataLoss !== true ||
        diagnostic.artifactPath !== requirement.path
      ) {
        throw new ArchiveAssemblyError(
          "missing-required-artifact",
          "An unavailable artifact lacks a truthful loss diagnostic.",
        );
      }
    }

    const invalidComponentDefinitionRequirement = [
      ...componentDefinitionPaths,
    ].some((path) => {
      const requirement = requirementsByPath.get(path);
      if (requirement === undefined) {
        return true;
      }
      if (requirement.status === "unavailable") {
        return draft.scope.kind === "current-selection";
      }
      return this.#registry.get(path)?.mediaType !== "application/json";
    });
    if (
      [...mandatoryPaths].some((path) => !seen.has(path)) ||
      mandatoryEmittedPaths.some((path) => !emittedRequirements.has(path)) ||
      invalidComponentDefinitionRequirement
    ) {
      throw new ArchiveAssemblyError(
        "missing-required-artifact",
        "The archive omits a mandatory artifact requirement.",
      );
    }

    const entryPaths = this.#registry.list().map((entry) => entry.path);
    if (entireFilePageIds !== undefined) {
      this.#validateEntireFileArtifacts(
        draft,
        documentValue,
        diagnosticsValue,
        entireFilePageIds,
        requirementsByPath,
        entryPaths,
      );
    }
    const componentDefinitionPrefix = `${this.#snapshotId}/ir/components/definitions/`;
    if (
      entryPaths.some(
        (path) =>
          path.startsWith(componentDefinitionPrefix) &&
          !componentDefinitionPaths.has(path),
      )
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The archive contains an orphan component definition artifact.",
      );
    }
    if (
      entryPaths.length !== emittedRequirements.size ||
      entryPaths.some((path) => !emittedRequirements.has(path))
    ) {
      throw new ArchiveAssemblyError(
        "missing-required-artifact",
        "Archive entries and artifact requirements disagree.",
      );
    }

    if (this.#malformedBinaryReference) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "Canonical IR contains a malformed raster, SVG, or preview reference.",
      );
    }
    const referencedBinaryPaths = new Set<string>();
    for (const reference of this.#binaryReferences.values()) {
      if (
        !reference.validShape ||
        reference.path === undefined ||
        reference.path !== reference.canonicalPath ||
        reference.mediaType === undefined ||
        reference.byteLength === undefined ||
        reference.contentSha256 === undefined
      ) {
        throw new ArchiveAssemblyError(
          "invalid-manifest",
          "Canonical IR contains an incomplete binary reference.",
        );
      }
      const entry = this.#registry.get(reference.path);
      if (
        entry === undefined ||
        entry.mediaType !== reference.mediaType ||
        entry.uncompressedByteLength !== reference.byteLength ||
        entry.contentSha256 !== reference.contentSha256
      ) {
        throw new ArchiveAssemblyError(
          "missing-required-artifact",
          "A binary reference does not match its exact archive entry metadata.",
        );
      }
      referencedBinaryPaths.add(reference.path);
    }
    const binaryPrefixes = [
      `${this.#snapshotId}/assets/raster/`,
      `${this.#snapshotId}/assets/vector/`,
      `${this.#snapshotId}/previews/`,
    ];
    if (
      entryPaths.some(
        (path) =>
          binaryPrefixes.some((prefix) => path.startsWith(prefix)) &&
          !referencedBinaryPaths.has(path),
      )
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The archive contains an orphan raster, SVG, or preview entry.",
      );
    }

    if (
      draft.counts.artifacts !== entryPaths.length ||
      !equalCounts(draft.diagnosticCounts, diagnosticsValue.summary.counts) ||
      draft.completeness !== diagnosticsValue.summary.completeness
    ) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "Manifest counts do not match finalized artifacts and diagnostics.",
      );
    }
  }

  async finalize(
    draft: ArchiveManifestDraft,
    requirements: readonly ArchiveArtifactRequirement[],
  ): Promise<CompletedArchive> {
    this.#assertActive();
    if (draft.snapshotId !== this.#snapshotId) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The manifest belongs to a different snapshot.",
      );
    }
    this.#validateRequirements(draft, requirements);

    const entries = this.#registry.list();
    const manifest: ArchiveManifest = {
      ...draft,
      entries,
    };
    const manifestText = serializeCanonicalJson(manifest);
    let manifestBytes: Uint8Array;
    try {
      const expectedByteLength = utf8ByteLength(manifestText);
      this.#assertEntryCapacity(expectedByteLength);
      manifestBytes = new Uint8Array(this.#runtime.encodeUtf8(manifestText));
      if (manifestBytes.byteLength !== expectedByteLength) {
        throw new ArchiveAssemblyError(
          "invalid-text",
          "Manifest UTF-8 length did not match the exact preflight count.",
        );
      }
      if (this.#runtime.decodeUtf8(manifestBytes) !== manifestText) {
        throw new ArchiveAssemblyError(
          "invalid-text",
          "The manifest did not round-trip through UTF-8.",
        );
      }
      JSON.parse(manifestText);
    } catch (error) {
      if (error instanceof ArchiveAssemblyError) {
        throw error;
      }
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The final manifest is invalid.",
      );
    }

    const manifestPath = archivePaths.manifest(this.#snapshotId);
    if (this.#registry.get(manifestPath) !== undefined) {
      throw new ArchiveAssemblyError(
        "invalid-manifest",
        "The recursive manifest path was emitted before finalization.",
      );
    }
    this.#addZipFile(manifestPath, "deflate", manifestBytes);
    this.#zip.end();
    await this.#completion;
    this.#assertActive();
    this.#state = "finalized";

    const chunks = this.#chunks.splice(0);
    this.#retainedZipByteLength = 0;

    return {
      filename: `${this.#snapshotId}.design-ir.zip`,
      chunks,
      manifest,
    };
  }

  cancel(): void {
    if (this.#state !== "active") {
      return;
    }
    this.#state = "cancelled";
    this.#zip.terminate();
    this.#rejectCompletion?.(
      new ArchiveAssemblyError(
        "cancelled",
        "The archive session was cancelled.",
      ),
    );
    this.#clearRetainedState();
  }
}
