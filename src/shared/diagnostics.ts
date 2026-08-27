import { DESIGN_IR_SCHEMA_VERSION, type SourceRef } from "./ir";

export const DIAGNOSTIC_CODES = {
  archiveDuplicatePath: "ARCHIVE_DUPLICATE_PATH",
  archiveInvalidPath: "ARCHIVE_INVALID_PATH",
  archiveMissingRequiredArtifact: "ARCHIVE_MISSING_REQUIRED_ARTIFACT",
  archiveEntryTooLarge: "ARCHIVE_ENTRY_TOO_LARGE",
  componentDependencyUnavailable: "COMPONENT_DEPENDENCY_UNAVAILABLE",
  componentDefinitionExportFailed: "COMPONENT_DEFINITION_EXPORT_FAILED",
  componentMainComponentUnavailable: "COMPONENT_MAIN_COMPONENT_UNAVAILABLE",
  collectionPropertyAccessFailed: "COLLECTION_PROPERTY_ACCESS_FAILED",
  interactionUnsupportedAction: "INTERACTION_UNSUPPORTED_ACTION",
  textSegmentsCollectionFailed: "TEXT_SEGMENTS_COLLECTION_FAILED",
  textMissingFont: "TEXT_MISSING_FONT",
  irUnknownNodeType: "IR_UNKNOWN_NODE_TYPE",
  normalizationCycle: "NORMALIZATION_CYCLE",
  normalizationNonFiniteNumber: "NORMALIZATION_NON_FINITE_NUMBER",
  normalizationPropertyAccessFailed: "NORMALIZATION_PROPERTY_ACCESS_FAILED",
  normalizationSpecialClassifierFailed:
    "NORMALIZATION_SPECIAL_CLASSIFIER_FAILED",
  normalizationUnsupportedValue: "NORMALIZATION_UNSUPPORTED_VALUE",
  pageCollectionFailed: "PAGE_COLLECTION_FAILED",
  pageLoadFailed: "PAGE_LOAD_FAILED",
  rasterContentDeduplicated: "RASTER_CONTENT_DEDUPLICATED",
  rasterImageHashMissing: "RASTER_IMAGE_HASH_MISSING",
  rasterImageUnavailable: "RASTER_IMAGE_UNAVAILABLE",
  rasterReadFailed: "RASTER_READ_FAILED",
  rasterUnknownFormat: "RASTER_UNKNOWN_FORMAT",
  previewExportFailed: "PREVIEW_EXPORT_FAILED",
  rawExportFailed: "RAW_EXPORT_FAILED",
  resourcePublishStatusFailed: "RESOURCE_PUBLISH_STATUS_FAILED",
  styleCollectionFailed: "STYLE_COLLECTION_FAILED",
  styleReferenceUnavailable: "STYLE_REFERENCE_UNAVAILABLE",
  styleReferenceReadFailed: "STYLE_REFERENCE_READ_FAILED",
  scopeDuplicateRoot: "SCOPE_DUPLICATE_ROOT",
  scopeNestedRoot: "SCOPE_NESTED_ROOT",
  scopeRootRemoved: "SCOPE_ROOT_REMOVED",
  variableAliasCycle: "VARIABLE_ALIAS_CYCLE",
  variableAliasMissingMode: "VARIABLE_ALIAS_MISSING_MODE",
  variableAliasMissingReference: "VARIABLE_ALIAS_MISSING_REFERENCE",
  variableAliasRequiresConsumerContext:
    "VARIABLE_ALIAS_REQUIRES_CONSUMER_CONTEXT",
  variableCollectionFailed: "VARIABLE_COLLECTION_FAILED",
  variableCollectionUnavailable: "VARIABLE_COLLECTION_UNAVAILABLE",
  variableReferenceUnavailable: "VARIABLE_REFERENCE_UNAVAILABLE",
  variableReferenceReadFailed: "VARIABLE_REFERENCE_READ_FAILED",
  vectorExportFailed: "VECTOR_EXPORT_FAILED",
} as const;

