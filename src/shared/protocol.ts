import {
  assertSafeArchivePath,
  parseSnapshotId,
  type ArchiveArtifactRequirement,
  type ArchiveCompression,
  type ArchiveManifestDraft,
} from "./archive";
import type {
  ArchiveCompleteness,
  DiagnosticCounts,
  SafeTechnicalCause,
} from "./diagnostics";
import { ARCHIVE_FORMAT_VERSION, DESIGN_IR_SCHEMA_VERSION } from "./ir";

export const PROTOCOL_VERSION = 4 as const;

export type ExportScope = "current-selection" | "entire-file";
/**
 * Component-collection scope for current-selection exports. "used" (default)
 * keeps only definitions instantiated by the selected roots — compact
 * archives for application work. "reachable" additionally expands every
 * component set touched by the selection so all sibling variants are
 * exported — intended for building UI kits with complete states.
 */
export type ExportComponentScope = "used" | "reachable";
export type ExportId = string;

export interface InitializeRequest {
  readonly type: "initialize-request";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
}

export interface PingRequest {
  readonly type: "ping-request";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
}

export interface StartExportRequest {
  readonly type: "start-export";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly snapshotId: string;
  readonly scope: ExportScope;
  readonly componentScope?: ExportComponentScope;
  readonly ownerConfirmedCurrent: true;
}

export interface CancelExportRequest {
  readonly type: "cancel-export";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly exportId: ExportId;
}

export interface ArchiveEntryAccepted {
  readonly type: "archive-entry-accepted";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly exportId: ExportId;
  readonly sequence: number;
}

export type UiToMainMessage =
  | InitializeRequest
  | PingRequest
  | StartExportRequest
  | CancelExportRequest
  | ArchiveEntryAccepted;

export interface InitializeResult {
  readonly type: "initialize-result";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly document: {
    readonly name: string;
    readonly pageCount: number;
    readonly selectionCount: number;
  };
  readonly capabilities: {
    readonly exportAvailable: true;
    readonly supportedScopes: readonly ["current-selection", "entire-file"];
  };
  readonly runtime: {
    readonly editorType: "figma";
    readonly pluginId: string;
  };
}

export interface PongResult {
  readonly type: "pong-result";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
}

export interface ExportStarted {
  readonly type: "export-started";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly exportId: ExportId;
  readonly scopeSummary:
    | {
        readonly kind: "current-selection";
        readonly rootCount: number;
      }
    | {
        readonly kind: "entire-file";
        readonly pageCount: number;
      };
}

export type ExportProgressPhase =
  | "scope"
  | "page-loading"
  | "collection"
  | "raw"
  | "asset"
  | "preview"
  | "serialization"
  | "archive";

export interface ProgressMessage {
  readonly type: "progress";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly exportId: ExportId;
  readonly phase: ExportProgressPhase;
  readonly completed: number;
  readonly total?: number;
  readonly currentLabel?: string;
  readonly durationMs?: number;
}

export interface ArchiveEntryPayload {
  readonly type: "archive-entry";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly exportId: ExportId;
  readonly path: string;
  readonly mediaType: string;
  readonly compression: ArchiveCompression;
  readonly data: string | Uint8Array;
}

export interface ArchiveEntryMessage extends ArchiveEntryPayload {
  readonly sequence: number;
}

export interface DiagnosticSummaryMessage {
  readonly type: "diagnostic-summary";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly exportId: ExportId;
  readonly counts: DiagnosticCounts;
  readonly completeness: ArchiveCompleteness;
}

export interface ExportReady {
  readonly type: "export-ready";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly exportId: ExportId;
  readonly manifestDraft: ArchiveManifestDraft;
  readonly artifacts: readonly ArchiveArtifactRequirement[];
}

export interface ExportCancelled {
  readonly type: "export-cancelled";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly exportId: ExportId;
}

export type ExportFailureCode =
  | "export-in-progress"
  | "invalid-request"
  | "scope-empty"
  | "scope-invalid"
  | "collection-failed"
  | "archive-capacity-exceeded"
  | "archive-entry-limit-exceeded"
  | "archive-failed";