export type DiagnosticCode =
  (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export type DiagnosticSeverity = "info" | "warning" | "error" | "fatal";

export type DiagnosticPhase =
  | "initialization"
  | "scope"
  | "page-loading"
  | "raw"
  | "normalization"
  | "alias-resolution"
  | "collection"
  | "asset"
  | "preview"
  | "serialization"
  | "archive"
  | "markdown"
  | "ui";

export type SafeErrorContext =
  | "normalization"
  | "property-access"
  | "alias-resolution"
  | "archive-path"
  | "serialization"
  | "unknown";

export type SafeErrorCategory =
  | "error"
  | "type-error"
  | "range-error"
  | "syntax-error"
  | "reference-error"
  | "aggregate-error"
  | "unknown-thrown-value";

export interface SafeTechnicalCause {
  readonly category: SafeErrorCategory;
  readonly context: SafeErrorContext;
}

export interface Diagnostic {
  readonly id: string;
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly phase: DiagnosticPhase;
  readonly source?: SourceRef;
  readonly artifactPath?: string;
  readonly propertyPath?: string;
  readonly causedDataLoss: boolean;
  readonly technicalCause?: SafeTechnicalCause;
}

export type DiagnosticDraft = Omit<Diagnostic, "id">;

export interface DiagnosticCounts {
  readonly info: number;
  readonly warning: number;
  readonly error: number;
  readonly fatal: number;
}

export type ArchiveCompleteness =
  "complete" | "complete-with-warnings" | "incomplete";

export interface DiagnosticSummary {
  readonly counts: DiagnosticCounts;
  readonly completeness: ArchiveCompleteness;
}

export interface DiagnosticsArtifact {
  readonly kind: "design-ir-diagnostics";
  readonly schemaVersion: typeof DESIGN_IR_SCHEMA_VERSION;
  readonly summary: DiagnosticSummary;
  readonly diagnostics: readonly Diagnostic[];
}

export class DiagnosticBagContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagnosticBagContractError";
  }
}

function safeErrorCategory(value: unknown): SafeErrorCategory {
  try {
    if (value instanceof TypeError) {
      return "type-error";
    }
    if (value instanceof RangeError) {
      return "range-error";
    }
    if (value instanceof SyntaxError) {
      return "syntax-error";
    }
    if (value instanceof ReferenceError) {
      return "reference-error";
    }
    if (value instanceof AggregateError) {
      return "aggregate-error";
    }
    if (value instanceof Error) {
      return "error";
    }
  } catch {
    return "unknown-thrown-value";
  }

  return "unknown-thrown-value";
}

export function normalizeSafeTechnicalCause(
  value: unknown,
  context: SafeErrorContext,
): SafeTechnicalCause {
  return {
    category: safeErrorCategory(value),
    context,
  };
}

export class DiagnosticBag {
  readonly #diagnostics: Diagnostic[] = [];
  readonly #namespace: string;

  constructor(namespace = "diagnostic") {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace)) {
      throw new DiagnosticBagContractError(
        "Diagnostic namespaces must be lowercase, path-safe identifiers of at most 64 characters.",
      );
    }
    this.#namespace = namespace;
  }

  add(draft: DiagnosticDraft): Diagnostic {
    const id = `${this.#namespace}-${String(
      this.#diagnostics.length + 1,
    ).padStart(6, "0")}`;
    const diagnostic: Diagnostic = {
      id,
      ...draft,
    };
    this.#diagnostics.push(diagnostic);
    return diagnostic;
  }

  list(): readonly Diagnostic[] {
    return [...this.#diagnostics];
  }

  size(): number {
    return this.#diagnostics.length;
  }

  listSince(index: number): readonly Diagnostic[] {
    if (!Number.isSafeInteger(index) || index < 0 || index > this.size()) {
      throw new DiagnosticBagContractError(
        "Diagnostic list offsets must refer to the current bag.",
      );
    }
    return this.#diagnostics.slice(index);
  }
}

export function summarizeDiagnostics(
  diagnostics: readonly Diagnostic[],
): DiagnosticSummary {
  const counts: {
    info: number;
    warning: number;
    error: number;
    fatal: number;
  } = {
    info: 0,
    warning: 0,
    error: 0,
    fatal: 0,
  };

  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }

  const completeness: ArchiveCompleteness =
    counts.error > 0 || counts.fatal > 0
      ? "incomplete"
      : counts.warning > 0
        ? "complete-with-warnings"
        : "complete";

  return {
    counts,
    completeness,
  };
}

export function createDiagnosticsArtifact(
  diagnostics: readonly Diagnostic[],
): DiagnosticsArtifact {
  return {
    kind: "design-ir-diagnostics",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    summary: summarizeDiagnostics(diagnostics),
    diagnostics: [...diagnostics],
  };
}