export interface SafeExportFailure {
  readonly code: ExportFailureCode;
  readonly technicalCause?: SafeTechnicalCause;
}

export interface ExportFailed {
  readonly type: "export-failed";
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly exportId: ExportId;
  readonly safeError: SafeExportFailure;
}

export type MainToUiMessage =
  | InitializeResult
  | PongResult
  | ExportStarted
  | ProgressMessage
  | ArchiveEntryMessage
  | DiagnosticSummaryMessage
  | ExportReady
  | ExportCancelled
  | ExportFailed;

export type ExportProducerMessage =
  Exclude<MainToUiMessage, ArchiveEntryMessage> | ArchiveEntryPayload;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function hasExactKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    hasOnlyKeys(value, [...requiredKeys, ...optionalKeys])
  );
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isEntrySequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isExportScope(value: unknown): value is ExportScope {
  return value === "current-selection" || value === "entire-file";
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^[a-z0-9][a-z0-9-]*$/.test(value)
  );
}

export function isExportId(value: unknown): value is ExportId {
  return typeof value === "string" && /^export-[0-9]{6}$/.test(value);
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isDiagnosticCounts(value: unknown): value is DiagnosticCounts {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["info", "warning", "error", "fatal"]) &&
    isCount(value.info) &&
    isCount(value.warning) &&
    isCount(value.error) &&
    isCount(value.fatal)
  );
}

function isCompleteness(value: unknown): value is ArchiveCompleteness {
  return (
    value === "complete" ||
    value === "complete-with-warnings" ||
    value === "incomplete"
  );
}

function isSafeTechnicalCause(value: unknown): value is SafeTechnicalCause {
  const categories = [
    "error",
    "type-error",
    "range-error",
    "syntax-error",
    "reference-error",
    "aggregate-error",
    "unknown-thrown-value",
  ];
  const contexts = [
    "normalization",
    "property-access",
    "alias-resolution",
    "archive-path",
    "serialization",
    "unknown",
  ];
  return (
    isRecord(value) &&
    hasExactKeys(value, ["category", "context"]) &&
    typeof value.category === "string" &&
    categories.includes(value.category) &&
    typeof value.context === "string" &&
    contexts.includes(value.context)
  );
}

function isSafeExportFailure(value: unknown): value is SafeExportFailure {
  const codes: readonly ExportFailureCode[] = [
    "export-in-progress",
    "invalid-request",
    "scope-empty",
    "scope-invalid",
    "collection-failed",
    "archive-capacity-exceeded",
    "archive-entry-limit-exceeded",
    "archive-failed",
  ];
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code"], ["technicalCause"]) &&
    typeof value.code === "string" &&
    codes.includes(value.code as ExportFailureCode) &&
    (value.technicalCause === undefined ||
      isSafeTechnicalCause(value.technicalCause))
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isManifestScope(
  value: unknown,
): value is ArchiveManifestDraft["scope"] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "orderedRootIds"], ["componentScope"]) &&
    isExportScope(value.kind) &&
    isStringArray(value.orderedRootIds) &&
    value.orderedRootIds.every((rootId) => rootId.length > 0) &&
    new Set(value.orderedRootIds).size === value.orderedRootIds.length &&
    (value.componentScope === undefined ||
      value.componentScope === "used" ||
      value.componentScope === "reachable") &&
    (value.kind !== "entire-file" || value.componentScope === undefined)
  );
}

function manifestCountsAgree(
  scope: ArchiveManifestDraft["scope"],
  counts: unknown,
): boolean {
  return (
    isRecord(counts) &&
    hasExactKeys(counts, ["pages", "roots", "artifacts"]) &&
    isCount(counts.pages) &&
    isCount(counts.roots) &&
    isCount(counts.artifacts) &&
    counts.roots === scope.orderedRootIds.length &&
    (scope.kind !== "current-selection" || counts.pages === 1)
  );
}

function isArtifactRequirement(
  value: unknown,
): value is ArchiveArtifactRequirement {
  if (!isRecord(value) || typeof value.path !== "string") {
    return false;
  }
  try {
    assertSafeArchivePath(value.path);
  } catch {
    return false;
  }
  if (value.status === "emitted" && hasExactKeys(value, ["path", "status"])) {
    return true;
  }
  return (
    value.status === "unavailable" &&
    hasExactKeys(value, ["path", "status", "diagnosticId"]) &&
    typeof value.diagnosticId === "string" &&
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(value.diagnosticId)
  );
}

function isManifestDraft(value: unknown): value is ArchiveManifestDraft {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "archiveVersion",
      "schemaVersion",
      "exporter",
      "snapshotId",
      "exportedAtUtc",
      "editorType",
      "document",
      "scope",
      "ownerConfirmedCurrent",
      "counts",
      "diagnosticCounts",
      "completeness",
      "capabilities",
      "pluginApiLimitations",
    ]) ||
    value.archiveVersion !== ARCHIVE_FORMAT_VERSION ||
    value.schemaVersion !== DESIGN_IR_SCHEMA_VERSION ||
    !isRecord(value.exporter) ||
    !hasExactKeys(value.exporter, ["packageName", "packageVersion"]) ||
    value.exporter.packageName !== "figma-design-ir" ||
    typeof value.exporter.packageVersion !== "string" ||
    typeof value.snapshotId !== "string" ||
    parseSnapshotId(value.snapshotId) === null ||
    typeof value.exportedAtUtc !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      value.exportedAtUtc,
    ) ||
    value.editorType !== "figma" ||
    !isRecord(value.document) ||
    !hasExactKeys(value.document, ["name"]) ||
    typeof value.document.name !== "string" ||
    !isManifestScope(value.scope) ||
    value.ownerConfirmedCurrent !== true ||
    !manifestCountsAgree(value.scope, value.counts) ||
    !isDiagnosticCounts(value.diagnosticCounts) ||
    !isCompleteness(value.completeness) ||
    !isStringArray(value.capabilities) ||
    !isStringArray(value.pluginApiLimitations)
  ) {
    return false;
  }
  return true;
}

export function parseUiToMainMessage(value: unknown): UiToMainMessage | null {
  if (
    !isRecord(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    typeof value.type !== "string"
  ) {
    return null;
  }

  if (
    value.type === "initialize-request" &&
    hasExactKeys(value, ["type", "protocolVersion"])
  ) {
    return { type: "initialize-request", protocolVersion: PROTOCOL_VERSION };
  }

  if (
    value.type === "ping-request" &&
    hasExactKeys(value, ["type", "protocolVersion", "requestId"]) &&
    isRequestId(value.requestId)
  ) {
    return {
      type: "ping-request",
      protocolVersion: PROTOCOL_VERSION,
      requestId: value.requestId,
    };
  }

  if (
    value.type === "start-export" &&
    (hasExactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "snapshotId",
      "scope",
      "ownerConfirmedCurrent",
    ]) ||
      hasExactKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "snapshotId",
        "scope",
        "componentScope",
        "ownerConfirmedCurrent",
      ])) &&
    isRequestId(value.requestId) &&
    typeof value.snapshotId === "string" &&
    parseSnapshotId(value.snapshotId) !== null &&
    isExportScope(value.scope) &&
    (value.componentScope === undefined ||
      value.componentScope === "used" ||
      value.componentScope === "reachable") &&
    value.ownerConfirmedCurrent === true
  ) {
    return {
      type: "start-export",
      protocolVersion: PROTOCOL_VERSION,
      requestId: value.requestId,
      snapshotId: value.snapshotId,
      scope: value.scope,
      ...(value.componentScope === undefined
        ? {}
        : { componentScope: value.componentScope }),
      ownerConfirmedCurrent: true,
    };
  }

  if (
    value.type === "cancel-export" &&
    hasExactKeys(value, ["type", "protocolVersion", "exportId"]) &&
    isExportId(value.exportId)
  ) {
    return {
      type: "cancel-export",
      protocolVersion: PROTOCOL_VERSION,
      exportId: value.exportId,
    };
  }

  if (
    value.type === "archive-entry-accepted" &&
    hasExactKeys(value, ["type", "protocolVersion", "exportId", "sequence"]) &&
    isExportId(value.exportId) &&
    isEntrySequence(value.sequence)
  ) {
    return {
      type: "archive-entry-accepted",
      protocolVersion: PROTOCOL_VERSION,
      exportId: value.exportId,
      sequence: value.sequence,
    };
  }

  return null;
}

export function parseMainToUiMessage(value: unknown): MainToUiMessage | null {
  if (
    !isRecord(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    typeof value.type !== "string"
  ) {
    return null;
  }

  if (
    value.type === "pong-result" &&
    hasExactKeys(value, ["type", "protocolVersion", "requestId"]) &&
    isRequestId(value.requestId)
  ) {
    return {
      type: "pong-result",
      protocolVersion: PROTOCOL_VERSION,
      requestId: value.requestId,
    };
  }

  if (
    value.type === "initialize-result" &&
    hasExactKeys(value, [
      "type",
      "protocolVersion",
      "document",
      "capabilities",
      "runtime",
    ]) &&
    isRecord(value.document) &&
    hasExactKeys(value.document, ["name", "pageCount", "selectionCount"]) &&
    typeof value.document.name === "string" &&
    isCount(value.document.pageCount) &&
    isCount(value.document.selectionCount) &&
    isRecord(value.capabilities) &&
    hasExactKeys(value.capabilities, ["exportAvailable", "supportedScopes"]) &&
    value.capabilities.exportAvailable === true &&
    Array.isArray(value.capabilities.supportedScopes) &&
    value.capabilities.supportedScopes.length === 2 &&
    value.capabilities.supportedScopes[0] === "current-selection" &&
    value.capabilities.supportedScopes[1] === "entire-file" &&
    isRecord(value.runtime) &&
    hasExactKeys(value.runtime, ["editorType", "pluginId"]) &&
    value.runtime.editorType === "figma" &&
    typeof value.runtime.pluginId === "string" &&
    /^\d+$/.test(value.runtime.pluginId)
  ) {
    return {
      type: "initialize-result",
      protocolVersion: PROTOCOL_VERSION,
      document: {
        name: value.document.name,
        pageCount: value.document.pageCount,
        selectionCount: value.document.selectionCount,
      },
      capabilities: {
        exportAvailable: true,
        supportedScopes: ["current-selection", "entire-file"],
      },
      runtime: {
        editorType: "figma",
        pluginId: value.runtime.pluginId,
      },
    };
  }

  if (
    value.type === "export-started" &&
    hasExactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "exportId",
      "scopeSummary",
    ]) &&
    isRequestId(value.requestId) &&
    isExportId(value.exportId) &&
    isRecord(value.scopeSummary)
  ) {
    if (
      hasExactKeys(value.scopeSummary, ["kind", "rootCount"]) &&
      value.scopeSummary.kind === "current-selection" &&
      isCount(value.scopeSummary.rootCount)
    ) {
      return {
        type: "export-started",
        protocolVersion: PROTOCOL_VERSION,
        requestId: value.requestId,
        exportId: value.exportId,
        scopeSummary: {
          kind: "current-selection",
          rootCount: value.scopeSummary.rootCount,
        },
      };
    }
    if (
      hasExactKeys(value.scopeSummary, ["kind", "pageCount"]) &&
      value.scopeSummary.kind === "entire-file" &&
      isCount(value.scopeSummary.pageCount)
    ) {
      return {
        type: "export-started",
        protocolVersion: PROTOCOL_VERSION,
        requestId: value.requestId,
        exportId: value.exportId,
        scopeSummary: {
          kind: "entire-file",
          pageCount: value.scopeSummary.pageCount,
        },
      };
    }
  }

  const phases: readonly ExportProgressPhase[] = [
    "scope",
    "page-loading",
    "collection",
    "raw",
    "asset",
    "preview",
    "serialization",
    "archive",
  ];
  if (
    value.type === "progress" &&
    hasExactKeys(
      value,
      ["type", "protocolVersion", "exportId", "phase", "completed"],
      ["total", "currentLabel", "durationMs"],
    ) &&
    isExportId(value.exportId) &&
    typeof value.phase === "string" &&
    phases.includes(value.phase as ExportProgressPhase) &&
    isCount(value.completed) &&
    (value.total === undefined ||
      (isCount(value.total) && value.completed <= value.total)) &&
    (value.currentLabel === undefined ||
      (typeof value.currentLabel === "string" &&
        value.currentLabel.length <= 256)) &&
    (value.durationMs === undefined || isDuration(value.durationMs))
  ) {
    return {
      type: "progress",
      protocolVersion: PROTOCOL_VERSION,
      exportId: value.exportId,
      phase: value.phase as ExportProgressPhase,
      completed: value.completed,
      ...(value.total === undefined ? {} : { total: value.total }),
      ...(value.currentLabel === undefined
        ? {}
        : { currentLabel: value.currentLabel }),
      ...(value.durationMs === undefined
        ? {}
        : { durationMs: value.durationMs }),
    };
  }

  if (
    value.type === "archive-entry" &&
    hasExactKeys(value, [
      "type",
      "protocolVersion",
      "exportId",
      "sequence",
      "path",
      "mediaType",
      "compression",
      "data",
    ]) &&
    isExportId(value.exportId) &&
    isEntrySequence(value.sequence) &&
    typeof value.path === "string" &&
    typeof value.mediaType === "string" &&
    value.mediaType.length > 0 &&
    (value.compression === "deflate" || value.compression === "store") &&
    (typeof value.data === "string" || isUint8Array(value.data))
  ) {
    try {
      assertSafeArchivePath(value.path);
    } catch {
      return null;
    }
    return {
      type: "archive-entry",
      protocolVersion: PROTOCOL_VERSION,
      exportId: value.exportId,
      sequence: value.sequence,
      path: value.path,
      mediaType: value.mediaType,
      compression: value.compression,
      data: value.data,
    };
  }

  if (
    value.type === "diagnostic-summary" &&
    hasExactKeys(value, [
      "type",
      "protocolVersion",
      "exportId",
      "counts",
      "completeness",
    ]) &&
    isExportId(value.exportId) &&
    isDiagnosticCounts(value.counts) &&
    isCompleteness(value.completeness)
  ) {
    return {
      type: "diagnostic-summary",
      protocolVersion: PROTOCOL_VERSION,
      exportId: value.exportId,
      counts: value.counts,
      completeness: value.completeness,
    };
  }

  if (
    value.type === "export-ready" &&
    hasExactKeys(value, [
      "type",
      "protocolVersion",
      "exportId",
      "manifestDraft",
      "artifacts",
    ]) &&
    isExportId(value.exportId) &&
    isManifestDraft(value.manifestDraft) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isArtifactRequirement)
  ) {
    return {
      type: "export-ready",
      protocolVersion: PROTOCOL_VERSION,
      exportId: value.exportId,
      manifestDraft: value.manifestDraft,
      artifacts: value.artifacts,
    };
  }

  if (
    value.type === "export-cancelled" &&
    hasExactKeys(value, ["type", "protocolVersion", "exportId"]) &&
    isExportId(value.exportId)
  ) {
    return {
      type: "export-cancelled",
      protocolVersion: PROTOCOL_VERSION,
      exportId: value.exportId,
    };
  }

  if (
    value.type === "export-failed" &&
    hasExactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "exportId",
      "safeError",
    ]) &&
    isRequestId(value.requestId) &&
    isExportId(value.exportId) &&
    isSafeExportFailure(value.safeError)
  ) {
    return {
      type: "export-failed",
      protocolVersion: PROTOCOL_VERSION,
      requestId: value.requestId,
      exportId: value.exportId,
      safeError: value.safeError,
    };
  }

  return null;
}
