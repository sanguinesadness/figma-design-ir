(() => {
  // src/shared/ir.ts
  var ARCHIVE_FORMAT_VERSION = "1.0.0";
  var DESIGN_IR_SCHEMA_VERSION = "1.0.0";
  var FIGMA_MIXED_VALUE = Object.freeze({
    $type: "figma-mixed"
  });
  function variableAlias(variableId2) {
    return {
      $type: "variable-alias",
      variableId: variableId2
    };
  }
  function isVariableAliasValue(value) {
    const objectValue2 = value;
    return typeof value === "object" && value !== null && !Array.isArray(value) && objectValue2.$type === "variable-alias" && typeof objectValue2.variableId === "string";
  }

  // src/shared/diagnostics.ts
  var DIAGNOSTIC_CODES = {
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
    normalizationSpecialClassifierFailed: "NORMALIZATION_SPECIAL_CLASSIFIER_FAILED",
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
    variableAliasRequiresConsumerContext: "VARIABLE_ALIAS_REQUIRES_CONSUMER_CONTEXT",
    variableCollectionFailed: "VARIABLE_COLLECTION_FAILED",
    variableCollectionUnavailable: "VARIABLE_COLLECTION_UNAVAILABLE",
    variableReferenceUnavailable: "VARIABLE_REFERENCE_UNAVAILABLE",
    variableReferenceReadFailed: "VARIABLE_REFERENCE_READ_FAILED",
    vectorExportFailed: "VECTOR_EXPORT_FAILED"
  };
  var DiagnosticBagContractError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "DiagnosticBagContractError";
    }
  };
  function safeErrorCategory(value) {
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
  function normalizeSafeTechnicalCause(value, context) {
    return {
      category: safeErrorCategory(value),
      context
    };
  }
  var DiagnosticBag = class {
    #diagnostics = [];
    #namespace;
    constructor(namespace = "diagnostic") {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(namespace)) {
        throw new DiagnosticBagContractError(
          "Diagnostic namespaces must be lowercase, path-safe identifiers of at most 64 characters."
        );
      }
      this.#namespace = namespace;
    }
    add(draft) {
      const id = `${this.#namespace}-${String(
        this.#diagnostics.length + 1
      ).padStart(6, "0")}`;
      const diagnostic = {
        id,
        ...draft
      };
      this.#diagnostics.push(diagnostic);
      return diagnostic;
    }
    list() {
      return [...this.#diagnostics];
    }
    size() {
      return this.#diagnostics.length;
    }
    listSince(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index > this.size()) {
        throw new DiagnosticBagContractError(
          "Diagnostic list offsets must refer to the current bag."
        );
      }
      return this.#diagnostics.slice(index);
    }
  };
  function summarizeDiagnostics(diagnostics) {
    const counts = {
      info: 0,
      warning: 0,
      error: 0,
      fatal: 0
    };
    for (const diagnostic of diagnostics) {
      counts[diagnostic.severity] += 1;
    }
    const completeness = counts.error > 0 || counts.fatal > 0 ? "incomplete" : counts.warning > 0 ? "complete-with-warnings" : "complete";
    return {
      counts,
      completeness
    };
  }
  function createDiagnosticsArtifact(diagnostics) {
    return {
      kind: "design-ir-diagnostics",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      summary: summarizeDiagnostics(diagnostics),
      diagnostics: [...diagnostics]
    };
  }

  // src/shared/archive.ts
  var SNAPSHOT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;
  var ARCHIVE_TOTAL_LIVE_BYTE_LIMIT = 384 * 1024 * 1024;
  var ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT = 64 * 1024 * 1024;
  var ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT = 65534;
  var ArchiveProducerSafetyError = class extends Error {
    code;
    constructor(code) {
      super(
        code === "archive-capacity-exceeded" ? "An archive entry exceeded the safe local capacity." : "The archive exceeded the safe classic-ZIP entry limit."
      );
      this.name = "ArchiveProducerSafetyError";
      this.code = code;
    }
  };
  function utf8ByteLength(value) {
    let byteLength = 0;
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit <= 127) {
        byteLength += 1;
      } else if (codeUnit <= 2047) {
        byteLength += 2;
      } else if (codeUnit >= 55296 && codeUnit <= 56319 && index + 1 < value.length) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (nextCodeUnit >= 56320 && nextCodeUnit <= 57343) {
          byteLength += 4;
          index += 1;
        } else {
          byteLength += 3;
        }
      } else {
        byteLength += 3;
      }
    }
    return byteLength;
  }
  var ArchivePathError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "ArchivePathError";
    }
  };
  function parseSnapshotId(value) {
    return SNAPSHOT_ID_PATTERN.test(value) ? value : null;
  }
  function requireSnapshotId(value) {
    const snapshotId = parseSnapshotId(value);
    if (snapshotId === null) {
      throw new ArchivePathError(
        "Snapshot IDs must match ^[a-z0-9][a-z0-9._-]{0,95}$."
      );
    }
    return snapshotId;
  }
  function encodeSourceId(sourceId) {
    if (sourceId.length === 0) {
      throw new ArchivePathError(
        "Source IDs used in archive paths cannot be empty."
      );
    }
    try {
      return encodeURIComponent(sourceId);
    } catch {
      throw new ArchivePathError(
        "A source ID could not be encoded safely for an archive path."
      );
    }
  }
  function assertSafeArchivePath(path) {
    const containsControlCharacter = (value) => {
      for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit <= 31 || codeUnit === 127) {
          return true;
        }
      }
      return false;
    };
    if (path.length === 0 || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || containsControlCharacter(path)) {
      throw new ArchivePathError("Archive path is not a safe relative ZIP path.");
    }
    const segments = path.split("/");
    for (const segment of segments) {
      let decodedSegment;
      try {
        decodedSegment = decodeURIComponent(segment);
      } catch {
        throw new ArchivePathError(
          "Archive path contains a malformed encoded segment."
        );
      }
      if (segment.length === 0 || segment === "." || segment === ".." || decodedSegment === "." || decodedSegment === "..") {
        throw new ArchivePathError("Archive path contains an unsafe segment.");
      }
    }
    if (!SNAPSHOT_ID_PATTERN.test(segments[0] ?? "")) {
      throw new ArchivePathError(
        "Archive path must be rooted at a validated snapshot ID."
      );
    }
  }
  function archivePath(snapshotId, ...controlledSegments) {
    const path = [snapshotId, ...controlledSegments].join("/");
    assertSafeArchivePath(path);
    return path;
  }
  function sourceJsonPath(snapshotId, directory, sourceId) {
    return archivePath(
      snapshotId,
      ...directory,
      `${encodeSourceId(sourceId)}.json`
    );
  }
  function sourceMarkdownPath(snapshotId, directory, sourceId) {
    return archivePath(
      snapshotId,
      ...directory,
      `${encodeSourceId(sourceId)}.md`
    );
  }
  var archivePaths = {
    manifest: (snapshotId) => archivePath(snapshotId, "manifest.json"),
    diagnostics: (snapshotId) => archivePath(snapshotId, "diagnostics.json"),
    rawRestPage: (snapshotId, pageId) => sourceJsonPath(snapshotId, ["raw", "rest-v1", "pages"], pageId),
    rawRestRoot: (snapshotId, nodeId2) => sourceJsonPath(snapshotId, ["raw", "rest-v1", "roots"], nodeId2),
    irDocument: (snapshotId) => archivePath(snapshotId, "ir", "document.json"),
    irVariables: (snapshotId) => archivePath(snapshotId, "ir", "variables.json"),
    irStyles: (snapshotId) => archivePath(snapshotId, "ir", "styles.json"),
    irComponents: (snapshotId) => archivePath(snapshotId, "ir", "components.json"),
    irComponentDefinition: (snapshotId, componentId) => sourceJsonPath(
      snapshotId,
      ["ir", "components", "definitions"],
      componentId
    ),
    rawRestComponent: (snapshotId, componentId) => sourceJsonPath(snapshotId, ["raw", "rest-v1", "components"], componentId),
    irNodePage: (snapshotId, pageId) => sourceJsonPath(snapshotId, ["ir", "nodes", "pages"], pageId),
    irNodeRoot: (snapshotId, nodeId2) => sourceJsonPath(snapshotId, ["ir", "nodes", "roots"], nodeId2),
    agentIndex: (snapshotId) => archivePath(snapshotId, "agent", "index.md"),
    agentTokens: (snapshotId) => archivePath(snapshotId, "agent", "tokens.md"),
    agentStyles: (snapshotId) => archivePath(snapshotId, "agent", "styles.md"),
    agentComponentIndex: (snapshotId) => archivePath(snapshotId, "agent", "component-index.md"),
    agentComponent: (snapshotId, componentId) => sourceMarkdownPath(snapshotId, ["agent", "components"], componentId),
    agentPageIndex: (snapshotId) => archivePath(snapshotId, "agent", "page-index.md"),
    agentPage: (snapshotId, pageId) => sourceMarkdownPath(snapshotId, ["agent", "pages"], pageId),
    rasterAsset: (snapshotId, contentSha256, extension) => {
      if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
        throw new ArchivePathError(
          "Raster asset paths require a lowercase hexadecimal SHA-256."
        );
      }
      return archivePath(
        snapshotId,
        "assets",
        "raster",
        `${contentSha256}.${extension}`
      );
    },
    vectorAsset: (snapshotId, nodeId2) => archivePath(
      snapshotId,
      "assets",
      "vector",
      `${encodeSourceId(nodeId2)}.svg`
    ),
    preview: (snapshotId, nodeId2) => archivePath(snapshotId, "previews", `${encodeSourceId(nodeId2)}.png`)
  };

  // src/shared/protocol.ts
  var PROTOCOL_VERSION = 4;
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function hasOnlyKeys(value, allowedKeys) {
    return Object.keys(value).every((key) => allowedKeys.includes(key));
  }
  function hasExactKeys(value, requiredKeys, optionalKeys = []) {
    return requiredKeys.every((key) => Object.hasOwn(value, key)) && hasOnlyKeys(value, [...requiredKeys, ...optionalKeys]);
  }
  function isEntrySequence(value) {
    return Number.isSafeInteger(value) && typeof value === "number" && value >= 1;
  }
  function isExportScope(value) {
    return value === "current-selection" || value === "entire-file";
  }
  function isRequestId(value) {
    return typeof value === "string" && value.length <= 64 && /^[a-z0-9][a-z0-9-]*$/.test(value);
  }
  function isExportId(value) {
    return typeof value === "string" && /^export-[0-9]{6}$/.test(value);
  }
  function parseUiToMainMessage(value) {
    if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || typeof value.type !== "string") {
      return null;
    }
    if (value.type === "initialize-request" && hasExactKeys(value, ["type", "protocolVersion"])) {
      return { type: "initialize-request", protocolVersion: PROTOCOL_VERSION };
    }
    if (value.type === "ping-request" && hasExactKeys(value, ["type", "protocolVersion", "requestId"]) && isRequestId(value.requestId)) {
      return {
        type: "ping-request",
        protocolVersion: PROTOCOL_VERSION,
        requestId: value.requestId
      };
    }
    if (value.type === "start-export" && hasExactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "snapshotId",
      "scope",
      "ownerConfirmedCurrent"
    ]) && isRequestId(value.requestId) && typeof value.snapshotId === "string" && parseSnapshotId(value.snapshotId) !== null && isExportScope(value.scope) && value.ownerConfirmedCurrent === true) {
      return {
        type: "start-export",
        protocolVersion: PROTOCOL_VERSION,
        requestId: value.requestId,
        snapshotId: value.snapshotId,
        scope: value.scope,
        ownerConfirmedCurrent: true
      };
    }
    if (value.type === "cancel-export" && hasExactKeys(value, ["type", "protocolVersion", "exportId"]) && isExportId(value.exportId)) {
      return {
        type: "cancel-export",
        protocolVersion: PROTOCOL_VERSION,
        exportId: value.exportId
      };
    }
    if (value.type === "archive-entry-accepted" && hasExactKeys(value, ["type", "protocolVersion", "exportId", "sequence"]) && isExportId(value.exportId) && isEntrySequence(value.sequence)) {
      return {
        type: "archive-entry-accepted",
        protocolVersion: PROTOCOL_VERSION,
        exportId: value.exportId,
        sequence: value.sequence
      };
    }
    return null;
  }

  // src/shared/serialization.ts
  var CanonicalSerializationError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "CanonicalSerializationError";
    }
  };
  function compareCodeUnits(left, right) {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  }
  function assertPlainObject(value) {
    let prototype;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch {
      throw new CanonicalSerializationError(
        "Canonical JSON could not inspect an object prototype; normalize it first."
      );
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalSerializationError(
        "Canonical JSON accepts only arrays and plain objects."
      );
    }
  }
  function safeArrayCheck(value) {
    try {
      return Array.isArray(value);
    } catch {
      throw new CanonicalSerializationError(
        "Canonical JSON could not inspect a runtime value kind; normalize it first."
      );
    }
  }
  function safeObjectKeys(value) {
    try {
      return Object.keys(value);
    } catch {
      throw new CanonicalSerializationError(
        "Canonical JSON could not inspect object keys; normalize it first."
      );
    }
  }
  function rejectSymbolKeys(value) {
    let symbols;
    try {
      symbols = Object.getOwnPropertySymbols(value);
    } catch {
      throw new CanonicalSerializationError(
        "Canonical JSON could not inspect object keys; normalize it first."
      );
    }
    if (symbols.length > 0) {
      throw new CanonicalSerializationError(
        "Canonical JSON cannot omit symbol-keyed properties; normalize them first."
      );
    }
  }
  function isArrayIndexKey(key, length) {
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
  }
  function canonicalizeJsonValue(value) {
    const activeObjects = /* @__PURE__ */ new WeakSet();
    const visit = (current) => {
      if (current === null || typeof current === "string" || typeof current === "boolean") {
        return current;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) {
          throw new CanonicalSerializationError(
            "Canonical JSON cannot contain a non-finite number; normalize it first."
          );
        }
        return current;
      }
      if (typeof current !== "object") {
        throw new CanonicalSerializationError(
          "Canonical JSON encountered a non-JSON runtime value; normalize it first."
        );
      }
      if (activeObjects.has(current)) {
        throw new CanonicalSerializationError(
          "Canonical JSON encountered a cyclic value; normalize it first."
        );
      }
      activeObjects.add(current);
      try {
        if (safeArrayCheck(current)) {
          const currentArray = current;
          let length;
          try {
            length = currentArray.length;
          } catch {
            throw new CanonicalSerializationError(
              "Canonical JSON could not inspect an array length; normalize it first."
            );
          }
          rejectSymbolKeys(current);
          if (safeObjectKeys(current).some((key) => !isArrayIndexKey(key, length))) {
            throw new CanonicalSerializationError(
              "Canonical JSON cannot omit non-index array properties; normalize them first."
            );
          }
          const canonicalArray = [];
          for (let index = 0; index < length; index += 1) {
            let item;
            try {
              item = currentArray[index];
            } catch {
              throw new CanonicalSerializationError(
                "Canonical JSON could not read an array item; normalize it first."
              );
            }
            canonicalArray.push(visit(item));
          }
          return canonicalArray;
        }
        assertPlainObject(current);
        rejectSymbolKeys(current);
        const canonicalObject = /* @__PURE__ */ Object.create(null);
        for (const key of safeObjectKeys(current).sort(compareCodeUnits)) {
          let propertyValue;
          try {
            propertyValue = current[key];
          } catch {
            throw new CanonicalSerializationError(
              "Canonical JSON could not read an object property; normalize it first."
            );
          }
          canonicalObject[key] = visit(propertyValue);
        }
        return canonicalObject;
      } finally {
        activeObjects.delete(current);
      }
    };
    return visit(value);
  }
  function indentation(depth) {
    return "  ".repeat(depth);
  }
  function isJsonArray(value) {
    return Array.isArray(value);
  }
  function serializeCanonicalValue(value, depth) {
    if (value === null) {
      return "null";
    }
    if (typeof value === "string") {
      return JSON.stringify(value);
    }
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }
    if (typeof value === "number") {
      if (Object.is(value, -0)) {
        return "-0";
      }
      return String(value);
    }
    if (isJsonArray(value)) {
      if (value.length === 0) {
        return "[]";
      }
      const childIndent2 = indentation(depth + 1);
      const serializedItems = value.map(
        (item) => `${childIndent2}${serializeCanonicalValue(item, depth + 1)}`
      );
      return `[
${serializedItems.join(",\n")}
${indentation(depth)}]`;
    }
    const objectValue2 = value;
    const keys = Object.keys(objectValue2).sort(compareCodeUnits);
    if (keys.length === 0) {
      return "{}";
    }
    const childIndent = indentation(depth + 1);
    const serializedProperties = keys.map((key) => {
      const propertyValue = objectValue2[key];
      if (propertyValue === void 0) {
        throw new CanonicalSerializationError(
          "Canonical JSON encountered an undefined object property; normalize it first."
        );
      }
      return `${childIndent}${JSON.stringify(key)}: ${serializeCanonicalValue(
        propertyValue,
        depth + 1
      )}`;
    });
    return `{
${serializedProperties.join(",\n")}
${indentation(depth)}}`;
  }
  function ensureOneFinalNewline(text) {
    return `${text.replace(/(?:\r\n|\r|\n)+$/u, "")}
`;
  }
  function serializeCanonicalJson(value) {
    return ensureOneFinalNewline(
      serializeCanonicalValue(canonicalizeJsonValue(value), 0)
    );
  }
  function compareSourceRefs(left, right) {
    return compareCodeUnits(left.id, right.id) || compareCodeUnits(
      left.name === void 0 ? "0" : `1${left.name}`,
      right.name === void 0 ? "0" : `1${right.name}`
    ) || compareCodeUnits(left.kind, right.kind) || compareCodeUnits(
      left.key === void 0 ? "0" : `1${left.key}`,
      right.key === void 0 ? "0" : `1${right.key}`
    ) || compareCodeUnits(
      left.remote === void 0 ? "0" : left.remote ? "2" : "1",
      right.remote === void 0 ? "0" : right.remote ? "2" : "1"
    );
  }
  function sortUnorderedSourceRefs(references) {
    return [...references].sort(compareSourceRefs);
  }
  function sortUnorderedSourceEntities(entities) {
    return [...entities].sort(
      (left, right) => compareSourceRefs(left.source, right.source)
    );
  }
  function compareComponentDependencies(left, right) {
    return compareSourceRefs(left.from, right.from) || compareSourceRefs(left.to, right.to) || compareCodeUnits(left.relationship, right.relationship);
  }
  function sortUnorderedComponentDefinitions(definitions) {
    return sortUnorderedSourceEntities(definitions);
  }
  function sortUnorderedComponentDependencies(dependencies) {
    return [...dependencies].sort(compareComponentDependencies);
  }

  // src/main/cancellation.ts
  var ExportCancelledError = class extends Error {
    constructor() {
      super("Export cancelled.");
      this.name = "ExportCancelledError";
    }
  };
  var ExportCancellationToken = class {
    #cancelled = false;
    get cancelled() {
      return this.#cancelled;
    }
    cancel() {
      this.#cancelled = true;
    }
    throwIfCancelled() {
      if (this.#cancelled) {
        throw new ExportCancelledError();
      }
    }
  };
  function yieldToFigma() {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  // src/main/archive-entry-preflight.ts
  var DEFAULT_TEXT_YIELD_INTERVAL = 256 * 1024;
  function requirePositiveSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive safe integer.`);
    }
    return value;
  }
  function canonicalSerializationError(message) {
    throw new CanonicalSerializationError(message);
  }
  function requireCanonicalObjectKeys(value) {
    let keys;
    let symbols;
    try {
      keys = Object.keys(value);
      symbols = Object.getOwnPropertySymbols(value);
    } catch {
      return canonicalSerializationError(
        "Canonical JSON could not inspect object keys; normalize it first."
      );
    }
    if (symbols.length > 0) {
      return canonicalSerializationError(
        "Canonical JSON cannot omit symbol-keyed properties; normalize them first."
      );
    }
    return keys;
  }
  function requirePlainCanonicalObject(value) {
    let prototype;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch {
      return canonicalSerializationError(
        "Canonical JSON could not inspect an object prototype; normalize it first."
      );
    }
    if (prototype !== Object.prototype && prototype !== null) {
      return canonicalSerializationError(
        "Canonical JSON accepts only arrays and plain objects."
      );
    }
    return value;
  }
  function isArrayIndexKey2(key, length) {
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
  }
  function requireArrayLength(value) {
    let length;
    try {
      length = value.length;
    } catch {
      return canonicalSerializationError(
        "Canonical JSON could not inspect an array length; normalize it first."
      );
    }
    if (requireCanonicalObjectKeys(value).some(
      (key) => !isArrayIndexKey2(key, length)
    )) {
      return canonicalSerializationError(
        "Canonical JSON cannot omit non-index array properties; normalize them first."
      );
    }
    return length;
  }
  function readCanonicalArrayItem(value, index) {
    try {
      return value[index];
    } catch {
      return canonicalSerializationError(
        "Canonical JSON could not read an array item; normalize it first."
      );
    }
  }
  function readCanonicalObjectProperty(value, key) {
    try {
      return value[key];
    } catch {
      return canonicalSerializationError(
        "Canonical JSON could not read an object property; normalize it first."
      );
    }
  }
  async function assertArchiveEntryFits(data, options) {
    const byteLimit = requirePositiveSafeInteger(
      options.byteLimit ?? ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT,
      "Archive entry byte limit"
    );
    const textYieldInterval = requirePositiveSafeInteger(
      options.textYieldInterval ?? DEFAULT_TEXT_YIELD_INTERVAL,
      "Archive text preflight yield interval"
    );
    const yieldControl = options.yieldControl ?? yieldToFigma;
    options.checkpoint();
    if (typeof data !== "string") {
      if (data.byteLength > byteLimit) {
        throw new ArchiveProducerSafetyError("archive-capacity-exceeded");
      }
      options.checkpoint();
      return;
    }
    let byteLength = 0;
    let index = 0;
    let nextYieldIndex = textYieldInterval;
    while (index < data.length) {
      const codeUnit = data.charCodeAt(index);
      if (codeUnit <= 127) {
        byteLength += 1;
        index += 1;
      } else if (codeUnit <= 2047) {
        byteLength += 2;
        index += 1;
      } else if (codeUnit >= 55296 && codeUnit <= 56319 && index + 1 < data.length) {
        const nextCodeUnit = data.charCodeAt(index + 1);
        if (nextCodeUnit >= 56320 && nextCodeUnit <= 57343) {
          byteLength += 4;
          index += 2;
        } else {
          byteLength += 3;
          index += 1;
        }
      } else {
        byteLength += 3;
        index += 1;
      }
      if (byteLength > byteLimit) {
        throw new ArchiveProducerSafetyError("archive-capacity-exceeded");
      }
      if (index >= nextYieldIndex) {
        await yieldControl();
        options.checkpoint();
        nextYieldIndex = index + textYieldInterval;
      }
    }
    options.checkpoint();
  }
  async function assertCanonicalJsonFits(value, options) {
    const byteLimit = requirePositiveSafeInteger(
      options.byteLimit ?? ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT,
      "Archive entry byte limit"
    );
    const workYieldInterval = requirePositiveSafeInteger(
      options.textYieldInterval ?? DEFAULT_TEXT_YIELD_INTERVAL,
      "Archive canonical preflight yield interval"
    );
    const yieldControl = options.yieldControl ?? yieldToFigma;
    const activeObjects = /* @__PURE__ */ new WeakSet();
    const frames = [{ kind: "value", value, depth: 0 }];
    let byteLength = 0;
    let workSinceYield = 0;
    const addBytes = (count) => {
      byteLength += count;
      if (byteLength > byteLimit) {
        throw new ArchiveProducerSafetyError("archive-capacity-exceeded");
      }
    };
    const yieldNow = async () => {
      workSinceYield = 0;
      await yieldControl();
      options.checkpoint();
    };
    options.checkpoint();
    addBytes(1);
    while (frames.length > 0) {
      const frame = frames.pop();
      if (frame === void 0) {
        break;
      }
      workSinceYield += 1;
      if (frame.kind === "json-string") {
        let stringIndex = frame.index;
        while (stringIndex < frame.value.length && workSinceYield < workYieldInterval) {
          const codeUnit = frame.value.charCodeAt(stringIndex);
          if (codeUnit === 34 || codeUnit === 92 || codeUnit === 8 || codeUnit === 9 || codeUnit === 10 || codeUnit === 12 || codeUnit === 13) {
            addBytes(2);
            stringIndex += 1;
          } else if (codeUnit <= 31) {
            addBytes(6);
            stringIndex += 1;
          } else if (codeUnit >= 55296 && codeUnit <= 56319 && stringIndex + 1 < frame.value.length) {
            const nextCodeUnit = frame.value.charCodeAt(stringIndex + 1);
            if (nextCodeUnit >= 56320 && nextCodeUnit <= 57343) {
              addBytes(4);
              stringIndex += 2;
            } else {
              addBytes(6);
              stringIndex += 1;
            }
          } else if (codeUnit >= 55296 && codeUnit <= 57343) {
            addBytes(6);
            stringIndex += 1;
          } else if (codeUnit <= 127) {
            addBytes(1);
            stringIndex += 1;
          } else if (codeUnit <= 2047) {
            addBytes(2);
            stringIndex += 1;
          } else {
            addBytes(3);
            stringIndex += 1;
          }
          workSinceYield += 1;
        }
        if (stringIndex < frame.value.length) {
          frames.push({
            kind: "json-string",
            value: frame.value,
            index: stringIndex
          });
        }
        if (workSinceYield >= workYieldInterval) {
          await yieldNow();
        }
        continue;
      }
      if (frame.kind === "array-item") {
        if (frame.index >= frame.length) {
          addBytes(frame.depth * 2 + 1);
          activeObjects.delete(frame.value);
        } else {
          addBytes((frame.depth + 1) * 2);
          frames.push({
            kind: "array-after-item",
            value: frame.value,
            depth: frame.depth,
            index: frame.index,
            length: frame.length
          });
          frames.push({
            kind: "value",
            value: readCanonicalArrayItem(frame.value, frame.index),
            depth: frame.depth + 1
          });
        }
        if (workSinceYield >= workYieldInterval) {
          await yieldNow();
        }
        continue;
      }
      if (frame.kind === "array-after-item") {
        addBytes(frame.index + 1 < frame.length ? 2 : 1);
        frames.push({
          kind: "array-item",
          value: frame.value,
          depth: frame.depth,
          index: frame.index + 1,
          length: frame.length
        });
        if (workSinceYield >= workYieldInterval) {
          await yieldNow();
        }
        continue;
      }
      if (frame.kind === "object-item") {
        if (frame.index >= frame.keys.length) {
          addBytes(frame.depth * 2 + 1);
          activeObjects.delete(frame.value);
        } else {
          const key = frame.keys[frame.index];
          if (key === void 0) {
            return canonicalSerializationError(
              "Canonical JSON could not read a sorted object key."
            );
          }
          addBytes((frame.depth + 1) * 2);
          frames.push({
            kind: "object-after-key",
            value: frame.value,
            depth: frame.depth,
            keys: frame.keys,
            index: frame.index,
            key
          });
          addBytes(2);
          frames.push({
            kind: "json-string",
            value: key,
            index: 0
          });
        }
        if (workSinceYield >= workYieldInterval) {
          await yieldNow();
        }
        continue;
      }
      if (frame.kind === "object-after-key") {
        addBytes(2);
        frames.push({
          kind: "object-after-item",
          value: frame.value,
          depth: frame.depth,
          keys: frame.keys,
          index: frame.index
        });
        frames.push({
          kind: "value",
          value: readCanonicalObjectProperty(frame.value, frame.key),
          depth: frame.depth + 1
        });
        if (workSinceYield >= workYieldInterval) {
          await yieldNow();
        }
        continue;
      }
      if (frame.kind === "object-after-item") {
        addBytes(frame.index + 1 < frame.keys.length ? 2 : 1);
        frames.push({
          kind: "object-item",
          value: frame.value,
          depth: frame.depth,
          keys: frame.keys,
          index: frame.index + 1
        });
        if (workSinceYield >= workYieldInterval) {
          await yieldNow();
        }
        continue;
      }
      const current = frame.value;
      if (current === null) {
        addBytes(4);
      } else if (typeof current === "string") {
        addBytes(2);
        frames.push({ kind: "json-string", value: current, index: 0 });
      } else if (typeof current === "boolean") {
        addBytes(current ? 4 : 5);
      } else if (typeof current === "number") {
        if (!Number.isFinite(current)) {
          return canonicalSerializationError(
            "Canonical JSON cannot contain a non-finite number; normalize it first."
          );
        }
        addBytes(Object.is(current, -0) ? 2 : String(current).length);
      } else if (typeof current !== "object") {
        return canonicalSerializationError(
          "Canonical JSON encountered a non-JSON runtime value; normalize it first."
        );
      } else {
        if (activeObjects.has(current)) {
          return canonicalSerializationError(
            "Canonical JSON encountered a cyclic value; normalize it first."
          );
        }
        activeObjects.add(current);
        let isArray;
        try {
          isArray = Array.isArray(current);
        } catch {
          return canonicalSerializationError(
            "Canonical JSON could not inspect a runtime value kind; normalize it first."
          );
        }
        if (isArray) {
          const array = current;
          const length = requireArrayLength(array);
          if (length === 0) {
            addBytes(2);
            activeObjects.delete(current);
          } else {
            addBytes(2);
            frames.push({
              kind: "array-item",
              value: array,
              depth: frame.depth,
              index: 0,
              length
            });
          }
        } else {
          const object = requirePlainCanonicalObject(current);
          const keys = requireCanonicalObjectKeys(object).sort();
          if (keys.length === 0) {
            addBytes(2);
            activeObjects.delete(current);
          } else {
            addBytes(2);
            frames.push({
              kind: "object-item",
              value: object,
              depth: frame.depth,
              keys,
              index: 0
            });
          }
        }
      }
      if (workSinceYield >= workYieldInterval) {
        await yieldNow();
      }
    }
    options.checkpoint();
  }

  // src/shared/minimal-markdown.ts
  var MAX_MARKDOWN_BYTES = 1024 * 1024;
  var MAX_DISPLAY_CHARS = 2048;
  var MAX_BLOCK_BYTES = 48 * 1024;
  var MAX_TREE_FACT_SAMPLES = 12;
  var MARKDOWN_ESCAPABLE = new Set(
    Array.from("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")
  );
  var MinimalMarkdownError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "MinimalMarkdownError";
    }
  };
  function relativePath(fromPath, toPath) {
    assertSafeArchivePath(fromPath);
    assertSafeArchivePath(toPath);
    const from = fromPath.split("/");
    const to = toPath.split("/");
    if (from[0] !== to[0]) {
      throw new MinimalMarkdownError(
        "A Markdown link target belongs to a different snapshot."
      );
    }
    from.pop();
    while (from.length > 0 && to.length > 0 && from[0] === to[0]) {
      from.shift();
      to.shift();
    }
    return `${"../".repeat(from.length)}${to.join("/")}`;
  }
  function link(fromPath, toPath, label) {
    return `[${escapeMarkdown(label)}](<${relativePath(fromPath, toPath)}>)`;
  }
  function escapeMarkdown(value) {
    return Array.from(value).map((character) => {
      const code = character.charCodeAt(0);
      if (code >= 0 && code <= 8 || code >= 11 && code <= 12 || code >= 14 && code <= 31 || code === 127) {
        return "\uFFFD";
      }
      if (character === "\r" || character === "\n") return " ";
      return MARKDOWN_ESCAPABLE.has(character) ? `\\${character}` : character;
    }).join("");
  }
  function boundedText(value, maximum = MAX_DISPLAY_CHARS) {
    const scalarValues = Array.from(value);
    if (scalarValues.length <= maximum) return value;
    return `${scalarValues.slice(0, maximum).join("")}\u2026 (truncated; follow canonical JSON)`;
  }
  function displayValue(value) {
    return escapeMarkdown(boundedText(serializeCanonicalJson(value).trim()));
  }
  function sourceLabel(source) {
    return escapeMarkdown(
      boundedText(source.name === void 0 ? source.id : source.name)
    );
  }
  function sourceIdentity(source) {
    return escapeMarkdown(boundedText(source.id));
  }
  function formatBounds(node) {
    const bounds = node.geometry?.absoluteBounds ?? node.geometry?.localBounds ?? void 0;
    if (bounds === void 0 || bounds === null) return "dimensions unavailable";
    return `${String(bounds.width)} \xD7 ${String(bounds.height)} at ${String(bounds.x)}, ${String(bounds.y)}`;
  }
  function partPath(path, part) {
    const extensionIndex = path.lastIndexOf(".");
    if (extensionIndex < 0) {
      throw new MinimalMarkdownError(
        "A Markdown artifact path lacks an extension."
      );
    }
    const result = `${path.slice(0, extensionIndex)}.part-${String(part)}${path.slice(extensionIndex)}`;
    assertSafeArchivePath(result);
    return result;
  }
  function splitBoundedBlock(value) {
    if (utf8ByteLength(value) <= MAX_BLOCK_BYTES) return [value];
    const chunks = [];
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
          "A Markdown block could not be split at a UTF-8 boundary."
        );
      }
      chunks.push(remaining.slice(0, chunkEnd));
      remaining = remaining.slice(chunkEnd);
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }
  function splitBlocks(blocks) {
    const chunks = [];
    for (const block of blocks) {
      chunks.push(...splitBoundedBlock(block));
    }
    return chunks;
  }
  function splitMarkdownArtifact(path, title, blocks) {
    const complete = ensureOneFinalNewline(blocks.join("\n\n"));
    if (utf8ByteLength(complete) <= MAX_MARKDOWN_BYTES)
      return [{ path, text: complete }];
    const normalizedBlocks = splitBlocks(blocks);
    const partLimit = MAX_MARKDOWN_BYTES - 32 * 1024;
    const parts = [];
    let current = [];
    let currentBytes = 0;
    for (const block of normalizedBlocks) {
      const separatorBytes = current.length === 0 ? 0 : 2;
      const blockBytes = utf8ByteLength(block);
      if (current.length > 0 && currentBytes + separatorBytes + blockBytes > partLimit) {
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
        "A bounded Markdown artifact could not be split."
      );
    }
    const partArtifacts = parts.map((part, index2) => {
      const text = ensureOneFinalNewline(
        `# ${title} \u2014 part ${String(index2 + 1)} of ${String(parts.length)}

${part.join("\n\n")}`
      );
      if (utf8ByteLength(text) > MAX_MARKDOWN_BYTES) {
        throw new MinimalMarkdownError(
          "A Markdown part exceeds the documented byte limit."
        );
      }
      return { path: partPath(path, index2 + 1), text };
    });
    const index = ensureOneFinalNewline(
      [
        `# ${title}`,
        "",
        "This bounded Markdown artifact is split deterministically. Read the parts in order; canonical JSON remains authoritative for exact values.",
        "",
        ...partArtifacts.map(
          (part, index2) => `- ${link(path, part.path, `Part ${String(index2 + 1)}`)}`
        )
      ].join("\n")
    );
    if (utf8ByteLength(index) > MAX_MARKDOWN_BYTES) {
      throw new MinimalMarkdownError(
        "A Markdown split index exceeds the byte limit."
      );
    }
    return [{ path, text: index }, ...partArtifacts];
  }
  function nodeStyleReferences(node) {
    const references = [];
    for (const candidate of [
      node.visual?.fillStyle,
      node.visual?.strokeStyle,
      node.visual?.effectStyle,
      node.visual?.gridStyle,
      node.visual?.backgroundStyle,
      ...node.family === "text" ? [
        node.text.textStyle,
        ...node.text.segments.flatMap((segment) => [
          segment.textStyle,
          segment.fillStyle
        ])
      ] : []
    ]) {
      if (candidate !== void 0 && candidate !== null && !("$type" in candidate) && candidate.kind === "style") {
        references.push(candidate);
      }
    }
    return references;
  }
  function definedRecord(entries) {
    const result = {};
    for (const [key, value] of entries) {
      if (value !== void 0) result[key] = value;
    }
    return result;
  }
  function addCanonicalSample(samples, seen, value) {
    if (samples.length >= MAX_TREE_FACT_SAMPLES) return;
    const serialized = serializeCanonicalJson(value).trim();
    if (seen.has(serialized)) return;
    seen.add(serialized);
    samples.push(serialized);
  }
  function displayCanonicalSample(value) {
    return escapeMarkdown(boundedText(value));
  }
  function collectTreeFacts(tree) {
    const styleRefs = /* @__PURE__ */ new Map();
    const variableRefs = /* @__PURE__ */ new Map();
    const instanceRefs = /* @__PURE__ */ new Map();
    const layoutSamples = [];
    const typographySamples = [];
    const paintSamples = [];
    const effectSamples = [];
    const seenLayouts = /* @__PURE__ */ new Set();
    const seenTypography = /* @__PURE__ */ new Set();
    const seenPaints = /* @__PURE__ */ new Set();
    const seenEffects = /* @__PURE__ */ new Set();
    const work = [tree];
    let nodeCount = 0;
    let layoutCount = 0;
    let typographyCount = 0;
    let paintCount = 0;
    let effectCount = 0;
    const addBindings = (bindings) => {
      for (const binding of bindings ?? []) {
        variableRefs.set(binding.variable.id, binding.variable);
      }
    };
    while (work.length > 0) {
      const node = work.pop();
      if (node === void 0) continue;
      nodeCount += 1;
      for (const reference of nodeStyleReferences(node))
        styleRefs.set(reference.id, reference);
      addBindings(node.variableBindings);
      if (node.layout !== void 0) {
        layoutCount += 1;
        addCanonicalSample(layoutSamples, seenLayouts, {
          nodeId: node.source.id,
          layout: node.layout
        });
        const grids = node.layout.grids;
        if (Array.isArray(grids)) {
          const gridRecords = grids;
          for (const grid of gridRecords) addBindings(grid.boundVariables);
        }
      }
      const recordPaints = (property, value) => {
        if (value === void 0) return;
        const records = Array.isArray(value) ? value : [value];
        paintCount += records.length;
        for (const record of records) {
          addCanonicalSample(paintSamples, seenPaints, {
            nodeId: node.source.id,
            property,
            value: record
          });
          if (record !== null && typeof record === "object") {
            const paint = record;
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
      if (effects !== void 0) {
        const records = Array.isArray(effects) ? effects : [effects];
        effectCount += records.length;
        for (const effect of records) {
          addCanonicalSample(effectSamples, seenEffects, {
            nodeId: node.source.id,
            effect
          });
          if (effect !== null && typeof effect === "object") {
            addBindings(
              effect.boundVariables
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
            ["leadingTrim", node.text.leadingTrim]
          ])
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
              ["lineHeight", segment.lineHeight]
            ])
          );
          addBindings(segment.variableBindings);
          recordPaints("text-segment-fills", segment.fills);
        }
      }
      if (node.family === "instance" && node.instanceData.mainComponent !== void 0) {
        instanceRefs.set(
          node.instanceData.mainComponent.id,
          node.instanceData.mainComponent
        );
      }
      if ("children" in node) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== void 0) work.push(child);
        }
      }
    }
    const sort = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
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
      effectSamples
    };
  }
  function markdownList(values, none = "None recorded.") {
    return values.length === 0 ? [`- ${none}`] : values.map((value) => `- ${value}`);
  }
  function assetLinks(fromPath, assets) {
    return assets.map(
      (asset) => link(
        fromPath,
        asset.archivePath,
        `${asset.assetKind}: ${asset.source.name ?? asset.source.id}`
      )
    );
  }
  function previewLinks(fromPath, previews) {
    return previews.map(
      (preview) => link(
        fromPath,
        preview.archivePath,
        preview.sourceNode.name ?? preview.sourceNode.id
      )
    );
  }
  function interactionLines(reactions) {
    return reactions.map((reaction) => {
      const actions = reaction.actions.map((action) => action.actionType).join(", ");
      return `${escapeMarkdown(reaction.id)} \u2014 trigger ${escapeMarkdown(reaction.trigger?.triggerType ?? "none")}; actions: ${escapeMarkdown(actions || "none")}`;
    });
  }
  function componentSummaryPath(snapshotId, componentId) {
    return archivePaths.agentComponent(snapshotId, componentId);
  }
  function componentReferenceLink(fromPath, snapshotId, reference, componentSummaryIds) {
    return componentSummaryIds?.has(reference.id) === true ? link(
      fromPath,
      componentSummaryPath(snapshotId, reference.id),
      "component summary"
    ) : link(
      fromPath,
      archivePaths.agentComponentIndex(snapshotId),
      "component index"
    );
  }
  function projectComponentMarkdown(snapshotId, definition, artifact, context = {}) {
    const path = componentSummaryPath(snapshotId, definition.source.id);
    const canonicalIndex = archivePaths.irComponents(snapshotId);
    const canonicalDefinition = artifact === void 0 ? void 0 : definition.definitionArtifact?.path;
    const facts = artifact === void 0 ? void 0 : collectTreeFacts(artifact.normalizedTree);
    const componentDependencies = (context.dependencies ?? []).filter(
      (dependency) => dependency.from.id === definition.source.id
    );
    const diagnostics = [
      .../* @__PURE__ */ new Set([
        ...definition.diagnosticIds,
        ...artifact?.diagnosticIds ?? []
      ])
    ];
    const blocks = [
      `# Component: ${sourceLabel(definition.source)}

This is a navigational projection. ${link(path, canonicalIndex, "Canonical component index")} is authoritative for metadata${canonicalDefinition === void 0 ? "." : `; ${link(path, canonicalDefinition, "canonical component definition")} is authoritative for the exact tree.`}`,
      `## Identity

- Source ID: ${sourceIdentity(definition.source)}
- Kind: ${escapeMarkdown(definition.componentKind)}
- Definition node ID: ${escapeMarkdown(definition.nodeId ?? "unavailable")}
- Component set ID: ${escapeMarkdown(definition.componentSetId ?? "none")}
- Default variant ID: ${escapeMarkdown(definition.defaultVariantId ?? "none")}
- Description: ${escapeMarkdown(boundedText(definition.description ?? "none"))}
- Documentation references: ${(definition.documentationLinks ?? []).map((value) => escapeMarkdown(boundedText(value))).join(", ") || "none"}`,
      `## Variants and properties

### Variant axes
${markdownList((definition.variantAxes ?? []).map((axis) => `${escapeMarkdown(axis.name)}: ${axis.values.map((value) => escapeMarkdown(boundedText(value))).join(", ")}`)).join("\n")}

### This definition's variant properties
${markdownList(
        (definition.variantProperties ?? []).map(
          (property) => `${escapeMarkdown(property.property)}: ${escapeMarkdown(boundedText(property.value))}`
        ),
        "No variant properties recorded."
      ).join("\n")}

### Property definitions
${markdownList(
        (definition.propertyDefinitions ?? []).map(
          (property) => `${escapeMarkdown(property.name)} (${escapeMarkdown(property.propertyType)}): default ${displayValue(property.defaultValue)}; variant options ${property.variantOptions?.map((value) => escapeMarkdown(boundedText(value))).join(", ") || "none"}; preferred values ${property.preferredValues.map((value) => `${escapeMarkdown(value.type)} ${escapeMarkdown(value.key)}`).join(", ") || "none"}; variable bindings ${property.variableBindings.map((binding) => `${escapeMarkdown(binding.propertyPath)} \u2192 ${sourceIdentity(binding.variable)}`).join(", ") || "none"}; slot settings ${property.slotSettings === void 0 ? "none" : displayValue(property.slotSettings)}`
        ),
        "No property definitions recorded."
      ).join("\n")}`,
      `## Layout, typography, colors, effects, and bindings

${artifact === void 0 || facts === void 0 ? "Canonical definition tree unavailable; follow diagnostics and canonical component index." : `- Nodes in canonical definition tree: ${String(facts.nodeCount)}
- Root dimensions: ${escapeMarkdown(formatBounds(artifact.normalizedTree))}
- Recorded layout objects: ${String(facts.layoutCount)}
- Recorded typography objects/runs: ${String(facts.typographyCount)}
- Recorded paint/color objects: ${String(facts.paintCount)}
- Recorded effect objects: ${String(facts.effectCount)}

### Layout values (first ${String(MAX_TREE_FACT_SAMPLES)} distinct records in canonical traversal order)
${markdownList(facts.layoutSamples.map(displayCanonicalSample)).join("\n")}

### Typography values (first ${String(MAX_TREE_FACT_SAMPLES)} distinct records in canonical traversal order)
${markdownList(facts.typographySamples.map(displayCanonicalSample)).join("\n")}

### Paint and color values (first ${String(MAX_TREE_FACT_SAMPLES)} distinct records in canonical traversal order)
${markdownList(facts.paintSamples.map(displayCanonicalSample)).join("\n")}

### Effect values (first ${String(MAX_TREE_FACT_SAMPLES)} distinct records in canonical traversal order)
${markdownList(facts.effectSamples.map(displayCanonicalSample)).join("\n")}

### Style bindings
${markdownList(facts.styleRefs.map((reference) => `${sourceLabel(reference)} (${sourceIdentity(reference)}) \u2014 ${link(path, archivePaths.agentStyles(snapshotId), "style index")}`)).join("\n")}

### Variable bindings
${markdownList(facts.variableRefs.map((reference) => `${sourceLabel(reference)} (${sourceIdentity(reference)}) \u2014 ${link(path, archivePaths.agentTokens(snapshotId), "token index")}`)).join("\n")}`}`,
      `## Dependencies and instance relationships

### Canonical dependency references
${markdownList(
        (artifact?.dependencyRefs ?? []).map(
          (reference) => reference.kind === "component" ? `${sourceLabel(reference)} (${sourceIdentity(reference)}) \u2014 ${componentReferenceLink(path, snapshotId, reference, context.componentSummaryIds)}` : `${escapeMarkdown(reference.kind)} ${sourceLabel(reference)} (${sourceIdentity(reference)})`
        )
      ).join("\n")}

### Component dependency edges
${markdownList(
        componentDependencies.map(
          (dependency) => `${escapeMarkdown(dependency.relationship)} \u2192 ${sourceLabel(dependency.to)} (${sourceIdentity(dependency.to)}) \u2014 ${componentReferenceLink(path, snapshotId, dependency.to, context.componentSummaryIds)}`
        ),
        "No outgoing component dependency edges recorded."
      ).join(
        "\n"
      )}

### Nested instance relationships
${artifact === void 0 || facts === void 0 ? "- No readable definition tree was available for this projection." : markdownList(facts.instanceRefs.map((reference) => `${sourceLabel(reference)} (${sourceIdentity(reference)}) \u2014 ${componentReferenceLink(path, snapshotId, reference, context.componentSummaryIds)}`)).join("\n")}

${definition.exposedInstanceIds === void 0 ? "Exposed-instance metadata unavailable." : `Exposed instance IDs: ${definition.exposedInstanceIds.map((id) => escapeMarkdown(id)).join(", ") || "none"}.`}`,
      `## Interactions, assets, previews, and diagnostics

### Interactions
${markdownList(artifact === void 0 ? [] : interactionLines(artifact.reactions)).join("\n")}

### Assets
${markdownList(artifact === void 0 ? [] : assetLinks(path, artifact.assets)).join("\n")}

### Previews
- Dedicated component previews are not generated; use the ${link(path, archivePaths.agentPageIndex(snapshotId), "page index")} to locate exported page-level previews.

### Diagnostics
${diagnostics.length === 0 ? "- None recorded on this component artifact." : `- ${link(path, archivePaths.diagnostics(snapshotId), "Diagnostics")}: ${diagnostics.map((id) => escapeMarkdown(id)).join(", ")}`}`
    ];
    return splitMarkdownArtifact(
      path,
      `Component: ${sourceLabel(definition.source)}`,
      blocks
    );
  }
  function projectPageLikeMarkdown(snapshotId, path, page, overviewCanonicalPath, canonicalPaths, trees, dependencyRefs, reactions, assets, previews, diagnosticIds, componentSummaryIds) {
    const rootLines = trees.map((tree, index) => {
      const canonicalPath = canonicalPaths[index] ?? overviewCanonicalPath;
      return `${escapeMarkdown(tree.nodeType)} ${sourceLabel(tree.source)} (${escapeMarkdown(formatBounds(tree))}) \u2014 ${link(path, canonicalPath, "exact canonical data")}`;
    });
    const facts = trees.map(collectTreeFacts);
    const componentRefs = dependencyRefs.filter(
      (reference) => reference.kind === "component"
    );
    const exactCanonicalPaths = [...new Set(canonicalPaths)];
    const blocks = [
      `# Page: ${sourceLabel(page)}

This is an agent-reading projection. ${link(path, overviewCanonicalPath, "Canonical page/root IR")} wins over this Markdown for exact values.`,
      `## Hierarchy and screen roots

${markdownList(rootLines, "No normalized screen roots are available; inspect canonical coverage and diagnostics.").join("\n")}`,
      `## Dependencies and component summaries

${markdownList(
        componentRefs.map(
          (reference) => `${sourceLabel(reference)} (${sourceIdentity(reference)}) \u2014 ${componentReferenceLink(path, snapshotId, reference, componentSummaryIds)}`
        ),
        "No component dependencies recorded."
      ).join("\n")}

Other dependency references: ${dependencyRefs.filter((reference) => reference.kind !== "component").map(sourceIdentity).join(", ") || "none"}.`,
      `## Interactions

${markdownList(interactionLines(reactions)).join("\n")}`,
      `## Assets and previews

### Assets
${markdownList(assetLinks(path, assets)).join("\n")}

### Previews
${markdownList(previewLinks(path, previews)).join("\n")}`,
      `## Exact canonical recovery

${markdownList(exactCanonicalPaths.map((canonicalPath, index) => link(path, canonicalPath, `Canonical IR artifact ${String(index + 1)}`))).join("\n")}
- ${link(path, archivePaths.diagnostics(snapshotId), "Diagnostics")}
- Normalized node count represented here: ${String(facts.reduce((total, item) => total + item.nodeCount, 0))}
- Diagnostic IDs: ${diagnosticIds.length === 0 ? "none" : diagnosticIds.map((id) => escapeMarkdown(id)).join(", ")}`
    ];
    return splitMarkdownArtifact(path, `Page: ${sourceLabel(page)}`, blocks);
  }
  function projectPageMarkdown(snapshotId, page, componentSummaryIds) {
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
      componentSummaryIds
    );
  }
  function projectSelectionPageMarkdown(snapshotId, page, roots, componentSummaryIds) {
    const canonicalPaths = roots.map(
      (root) => archivePaths.irNodeRoot(snapshotId, root.source.id)
    );
    return projectPageLikeMarkdown(
      snapshotId,
      archivePaths.agentPage(snapshotId, page.id),
      page,
      roots.length === 1 ? canonicalPaths[0] : archivePaths.irDocument(snapshotId),
      canonicalPaths,
      roots.map((root) => root.normalizedTree),
      roots.flatMap((root) => root.dependencyRefs),
      roots.flatMap((root) => root.reactions),
      roots.flatMap((root) => root.assets),
      roots.flatMap((root) => root.previews),
      roots.flatMap((root) => root.diagnosticIds),
      componentSummaryIds
    );
  }
  function variableBlock(variable) {
    return `## ${sourceLabel(variable.source)}

- Source ID: ${sourceIdentity(variable.source)}
- Type: ${escapeMarkdown(variable.resolvedType)}
- Collection ID: ${escapeMarkdown(variable.collectionId)}
- Description: ${escapeMarkdown(boundedText(variable.description ?? "none"))}
- Scopes: ${variable.scopes.map((scope) => escapeMarkdown(scope)).join(", ") || "none"}
- Code syntax: ${displayValue(variable.codeSyntax)}
- Diagnostic IDs: ${variable.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ") || "none"}

${markdownList(
      variable.values.map(
        (value) => `Mode ${escapeMarkdown(value.modeId)} \u2014 raw: ${displayValue(value.raw)}; resolution: ${escapeMarkdown(value.status)}${value.resolved === void 0 ? "" : `; resolved: ${displayValue(value.resolved)}`}; alias chain: ${value.aliasChain.map((item) => escapeMarkdown(item)).join(" \u2192 ") || "none"}; resolution context: ${displayValue(value.resolutionContext)}`
      ),
      "No mode values recorded."
    ).join("\n")}`;
  }
  function styleBlock(style, fromPath) {
    const details = style.styleType === "paint" ? `Paint records: ${String(style.paints.length)}; first ${String(MAX_TREE_FACT_SAMPLES)}: ${displayValue(style.paints.slice(0, MAX_TREE_FACT_SAMPLES))}
- Raster asset links: ${assetLinks(fromPath, style.assetRefs).join(", ") || "none"}` : style.styleType === "text" ? `Text properties: ${displayValue(style.properties)}` : style.styleType === "effect" ? `Effect records: ${String(style.effects.length)}; first ${String(MAX_TREE_FACT_SAMPLES)}: ${displayValue(style.effects.slice(0, MAX_TREE_FACT_SAMPLES))}` : style.styleType === "grid" ? `Grid records: ${String(style.grids.length)}; first ${String(MAX_TREE_FACT_SAMPLES)}: ${displayValue(style.grids.slice(0, MAX_TREE_FACT_SAMPLES))}` : `Unknown style record: ${displayValue(style.raw)}`;
    return `## ${sourceLabel(style.source)}

- Source ID: ${sourceIdentity(style.source)}
- Type: ${escapeMarkdown(style.styleType)}
- Description: ${escapeMarkdown(boundedText(style.description ?? "none"))}
- ${details}
- Variable bindings: ${style.variableBindings.map((binding) => `${escapeMarkdown(binding.propertyPath)} \u2192 ${sourceIdentity(binding.variable)}`).join(", ") || "none"}
- Referenced by: ${style.referencedBy.map(sourceIdentity).join(", ") || "none"}
- Diagnostic IDs: ${style.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ") || "none"}`;
  }
  function collectionCountLabel(count) {
    if (count.status === "not-collected") {
      return `not collected (${escapeMarkdown(boundedText(count.reason, 512))})`;
    }
    const coverage2 = count.coverage === void 0 ? "" : `, ${count.coverage}`;
    return `${String(count.value)} (${count.status}${escapeMarkdown(coverage2)})`;
  }
  function projectGlobalMarkdown(snapshotId, document, variables, styles, components, pageSummaryPaths, diagnosticSummary) {
    const indexPath = archivePaths.agentIndex(snapshotId);
    const tokenPath = archivePaths.agentTokens(snapshotId);
    const stylesPath = archivePaths.agentStyles(snapshotId);
    const componentIndexPath = archivePaths.agentComponentIndex(snapshotId);
    const pageIndexPath = archivePaths.agentPageIndex(snapshotId);
    const availablePageSummaries = pageSummaryPaths.filter(
      (path) => path !== void 0
    ).length;
    const availableComponentSummaries = components.definitions.filter(
      (definition) => definition.definitionArtifact !== void 0
    ).length;
    const indexBlocks = [
      "# Figma Design IR\n\nThis archive is local-only. Markdown is a bounded navigation layer; canonical JSON always wins for exact values.",
      `## Snapshot identity and completeness

- Snapshot ID: ${escapeMarkdown(snapshotId)}
- Source document ID: ${sourceIdentity(document.source)}
- Completeness: ${escapeMarkdown(diagnosticSummary.completeness)}
- Diagnostics: info ${String(diagnosticSummary.counts.info)}, warning ${String(diagnosticSummary.counts.warning)}, error ${String(diagnosticSummary.counts.error)}, fatal ${String(diagnosticSummary.counts.fatal)}`,
      `## Reading strategy

1. Read ${link(indexPath, archivePaths.manifest(snapshotId), "manifest.json")} for scope, archive paths, integrity, and final completeness.
2. Read ${link(indexPath, archivePaths.diagnostics(snapshotId), "diagnostics.json")} before relying on unavailable or partial data.
3. Return here and choose the token/style, component, or page index below.
4. Open the targeted summary needed for the task.
5. Follow that summary's canonical JSON link for exact values, complete trees, raw REST-like evidence, and coverage.
6. Follow asset and preview links only when visual evidence is needed; do not infer semantics from appearance.`,
      `## Archive overview and indexes

- ${link(indexPath, tokenPath, `Tokens and variables (${String(variables.variables.length)})`)}
- ${link(indexPath, stylesPath, `Styles (${String(styles.styles.length)})`)}
- ${link(indexPath, componentIndexPath, `Components (${String(components.definitions.length)} indexed; ${String(availableComponentSummaries)} linked summaries)`)}
- ${link(indexPath, pageIndexPath, `Pages (${String(document.pages.length)} indexed; ${String(availablePageSummaries)} summaries)`)}
- ${link(indexPath, archivePaths.irDocument(snapshotId), "Canonical document index")}
- Selected roots recorded: ${String(document.selectedRootIds.length)}
- Canonical node artifacts recorded: ${String(document.artifacts.nodeArtifacts.length)}
- Local variables: ${collectionCountLabel(document.counts.localVariables)}
- Local styles: ${collectionCountLabel(document.counts.localStyles)}
- Local components: ${collectionCountLabel(document.counts.localComponents)}`,
      `## Scope, limitations, and diagnostics

- Capabilities: ${document.capabilities.map((capability) => escapeMarkdown(capability)).join(", ") || "none"}
- Limitations: ${document.limitations.map((limitation) => escapeMarkdown(boundedText(limitation, 512))).join("; ") || "none"}
- ${link(indexPath, archivePaths.diagnostics(snapshotId), "Open the complete diagnostic list")}`
    ];
    const componentBlocks = [
      "# Component index\n\nEach component summary links back to canonical component data. No component intent is inferred.",
      ...components.definitions.map(
        (definition) => `- ${definition.definitionArtifact === void 0 ? sourceLabel(definition.source) : link(componentIndexPath, componentSummaryPath(snapshotId, definition.source.id), definition.source.name ?? definition.source.id)} \u2014 ${escapeMarkdown(definition.componentKind)}; canonical: ${link(componentIndexPath, archivePaths.irComponents(snapshotId), "index")}`
      ),
      `## Exact canonical recovery

- ${link(componentIndexPath, archivePaths.irComponents(snapshotId), "ir/components.json")}
- Component-index diagnostics: ${components.diagnosticIds.length === 0 ? "none" : components.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ")}`
    ];
    const pageBlocks = [
      "# Page index\n\nPage summaries are bounded projections. Follow their canonical links for full node trees and exact dimensions.",
      ...document.pages.map((page, index) => {
        const summaryPath = pageSummaryPaths[index];
        return summaryPath === void 0 ? `- ${sourceLabel(page)} \u2014 source ID ${sourceIdentity(page)}; canonical page summary unavailable, see ${link(pageIndexPath, archivePaths.diagnostics(snapshotId), "diagnostics")}.` : `- ${link(pageIndexPath, summaryPath, page.name ?? page.id)} \u2014 source ID ${sourceIdentity(page)}`;
      }),
      `## Exact canonical recovery

- ${link(pageIndexPath, archivePaths.irDocument(snapshotId), "ir/document.json")}
- ${link(pageIndexPath, archivePaths.diagnostics(snapshotId), "diagnostics.json")}`
    ];
    const variableBlocks = [
      "# Tokens and variables\n\nThis index is a projection of canonical variables. Raw aliases and values are shown for navigation only; use canonical JSON for exact recovery.",
      `## Collections

${markdownList(variables.collections.map((collection) => `${sourceLabel(collection.source)} \u2014 modes: ${collection.modes.map((mode) => `${escapeMarkdown(mode.name)} (${escapeMarkdown(mode.id)})`).join(", ")}; default: ${escapeMarkdown(collection.defaultModeId)}`)).join("\n")}`,
      ...variables.variables.map(variableBlock),
      `## Exact canonical recovery

- ${link(tokenPath, archivePaths.irVariables(snapshotId), "ir/variables.json")}
- Variable-index diagnostics: ${variables.diagnosticIds.length === 0 ? "none" : variables.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ")}`
    ];
    return [
      ...splitMarkdownArtifact(indexPath, "Figma Design IR", indexBlocks),
      ...splitMarkdownArtifact(tokenPath, "Tokens and variables", variableBlocks),
      ...splitMarkdownArtifact(stylesPath, "Styles", [
        "# Styles\n\nStyles are projected from canonical IR; do not infer semantic roles.",
        ...styles.styles.map((style) => styleBlock(style, stylesPath)),
        `## Exact canonical recovery

- ${link(stylesPath, archivePaths.irStyles(snapshotId), "ir/styles.json")}
- Style-index diagnostics: ${styles.diagnosticIds.length === 0 ? "none" : styles.diagnosticIds.map((id) => escapeMarkdown(id)).join(", ")}`
      ]),
      ...splitMarkdownArtifact(
        componentIndexPath,
        "Component index",
        componentBlocks
      ),
      ...splitMarkdownArtifact(pageIndexPath, "Page index", pageBlocks)
    ];
  }

  // src/shared/normalization.ts
  function formatObjectKey(key) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
  function formatPropertyPath(segments) {
    return segments.reduce(
      (path, segment) => typeof segment === "number" ? `${path}[${segment}]` : `${path}${formatObjectKey(segment)}`,
      "$"
    );
  }
  function runtimeType(value) {
    if (value === null) {
      return "null";
    }
    try {
      if (Array.isArray(value)) {
        return "array";
      }
    } catch {
      return "uninspectable-object";
    }
    return typeof value;
  }
  function unsupportedValue(reason, value) {
    return {
      $type: "unsupported",
      reason,
      runtimeType: runtimeType(value)
    };
  }
  function inaccessibleProperty() {
    return {
      $type: "unavailable",
      reason: "property-access-failed"
    };
  }
  function isArrayIndexKey3(key, length) {
    const index = Number(key);
    return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
  }
  function normalizeJsonSafeValue(input, options) {
    const diagnostics = options.diagnostics;
    const diagnosticStart = diagnostics.size();
    const activeObjects = /* @__PURE__ */ new WeakMap();
    const phase = options.phase ?? "normalization";
    const addDiagnostic = (draft) => {
      diagnostics.add({
        ...draft,
        phase,
        ...options.source === void 0 ? {} : { source: options.source }
      });
    };
    const normalize = (value, path) => {
      if (options.classifySpecialValue !== void 0) {
        try {
          const specialValue = options.classifySpecialValue(value, path);
          if (specialValue !== void 0) {
            return specialValue;
          }
        } catch (error) {
          addDiagnostic({
            code: DIAGNOSTIC_CODES.normalizationSpecialClassifierFailed,
            severity: "error",
            message: "A special Figma-like value could not be classified safely and was preserved as an unsupported tagged value.",
            propertyPath: formatPropertyPath(path),
            causedDataLoss: true,
            technicalCause: normalizeSafeTechnicalCause(error, "normalization")
          });
          return unsupportedValue("unknown", value);
        }
      }
      if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value;
      }
      if (typeof value === "number") {
        if (Number.isFinite(value)) {
          return value;
        }
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationNonFiniteNumber,
          severity: "warning",
          message: "A non-finite numeric value was replaced with null for canonical JSON.",
          propertyPath: formatPropertyPath(path),
          causedDataLoss: true
        });
        return null;
      }
      if (typeof value === "undefined") {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
          severity: "warning",
          message: "An undefined value was preserved as an explicit unsupported tagged value.",
          propertyPath: formatPropertyPath(path),
          causedDataLoss: true
        });
        return unsupportedValue("undefined", value);
      }
      if (typeof value === "bigint") {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
          severity: "warning",
          message: "A bigint value was preserved as an explicit unsupported tagged value.",
          propertyPath: formatPropertyPath(path),
          causedDataLoss: true
        });
        return unsupportedValue("bigint", value);
      }
      if (typeof value === "symbol") {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
          severity: "warning",
          message: "A symbol value was preserved as an explicit unsupported tagged value.",
          propertyPath: formatPropertyPath(path),
          causedDataLoss: true
        });
        return unsupportedValue("symbol", value);
      }
      if (typeof value === "function") {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
          severity: "warning",
          message: "A function value was preserved as an explicit unsupported tagged value.",
          propertyPath: formatPropertyPath(path),
          causedDataLoss: true
        });
        return unsupportedValue("function", value);
      }
      if (typeof value !== "object") {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
          severity: "warning",
          message: "An unknown runtime value was preserved as an explicit unsupported tagged value.",
          propertyPath: formatPropertyPath(path),
          causedDataLoss: true
        });
        return unsupportedValue("unknown", value);
      }
      const objectValue2 = value;
      const currentPath = formatPropertyPath(path);
      const firstSeenAt = activeObjects.get(objectValue2);
      if (firstSeenAt !== void 0) {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationCycle,
          severity: "error",
          message: `A cyclic runtime value referencing ${firstSeenAt} was preserved as an explicit unsupported tagged value.`,
          propertyPath: currentPath,
          causedDataLoss: true
        });
        return unsupportedValue("cyclic-reference", value);
      }
      activeObjects.set(objectValue2, currentPath);
      try {
        let arrayValue;
        try {
          arrayValue = Array.isArray(objectValue2);
        } catch (error) {
          addDiagnostic({
            code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
            severity: "error",
            message: "The runtime value kind could not be inspected and was preserved as an unsupported tagged value.",
            propertyPath: currentPath,
            causedDataLoss: true,
            technicalCause: normalizeSafeTechnicalCause(error, "property-access")
          });
          return unsupportedValue("unknown", value);
        }
        if (arrayValue) {
          const runtimeArray = objectValue2;
          let length;
          let ownStringKeys;
          let ownSymbolKeys;
          try {
            length = runtimeArray.length;
            ownStringKeys = Object.keys(objectValue2);
            ownSymbolKeys = Object.getOwnPropertySymbols(objectValue2);
          } catch (error) {
            addDiagnostic({
              code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
              severity: "error",
              message: "The runtime array structure could not be inspected and was preserved as an unsupported tagged value.",
              propertyPath: currentPath,
              causedDataLoss: true,
              technicalCause: normalizeSafeTechnicalCause(
                error,
                "property-access"
              )
            });
            return unsupportedValue("unknown", value);
          }
          if (ownSymbolKeys.length > 0 || ownStringKeys.some((key) => !isArrayIndexKey3(key, length))) {
            addDiagnostic({
              code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
              severity: "warning",
              message: "An array with non-index properties was preserved as an explicit unsupported tagged value.",
              propertyPath: currentPath,
              causedDataLoss: true
            });
            return unsupportedValue(
              ownSymbolKeys.length > 0 ? "symbol-keyed-property" : "array-extra-property",
              value
            );
          }
          const normalizedArray = [];
          for (let index = 0; index < length; index += 1) {
            const childPath = [...path, index];
            try {
              normalizedArray.push(normalize(runtimeArray[index], childPath));
            } catch (error) {
              addDiagnostic({
                code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
                severity: "error",
                message: "A runtime array item could not be read and was preserved as an unavailable tagged value.",
                propertyPath: formatPropertyPath(childPath),
                causedDataLoss: true,
                technicalCause: normalizeSafeTechnicalCause(
                  error,
                  "property-access"
                )
              });
              normalizedArray.push(inaccessibleProperty());
            }
          }
          return normalizedArray;
        }
        let prototype;
        try {
          prototype = Object.getPrototypeOf(objectValue2);
        } catch (error) {
          addDiagnostic({
            code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
            severity: "error",
            message: "The runtime value prototype could not be inspected and was preserved as an unsupported tagged value.",
            propertyPath: currentPath,
            causedDataLoss: true,
            technicalCause: normalizeSafeTechnicalCause(error, "property-access")
          });
          return unsupportedValue("non-plain-object", value);
        }
        if (prototype !== Object.prototype && prototype !== null) {
          addDiagnostic({
            code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
            severity: "warning",
            message: "A non-plain runtime object was preserved as an explicit unsupported tagged value.",
            propertyPath: currentPath,
            causedDataLoss: true
          });
          return unsupportedValue("non-plain-object", value);
        }
        let keys;
        let symbolKeys;
        try {
          keys = Object.keys(objectValue2).sort();
          symbolKeys = Object.getOwnPropertySymbols(objectValue2);
        } catch (error) {
          addDiagnostic({
            code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
            severity: "error",
            message: "The runtime object keys could not be read and were preserved as an unsupported tagged value.",
            propertyPath: currentPath,
            causedDataLoss: true,
            technicalCause: normalizeSafeTechnicalCause(error, "property-access")
          });
          return unsupportedValue("unknown", value);
        }
        if (symbolKeys.length > 0) {
          addDiagnostic({
            code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
            severity: "warning",
            message: "An object with symbol-keyed properties was preserved as an explicit unsupported tagged value.",
            propertyPath: currentPath,
            causedDataLoss: true
          });
          return unsupportedValue("symbol-keyed-property", value);
        }
        const normalizedObject = /* @__PURE__ */ Object.create(null);
        for (const key of keys) {
          const childPath = [...path, key];
          try {
            normalizedObject[key] = normalize(
              objectValue2[key],
              childPath
            );
          } catch (error) {
            addDiagnostic({
              code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
              severity: "error",
              message: "A runtime object property could not be read and was preserved as an unavailable tagged value.",
              propertyPath: formatPropertyPath(childPath),
              causedDataLoss: true,
              technicalCause: normalizeSafeTechnicalCause(
                error,
                "property-access"
              )
            });
            normalizedObject[key] = inaccessibleProperty();
          }
        }
        return normalizedObject;
      } finally {
        activeObjects.delete(objectValue2);
      }
    };
    return {
      value: normalize(input, options.propertyPath ?? []),
      diagnostics: diagnostics.listSince(diagnosticStart)
    };
  }

  // node_modules/fflate/esm/browser.js
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i32 = Int32Array;
  var fleb = new u8([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fdeb = new u8([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start) {
    var b = new u16(31);
    for (var i2 = 0; i2 < 31; ++i2) {
      b[i2] = start += 1 << eb[i2 - 1];
    }
    var r = new i32(b[30]);
    for (var i2 = 1; i2 < 30; ++i2) {
      for (var j = b[i2]; j < b[i2 + 1]; ++j) {
        r[j] = j - b[i2] << 5 | i2;
      }
    }
    return { b, r };
  };
  var _a = freb(fleb, 2);
  var fl = _a.b;
  var revfl = _a.r;
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b.b;
  var revfd = _b.r;
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  var x;
  var i;
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    return new u8(v.subarray(s, e));
  };
  var et = /* @__PURE__ */ new u8(0);
  var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }
  function strToU8(str, latin1) {
    if (latin1) {
      var ar_1 = new u8(str.length);
      for (var i2 = 0; i2 < str.length; ++i2)
        ar_1[i2] = str.charCodeAt(i2);
      return ar_1;
    }
    if (te)
      return te.encode(str);
    var l = str.length;
    var ar = new u8(str.length + (str.length >> 1));
    var ai = 0;
    var w = function(v) {
      ar[ai++] = v;
    };
    for (var i2 = 0; i2 < l; ++i2) {
      if (ai + 5 > ar.length) {
        var n = new u8(ai + 8 + (l - i2 << 1));
        n.set(ar);
        ar = n;
      }
      var c = str.charCodeAt(i2);
      if (c < 128 || latin1)
        w(c);
      else if (c < 2048)
        w(192 | c >> 6), w(128 | c & 63);
      else if (c > 55295 && c < 57344)
        c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i2) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
      else
        w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
    }
    return slc(ar, 0, ai);
  }

  // src/shared/sha256.ts
  var BLOCK_BYTE_LENGTH = 64;
  var LENGTH_FIELD_BYTE_LENGTH = 8;
  var INITIAL_HASH = [
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ];
  var ROUND_CONSTANTS = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  function rotateRight(value, count) {
    return value >>> count | value << 32 - count;
  }
  function processBlock(bytes, offset, hash, schedule) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      schedule[index] = (bytes[byteOffset] << 24 | bytes[byteOffset + 1] << 16 | bytes[byteOffset + 2] << 8 | bytes[byteOffset + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = schedule[index - 15];
      const word2 = schedule[index - 2];
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ word15 >>> 3;
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ word2 >>> 10;
      schedule[index] = schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1 >>> 0;
    }
    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = e & f ^ ~e & g;
      const temporary1 = h + upperSigma1 + choose + ROUND_CONSTANTS[index] + schedule[index] >>> 0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const temporary2 = upperSigma0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + temporary1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temporary1 + temporary2 >>> 0;
    }
    hash[0] = hash[0] + a >>> 0;
    hash[1] = hash[1] + b >>> 0;
    hash[2] = hash[2] + c >>> 0;
    hash[3] = hash[3] + d >>> 0;
    hash[4] = hash[4] + e >>> 0;
    hash[5] = hash[5] + f >>> 0;
    hash[6] = hash[6] + g >>> 0;
    hash[7] = hash[7] + h >>> 0;
  }
  function sha256Hex(bytes) {
    const hash = Uint32Array.from(INITIAL_HASH);
    const schedule = new Uint32Array(64);
    const completeByteLength = bytes.byteLength - bytes.byteLength % BLOCK_BYTE_LENGTH;
    for (let offset = 0; offset < completeByteLength; offset += BLOCK_BYTE_LENGTH) {
      processBlock(bytes, offset, hash, schedule);
    }
    const remainingByteLength = bytes.byteLength - completeByteLength;
    const paddedByteLength = remainingByteLength + 1 + LENGTH_FIELD_BYTE_LENGTH <= BLOCK_BYTE_LENGTH ? BLOCK_BYTE_LENGTH : BLOCK_BYTE_LENGTH * 2;
    const padded = new Uint8Array(paddedByteLength);
    padded.set(bytes.subarray(completeByteLength));
    padded[remainingByteLength] = 128;
    const bitLength = BigInt.asUintN(64, BigInt(bytes.byteLength) << 3n);
    for (let index = 0; index < LENGTH_FIELD_BYTE_LENGTH; index += 1) {
      padded[paddedByteLength - 1 - index] = Number(
        bitLength >> BigInt(index * 8) & 0xffn
      );
    }
    for (let offset = 0; offset < padded.byteLength; offset += BLOCK_BYTE_LENGTH) {
      processBlock(padded, offset, hash, schedule);
    }
    return [...hash].map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  // src/main/collect-assets.ts
  var VECTOR_PRIMITIVE_NODE_TYPES = /* @__PURE__ */ new Set([
    "BOOLEAN_OPERATION",
    "ELLIPSE",
    "LINE",
    "POLYGON",
    "RECTANGLE",
    "STAR",
    "VECTOR"
  ]);
  function hasPrefix(bytes, signature) {
    return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  }
  function findSvgTagEnd(source, start) {
    let quote;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote !== void 0) {
        if (character === quote) {
          quote = void 0;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "<") {
        return -1;
      }
      if (character === ">") {
        return index;
      }
    }
    return -1;
  }
  function svgTagName(body) {
    return /^[:A-Z_a-z][:A-Z_a-z.\-0-9]*/.exec(body)?.[0];
  }
  function isStructurallyValidSvg(source) {
    if (source.length === 0) {
      return false;
    }
    const elements = [];
    let rootSeen = false;
    let rootClosed = false;
    let index = 0;
    while (index < source.length) {
      if (source[index] !== "<") {
        const next = source.indexOf("<", index);
        const end2 = next < 0 ? source.length : next;
        const text = source.slice(index, end2);
        if (elements.length === 0 && text.trim().length > 0) {
          return false;
        }
        index = end2;
        continue;
      }
      if (source.startsWith("<!--", index)) {
        const end2 = source.indexOf("-->", index + 4);
        if (end2 < 0 || source.slice(index + 4, end2).includes("--")) {
          return false;
        }
        index = end2 + 3;
        continue;
      }
      if (source.startsWith("<![CDATA[", index)) {
        if (elements.length === 0) {
          return false;
        }
        const end2 = source.indexOf("]]>", index + 9);
        if (end2 < 0) {
          return false;
        }
        index = end2 + 3;
        continue;
      }
      if (source.startsWith("<?", index)) {
        const end2 = source.indexOf("?>", index + 2);
        if (end2 < 0) {
          return false;
        }
        index = end2 + 2;
        continue;
      }
      if (source.startsWith("<!", index)) {
        return false;
      }
      const end = findSvgTagEnd(source, index + 1);
      if (end < 0) {
        return false;
      }
      let body = source.slice(index + 1, end).trim();
      if (body.startsWith("/")) {
        body = body.slice(1).trim();
        const closing = svgTagName(body);
        if (closing === void 0 || body.slice(closing.length).trim().length > 0 || elements.pop() !== closing) {
          return false;
        }
        if (elements.length === 0) {
          rootClosed = true;
        }
        index = end + 1;
        continue;
      }
      let selfClosing = false;
      if (body.endsWith("/")) {
        selfClosing = true;
        body = body.slice(0, -1).trimEnd();
      }
      const opening = svgTagName(body);
      if (opening === void 0 || body.length > opening.length && !/\s/.test(body[opening.length]) || elements.length === 0 && (rootSeen || rootClosed)) {
        return false;
      }
      if (elements.length === 0) {
        if (opening !== "svg") {
          return false;
        }
        rootSeen = true;
      }
      if (selfClosing) {
        if (elements.length === 0) {
          rootClosed = true;
        }
      } else {
        elements.push(opening);
      }
      index = end + 1;
    }
    return rootSeen && rootClosed && elements.length === 0;
  }
  function detectRasterFormat(bytes) {
    if (hasPrefix(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) {
      return { extension: "png", mediaType: "image/png", known: true };
    }
    if (hasPrefix(bytes, [255, 216, 255])) {
      return { extension: "jpg", mediaType: "image/jpeg", known: true };
    }
    if (hasPrefix(bytes, [71, 73, 70, 56, 55, 97]) || hasPrefix(bytes, [71, 73, 70, 56, 57, 97])) {
      return { extension: "gif", mediaType: "image/gif", known: true };
    }
    if (bytes.length >= 12 && hasPrefix(bytes, [82, 73, 70, 70]) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) {
      return { extension: "webp", mediaType: "image/webp", known: true };
    }
    return {
      extension: "bin",
      mediaType: "application/octet-stream",
      known: false
    };
  }
  function explicitSvgSettings(setting) {
    const supportedColorProfile = setting.colorProfile === "DOCUMENT" || setting.colorProfile === "SRGB" || setting.colorProfile === "DISPLAY_P3_V4" ? setting.colorProfile : void 0;
    return {
      format: "SVG_STRING",
      ...setting.suffix === void 0 ? {} : { suffix: setting.suffix },
      ...setting.contentsOnly === void 0 ? {} : { contentsOnly: setting.contentsOnly },
      ...setting.useAbsoluteBounds === void 0 ? {} : { useAbsoluteBounds: setting.useAbsoluteBounds },
      ...supportedColorProfile === void 0 ? {} : { colorProfile: supportedColorProfile },
      ...setting.svgOutlineText === void 0 ? {} : { svgOutlineText: setting.svgOutlineText },
      ...setting.svgIdAttribute === void 0 ? {} : { svgIdAttribute: setting.svgIdAttribute },
      ...setting.svgSimplifyStroke === void 0 ? {} : { svgSimplifyStroke: setting.svgSimplifyStroke }
    };
  }
  function selectVectorAssetCandidates(tree) {
    const candidates = [];
    const work = [{ node: tree, hasExportedAncestor: false }];
    while (work.length > 0) {
      const item = work.pop();
      if (item === void 0) {
        continue;
      }
      const explicitSetting = item.node.exportSettings?.find(
        (setting) => setting.format === "SVG"
      );
      const automatic = explicitSetting === void 0 && VECTOR_PRIMITIVE_NODE_TYPES.has(item.node.nodeType) && !item.hasExportedAncestor;
      const eligible = explicitSetting !== void 0 || automatic;
      if (eligible) {
        candidates.push({
          nodeId: item.node.source.id,
          eligibility: explicitSetting === void 0 ? "top-level-vector-root" : "explicit-svg-setting",
          exportSettings: explicitSetting === void 0 ? { format: "SVG_STRING" } : explicitSvgSettings(explicitSetting)
        });
      }
      if ("children" in item.node) {
        for (let index = item.node.children.length - 1; index >= 0; index -= 1) {
          const child = item.node.children[index];
          if (child !== void 0) {
            work.push({
              node: child,
              hasExportedAncestor: item.hasExportedAncestor || eligible
            });
          }
        }
      }
    }
    return candidates;
  }
  function appendPaintSites(sites, paints, propertyPath) {
    if (paints === void 0) {
      return;
    }
    for (const [index, paint] of paints.entries()) {
      if (paint.paintType !== "IMAGE") {
        continue;
      }
      sites.push({
        imageHash: typeof paint.imageHash === "string" && paint.imageHash.length > 0 ? paint.imageHash : null,
        propertyPath: `${propertyPath}[${index}].imageHash`
      });
    }
  }
  function paintsOrUndefined(value) {
    return Array.isArray(value) ? value : void 0;
  }
  function rasterSitesForNode(node) {
    const sites = [];
    appendPaintSites(
      sites,
      paintsOrUndefined(node.visual?.fills),
      "$.visual.fills"
    );
    appendPaintSites(
      sites,
      paintsOrUndefined(node.visual?.strokes),
      "$.visual.strokes"
    );
    appendPaintSites(
      sites,
      paintsOrUndefined(node.visual?.backgrounds),
      "$.visual.backgrounds"
    );
    if (node.family === "text") {
      for (const [segmentIndex, segment] of node.text.segments.entries()) {
        appendPaintSites(
          sites,
          paintsOrUndefined(segment.fills),
          `$.text.segments[${segmentIndex}].fills`
        );
      }
    }
    const seen = /* @__PURE__ */ new Set();
    return sites.filter((site) => {
      const key = site.imageHash ?? "\0missing";
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  function rasterSitesForStyle(style) {
    const sites = [];
    appendPaintSites(sites, style.paints, "$.paints");
    const seen = /* @__PURE__ */ new Set();
    return sites.filter((site) => {
      const key = site.imageHash ?? "\0missing";
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
  function assetIdentity(asset) {
    return asset.assetKind === "raster" ? `raster\0${asset.imageHash}` : `vector\0${asset.node.id}`;
  }
  function deduplicateAssets(assets) {
    const byIdentity = /* @__PURE__ */ new Map();
    for (const asset of assets) {
      byIdentity.set(assetIdentity(asset), asset);
    }
    return [...byIdentity.values()].sort((left, right) => {
      const leftKey = `${left.assetKind}\0${left.source.id}\0${left.archivePath}`;
      const rightKey = `${right.assetKind}\0${right.source.id}\0${right.archivePath}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }
  async function cloneTreeWithAssets(tree, refsByNodeId, diagnosticIdsByNodeId, cancellation) {
    const work = [
      { node: tree, exiting: false }
    ];
    const built = /* @__PURE__ */ new Map();
    let visited = 0;
    while (work.length > 0) {
      cancellation.throwIfCancelled();
      const item = work.pop();
      if (item === void 0) {
        continue;
      }
      if (!item.exiting) {
        work.push({ node: item.node, exiting: true });
        if ("children" in item.node) {
          for (let index = item.node.children.length - 1; index >= 0; index -= 1) {
            const child = item.node.children[index];
            if (child !== void 0) {
              work.push({ node: child, exiting: false });
            }
          }
        }
        continue;
      }
      const assetRefs = deduplicateAssets([
        ...item.node.assetRefs,
        ...refsByNodeId.get(item.node.source.id) ?? []
      ]);
      const diagnosticIds = [
        .../* @__PURE__ */ new Set([
          ...item.node.diagnosticIds,
          ...diagnosticIdsByNodeId.get(item.node.source.id) ?? []
        ])
      ];
      if ("children" in item.node) {
        const children2 = item.node.children.map((child) => {
          const builtChild = built.get(child);
          if (builtChild === void 0) {
            throw new Error("Asset enrichment lost a collected child node.");
          }
          return builtChild;
        });
        built.set(item.node, {
          ...item.node,
          assetRefs,
          diagnosticIds,
          children: children2
        });
      } else {
        built.set(item.node, {
          ...item.node,
          assetRefs,
          diagnosticIds
        });
      }
      visited += 1;
      if (visited % 50 === 0) {
        await yieldToFigma();
        cancellation.throwIfCancelled();
      }
    }
    const enriched = built.get(tree);
    if (enriched === void 0) {
      throw new Error("Asset enrichment did not produce a root node.");
    }
    return enriched;
  }
  function defaultApi() {
    const runtimeApi = figma;
    return runtimeApi;
  }
  var AssetCollectionSession = class {
    #snapshotId;
    #diagnostics;
    #cancellation;
    #emitter;
    #api;
    #entryByteLimit;
    #rasterByImageHash = /* @__PURE__ */ new Map();
    #contentAssets = /* @__PURE__ */ new Map();
    #vectorByNodeId = /* @__PURE__ */ new Map();
    #unavailablePaths = /* @__PURE__ */ new Set();
    constructor(options) {
      this.#snapshotId = options.snapshotId;
      this.#diagnostics = options.diagnostics;
      this.#cancellation = options.cancellation;
      this.#emitter = options.emitter;
      this.#api = options.api ?? defaultApi();
      this.#entryByteLimit = options.entryByteLimit;
    }
    stats() {
      return {
        imageHashes: this.#rasterByImageHash.size,
        rasterContents: this.#contentAssets.size,
        vectorNodes: this.#vectorByNodeId.size
      };
    }
    #missingHashDiagnostic(source, propertyPath) {
      return this.#diagnostics.add({
        code: DIAGNOSTIC_CODES.rasterImageHashMissing,
        severity: "error",
        message: "A reachable image fill has no usable image hash, so its original bytes are unavailable.",
        phase: "asset",
        source,
        propertyPath,
        causedDataLoss: true
      }).id;
    }
    #markUnavailable(path, diagnosticId) {
      if (this.#unavailablePaths.has(path)) {
        return;
      }
      this.#unavailablePaths.add(path);
      this.#emitter.unavailable(path, diagnosticId);
    }
    #unavailableRasterDiagnostic(resolution, source, propertyPath) {
      return this.#diagnostics.add({
        code: resolution.code,
        severity: "error",
        message: resolution.message,
        phase: "asset",
        source,
        propertyPath,
        ...resolution.artifactPath === void 0 ? {} : { artifactPath: resolution.artifactPath },
        causedDataLoss: true,
        ...resolution.technicalCause === void 0 ? {} : { technicalCause: resolution.technicalCause }
      }).id;
    }
    async #resolveRaster(imageHash, source, propertyPath) {
      const cached = this.#rasterByImageHash.get(imageHash);
      if (cached !== void 0) {
        return cached.status === "available" ? { reference: cached.reference } : {
          diagnosticId: this.#unavailableRasterDiagnostic(
            cached,
            source,
            propertyPath
          )
        };
      }
      this.#cancellation.throwIfCancelled();
      let image;
      try {
        image = this.#api.getImageByHash(imageHash);
      } catch (error) {
        const resolution = {
          status: "unavailable",
          code: DIAGNOSTIC_CODES.rasterReadFailed,
          message: "A reachable raster image handle could not be read through the Plugin API.",
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        };
        this.#rasterByImageHash.set(imageHash, resolution);
        return {
          diagnosticId: this.#unavailableRasterDiagnostic(
            resolution,
            source,
            propertyPath
          )
        };
      }
      this.#cancellation.throwIfCancelled();
      if (image === null) {
        const resolution = {
          status: "unavailable",
          code: DIAGNOSTIC_CODES.rasterImageUnavailable,
          message: "A reachable raster image hash is not accessible through the Plugin API."
        };
        this.#rasterByImageHash.set(imageHash, resolution);
        return {
          diagnosticId: this.#unavailableRasterDiagnostic(
            resolution,
            source,
            propertyPath
          )
        };
      }
      let bytes;
      try {
        this.#cancellation.throwIfCancelled();
        bytes = await image.getBytesAsync();
        this.#cancellation.throwIfCancelled();
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError("Image bytes are not a Uint8Array.");
        }
      } catch (error) {
        if (error instanceof ExportCancelledError) {
          throw error;
        }
        this.#cancellation.throwIfCancelled();
        const resolution = {
          status: "unavailable",
          code: DIAGNOSTIC_CODES.rasterReadFailed,
          message: "Original raster bytes could not be read through the Plugin API.",
          technicalCause: normalizeSafeTechnicalCause(error, "unknown")
        };
        this.#rasterByImageHash.set(imageHash, resolution);
        return {
          diagnosticId: this.#unavailableRasterDiagnostic(
            resolution,
            source,
            propertyPath
          )
        };
      }
      try {
        await assertArchiveEntryFits(bytes, {
          byteLimit: this.#entryByteLimit,
          checkpoint: () => this.#cancellation.throwIfCancelled()
        });
      } catch (error) {
        if (error instanceof ArchiveProducerSafetyError && error.code === "archive-capacity-exceeded") {
          const resolution = {
            status: "unavailable",
            code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
            message: "Original raster bytes exceeded the safe single-entry archive limit and are absent."
          };
          this.#rasterByImageHash.set(imageHash, resolution);
          const diagnosticId = this.#unavailableRasterDiagnostic(
            resolution,
            source,
            propertyPath
          );
          return { diagnosticId };
        }
        throw error;
      }
      this.#cancellation.throwIfCancelled();
      const contentSha256 = sha256Hex(bytes);
      this.#cancellation.throwIfCancelled();
      const detected = detectRasterFormat(bytes);
      const archivePath2 = archivePaths.rasterAsset(
        this.#snapshotId,
        contentSha256,
        detected.extension
      );
      if (!detected.known) {
        this.#diagnostics.add({
          code: DIAGNOSTIC_CODES.rasterUnknownFormat,
          severity: "warning",
          message: "Raster magic bytes are not PNG, JPEG, GIF, or WebP; original bytes were preserved as .bin.",
          phase: "asset",
          source: { kind: "asset", id: imageHash },
          artifactPath: archivePath2,
          causedDataLoss: false
        });
      }
      const existingContent = this.#contentAssets.get(contentSha256);
      if (existingContent === void 0) {
        await this.#emitter.emit(archivePath2, detected.mediaType, "store", bytes);
        this.#cancellation.throwIfCancelled();
        this.#contentAssets.set(contentSha256, {
          imageHash,
          archivePath: archivePath2,
          mediaType: detected.mediaType
        });
      } else if (existingContent.imageHash !== imageHash) {
        this.#diagnostics.add({
          code: DIAGNOSTIC_CODES.rasterContentDeduplicated,
          severity: "info",
          message: "Distinct Figma image hashes resolved to identical original bytes and share one raster archive entry.",
          phase: "asset",
          source: { kind: "asset", id: imageHash },
          artifactPath: existingContent.archivePath,
          causedDataLoss: false
        });
      }
      const contentAsset = this.#contentAssets.get(contentSha256);
      const reference = {
        assetKind: "raster",
        source: { kind: "asset", id: imageHash },
        imageHash,
        contentSha256,
        mediaType: contentAsset.mediaType,
        byteLength: bytes.byteLength,
        archivePath: contentAsset.archivePath
      };
      this.#rasterByImageHash.set(imageHash, {
        status: "available",
        reference
      });
      await yieldToFigma();
      this.#cancellation.throwIfCancelled();
      return { reference };
    }
    #vectorFailure(node, path, error) {
      const diagnostic = this.#diagnostics.add({
        code: DIAGNOSTIC_CODES.vectorExportFailed,
        severity: "error",
        message: "An eligible standalone SVG asset could not be exported and is absent.",
        phase: "asset",
        source: node.source,
        artifactPath: path,
        causedDataLoss: true,
        ...error === void 0 ? {} : { technicalCause: normalizeSafeTechnicalCause(error, "unknown") }
      });
      this.#markUnavailable(path, diagnostic.id);
      const resolution = {
        status: "unavailable",
        diagnosticId: diagnostic.id
      };
      this.#vectorByNodeId.set(node.source.id, resolution);
      return resolution;
    }
    async #resolveVector(node, sceneNode, candidate) {
      const cached = this.#vectorByNodeId.get(node.source.id);
      if (cached !== void 0) {
        return cached;
      }
      const path = archivePaths.vectorAsset(this.#snapshotId, node.source.id);
      if (sceneNode === void 0) {
        return this.#vectorFailure(node, path);
      }
      let rawSvg;
      try {
        this.#cancellation.throwIfCancelled();
        rawSvg = await sceneNode.exportAsync(candidate.exportSettings);
        this.#cancellation.throwIfCancelled();
        if (typeof rawSvg !== "string" || rawSvg.length === 0) {
          throw new TypeError("SVG export did not return text.");
        }
      } catch (error) {
        if (error instanceof ExportCancelledError) {
          throw error;
        }
        this.#cancellation.throwIfCancelled();
        return this.#vectorFailure(node, path, error);
      }
      const svg = ensureOneFinalNewline(rawSvg);
      try {
        await assertArchiveEntryFits(svg, {
          byteLimit: this.#entryByteLimit,
          checkpoint: () => this.#cancellation.throwIfCancelled()
        });
      } catch (error) {
        if (error instanceof ArchiveProducerSafetyError && error.code === "archive-capacity-exceeded") {
          const diagnostic = this.#diagnostics.add({
            code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
            severity: "error",
            message: "An SVG asset exceeded the safe single-entry archive limit and is absent.",
            phase: "asset",
            source: node.source,
            artifactPath: path,
            causedDataLoss: true
          });
          this.#markUnavailable(path, diagnostic.id);
          const resolution2 = {
            status: "unavailable",
            diagnosticId: diagnostic.id
          };
          this.#vectorByNodeId.set(node.source.id, resolution2);
          return resolution2;
        }
        throw error;
      }
      this.#cancellation.throwIfCancelled();
      if (!isStructurallyValidSvg(svg)) {
        return this.#vectorFailure(
          node,
          path,
          new TypeError("SVG export returned malformed XML.")
        );
      }
      const bytes = strToU8(svg);
      this.#cancellation.throwIfCancelled();
      const reference = {
        assetKind: "vector",
        source: {
          kind: "asset",
          id: node.source.id,
          ...node.source.name === void 0 ? {} : { name: node.source.name }
        },
        node: node.source,
        archivePath: path,
        mediaType: "image/svg+xml",
        byteLength: bytes.byteLength,
        contentSha256: sha256Hex(bytes),
        eligibility: candidate.eligibility,
        exportSettings: candidate.exportSettings
      };
      this.#cancellation.throwIfCancelled();
      await this.#emitter.emit(path, "image/svg+xml", "deflate", svg);
      this.#cancellation.throwIfCancelled();
      const resolution = {
        status: "available",
        reference
      };
      this.#vectorByNodeId.set(node.source.id, resolution);
      await yieldToFigma();
      this.#cancellation.throwIfCancelled();
      return resolution;
    }
    async collectTree(tree, nodesById) {
      const diagnosticStart = this.#diagnostics.size();
      const refsByNodeId = /* @__PURE__ */ new Map();
      const diagnosticIdsByNodeId = /* @__PURE__ */ new Map();
      const candidateByNodeId = new Map(
        selectVectorAssetCandidates(tree).map((candidate) => [
          candidate.nodeId,
          candidate
        ])
      );
      const work = [tree];
      let visited = 0;
      let complete = true;
      while (work.length > 0) {
        this.#cancellation.throwIfCancelled();
        const node = work.pop();
        if (node === void 0) {
          continue;
        }
        const refs = refsByNodeId.get(node.source.id) ?? [];
        const nodeDiagnosticIds = diagnosticIdsByNodeId.get(node.source.id) ?? [];
        for (const site of rasterSitesForNode(node)) {
          if (site.imageHash === null) {
            complete = false;
            nodeDiagnosticIds.push(
              this.#missingHashDiagnostic(node.source, site.propertyPath)
            );
            continue;
          }
          const result = await this.#resolveRaster(
            site.imageHash,
            node.source,
            site.propertyPath
          );
          if ("reference" in result) {
            refs.push(result.reference);
          } else {
            complete = false;
            nodeDiagnosticIds.push(result.diagnosticId);
          }
        }
        const candidate = candidateByNodeId.get(node.source.id);
        if (candidate !== void 0) {
          const result = await this.#resolveVector(
            node,
            nodesById.get(node.source.id),
            candidate
          );
          if (result.status === "available") {
            refs.push(result.reference);
          } else {
            complete = false;
            nodeDiagnosticIds.push(result.diagnosticId);
          }
        }
        refsByNodeId.set(node.source.id, refs);
        diagnosticIdsByNodeId.set(node.source.id, nodeDiagnosticIds);
        if ("children" in node) {
          for (let index = node.children.length - 1; index >= 0; index -= 1) {
            const child = node.children[index];
            if (child !== void 0) {
              work.push(child);
            }
          }
        }
        visited += 1;
        if (visited % 25 === 0) {
          await yieldToFigma();
          this.#cancellation.throwIfCancelled();
        }
      }
      const enrichedTree = await cloneTreeWithAssets(
        tree,
        refsByNodeId,
        diagnosticIdsByNodeId,
        this.#cancellation
      );
      const assets = [];
      const assetWork = [enrichedTree];
      let assetScanCount = 0;
      while (assetWork.length > 0) {
        this.#cancellation.throwIfCancelled();
        const node = assetWork.pop();
        if (node === void 0) {
          continue;
        }
        assets.push(...node.assetRefs);
        if ("children" in node) {
          for (const child of node.children) {
            assetWork.push(child);
          }
        }
        assetScanCount += 1;
        if (assetScanCount % 50 === 0) {
          await yieldToFigma();
          this.#cancellation.throwIfCancelled();
        }
      }
      const diagnostics = this.#diagnostics.listSince(diagnosticStart);
      const diagnosticIds = [
        .../* @__PURE__ */ new Set([
          ...diagnostics.map((diagnostic) => diagnostic.id),
          ...[...diagnosticIdsByNodeId.values()].flat()
        ])
      ];
      return {
        tree: enrichedTree,
        assets: deduplicateAssets(assets),
        complete: complete && diagnostics.every((diagnostic) => !diagnostic.causedDataLoss),
        diagnosticIds
      };
    }
    async collectStyles(artifact) {
      const diagnosticStart = this.#diagnostics.size();
      const styles = [];
      for (const style of artifact.styles) {
        this.#cancellation.throwIfCancelled();
        if (style.styleType !== "paint") {
          styles.push(style);
          continue;
        }
        const styleDiagnosticStart = this.#diagnostics.size();
        const assetRefs = [];
        for (const site of rasterSitesForStyle(style)) {
          const diagnosticSources = [style.source, ...style.referencedBy];
          if (site.imageHash === null) {
            for (const source of diagnosticSources) {
              this.#missingHashDiagnostic(source, site.propertyPath);
            }
            continue;
          }
          const firstSource = diagnosticSources[0] ?? style.source;
          const result = await this.#resolveRaster(
            site.imageHash,
            firstSource,
            site.propertyPath
          );
          if ("reference" in result) {
            assetRefs.push(result.reference);
            continue;
          }
          for (const source of diagnosticSources.slice(1)) {
            await this.#resolveRaster(site.imageHash, source, site.propertyPath);
          }
        }
        styles.push({
          ...style,
          assetRefs: deduplicateAssets(assetRefs).filter(
            (asset) => asset.assetKind === "raster"
          ),
          diagnosticIds: [
            .../* @__PURE__ */ new Set([
              ...style.diagnosticIds,
              ...this.#diagnostics.listSince(styleDiagnosticStart).map((diagnostic) => diagnostic.id)
            ])
          ]
        });
        await yieldToFigma();
        this.#cancellation.throwIfCancelled();
      }
      const diagnostics = this.#diagnostics.listSince(diagnosticStart);
      return {
        artifact: {
          ...artifact,
          styles,
          diagnosticIds: [
            .../* @__PURE__ */ new Set([
              ...artifact.diagnosticIds,
              ...diagnostics.map((diagnostic) => diagnostic.id)
            ])
          ]
        },
        complete: diagnostics.every((diagnostic) => !diagnostic.causedDataLoss),
        diagnosticIds: diagnostics.map((diagnostic) => diagnostic.id)
      };
    }
  };

  // src/main/collect-components.ts
  var ComponentCollectionSession = class {
    #definitionsById = /* @__PURE__ */ new Map();
    #definitionsByKey = /* @__PURE__ */ new Map();
    definitionById(id) {
      return this.#definitionsById.get(id);
    }
    definitionByKey(key) {
      return this.#definitionsByKey.get(key);
    }
    rememberDefinitions(definitions) {
      for (const definition of definitions) {
        if (!this.#definitionsById.has(definition.source.id)) {
          this.#definitionsById.set(definition.source.id, definition);
        }
        const key = definition.source.key;
        if (key !== void 0 && !this.#definitionsByKey.has(key)) {
          this.#definitionsByKey.set(key, definition);
        }
      }
    }
  };
  function basicNodeSource(node) {
    let id = "unavailable-node";
    let name;
    try {
      if (typeof node.id === "string") {
        id = node.id;
      }
    } catch {
    }
    try {
      if (typeof node.name === "string") {
        name = node.name;
      }
    } catch {
    }
    return { kind: "node", id, ...name === void 0 ? {} : { name } };
  }
  function readProperty(node, property, diagnostics, state) {
    try {
      if (!Reflect.has(node, property)) {
        return { ok: true, present: false };
      }
      return {
        ok: true,
        present: true,
        value: Reflect.get(node, property)
      };
    } catch (error) {
      state.complete = false;
      diagnostics.add({
        code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
        severity: "warning",
        message: "Supported component metadata could not be read.",
        phase: "collection",
        source: basicNodeSource(node),
        propertyPath: `$.${property}`,
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return { ok: false, present: false };
    }
  }
  function invalidShapeDiagnostic(node, propertyPath, diagnostics, state) {
    state.complete = false;
    diagnostics.add({
      code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
      severity: "warning",
      message: "Supported component metadata had an unexpected runtime shape.",
      phase: "collection",
      source: basicNodeSource(node),
      propertyPath,
      causedDataLoss: true
    });
  }
  function nodeId(node) {
    try {
      return typeof node.id === "string" ? node.id : void 0;
    } catch {
      return void 0;
    }
  }
  function nodeType(node, diagnostics, state) {
    const result = readProperty(node, "type", diagnostics, state);
    return result.ok && typeof result.value === "string" ? result.value : void 0;
  }
  function componentSource(node, diagnostics, state) {
    const id = readProperty(node, "id", diagnostics, state);
    if (!id.ok || typeof id.value !== "string") {
      invalidShapeDiagnostic(node, "$.id", diagnostics, state);
      return void 0;
    }
    const name = readProperty(node, "name", diagnostics, state);
    const key = readProperty(node, "key", diagnostics, state);
    const remote = readProperty(node, "remote", diagnostics, state);
    return {
      kind: "component",
      id: id.value,
      ...name.ok && typeof name.value === "string" ? { name: name.value } : {},
      ...key.ok && typeof key.value === "string" && key.value.length > 0 ? { key: key.value } : {},
      ...remote.ok && typeof remote.value === "boolean" ? { remote: remote.value } : {}
    };
  }
  function normalizeRuntimeValue(node, propertyPath, value, diagnostics) {
    return normalizeJsonSafeValue(value, {
      diagnostics,
      phase: "collection",
      source: basicNodeSource(node),
      propertyPath,
      classifySpecialValue: (candidate) => {
        if (typeof candidate !== "object" || candidate === null) {
          return void 0;
        }
        try {
          const record = candidate;
          return record.type === "VARIABLE_ALIAS" && typeof record.id === "string" ? variableAlias(record.id) : void 0;
        } catch {
          return void 0;
        }
      }
    }).value;
  }
  function jsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
  }
  function variableId(value) {
    const object = jsonObject(value);
    if (object === void 0) {
      return void 0;
    }
    return object.$type === "variable-alias" && typeof object.variableId === "string" ? object.variableId : object.type === "VARIABLE_ALIAS" && typeof object.id === "string" ? object.id : void 0;
  }
  function variableBindings(node, propertyPath, value, diagnostics) {
    if (value === void 0) {
      return [];
    }
    const normalized = jsonObject(
      normalizeRuntimeValue(node, propertyPath, value, diagnostics)
    );
    if (normalized === void 0) {
      return [];
    }
    return Object.keys(normalized).sort().flatMap((field) => {
      const id = variableId(normalized[field]);
      return id === void 0 ? [] : [{ propertyPath: field, variable: { kind: "variable", id } }];
    });
  }
  function preferredValues(node, propertyPath, value, diagnostics, state) {
    if (value === void 0) {
      return [];
    }
    const normalized = normalizeRuntimeValue(
      node,
      propertyPath,
      value,
      diagnostics
    );
    if (!Array.isArray(normalized)) {
      invalidShapeDiagnostic(
        node,
        `$.${propertyPath.join(".")}`,
        diagnostics,
        state
      );
      return [];
    }
    return normalized.flatMap(
      (candidate, index) => {
        const object = jsonObject(candidate);
        if (object === void 0 || object.type !== "COMPONENT" && object.type !== "COMPONENT_SET" || typeof object.key !== "string") {
          invalidShapeDiagnostic(
            node,
            `$.${propertyPath.join(".")}[${index}]`,
            diagnostics,
            state
          );
          return [];
        }
        return [{ type: object.type, key: object.key }];
      }
    );
  }
  function slotSettings(value) {
    const object = jsonObject(value);
    if (object === void 0) {
      return void 0;
    }
    const result = {
      ...typeof object.stretchChildOnInsert === "boolean" ? { stretchChildOnInsert: object.stretchChildOnInsert } : {},
      ...typeof object.displayEmptyByDefault === "boolean" ? { displayEmptyByDefault: object.displayEmptyByDefault } : {},
      ...typeof object.minChildren === "number" || object.minChildren === null ? { minChildren: object.minChildren } : {},
      ...typeof object.maxChildren === "number" || object.maxChildren === null ? { maxChildren: object.maxChildren } : {},
      ...typeof object.allowPreferredValuesOnly === "boolean" ? { allowPreferredValuesOnly: object.allowPreferredValuesOnly } : {}
    };
    return Object.keys(result).length === 0 ? void 0 : result;
  }
  function propertyDefinitions(owner, diagnostics, state) {
    const diagnosticStart = diagnostics.size();
    const read = readProperty(
      owner,
      "componentPropertyDefinitions",
      diagnostics,
      state
    );
    if (!read.ok) {
      return {
        definitions: [],
        ids: [],
        variantAxes: [],
        swapTargetIds: [],
        preferredTargetKeys: [],
        available: false,
        complete: false
      };
    }
    if (!read.present || read.value === void 0) {
      return {
        definitions: [],
        ids: [],
        variantAxes: [],
        swapTargetIds: [],
        preferredTargetKeys: [],
        available: true,
        complete: true
      };
    }
    if (typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) {
      invalidShapeDiagnostic(
        owner,
        "$.componentPropertyDefinitions",
        diagnostics,
        state
      );
      return {
        definitions: [],
        ids: [],
        variantAxes: [],
        swapTargetIds: [],
        preferredTargetKeys: [],
        available: false,
        complete: false
      };
    }
    const definitions = [];
    const axes = [];
    const swapTargetIds = [];
    const preferredTargetKeys = [];
    for (const opaqueName of Object.keys(read.value).sort()) {
      let definition;
      try {
        definition = read.value[opaqueName];
      } catch (error) {
        state.complete = false;
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message: "A component property definition could not be read.",
          phase: "collection",
          source: basicNodeSource(owner),
          propertyPath: `$.componentPropertyDefinitions[${JSON.stringify(opaqueName)}]`,
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
        continue;
      }
      if (typeof definition !== "object" || definition === null) {
        invalidShapeDiagnostic(
          owner,
          `$.componentPropertyDefinitions[${JSON.stringify(opaqueName)}]`,
          diagnostics,
          state
        );
        continue;
      }
      const record = definition;
      const propertyType = typeof record.type === "string" ? record.type : "UNKNOWN";
      if (propertyType === "UNKNOWN") {
        invalidShapeDiagnostic(
          owner,
          `$.componentPropertyDefinitions[${JSON.stringify(opaqueName)}].type`,
          diagnostics,
          state
        );
      }
      const defaultValue = normalizeRuntimeValue(
        owner,
        ["componentPropertyDefinitions", opaqueName, "defaultValue"],
        record.defaultValue,
        diagnostics
      );
      const preferred = preferredValues(
        owner,
        ["componentPropertyDefinitions", opaqueName, "preferredValues"],
        record.preferredValues,
        diagnostics,
        state
      );
      const bindings = variableBindings(
        owner,
        ["componentPropertyDefinitions", opaqueName, "boundVariables"],
        record.boundVariables,
        diagnostics
      );
      let variants;
      if (record.variantOptions !== void 0) {
        if (!Array.isArray(record.variantOptions)) {
          invalidShapeDiagnostic(
            owner,
            `$.componentPropertyDefinitions[${JSON.stringify(opaqueName)}].variantOptions`,
            diagnostics,
            state
          );
        } else {
          variants = [];
          for (const [index, value] of record.variantOptions.entries()) {
            if (typeof value === "string") {
              variants.push(value);
            } else {
              invalidShapeDiagnostic(
                owner,
                `$.componentPropertyDefinitions[${JSON.stringify(opaqueName)}].variantOptions[${index}]`,
                diagnostics,
                state
              );
            }
          }
        }
      }
      const normalizedSlotSettings = slotSettings(
        record.slotSettings === void 0 ? void 0 : normalizeRuntimeValue(
          owner,
          ["componentPropertyDefinitions", opaqueName, "slotSettings"],
          record.slotSettings,
          diagnostics
        )
      );
      definitions.push({
        id: opaqueName,
        name: opaqueName,
        propertyType,
        defaultValue,
        preferredValues: preferred,
        ...variants === void 0 ? {} : { variantOptions: variants },
        ...typeof record.description === "string" ? { description: record.description } : {},
        ...normalizedSlotSettings === void 0 ? {} : { slotSettings: normalizedSlotSettings },
        variableBindings: bindings
      });
      if (propertyType === "VARIANT" && variants !== void 0) {
        axes.push({ name: opaqueName, values: variants });
      }
      if (propertyType === "INSTANCE_SWAP" && typeof record.defaultValue === "string") {
        swapTargetIds.push(record.defaultValue);
      }
      preferredTargetKeys.push(...preferred.map((value) => value.key));
    }
    return {
      definitions,
      ids: definitions.map((definition) => definition.id),
      variantAxes: axes,
      swapTargetIds,
      preferredTargetKeys,
      available: true,
      complete: diagnostics.listSince(diagnosticStart).every((diagnostic) => !diagnostic.causedDataLoss)
    };
  }
  function variantProperties(node, diagnostics, state) {
    const read = readProperty(node, "variantProperties", diagnostics, state);
    if (!read.ok) {
      return void 0;
    }
    if (!read.present || read.value === null || read.value === void 0) {
      return [];
    }
    if (typeof read.value !== "object" || Array.isArray(read.value)) {
      invalidShapeDiagnostic(node, "$.variantProperties", diagnostics, state);
      return void 0;
    }
    return Object.keys(read.value).sort().flatMap((property) => {
      let value;
      try {
        value = read.value[property];
      } catch (error) {
        state.complete = false;
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message: "Variant metadata could not be read.",
          phase: "collection",
          source: basicNodeSource(node),
          propertyPath: `$.variantProperties[${JSON.stringify(property)}]`,
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
        return [];
      }
      if (typeof value !== "string") {
        invalidShapeDiagnostic(
          node,
          `$.variantProperties[${JSON.stringify(property)}]`,
          diagnostics,
          state
        );
        return [];
      }
      return [{ property, value }];
    });
  }
  function documentationLinks(node, diagnostics, state) {
    const read = readProperty(node, "documentationLinks", diagnostics, state);
    if (!read.ok) {
      return void 0;
    }
    if (!read.present || read.value === void 0) {
      return [];
    }
    if (!Array.isArray(read.value)) {
      invalidShapeDiagnostic(node, "$.documentationLinks", diagnostics, state);
      return void 0;
    }
    return read.value.flatMap((link2, index) => {
      if (typeof link2 !== "object" || link2 === null) {
        invalidShapeDiagnostic(
          node,
          `$.documentationLinks[${index}]`,
          diagnostics,
          state
        );
        return [];
      }
      try {
        const uri = link2.uri;
        if (typeof uri === "string") {
          return [uri];
        }
      } catch (error) {
        state.complete = false;
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message: "A component documentation link could not be read.",
          phase: "collection",
          source: basicNodeSource(node),
          propertyPath: `$.documentationLinks[${index}].uri`,
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
        return [];
      }
      invalidShapeDiagnostic(
        node,
        `$.documentationLinks[${index}].uri`,
        diagnostics,
        state
      );
      return [];
    });
  }
  function componentPropertyReferences(node, diagnostics, state) {
    const read = readProperty(
      node,
      "componentPropertyReferences",
      diagnostics,
      state
    );
    if (!read.ok || !read.present) {
      return void 0;
    }
    if (read.value === null) {
      return null;
    }
    if (typeof read.value !== "object" || Array.isArray(read.value)) {
      invalidShapeDiagnostic(
        node,
        "$.componentPropertyReferences",
        diagnostics,
        state
      );
      return void 0;
    }
    const record = read.value;
    const result = {};
    for (const property of ["visible", "characters", "mainComponent"]) {
      if (typeof record[property] === "string") {
        result[property] = record[property];
      } else if (record[property] !== void 0) {
        invalidShapeDiagnostic(
          node,
          `$.componentPropertyReferences.${property}`,
          diagnostics,
          state
        );
      }
    }
    return result;
  }
  function slotLimitViolations(node, diagnostics, state) {
    const read = readProperty(node, "limitViolations", diagnostics, state);
    if (!read.ok || !read.present) {
      return void 0;
    }
    if (!Array.isArray(read.value) || !read.value.every(
      (value) => value === "BELOW_MIN" || value === "ABOVE_MAX" || value === "HAS_NON_PREFERRED"
    )) {
      invalidShapeDiagnostic(node, "$.limitViolations", diagnostics, state);
      return void 0;
    }
    return [...read.value].sort();
  }
  function componentPropertyValues(node, diagnostics, state) {
    const read = readProperty(node, "componentProperties", diagnostics, state);
    if (!read.ok) {
      return {
        swapTargetIds: [],
        preferredTargetKeys: [],
        variableRefs: []
      };
    }
    if (!read.present || read.value === void 0) {
      return {
        values: [],
        swapTargetIds: [],
        preferredTargetKeys: [],
        variableRefs: []
      };
    }
    if (typeof read.value !== "object" || read.value === null || Array.isArray(read.value)) {
      invalidShapeDiagnostic(node, "$.componentProperties", diagnostics, state);
      return {
        swapTargetIds: [],
        preferredTargetKeys: [],
        variableRefs: []
      };
    }
    const values = [];
    const swaps = [];
    const keys = [];
    const variableRefs = [];
    for (const opaqueName of Object.keys(read.value).sort()) {
      let property;
      try {
        property = read.value[opaqueName];
      } catch (error) {
        state.complete = false;
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message: "An instance component property could not be read.",
          phase: "collection",
          source: basicNodeSource(node),
          propertyPath: `$.componentProperties[${JSON.stringify(opaqueName)}]`,
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
        continue;
      }
      if (typeof property !== "object" || property === null) {
        invalidShapeDiagnostic(
          node,
          `$.componentProperties[${JSON.stringify(opaqueName)}]`,
          diagnostics,
          state
        );
        continue;
      }
      const record = property;
      const type = typeof record.type === "string" ? record.type : "UNKNOWN";
      const value = normalizeRuntimeValue(
        node,
        ["componentProperties", opaqueName, "value"],
        record.value,
        diagnostics
      );
      const preferred = preferredValues(
        node,
        ["componentProperties", opaqueName, "preferredValues"],
        record.preferredValues,
        diagnostics,
        state
      );
      const bindings = variableBindings(
        node,
        ["componentProperties", opaqueName, "boundVariables"],
        record.boundVariables,
        diagnostics
      );
      values.push({
        id: opaqueName,
        name: opaqueName,
        propertyType: type,
        value,
        ...record.preferredValues === void 0 ? {} : { preferredValues: preferred },
        variableBindings: bindings
      });
      variableRefs.push(...bindings.map((binding) => binding.variable));
      if (type === "INSTANCE_SWAP" && typeof record.value === "string") {
        swaps.push(record.value);
      }
      keys.push(...preferred.map((preferredValue) => preferredValue.key));
    }
    return {
      values,
      swapTargetIds: swaps,
      preferredTargetKeys: keys,
      variableRefs
    };
  }
  function instanceOverrides(node, diagnostics, state) {
    const read = readProperty(node, "overrides", diagnostics, state);
    if (!read.ok) {
      return void 0;
    }
    if (!read.present || read.value === void 0) {
      return [];
    }
    if (!Array.isArray(read.value)) {
      invalidShapeDiagnostic(node, "$.overrides", diagnostics, state);
      return void 0;
    }
    return read.value.flatMap((override, index) => {
      if (typeof override !== "object" || override === null) {
        invalidShapeDiagnostic(
          node,
          `$.overrides[${index}]`,
          diagnostics,
          state
        );
        return [];
      }
      const record = override;
      if (typeof record.id !== "string" || !Array.isArray(record.overriddenFields) || !record.overriddenFields.every((field) => typeof field === "string")) {
        invalidShapeDiagnostic(
          node,
          `$.overrides[${index}]`,
          diagnostics,
          state
        );
        return [];
      }
      return [
        {
          id: record.id,
          overriddenFields: [...record.overriddenFields].sort()
        }
      ];
    }).sort(
      (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
  }
  function exposedInstanceIds(node, diagnostics, state) {
    const read = readProperty(node, "exposedInstances", diagnostics, state);
    if (!read.ok) {
      return void 0;
    }
    if (!read.present || read.value === void 0) {
      return [];
    }
    if (!Array.isArray(read.value)) {
      invalidShapeDiagnostic(node, "$.exposedInstances", diagnostics, state);
      return void 0;
    }
    return read.value.flatMap((instance, index) => {
      if (typeof instance !== "object" || instance === null) {
        invalidShapeDiagnostic(
          node,
          `$.exposedInstances[${index}]`,
          diagnostics,
          state
        );
        return [];
      }
      try {
        const id = instance.id;
        if (typeof id === "string") {
          return [id];
        }
        invalidShapeDiagnostic(
          node,
          `$.exposedInstances[${index}].id`,
          diagnostics,
          state
        );
        return [];
      } catch (error) {
        state.complete = false;
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message: "An exposed-instance identifier could not be read.",
          phase: "collection",
          source: basicNodeSource(node),
          propertyPath: `$.exposedInstances[${index}].id`,
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
        return [];
      }
    }).sort();
  }
  function children(node, diagnostics, state) {
    const read = readProperty(node, "children", diagnostics, state);
    if (!read.ok) {
      return void 0;
    }
    if (!read.present || read.value === void 0) {
      return [];
    }
    if (!Array.isArray(read.value)) {
      invalidShapeDiagnostic(node, "$.children", diagnostics, state);
      return void 0;
    }
    return read.value;
  }
  function coverage(complete) {
    return complete ? { status: "collected" } : {
      status: "partial",
      reason: "Some supported component metadata was inaccessible."
    };
  }
  function deduplicateSourceRefs(references) {
    const seen = /* @__PURE__ */ new Set();
    return sortUnorderedSourceRefs(references).filter((reference) => {
      const signature = `${reference.kind}\0${reference.id}`;
      if (seen.has(signature)) {
        return false;
      }
      seen.add(signature);
      return true;
    });
  }
  function deduplicateDependencies(dependencies) {
    const seen = /* @__PURE__ */ new Set();
    return sortUnorderedComponentDependencies(dependencies).filter(
      (dependency) => {
        const signature = `${dependency.from.id}\0${dependency.to.id}\0${dependency.relationship}`;
        if (seen.has(signature)) {
          return false;
        }
        seen.add(signature);
        return true;
      }
    );
  }
  async function collectComponents(options) {
    const diagnosticStart = options.diagnostics.size();
    const usedScope = options.componentScope === "used";
    const state = { complete: true };
    const definitions = /* @__PURE__ */ new Map();
    const definitionNodesById = /* @__PURE__ */ new Map();
    const componentDataByNodeId = /* @__PURE__ */ new Map();
    const instanceDataByNodeId = /* @__PURE__ */ new Map();
    const propertyReferencesByNodeId = /* @__PURE__ */ new Map();
    const slotLimitViolationsByNodeId = /* @__PURE__ */ new Map();
    const propertyDefinitionCache = /* @__PURE__ */ new Map();
    const dependencies = [];
    const dependencyRefs = [];
    const pendingIds = /* @__PURE__ */ new Map();
    const preferredEdges = [];
    const exposedInstanceIdsByOwner = /* @__PURE__ */ new Map();
    const traversalQueue = options.roots.map((node) => ({
      node,
      selectionContent: true
    }));
    let traversalCursor = 0;
    const visitedContexts = /* @__PURE__ */ new Set();
    const resolvedIds = /* @__PURE__ */ new Set();
    let traversedNodeCount = 0;
    let definitionsDiscovered = 0;
    let instanceLookupsStarted = 0;
    let instanceLookupsCompleted = 0;
    let idLookupsStarted = 0;
    let idLookupsCompleted = 0;
    let reusedDefinitionTraversals = 0;
    let duplicateDefinitionQueuesSkipped = 0;
    const queuedResolvedDefinitionIds = new Set(
      options.roots.flatMap((node) => {
        const id = nodeId(node);
        return id === void 0 ? [] : [id];
      })
    );
    const reportProgress = (stage) => {
      options.onProgress?.({
        stage,
        traversedNodes: traversedNodeCount,
        definitionsDiscovered,
        instanceLookupsStarted,
        instanceLookupsCompleted,
        idLookupsStarted,
        idLookupsCompleted,
        reusedDefinitionTraversals,
        duplicateDefinitionQueuesSkipped
      });
    };
    const reportLookupBoundary = (stage, count) => {
      if (count === 1 || count % 25 === 0) {
        reportProgress(stage);
      }
    };
    const reportReuseBoundary = () => {
      const reuseEvents = reusedDefinitionTraversals + duplicateDefinitionQueuesSkipped;
      if (reuseEvents === 1 || reuseEvents % 25 === 0) {
        reportProgress("traversal");
      }
    };
    reportProgress("traversal");
    const cachedDefinitions = (node) => {
      const existing = propertyDefinitionCache.get(node);
      if (existing !== void 0) {
        return existing;
      }
      const result = propertyDefinitions(node, options.diagnostics, state);
      propertyDefinitionCache.set(node, result);
      dependencyRefs.push(
        ...result.definitions.flatMap(
          (definition) => definition.variableBindings.map((binding) => binding.variable)
        )
      );
      return result;
    };
    const requestTarget = (id, source, owner) => {
      dependencyRefs.push({ kind: "component", id });
      if (owner !== void 0) {
        dependencies.push({
          from: owner,
          to: { kind: "component", id },
          relationship: "swap"
        });
      }
      if (options.session?.definitionById(id) !== void 0) {
        reusedDefinitionTraversals += 1;
        reportReuseBoundary();
        return;
      }
      if (definitions.has(id)) {
        duplicateDefinitionQueuesSkipped += 1;
        reportReuseBoundary();
        return;
      }
      if (!pendingIds.has(id)) {
        pendingIds.set(id, {
          source,
          ...owner === void 0 ? {} : { owner }
        });
      }
    };
    const enqueueDefinitionNode = (node) => {
      const id = nodeId(node);
      if (id !== void 0) {
        if (options.session?.definitionById(id) !== void 0) {
          reusedDefinitionTraversals += 1;
          reportReuseBoundary();
          return;
        }
        if (definitions.has(id) || queuedResolvedDefinitionIds.has(id)) {
          duplicateDefinitionQueuesSkipped += 1;
          reportReuseBoundary();
          return;
        }
        queuedResolvedDefinitionIds.add(id);
      }
      traversalQueue.push({ node, selectionContent: false });
    };
    const enqueueMainComponent = (node) => {
      const id = nodeId(node);
      if (id !== void 0 && options.session?.definitionById(id) !== void 0) {
        reusedDefinitionTraversals += 1;
        reportReuseBoundary();
        return;
      }
      if (usedScope) {
        enqueueDefinitionNode(node);
        return;
      }
      const parentRead = readProperty(node, "parent", options.diagnostics, state);
      if (parentRead.ok && typeof parentRead.value === "object" && parentRead.value !== null && nodeType(parentRead.value, options.diagnostics, state) === "COMPONENT_SET") {
        enqueueDefinitionNode(parentRead.value);
      }
      enqueueDefinitionNode(node);
    };
    while (traversalCursor < traversalQueue.length || pendingIds.size > 0) {
      options.cancellation.throwIfCancelled();
      const item = traversalQueue[traversalCursor];
      if (item !== void 0) {
        traversalCursor += 1;
        if (traversalCursor >= 512 && traversalCursor * 2 >= traversalQueue.length) {
          traversalQueue.splice(0, traversalCursor);
          traversalCursor = 0;
        }
      }
      if (item === void 0) {
        const requestEntry = pendingIds.entries().next().value;
        if (requestEntry === void 0) {
          break;
        }
        const [id2, request] = requestEntry;
        pendingIds.delete(id2);
        if (resolvedIds.has(id2) || definitions.has(id2)) {
          continue;
        }
        if (options.session?.definitionById(id2) !== void 0) {
          reusedDefinitionTraversals += 1;
          reportReuseBoundary();
          continue;
        }
        resolvedIds.add(id2);
        let resolved;
        idLookupsStarted += 1;
        reportLookupBoundary("id-lookup", idLookupsStarted);
        try {
          options.cancellation.throwIfCancelled();
          resolved = await options.adapter.getNodeByIdAsync(id2);
          options.cancellation.throwIfCancelled();
          idLookupsCompleted += 1;
          reportLookupBoundary("id-lookup", idLookupsCompleted);
        } catch (error) {
          options.cancellation.throwIfCancelled();
          idLookupsCompleted += 1;
          reportLookupBoundary("id-lookup", idLookupsCompleted);
          state.complete = false;
          options.diagnostics.add({
            code: DIAGNOSTIC_CODES.componentDependencyUnavailable,
            severity: "warning",
            message: "A referenced component definition could not be resolved.",
            phase: "collection",
            source: { kind: "component", id: id2 },
            propertyPath: `$.referencedBy[${JSON.stringify(request.source.id)}]`,
            causedDataLoss: true,
            technicalCause: normalizeSafeTechnicalCause(error, "property-access")
          });
          continue;
        }
        if (resolved === null || !["COMPONENT", "COMPONENT_SET"].includes(
          nodeType(resolved, options.diagnostics, state) ?? ""
        )) {
          state.complete = false;
          options.diagnostics.add({
            code: DIAGNOSTIC_CODES.componentDependencyUnavailable,
            severity: "warning",
            message: "A referenced component definition is not accessible.",
            phase: "collection",
            source: { kind: "component", id: id2 },
            propertyPath: `$.referencedBy[${JSON.stringify(request.source.id)}]`,
            causedDataLoss: true
          });
          continue;
        }
        if (usedScope && nodeType(resolved, options.diagnostics, state) === "COMPONENT_SET") {
          continue;
        }
        enqueueMainComponent(resolved);
        continue;
      }
      const id = nodeId(item.node);
      if (id === void 0) {
        invalidShapeDiagnostic(item.node, "$.id", options.diagnostics, state);
        continue;
      }
      const context = `${id}\0${item.ownerComponent?.id ?? ""}`;
      if (visitedContexts.has(context)) {
        continue;
      }
      visitedContexts.add(context);
      if (usedScope && !item.selectionContent) {
        const visitedType = nodeType(item.node, options.diagnostics, state);
        if (visitedType === "COMPONENT_SET") {
          continue;
        }
      }
      traversedNodeCount += 1;
      if (traversedNodeCount % 50 === 0) {
        reportProgress("traversal");
        await yieldToFigma();
        options.cancellation.throwIfCancelled();
      }
      const references = componentPropertyReferences(
        item.node,
        options.diagnostics,
        state
      );
      if (references !== void 0) {
        propertyReferencesByNodeId.set(id, references);
      }
      const type = nodeType(item.node, options.diagnostics, state);
      if (type === "SLOT") {
        const violations = slotLimitViolations(
          item.node,
          options.diagnostics,
          state
        );
        if (violations !== void 0) {
          slotLimitViolationsByNodeId.set(id, violations);
        }
      }
      let childOwner = item.ownerComponent;
      if (type === "COMPONENT" || type === "COMPONENT_SET") {
        const definitionDiagnosticStart = options.diagnostics.size();
        const source = componentSource(item.node, options.diagnostics, state);
        if (source !== void 0) {
          let owningSet;
          let definitionsOwner = item.node;
          let canReadOwnDefinitions = type === "COMPONENT_SET";
          if (type === "COMPONENT") {
            const parent = readProperty(
              item.node,
              "parent",
              options.diagnostics,
              state
            );
            if (!parent.ok) {
              canReadOwnDefinitions = false;
            } else if (typeof parent.value === "object" && parent.value !== null && nodeType(parent.value, options.diagnostics, state) === "COMPONENT_SET") {
              owningSet = componentSource(
                parent.value,
                options.diagnostics,
                state
              );
              definitionsOwner = parent.value;
              canReadOwnDefinitions = false;
              if (!usedScope) {
                enqueueDefinitionNode(parent.value);
              }
            } else {
              canReadOwnDefinitions = true;
            }
          }
          const propertyMetadata = type === "COMPONENT_SET" || owningSet !== void 0 ? cachedDefinitions(definitionsOwner) : canReadOwnDefinitions ? cachedDefinitions(item.node) : {
            definitions: [],
            ids: [],
            variantAxes: [],
            swapTargetIds: [],
            preferredTargetKeys: [],
            available: false,
            complete: false
          };
          const variants = variantProperties(
            item.node,
            options.diagnostics,
            state
          );
          const description = readProperty(
            item.node,
            "description",
            options.diagnostics,
            state
          );
          const markdown = readProperty(
            item.node,
            "descriptionMarkdown",
            options.diagnostics,
            state
          );
          const defaultVariant = type === "COMPONENT_SET" ? readProperty(
            item.node,
            "defaultVariant",
            options.diagnostics,
            state
          ) : void 0;
          let defaultVariantId;
          if (defaultVariant?.present === true && typeof defaultVariant.value === "object" && defaultVariant.value !== null) {
            try {
              const value = defaultVariant.value.id;
              if (typeof value === "string") {
                defaultVariantId = value;
              } else {
                invalidShapeDiagnostic(
                  item.node,
                  "$.defaultVariant.id",
                  options.diagnostics,
                  state
                );
              }
            } catch (error) {
              state.complete = false;
              options.diagnostics.add({
                code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
                severity: "warning",
                message: "The default component variant could not be read.",
                phase: "collection",
                source: basicNodeSource(item.node),
                propertyPath: "$.defaultVariant.id",
                causedDataLoss: true,
                technicalCause: normalizeSafeTechnicalCause(
                  error,
                  "property-access"
                )
              });
            }
          }
          const definition = {
            componentKind: type === "COMPONENT_SET" ? "component-set" : "component",
            source,
            nodeId: source.id,
            ...owningSet === void 0 ? {} : { componentSetId: owningSet.id },
            ...defaultVariantId === void 0 ? {} : { defaultVariantId },
            ...propertyMetadata.available ? {
              variantAxes: type === "COMPONENT_SET" ? propertyMetadata.variantAxes : [],
              propertyDefinitions: type === "COMPONENT_SET" || owningSet === void 0 ? propertyMetadata.definitions : []
            } : {},
            ...variants === void 0 ? {} : { variantProperties: variants },
            ...(() => {
              const links = documentationLinks(
                item.node,
                options.diagnostics,
                state
              );
              return links === void 0 ? {} : { documentationLinks: links };
            })(),
            ...description.ok && typeof description.value === "string" ? { description: description.value } : {},
            ...markdown.ok && typeof markdown.value === "string" ? { descriptionMarkdown: markdown.value } : {},
            diagnosticIds: options.diagnostics.listSince(definitionDiagnosticStart).map((diagnostic) => diagnostic.id)
          };
          if (!definitions.has(source.id)) {
            definitionsDiscovered += 1;
          }
          definitions.set(source.id, definition);
          definitionNodesById.set(source.id, item.node);
          componentDataByNodeId.set(source.id, {
            metadataCoverage: coverage(
              options.diagnostics.listSince(definitionDiagnosticStart).every((diagnostic) => !diagnostic.causedDataLoss) && propertyMetadata.complete
            ),
            component: source,
            ...owningSet === void 0 ? {} : { componentSet: owningSet },
            ...variants === void 0 ? {} : { variantProperties: variants },
            ...propertyMetadata.available ? { propertyDefinitionIds: propertyMetadata.ids } : {}
          });
          childOwner = source;
          dependencyRefs.push(source);
          if (owningSet !== void 0) {
            dependencies.push({
              from: owningSet,
              to: source,
              relationship: "contains"
            });
          }
          for (const targetId of propertyMetadata.swapTargetIds) {
            requestTarget(targetId, source, source);
          }
          preferredEdges.push(
            ...propertyMetadata.preferredTargetKeys.map((key) => ({
              owner: source,
              key
            }))
          );
        }
      } else if (type === "INSTANCE") {
        const instanceDiagnosticStart = options.diagnostics.size();
        const source = basicNodeSource(item.node);
        const isExposed = readProperty(
          item.node,
          "isExposedInstance",
          options.diagnostics,
          state
        );
        if (item.ownerComponent !== void 0 && isExposed.value === true) {
          const ownerIds = exposedInstanceIdsByOwner.get(item.ownerComponent.id) ?? /* @__PURE__ */ new Set();
          ownerIds.add(id);
          exposedInstanceIdsByOwner.set(item.ownerComponent.id, ownerIds);
        }
        const values = componentPropertyValues(
          item.node,
          options.diagnostics,
          state
        );
        dependencyRefs.push(...values.variableRefs);
        const overrides = instanceOverrides(
          item.node,
          options.diagnostics,
          state
        );
        const exposed = exposedInstanceIds(item.node, options.diagnostics, state);
        const scale = readProperty(
          item.node,
          "scaleFactor",
          options.diagnostics,
          state
        );
        const mainGetter = readProperty(
          item.node,
          "getMainComponentAsync",
          options.diagnostics,
          state
        );
        let mainComponent;
        if (mainGetter.ok && typeof mainGetter.value === "function") {
          options.cancellation.throwIfCancelled();
          instanceLookupsStarted += 1;
          reportLookupBoundary("instance-lookup", instanceLookupsStarted);
          try {
            const resolved = await Reflect.apply(
              mainGetter.value,
              item.node,
              []
            );
            options.cancellation.throwIfCancelled();
            instanceLookupsCompleted += 1;
            reportLookupBoundary("instance-lookup", instanceLookupsCompleted);
            if (resolved === null) {
              state.complete = false;
              options.diagnostics.add({
                code: DIAGNOSTIC_CODES.componentMainComponentUnavailable,
                severity: "warning",
                message: "An instance main component is not accessible.",
                phase: "collection",
                source,
                propertyPath: "$.getMainComponentAsync",
                causedDataLoss: true
              });
            } else {
              mainComponent = componentSource(
                resolved,
                options.diagnostics,
                state
              );
              if (mainComponent !== void 0) {
                dependencyRefs.push(mainComponent);
                if (item.ownerComponent !== void 0) {
                  dependencies.push({
                    from: item.ownerComponent,
                    to: mainComponent,
                    relationship: "instance"
                  });
                }
                enqueueMainComponent(resolved);
              }
            }
          } catch (error) {
            options.cancellation.throwIfCancelled();
            instanceLookupsCompleted += 1;
            reportLookupBoundary("instance-lookup", instanceLookupsCompleted);
            state.complete = false;
            options.diagnostics.add({
              code: DIAGNOSTIC_CODES.componentMainComponentUnavailable,
              severity: "warning",
              message: "An instance main component could not be resolved.",
              phase: "collection",
              source,
              propertyPath: "$.getMainComponentAsync",
              causedDataLoss: true,
              technicalCause: normalizeSafeTechnicalCause(
                error,
                "property-access"
              )
            });
          }
        } else {
          state.complete = false;
          options.diagnostics.add({
            code: DIAGNOSTIC_CODES.componentMainComponentUnavailable,
            severity: "warning",
            message: "An instance main component resolver is unavailable.",
            phase: "collection",
            source,
            propertyPath: "$.getMainComponentAsync",
            causedDataLoss: true
          });
        }
        const swapTargets = deduplicateSourceRefs(
          values.swapTargetIds.map((targetId) => ({
            kind: "component",
            id: targetId
          }))
        );
        instanceDataByNodeId.set(id, {
          metadataCoverage: coverage(
            options.diagnostics.listSince(instanceDiagnosticStart).every((diagnostic) => !diagnostic.causedDataLoss)
          ),
          ...mainComponent === void 0 ? {} : { mainComponent },
          ...values.values === void 0 ? {} : { componentProperties: values.values },
          ...overrides === void 0 ? {} : { overrides },
          ...values.values === void 0 ? {} : { swapTargets },
          ...exposed === void 0 ? {} : { exposedInstanceIds: exposed },
          ...scale.ok && typeof scale.value === "number" ? { scaleFactor: Number.isFinite(scale.value) ? scale.value : null } : {}
        });
        for (const targetId of values.swapTargetIds) {
          requestTarget(targetId, source, item.ownerComponent ?? mainComponent);
        }
        const propertyOwner = item.ownerComponent ?? mainComponent;
        if (propertyOwner !== void 0) {
          preferredEdges.push(
            ...values.preferredTargetKeys.map((key) => ({
              owner: propertyOwner,
              key
            }))
          );
        }
      }
      const nodeChildren = children(item.node, options.diagnostics, state);
      for (const child of nodeChildren ?? []) {
        traversalQueue.push({
          node: child,
          ...childOwner === void 0 ? {} : { ownerComponent: childOwner },
          selectionContent: item.selectionContent
        });
      }
    }
    for (const [id, definition] of definitions) {
      const exposedIds = exposedInstanceIdsByOwner.get(id);
      if (exposedIds !== void 0) {
        definitions.set(id, {
          ...definition,
          exposedInstanceIds: [...exposedIds].sort()
        });
      }
    }
    const definitionsByKey = /* @__PURE__ */ new Map();
    for (const definition of definitions.values()) {
      if (definition.source.key !== void 0) {
        definitionsByKey.set(definition.source.key, definition);
      }
    }
    for (const request of preferredEdges) {
      const target = definitionsByKey.get(request.key) ?? options.session?.definitionByKey(request.key);
      if (target !== void 0) {
        dependencies.push({
          from: request.owner,
          to: target.source,
          relationship: "preferred-value"
        });
      }
    }
    const enrichComponentRef = (reference) => definitions.get(reference.id)?.source ?? options.session?.definitionById(reference.id)?.source ?? reference;
    const enrichedDependencies = dependencies.map((dependency) => ({
      ...dependency,
      from: enrichComponentRef(dependency.from),
      to: enrichComponentRef(dependency.to)
    }));
    const index = {
      kind: "design-ir-components",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      definitions: sortUnorderedComponentDefinitions([...definitions.values()]),
      dependencies: deduplicateDependencies(enrichedDependencies),
      diagnosticIds: options.diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
    };
    options.session?.rememberDefinitions(index.definitions);
    reportProgress("complete");
    return {
      index,
      componentDataByNodeId,
      instanceDataByNodeId,
      componentPropertyReferencesByNodeId: propertyReferencesByNodeId,
      slotLimitViolationsByNodeId,
      dependencyRefs: deduplicateSourceRefs(
        dependencyRefs.map(
          (reference) => reference.kind === "component" ? enrichComponentRef(
            reference
          ) : reference
        )
      ),
      complete: state.complete,
      definitionNodesById
    };
  }

  // src/main/collect-interactions.ts
  function nodeSource(node) {
    let id = "unavailable-node";
    let name;
    try {
      id = node.id;
    } catch {
    }
    try {
      name = node.name;
    } catch {
    }
    return { kind: "node", id, ...name === void 0 ? {} : { name } };
  }
  function normalizeRuntimeValue2(node, propertyPath, value, diagnostics) {
    return normalizeJsonSafeValue(value, {
      diagnostics,
      phase: "collection",
      source: nodeSource(node),
      propertyPath,
      classifySpecialValue: (candidate) => candidate === figma.mixed ? { $type: "figma-mixed" } : void 0
    }).value;
  }
  function objectValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
  }
  function stringValue(value) {
    return typeof value === "string" ? value : void 0;
  }
  function numberValue(value) {
    if (value === null) {
      return null;
    }
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function isNumberArray(value) {
    return Array.isArray(value) && value.every((candidate) => typeof candidate === "number");
  }
  function transitionFromAction(node, action, propertyPath, diagnostics) {
    const transition = action.transition;
    if (transition === null || typeof transition !== "object") {
      return void 0;
    }
    const record = transition;
    const transitionType = stringValue(record.type);
    if (transitionType === void 0) {
      return void 0;
    }
    const easing = normalizeRuntimeValue2(
      node,
      [...propertyPath, "transition", "easing"],
      record.easing,
      diagnostics
    );
    const durationSeconds = numberValue(record.duration);
    return {
      transitionType,
      ...easing === void 0 ? {} : { easing },
      ...durationSeconds === void 0 ? {} : { durationSeconds },
      ...typeof record.direction === "string" ? { direction: record.direction } : {},
      ...typeof record.matchLayers === "boolean" ? { matchLayers: record.matchLayers } : {}
    };
  }
  function destinationRef(destinationId) {
    return typeof destinationId === "string" && destinationId.length > 0 ? { kind: "node", id: destinationId } : void 0;
  }
  function variableRefsFromJson(value) {
    const references = [];
    const visit = (candidate) => {
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          visit(item);
        }
        return;
      }
      if (typeof candidate !== "object" || candidate === null) {
        return;
      }
      const object = candidate;
      if ((object.type === "VARIABLE_ALIAS" || object.$type === "variable-alias") && typeof (object.id ?? object.variableId) === "string") {
        references.push({
          kind: "variable",
          id: object.id ?? object.variableId
        });
      }
      for (const child of Object.values(object)) {
        if (child !== void 0) {
          visit(child);
        }
      }
    };
    visit(value);
    return references;
  }
  function collectUnknownAction(node, action, propertyPath, diagnostics) {
    const raw = normalizeRuntimeValue2(node, propertyPath, action, diagnostics);
    const diagnostic = diagnostics.add({
      code: DIAGNOSTIC_CODES.interactionUnsupportedAction,
      severity: "warning",
      message: "An unsupported interaction action was retained as canonical raw data.",
      phase: "collection",
      source: nodeSource(node),
      propertyPath: `$.${propertyPath.join(".")}`,
      causedDataLoss: false
    });
    return {
      actionType: "unknown",
      raw: objectValue(raw) ?? {
        $type: "unsupported",
        runtimeType: typeof action,
        reason: "unknown"
      },
      diagnosticIds: [diagnostic.id]
    };
  }
  function collectAction(node, action, propertyPath, diagnostics, dependencyRefs) {
    if (typeof action !== "object" || action === null) {
      return collectUnknownAction(node, action, propertyPath, diagnostics);
    }
    const record = action;
    const actionType = stringValue(record.type);
    const normalizedAction = objectValue(
      normalizeRuntimeValue2(node, propertyPath, action, diagnostics)
    );
    if (actionType === "BACK") {
      return {
        actionType: "back",
        ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
      };
    }
    if (actionType === "CLOSE") {
      return {
        actionType: "close-overlay",
        ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
      };
    }
    if (actionType === "URL") {
      if (typeof record.url !== "string") {
        return collectUnknownAction(node, action, propertyPath, diagnostics);
      }
      return {
        actionType: "url",
        url: record.url,
        ...typeof record.openInNewTab === "boolean" ? { openInNewTab: record.openInNewTab } : {},
        ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
      };
    }
    if (actionType === "UPDATE_MEDIA_RUNTIME") {
      const destination = destinationRef(record.destinationId);
      if (destination !== void 0) {
        dependencyRefs.push(destination);
      }
      if (typeof record.mediaAction !== "string") {
        return collectUnknownAction(node, action, propertyPath, diagnostics);
      }
      return {
        actionType: "update-media-runtime",
        ...destination === void 0 ? {} : { destination },
        mediaAction: record.mediaAction,
        ...numberValue(record.amountToSkip) === void 0 ? {} : { amountToSkip: numberValue(record.amountToSkip) },
        ...numberValue(record.newTimestamp) === void 0 ? {} : { newTimestamp: numberValue(record.newTimestamp) },
        ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
      };
    }
    if (actionType === "NODE") {
      const destination = destinationRef(record.destinationId);
      if (destination !== void 0) {
        dependencyRefs.push(destination);
      }
      const navigation = stringValue(record.navigation) ?? "UNKNOWN";
      const transition = transitionFromAction(
        node,
        record,
        propertyPath,
        diagnostics
      );
      if (navigation === "OVERLAY" || navigation === "SWAP") {
        const relative = record.overlayRelativePosition;
        const relativePosition = typeof relative === "object" && relative !== null ? {
          x: numberValue(relative.x) ?? null,
          y: numberValue(relative.y) ?? null
        } : void 0;
        return {
          actionType: navigation === "OVERLAY" ? "open-overlay" : "swap-overlay",
          ...destination === void 0 ? {} : { destination },
          ...relativePosition === void 0 ? {} : { relativePosition },
          ...transition === void 0 ? {} : { transition },
          ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
        };
      }
      if (navigation === "SCROLL_TO") {
        return {
          actionType: "scroll-to",
          ...destination === void 0 ? {} : { destination },
          ...transition === void 0 ? {} : { transition },
          ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
        };
      }
      return {
        actionType: "navigate",
        ...destination === void 0 ? {} : { destination },
        navigation,
        ...transition === void 0 ? {} : { transition },
        ...typeof record.preserveScrollPosition === "boolean" ? { preserveScrollPosition: record.preserveScrollPosition } : {},
        ...typeof record.resetScrollPosition === "boolean" ? { resetScrollPosition: record.resetScrollPosition } : {},
        ...typeof record.resetVideoPosition === "boolean" ? { resetVideoPosition: record.resetVideoPosition } : {},
        ...typeof record.resetInteractiveComponents === "boolean" ? { resetInteractiveComponents: record.resetInteractiveComponents } : {},
        ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
      };
    }
    if (actionType === "SET_VARIABLE") {
      const variable = typeof record.variableId === "string" ? { kind: "variable", id: record.variableId } : void 0;
      if (variable !== void 0) {
        dependencyRefs.push(variable);
      }
      const value = record.variableValue === void 0 ? void 0 : normalizeRuntimeValue2(
        node,
        [...propertyPath, "variableValue"],
        record.variableValue,
        diagnostics
      );
      if (value !== void 0) {
        dependencyRefs.push(...variableRefsFromJson(value));
      }
      return {
        actionType: "set-variable",
        ...variable === void 0 ? {} : { variable },
        ...value === void 0 ? {} : { value },
        ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
      };
    }
    if (actionType === "SET_VARIABLE_MODE") {
      const collection = typeof record.variableCollectionId === "string" ? { kind: "collection", id: record.variableCollectionId } : void 0;
      if (collection !== void 0) {
        dependencyRefs.push(collection);
      }
      return {
        actionType: "set-variable-mode",
        ...collection === void 0 ? {} : { collection },
        ...typeof record.variableModeId === "string" ? { modeId: record.variableModeId } : {},
        ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
      };
    }
    if (actionType === "CONDITIONAL") {
      const raw = normalizeRuntimeValue2(node, propertyPath, action, diagnostics);
      dependencyRefs.push(...variableRefsFromJson(raw));
      const rawBlocks = Array.isArray(record.conditionalBlocks) ? record.conditionalBlocks : [];
      const conditionalBlocks = rawBlocks.map(
        (block, blockIndex) => {
          const normalizedBlock = normalizeRuntimeValue2(
            node,
            [...propertyPath, "conditionalBlocks", blockIndex],
            block,
            diagnostics
          );
          const blockRecord = typeof block === "object" && block !== null ? block : {};
          const blockActions = Array.isArray(blockRecord.actions) ? blockRecord.actions.map(
            (nestedAction, nestedIndex) => collectAction(
              node,
              nestedAction,
              [
                ...propertyPath,
                "conditionalBlocks",
                blockIndex,
                "actions",
                nestedIndex
              ],
              diagnostics,
              dependencyRefs
            )
          ) : [];
          const condition = blockRecord.condition === void 0 ? void 0 : normalizeRuntimeValue2(
            node,
            [...propertyPath, "conditionalBlocks", blockIndex, "condition"],
            blockRecord.condition,
            diagnostics
          );
          return {
            ...condition === void 0 ? {} : { condition },
            actions: blockActions,
            ...objectValue(normalizedBlock) === void 0 ? {} : { raw: objectValue(normalizedBlock) }
          };
        }
      );
      return {
        actionType: "conditional",
        actions: conditionalBlocks.flatMap((block) => block.actions),
        conditionalBlocks,
        ...normalizedAction === void 0 ? {} : { raw: normalizedAction }
      };
    }
    return collectUnknownAction(node, action, propertyPath, diagnostics);
  }
  function collectTrigger(node, trigger, propertyPath, diagnostics) {
    if (trigger === null) {
      return null;
    }
    if (typeof trigger !== "object") {
      const raw2 = objectValue(
        normalizeRuntimeValue2(node, propertyPath, trigger, diagnostics)
      );
      return {
        triggerType: "UNKNOWN",
        ...raw2 === void 0 ? {} : { raw: raw2 }
      };
    }
    const record = trigger;
    const triggerType = stringValue(record.type) ?? "UNKNOWN";
    const raw = objectValue(
      normalizeRuntimeValue2(node, propertyPath, trigger, diagnostics)
    );
    return {
      triggerType,
      ...numberValue(record.timeout) === void 0 ? {} : { delaySeconds: numberValue(record.timeout) },
      ...numberValue(record.delay) === void 0 ? {} : { delaySeconds: numberValue(record.delay) },
      ...typeof record.device === "string" ? { device: record.device } : {},
      ...isNumberArray(record.keyCodes) ? { keyCodes: record.keyCodes } : {},
      ...numberValue(record.mediaHitTime) === void 0 ? {} : { mediaHitTime: numberValue(record.mediaHitTime) },
      ...raw === void 0 ? {} : { raw }
    };
  }
  function readProperty2(node, property, diagnostics) {
    try {
      if (!(property in node)) {
        return { ok: true, value: [] };
      }
      return {
        ok: true,
        value: node[property]
      };
    } catch (error) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
        severity: "warning",
        message: "A supported interaction or annotation property could not be read.",
        phase: "collection",
        source: nodeSource(node),
        propertyPath: `$.${property}`,
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return { ok: false };
    }
  }
  function diagnoseInteractionShape(node, propertyPath, diagnostics) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
      severity: "warning",
      message: "Supported interaction or annotation data had an unexpected runtime shape.",
      phase: "collection",
      source: nodeSource(node),
      propertyPath,
      causedDataLoss: true
    });
  }
  function collectNodeInteractions(node, diagnostics) {
    const dependencyRefs = [];
    let complete = true;
    const annotationRead = readProperty2(node, "annotations", diagnostics);
    const annotations = [];
    if (!annotationRead.ok) {
      complete = false;
    } else if (Array.isArray(annotationRead.value)) {
      for (const [index, annotation] of annotationRead.value.entries()) {
        const normalized = objectValue(
          normalizeRuntimeValue2(
            node,
            ["annotations", index],
            annotation,
            diagnostics
          )
        );
        if (normalized === void 0) {
          diagnoseInteractionShape(node, `$.annotations[${index}]`, diagnostics);
          complete = false;
          continue;
        }
        let properties;
        if (normalized.properties !== void 0) {
          if (!Array.isArray(normalized.properties)) {
            diagnoseInteractionShape(
              node,
              `$.annotations[${index}].properties`,
              diagnostics
            );
            complete = false;
          } else {
            const collectedProperties = [];
            for (const [propertyIndex, property] of normalized.properties.entries()) {
              const object = objectValue(property);
              if (object === void 0 || typeof object.type !== "string") {
                diagnoseInteractionShape(
                  node,
                  `$.annotations[${index}].properties[${propertyIndex}]`,
                  diagnostics
                );
                complete = false;
              } else {
                collectedProperties.push({ type: object.type });
              }
            }
            properties = collectedProperties;
          }
        }
        annotations.push({
          ...typeof normalized.label === "string" ? { label: normalized.label } : {},
          ...typeof normalized.labelMarkdown === "string" ? { labelMarkdown: normalized.labelMarkdown } : {},
          ...typeof normalized.categoryId === "string" ? { categoryId: normalized.categoryId } : {},
          ...properties === void 0 ? {} : { properties },
          raw: normalized
        });
      }
    } else {
      diagnoseInteractionShape(node, "$.annotations", diagnostics);
      complete = false;
    }
    const reactionRead = readProperty2(node, "reactions", diagnostics);
    const reactions = [];
    if (!reactionRead.ok) {
      complete = false;
    } else if (Array.isArray(reactionRead.value)) {
      for (const [reactionIndex, reaction] of reactionRead.value.entries()) {
        if (typeof reaction !== "object" || reaction === null) {
          diagnoseInteractionShape(
            node,
            `$.reactions[${reactionIndex}]`,
            diagnostics
          );
          complete = false;
          continue;
        }
        const record = reaction;
        const actionInputs = Array.isArray(record.actions) ? record.actions : record.action === void 0 ? [] : [record.action];
        const diagnosticStart = diagnostics.size();
        const actions = actionInputs.map(
          (action, actionIndex) => collectAction(
            node,
            action,
            ["reactions", reactionIndex, "actions", actionIndex],
            diagnostics,
            dependencyRefs
          )
        );
        reactions.push({
          id: `${nodeSource(node).id}:reaction:${String(reactionIndex).padStart(6, "0")}`,
          sourceNode: nodeSource(node),
          order: reactionIndex,
          trigger: collectTrigger(
            node,
            record.trigger,
            ["reactions", reactionIndex, "trigger"],
            diagnostics
          ),
          actions,
          diagnosticIds: diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
        });
      }
    } else {
      diagnoseInteractionShape(node, "$.reactions", diagnostics);
      complete = false;
    }
    return {
      annotations,
      reactions,
      annotationsAvailable: annotationRead.ok,
      reactionsAvailable: reactionRead.ok,
      dependencyRefs,
      complete
    };
  }

  // src/main/collect-node.ts
  var KNOWN_NODE_TYPES = /* @__PURE__ */ new Set([
    "BOOLEAN_OPERATION",
    "COMPONENT",
    "COMPONENT_SET",
    "ELLIPSE",
    "FRAME",
    "GROUP",
    "INSTANCE",
    "LINE",
    "POLYGON",
    "RECTANGLE",
    "SECTION",
    "SLICE",
    "SLOT",
    "STAR",
    "TEXT",
    "TEXT_PATH",
    "TRANSFORM_GROUP",
    "VECTOR"
  ]);
  var VECTOR_NODE_TYPES = /* @__PURE__ */ new Set([
    "BOOLEAN_OPERATION",
    "ELLIPSE",
    "LINE",
    "POLYGON",
    "RECTANGLE",
    "STAR",
    "VECTOR"
  ]);
  var CONTAINER_NODE_TYPES = /* @__PURE__ */ new Set([
    "COMPONENT",
    "COMPONENT_SET",
    "FRAME",
    "GROUP",
    "INSTANCE",
    "SECTION",
    "SLOT",
    "TRANSFORM_GROUP"
  ]);
  function safeNodeId(node) {
    try {
      return node.id;
    } catch {
      return "unavailable-node";
    }
  }
  function safeNodeName(node) {
    try {
      return node.name;
    } catch {
      return void 0;
    }
  }
  function sourceForNode(node) {
    const name = safeNodeName(node);
    return {
      kind: "node",
      id: safeNodeId(node),
      ...name === void 0 ? {} : { name }
    };
  }
  function readOptional(node, property, diagnostics, severity = "warning") {
    try {
      if (!(property in node)) {
        return { present: false };
      }
      return {
        present: true,
        value: node[property]
      };
    } catch (error) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
        severity,
        message: "A supported node property could not be read and remains explicit in diagnostics.",
        phase: "collection",
        source: sourceForNode(node),
        propertyPath: `$.${property}`,
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return { present: false };
    }
  }
  function normalizeValue(node, property, value, diagnostics) {
    const propertyPath = [];
    const tokenPattern = /([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+)\]/g;
    for (const match of property.matchAll(tokenPattern)) {
      propertyPath.push(match[1] ?? Number(match[2]));
    }
    if (propertyPath.length === 0) {
      propertyPath.push(property);
    }
    return normalizeJsonSafeValue(value, {
      diagnostics,
      phase: "collection",
      source: sourceForNode(node),
      propertyPath,
      classifySpecialValue: (candidate) => candidate === figma.mixed ? FIGMA_MIXED_VALUE : void 0
    }).value;
  }
  function optionalString(node, property, diagnostics) {
    const result = readOptional(node, property, diagnostics);
    if (!result.present || result.value === void 0) {
      return void 0;
    }
    if (typeof result.value !== "string") {
      diagnoseUnexpectedSupportedShape(node, property, diagnostics);
      return void 0;
    }
    return result.value;
  }
  function optionalBoolean(node, property, diagnostics) {
    const result = readOptional(node, property, diagnostics);
    if (!result.present || result.value === void 0) {
      return void 0;
    }
    if (typeof result.value !== "boolean") {
      diagnoseUnexpectedSupportedShape(node, property, diagnostics);
      return void 0;
    }
    return result.value;
  }
  function optionalNumber(node, property, diagnostics) {
    const result = readOptional(node, property, diagnostics);
    return numberFromRead(node, property, result, diagnostics);
  }
  function optionalNumberOrMixed(node, property, diagnostics) {
    const result = readOptional(node, property, diagnostics);
    return result.value === figma.mixed ? FIGMA_MIXED_VALUE : numberFromRead(node, property, result, diagnostics);
  }
  function numberFromRead(node, property, result, diagnostics) {
    if (!result.present) {
      return void 0;
    }
    if (result.value === null) {
      return null;
    }
    if (typeof result.value !== "number") {
      if (result.value !== void 0) {
        diagnoseUnexpectedSupportedShape(node, property, diagnostics);
      }
      return void 0;
    }
    const normalized = normalizeValue(node, property, result.value, diagnostics);
    return typeof normalized === "number" || normalized === null ? normalized : void 0;
  }
  function jsonObject2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
  }
  function optionalNormalized(node, property, diagnostics) {
    const result = readOptional(node, property, diagnostics);
    return !result.present ? void 0 : normalizeValue(node, property, result.value, diagnostics);
  }
  function objectNumber(node, property, object, key, diagnostics) {
    const value = object[key];
    const normalized = normalizeJsonSafeValue(value, {
      diagnostics,
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: [property, key],
      classifySpecialValue: (candidate) => candidate === figma.mixed ? FIGMA_MIXED_VALUE : void 0
    }).value;
    return typeof normalized === "number" ? normalized : null;
  }
  function readRect(node, property, diagnostics) {
    const result = readOptional(node, property, diagnostics);
    if (!result.present || result.value === null || typeof result.value !== "object") {
      return result.value === null ? null : void 0;
    }
    const record = result.value;
    return {
      x: objectNumber(node, property, record, "x", diagnostics),
      y: objectNumber(node, property, record, "y", diagnostics),
      width: objectNumber(node, property, record, "width", diagnostics),
      height: objectNumber(node, property, record, "height", diagnostics)
    };
  }
  function readTransform(node, property, diagnostics) {
    const result = readOptional(node, property, diagnostics);
    if (!result.present || !Array.isArray(result.value) || result.value.length !== 2 || !result.value.every((row) => Array.isArray(row) && row.length === 3)) {
      return void 0;
    }
    const rows = result.value;
    const normalizeCell = (value, row, column) => {
      const normalized = normalizeJsonSafeValue(value, {
        diagnostics,
        phase: "collection",
        source: sourceForNode(node),
        propertyPath: [property, row, column],
        classifySpecialValue: (candidate) => candidate === figma.mixed ? FIGMA_MIXED_VALUE : void 0
      }).value;
      return typeof normalized === "number" ? normalized : null;
    };
    return [
      [
        normalizeCell(rows[0]?.[0], 0, 0),
        normalizeCell(rows[0]?.[1], 0, 1),
        normalizeCell(rows[0]?.[2], 0, 2)
      ],
      [
        normalizeCell(rows[1]?.[0], 1, 0),
        normalizeCell(rows[1]?.[1], 1, 1),
        normalizeCell(rows[1]?.[2], 1, 2)
      ]
    ];
  }
  function collectGeometry(node, diagnostics) {
    const x2 = optionalNumber(node, "x", diagnostics);
    const y = optionalNumber(node, "y", diagnostics);
    const width = optionalNumber(node, "width", diagnostics);
    const height = optionalNumber(node, "height", diagnostics);
    const localBounds = x2 === void 0 || y === void 0 || width === void 0 || height === void 0 ? void 0 : { x: x2, y, width, height };
    const absoluteBounds = readRect(node, "absoluteBoundingBox", diagnostics);
    const absoluteRenderBounds = readRect(
      node,
      "absoluteRenderBounds",
      diagnostics
    );
    const relativeTransform = readTransform(
      node,
      "relativeTransform",
      diagnostics
    );
    const absoluteTransform = readTransform(
      node,
      "absoluteTransform",
      diagnostics
    );
    const rotation = optionalNumber(node, "rotation", diagnostics);
    const constraintsResult = readOptional(node, "constraints", diagnostics);
    const constraints = constraintsResult.present && typeof constraintsResult.value === "object" && constraintsResult.value !== null && typeof constraintsResult.value.horizontal === "string" && typeof constraintsResult.value.vertical === "string" ? {
      horizontal: constraintsResult.value.horizontal,
      vertical: constraintsResult.value.vertical
    } : void 0;
    const geometry = {
      ...localBounds === void 0 ? {} : { localBounds },
      ...absoluteBounds === void 0 ? {} : { absoluteBounds },
      ...absoluteRenderBounds === void 0 ? {} : { absoluteRenderBounds },
      ...relativeTransform === void 0 ? {} : { relativeTransform },
      ...absoluteTransform === void 0 ? {} : { absoluteTransform },
      ...rotation === void 0 ? {} : { rotation },
      ...constraints === void 0 ? {} : { constraints },
      ...numberProperties(node, diagnostics, [
        "minWidth",
        "maxWidth",
        "minHeight",
        "maxHeight"
      ])
    };
    return Object.keys(geometry).length === 0 ? void 0 : geometry;
  }
  function numberProperties(node, diagnostics, properties) {
    const result = {};
    for (const property of properties) {
      const value = optionalNumber(node, property, diagnostics);
      if (value !== void 0) {
        result[property] = value;
      }
    }
    return result;
  }
  function collectLayout(node, diagnostics) {
    const stringMapping = [
      ["layoutMode", "mode"],
      ["layoutWrap", "wrap"],
      ["layoutSizingHorizontal", "sizingHorizontal"],
      ["layoutSizingVertical", "sizingVertical"],
      ["primaryAxisSizingMode", "primaryAxisSizingMode"],
      ["counterAxisSizingMode", "counterAxisSizingMode"],
      ["primaryAxisAlignItems", "primaryAxisAlignItems"],
      ["counterAxisAlignItems", "counterAxisAlignItems"],
      ["counterAxisAlignContent", "counterAxisAlignContent"],
      ["layoutPositioning", "layoutPositioning"],
      ["layoutAlign", "layoutAlign"],
      ["overflowDirection", "overflowDirection"],
      ["gridAutoTracks", "gridAutoTracks"],
      ["gridItemsPositioning", "gridItemsPositioning"],
      ["gridChildHorizontalAlign", "gridChildHorizontalAlign"],
      ["gridChildVerticalAlign", "gridChildVerticalAlign"]
    ];
    const layout = {};
    for (const [sourceProperty, irProperty] of stringMapping) {
      const value = optionalString(node, sourceProperty, diagnostics);
      if (value !== void 0) {
        layout[irProperty] = value;
      }
    }
    Object.assign(
      layout,
      numberProperties(node, diagnostics, [
        "itemSpacing",
        "counterAxisSpacing",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "layoutGrow",
        "gridRowCount",
        "gridColumnCount",
        "gridRowGap",
        "gridColumnGap",
        "gridRowAnchorIndex",
        "gridColumnAnchorIndex",
        "gridRowSpan",
        "gridColumnSpan"
      ])
    );
    for (const property of [
      "itemReverseZIndex",
      "strokesIncludedInLayout"
    ]) {
      const value = optionalBoolean(node, property, diagnostics);
      if (value !== void 0) {
        layout[property] = value;
      }
    }
    const grids = collectLayoutGrids(node, diagnostics);
    if (grids !== void 0) {
      layout.grids = grids;
    }
    const inferredAutoLayout = optionalNormalized(
      node,
      "inferredAutoLayout",
      diagnostics
    );
    if (inferredAutoLayout === null || jsonObject2(inferredAutoLayout) !== void 0) {
      layout.inferredAutoLayout = inferredAutoLayout;
    }
    for (const [property, irProperty] of [
      ["gridRowSizes", "gridRowSizes"],
      ["gridColumnSizes", "gridColumnSizes"]
    ]) {
      const normalized = optionalNormalized(node, property, diagnostics);
      if (Array.isArray(normalized)) {
        const tracks = [];
        for (const [index, track] of normalized.entries()) {
          const object = jsonObject2(track);
          if (object === void 0) {
            diagnoseUnexpectedSupportedShape(
              node,
              `${property}[${index}]`,
              diagnostics
            );
          } else {
            tracks.push(object);
          }
        }
        layout[irProperty] = tracks;
      } else if (normalized !== void 0) {
        diagnoseUnexpectedSupportedShape(node, property, diagnostics);
      }
    }
    return Object.keys(layout).length === 0 ? void 0 : layout;
  }
  function normalizeObjectArrayItem(node, property, value, diagnostics) {
    return jsonObject2(normalizeValue(node, property, value, diagnostics));
  }
  function diagnoseUnexpectedSupportedShape(node, propertyPath, diagnostics) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
      severity: "warning",
      message: "A supported property had an unexpected shape and remains explicit in diagnostics.",
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: `$.${propertyPath}`,
      causedDataLoss: true
    });
  }
  function variableBindingsFromJson(value, propertyPath) {
    if (value === void 0) {
      return [];
    }
    const bindings = [];
    const visit = (candidate, path) => {
      if (Array.isArray(candidate)) {
        for (const [index, item] of candidate.entries()) {
          visit(item, `${path}[${index}]`);
        }
        return;
      }
      if (typeof candidate !== "object" || candidate === null) {
        return;
      }
      const object = candidate;
      if (object.type === "VARIABLE_ALIAS" && typeof object.id === "string") {
        bindings.push({
          propertyPath: path,
          variable: { kind: "variable", id: object.id }
        });
        return;
      }
      for (const key of Object.keys(object).sort()) {
        const child = object[key];
        if (child !== void 0) {
          visit(child, `${path}.${key}`);
        }
      }
    };
    visit(value, propertyPath);
    return bindings;
  }
  function colorFromJson(value) {
    const object = value === void 0 ? void 0 : jsonObject2(value);
    if (object === void 0) {
      return void 0;
    }
    const component = (key) => {
      const candidate = object[key];
      if (typeof candidate === "number" || candidate === null) {
        return candidate;
      }
      return key === "a" ? 1 : null;
    };
    return {
      r: component("r"),
      g: component("g"),
      b: component("b"),
      a: component("a")
    };
  }
  function transformFromJson(value) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(
      (row) => Array.isArray(row) && row.length === 3 && row.every((cell) => typeof cell === "number" || cell === null)
    )) {
      return void 0;
    }
    return value;
  }
  function collectPaints(node, property, diagnostics, diagnosticPath = property) {
    const result = readOptional(node, property, diagnostics);
    if (!result.present) {
      return void 0;
    }
    if (result.value === figma.mixed) {
      return FIGMA_MIXED_VALUE;
    }
    if (!Array.isArray(result.value)) {
      if (result.value !== void 0) {
        diagnoseUnexpectedSupportedShape(node, property, diagnostics);
      }
      return void 0;
    }
    const paints = [];
    for (const [index, paint] of result.value.entries()) {
      const raw = normalizeObjectArrayItem(
        node,
        `${diagnosticPath}[${index}]`,
        paint,
        diagnostics
      );
      if (raw === void 0 || typeof raw.type !== "string") {
        diagnoseUnexpectedSupportedShape(
          node,
          `${diagnosticPath}[${index}]`,
          diagnostics
        );
        continue;
      }
      let gradientStops;
      if (raw.gradientStops !== void 0) {
        if (!Array.isArray(raw.gradientStops)) {
          diagnoseUnexpectedSupportedShape(
            node,
            `${diagnosticPath}[${index}].gradientStops`,
            diagnostics
          );
        } else {
          const collectedStops = [];
          for (const [stopIndex, candidate] of raw.gradientStops.entries()) {
            const stop = jsonObject2(candidate);
            const color = stop === void 0 ? void 0 : jsonObject2(stop.color);
            const validPosition = stop !== void 0 && (typeof stop.position === "number" || stop.position === null);
            const validColor = color !== void 0 && [color.r, color.g, color.b, color.a].every(
              (component) => typeof component === "number" || component === null
            );
            if (!validPosition || !validColor) {
              diagnoseUnexpectedSupportedShape(
                node,
                `${diagnosticPath}[${index}].gradientStops[${stopIndex}]`,
                diagnostics
              );
              continue;
            }
            const bindings = variableBindingsFromJson(
              stop.boundVariables,
              `$.${diagnosticPath}[${index}].gradientStops[${stopIndex}].boundVariables`
            );
            collectedStops.push({
              position: stop.position,
              color: {
                r: color.r,
                g: color.g,
                b: color.b,
                a: color.a
              },
              ...bindings.length === 0 ? {} : { boundVariables: bindings }
            });
          }
          gradientStops = collectedStops;
        }
      }
      paints.push({
        paintType: raw.type,
        ...typeof raw.visible === "boolean" ? { visible: raw.visible } : {},
        ...typeof raw.opacity === "number" || raw.opacity === null ? { opacity: raw.opacity } : {},
        ...typeof raw.blendMode === "string" ? { blendMode: raw.blendMode } : {},
        ...colorFromJson(raw.color) === void 0 ? {} : { color: colorFromJson(raw.color) },
        ...gradientStops === void 0 ? {} : { gradientStops },
        ...transformFromJson(raw.gradientTransform) === void 0 ? {} : { gradientTransform: transformFromJson(raw.gradientTransform) },
        ...typeof raw.imageHash === "string" || raw.imageHash === null ? { imageHash: raw.imageHash } : {},
        ...typeof raw.scaleMode === "string" ? { scaleMode: raw.scaleMode } : {},
        ...transformFromJson(raw.imageTransform) === void 0 ? {} : { imageTransform: transformFromJson(raw.imageTransform) },
        ...typeof raw.scalingFactor === "number" || raw.scalingFactor === null ? { scalingFactor: raw.scalingFactor } : {},
        ...typeof raw.rotation === "number" || raw.rotation === null ? { rotation: raw.rotation } : {},
        ...jsonObject2(raw.filters) === void 0 ? {} : { filters: jsonObject2(raw.filters) },
        ...variableBindingsFromJson(
          raw.boundVariables,
          `$.${diagnosticPath}[${index}].boundVariables`
        ).length === 0 ? {} : {
          boundVariables: variableBindingsFromJson(
            raw.boundVariables,
            `$.${diagnosticPath}[${index}].boundVariables`
          )
        },
        raw
      });
    }
    return paints;
  }
  function collectEffects(node, diagnostics) {
    const result = readOptional(node, "effects", diagnostics);
    if (!result.present) {
      return void 0;
    }
    if (result.value === figma.mixed) {
      return FIGMA_MIXED_VALUE;
    }
    if (!Array.isArray(result.value)) {
      if (result.value !== void 0) {
        diagnoseUnexpectedSupportedShape(node, "effects", diagnostics);
      }
      return void 0;
    }
    const effects = [];
    for (const [index, effect] of result.value.entries()) {
      const raw = normalizeObjectArrayItem(
        node,
        `effects[${index}]`,
        effect,
        diagnostics
      );
      if (raw === void 0 || typeof raw.type !== "string" || typeof raw.visible !== "boolean") {
        diagnoseUnexpectedSupportedShape(node, `effects[${index}]`, diagnostics);
        continue;
      }
      effects.push({
        effectType: raw.type,
        visible: raw.visible,
        ...typeof raw.radius === "number" || raw.radius === null ? { radius: raw.radius } : {},
        ...typeof raw.spread === "number" || raw.spread === null ? { spread: raw.spread } : {},
        ...typeof raw.blendMode === "string" ? { blendMode: raw.blendMode } : {},
        ...colorFromJson(raw.color) === void 0 ? {} : { color: colorFromJson(raw.color) },
        ...jsonObject2(raw.offset) === void 0 ? {} : {
          offset: {
            x: typeof jsonObject2(raw.offset).x === "number" || jsonObject2(raw.offset).x === null ? jsonObject2(raw.offset).x : null,
            y: typeof jsonObject2(raw.offset).y === "number" || jsonObject2(raw.offset).y === null ? jsonObject2(raw.offset).y : null
          }
        },
        ...variableBindingsFromJson(
          raw.boundVariables,
          `$.effects[${index}].boundVariables`
        ).length === 0 ? {} : {
          boundVariables: variableBindingsFromJson(
            raw.boundVariables,
            `$.effects[${index}].boundVariables`
          )
        },
        raw
      });
    }
    return effects;
  }
  function collectLayoutGrids(node, diagnostics) {
    const result = readOptional(node, "layoutGrids", diagnostics);
    if (!result.present) {
      return void 0;
    }
    if (result.value === figma.mixed) {
      return FIGMA_MIXED_VALUE;
    }
    if (!Array.isArray(result.value)) {
      if (result.value !== void 0) {
        diagnoseUnexpectedSupportedShape(node, "layoutGrids", diagnostics);
      }
      return void 0;
    }
    const grids = [];
    for (const [index, grid] of result.value.entries()) {
      const raw = normalizeObjectArrayItem(
        node,
        `layoutGrids[${index}]`,
        grid,
        diagnostics
      );
      if (raw === void 0 || typeof raw.pattern !== "string") {
        diagnoseUnexpectedSupportedShape(
          node,
          `layoutGrids[${index}]`,
          diagnostics
        );
        continue;
      }
      grids.push({
        pattern: raw.pattern,
        ...typeof raw.alignment === "string" ? { alignment: raw.alignment } : {},
        ...typeof raw.visible === "boolean" ? { visible: raw.visible } : {},
        ...Object.fromEntries(
          ["sectionSize", "gutterSize", "offset", "count"].flatMap(
            (key) => typeof raw[key] === "number" || raw[key] === null ? [[key, raw[key]]] : []
          )
        ),
        ...colorFromJson(raw.color) === void 0 ? {} : { color: colorFromJson(raw.color) },
        ...variableBindingsFromJson(
          raw.boundVariables,
          `$.layoutGrids[${index}].boundVariables`
        ).length === 0 ? {} : {
          boundVariables: variableBindingsFromJson(
            raw.boundVariables,
            `$.layoutGrids[${index}].boundVariables`
          )
        },
        raw
      });
    }
    return grids;
  }
  function styleReference(node, property, diagnostics) {
    const result = readOptional(node, property, diagnostics);
    if (!result.present) {
      return void 0;
    }
    if (result.value === figma.mixed) {
      return FIGMA_MIXED_VALUE;
    }
    if (result.value === "" || result.value === null) {
      return null;
    }
    if (typeof result.value === "string") {
      return { kind: "style", id: result.value };
    }
    diagnoseUnexpectedSupportedShape(node, property, diagnostics);
    return void 0;
  }
  function collectVisual(node, diagnostics) {
    const opacity = optionalNumber(node, "opacity", diagnostics);
    const blendMode = optionalString(node, "blendMode", diagnostics);
    const isMask = optionalBoolean(node, "isMask", diagnostics);
    const maskType = optionalString(node, "maskType", diagnostics);
    const clipsContent = optionalBoolean(node, "clipsContent", diagnostics);
    const visual = {
      ...opacity === void 0 ? {} : { opacity },
      ...blendMode === void 0 ? {} : { blendMode },
      ...isMask === void 0 ? {} : { isMask },
      ...maskType === void 0 ? {} : { maskType },
      ...clipsContent === void 0 ? {} : { clipsContent }
    };
    const fills = collectPaints(node, "fills", diagnostics);
    const strokes = collectPaints(node, "strokes", diagnostics);
    const backgrounds = collectPaints(node, "backgrounds", diagnostics);
    const effects = collectEffects(node, diagnostics);
    const cornerRadiusResult = readOptional(node, "cornerRadius", diagnostics);
    const cornerRadius = cornerRadiusResult.value === figma.mixed ? FIGMA_MIXED_VALUE : typeof cornerRadiusResult.value === "number" ? optionalNumber(node, "cornerRadius", diagnostics) : void 0;
    const cornerRadiiValue = optionalNormalized(node, "cornerRadii", diagnostics);
    const cornerRadii = Array.isArray(cornerRadiiValue) && cornerRadiiValue.every(
      (value) => typeof value === "number" || value === null
    ) ? cornerRadiiValue : void 0;
    const cornerSmoothing = optionalNumber(node, "cornerSmoothing", diagnostics);
    const strokeGeometry = collectStrokeGeometry(node, diagnostics);
    const fillStyle = styleReference(node, "fillStyleId", diagnostics);
    const strokeStyle = styleReference(node, "strokeStyleId", diagnostics);
    const effectStyle = styleReference(node, "effectStyleId", diagnostics);
    const gridStyle = styleReference(node, "gridStyleId", diagnostics);
    const backgroundStyle = styleReference(
      node,
      "backgroundStyleId",
      diagnostics
    );
    const result = {
      ...visual,
      ...fills === void 0 ? {} : { fills },
      ...strokes === void 0 ? {} : { strokes },
      ...backgrounds === void 0 ? {} : { backgrounds },
      ...effects === void 0 ? {} : { effects },
      ...strokeGeometry === void 0 ? {} : { strokeGeometry },
      ...cornerRadius === void 0 ? {} : { cornerRadius },
      ...cornerRadii === void 0 ? {} : { cornerRadii },
      ...cornerSmoothing === void 0 ? {} : { cornerSmoothing },
      ...fillStyle === void 0 ? {} : { fillStyle },
      ...strokeStyle === void 0 ? {} : { strokeStyle },
      ...effectStyle === void 0 ? {} : { effectStyle },
      ...gridStyle === void 0 ? {} : { gridStyle },
      ...backgroundStyle === void 0 ? {} : { backgroundStyle }
    };
    return Object.keys(result).length === 0 ? void 0 : result;
  }
  function collectStrokeGeometry(node, diagnostics) {
    const weightValue = readOptional(node, "strokeWeight", diagnostics);
    const weight = weightValue.value === figma.mixed ? FIGMA_MIXED_VALUE : numberFromRead(node, "strokeWeight", weightValue, diagnostics);
    const topWeight = optionalNumber(node, "strokeTopWeight", diagnostics);
    const rightWeight = optionalNumber(node, "strokeRightWeight", diagnostics);
    const bottomWeight = optionalNumber(node, "strokeBottomWeight", diagnostics);
    const leftWeight = optionalNumber(node, "strokeLeftWeight", diagnostics);
    const align = optionalString(node, "strokeAlign", diagnostics);
    const cap = optionalNormalized(node, "strokeCap", diagnostics);
    const joinValue = readOptional(node, "strokeJoin", diagnostics);
    const join = joinValue.value === figma.mixed ? FIGMA_MIXED_VALUE : typeof joinValue.value === "string" ? joinValue.value : void 0;
    const miterLimit = optionalNumber(node, "strokeMiterLimit", diagnostics);
    const dashValue = optionalNormalized(node, "dashPattern", diagnostics);
    const dashPattern = Array.isArray(dashValue) && dashValue.every((value) => typeof value === "number" || value === null) ? dashValue : void 0;
    const result = {
      ...weight === void 0 ? {} : { weight },
      ...topWeight === void 0 ? {} : { topWeight },
      ...rightWeight === void 0 ? {} : { rightWeight },
      ...bottomWeight === void 0 ? {} : { bottomWeight },
      ...leftWeight === void 0 ? {} : { leftWeight },
      ...align === void 0 ? {} : { align },
      ...cap === void 0 ? {} : { cap },
      ...join === void 0 ? {} : { join },
      ...miterLimit === void 0 ? {} : { miterLimit },
      ...dashPattern === void 0 ? {} : { dashPattern }
    };
    return Object.keys(result).length === 0 ? void 0 : result;
  }
  function collectVariableBindings(node, diagnostics) {
    const result = readOptional(node, "boundVariables", diagnostics);
    if (!result.present) {
      return void 0;
    }
    if (result.value === void 0) {
      return [];
    }
    const normalized = normalizeValue(
      node,
      "boundVariables",
      result.value,
      diagnostics
    );
    return variableBindingsFromJson(normalized, "$.boundVariables");
  }
  var STYLED_TEXT_FIELDS = [
    "fontName",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "textDecoration",
    "textDecorationStyle",
    "textDecorationOffset",
    "textDecorationThickness",
    "textDecorationColor",
    "textDecorationSkipInk",
    "textCase",
    "lineHeight",
    "letterSpacing",
    "fills",
    "textStyleId",
    "fillStyleId",
    "listOptions",
    "listSpacing",
    "indentation",
    "paragraphIndent",
    "paragraphSpacing",
    "hyperlink",
    "boundVariables",
    "textStyleOverrides",
    "openTypeFeatures"
  ];
  function segmentStyleReference(value) {
    if (value === null || value === "") {
      return null;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value) && value.$type === "figma-mixed") {
      return FIGMA_MIXED_VALUE;
    }
    return typeof value === "string" ? { kind: "style", id: value } : void 0;
  }
  function collectStyledTextSegments(node, diagnostics, characters) {
    let getter;
    try {
      getter = node.getStyledTextSegments;
    } catch (error) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
        severity: "warning",
        message: "Styled text segments could not be read; complete characters remain available.",
        phase: "collection",
        source: sourceForNode(node),
        propertyPath: "$.getStyledTextSegments",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return { segments: [], dependencyRefs: [], complete: false };
    }
    if (typeof getter !== "function") {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
        severity: "warning",
        message: "The styled text segment reader was unavailable; complete characters remain available.",
        phase: "collection",
        source: sourceForNode(node),
        propertyPath: "$.getStyledTextSegments",
        causedDataLoss: true
      });
      return { segments: [], dependencyRefs: [], complete: false };
    }
    let rawSegments;
    try {
      rawSegments = getter.call(node, STYLED_TEXT_FIELDS);
    } catch (error) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
        severity: "warning",
        message: "Styled text segments could not be read; complete characters remain available.",
        phase: "collection",
        source: sourceForNode(node),
        propertyPath: "$.getStyledTextSegments",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return { segments: [], dependencyRefs: [], complete: false };
    }
    if (!Array.isArray(rawSegments)) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
        severity: "warning",
        message: "Styled text segments returned an unsupported value; complete characters remain available.",
        phase: "collection",
        source: sourceForNode(node),
        propertyPath: "$.getStyledTextSegments",
        causedDataLoss: true
      });
      return { segments: [], dependencyRefs: [], complete: false };
    }
    const segments = [];
    const dependencyRefs = [];
    let complete = true;
    let previousEnd = 0;
    for (const [index, rawSegment] of rawSegments.entries()) {
      const normalized = jsonObject2(
        normalizeValue(
          node,
          `getStyledTextSegments[${index}]`,
          rawSegment,
          diagnostics
        )
      );
      if (normalized === void 0) {
        complete = false;
        continue;
      }
      const start = normalized.start;
      const end = normalized.end;
      const segmentCharacters = normalized.characters;
      if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== previousEnd || end < start || end > characters.length || typeof segmentCharacters !== "string" || segmentCharacters !== characters.slice(start, end)) {
        diagnostics.add({
          code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
          severity: "warning",
          message: "A styled text segment had inconsistent UTF-16 offsets and was not represented as complete.",
          phase: "collection",
          source: sourceForNode(node),
          propertyPath: `$.getStyledTextSegments[${index}]`,
          causedDataLoss: true
        });
        complete = false;
        continue;
      }
      previousEnd = end;
      const textStyle = segmentStyleReference(normalized.textStyleId);
      const fillStyle = segmentStyleReference(normalized.fillStyleId);
      for (const reference of [textStyle, fillStyle]) {
        if (reference !== void 0 && reference !== null && !("$type" in reference)) {
          dependencyRefs.push(reference);
        }
      }
      const variableBindings2 = variableBindingsFromJson(
        normalized.boundVariables,
        `$.getStyledTextSegments[${index}].boundVariables`
      );
      dependencyRefs.push(...variableBindings2.map((binding) => binding.variable));
      const fills = Array.isArray(normalized.fills) ? collectPaintsFromNormalized(
        node,
        `getStyledTextSegments[${index}].fills`,
        normalized.fills,
        diagnostics
      ) : void 0;
      if (fills !== void 0) {
        for (const paint of fills) {
          dependencyRefs.push(
            ...(paint.boundVariables ?? []).map(
              (binding) => binding.variable
            )
          );
        }
      }
      const normalizedFields = {};
      for (const property of [
        "fontName",
        "fontSize",
        "fontWeight",
        "textCase",
        "textDecoration",
        "textDecorationStyle",
        "textDecorationOffset",
        "textDecorationThickness",
        "textDecorationColor",
        "letterSpacing",
        "lineHeight",
        "hyperlink"
      ]) {
        const value = normalized[property];
        if (value !== void 0) {
          normalizedFields[property] = value;
        }
      }
      const listOptions = jsonObject2(normalized.listOptions);
      const openTypeFeatures = jsonObject2(normalized.openTypeFeatures);
      let overrides;
      if (normalized.textStyleOverrides !== void 0) {
        if (!Array.isArray(normalized.textStyleOverrides)) {
          diagnoseUnexpectedSupportedShape(
            node,
            `getStyledTextSegments[${index}].textStyleOverrides`,
            diagnostics
          );
          complete = false;
        } else {
          overrides = [];
          for (const [overrideIndex, candidate] of normalized.textStyleOverrides.entries()) {
            const override = jsonObject2(candidate);
            if (override === void 0 || typeof override.type !== "string") {
              diagnoseUnexpectedSupportedShape(
                node,
                `getStyledTextSegments[${index}].textStyleOverrides[${overrideIndex}]`,
                diagnostics
              );
              complete = false;
            } else {
              overrides.push({ type: override.type });
            }
          }
        }
      }
      const segment = {
        start,
        end,
        characters: segmentCharacters,
        ...normalizedFields,
        ...typeof normalized.fontStyle === "string" ? { fontStyle: normalized.fontStyle } : {},
        ...typeof normalized.textDecorationSkipInk === "boolean" || normalized.textDecorationSkipInk === null ? { textDecorationSkipInk: normalized.textDecorationSkipInk } : {},
        ...fills === void 0 ? {} : { fills },
        ...textStyle === void 0 ? {} : { textStyle },
        ...fillStyle === void 0 ? {} : { fillStyle },
        ...listOptions === void 0 ? {} : { listOptions },
        ...typeof normalized.listSpacing === "number" || normalized.listSpacing === null ? { listSpacing: normalized.listSpacing } : {},
        ...typeof normalized.indentation === "number" || normalized.indentation === null ? { indentation: normalized.indentation } : {},
        ...typeof normalized.paragraphIndent === "number" || normalized.paragraphIndent === null ? { paragraphIndent: normalized.paragraphIndent } : {},
        ...typeof normalized.paragraphSpacing === "number" || normalized.paragraphSpacing === null ? { paragraphSpacing: normalized.paragraphSpacing } : {},
        ...openTypeFeatures === void 0 ? {} : { openTypeFeatures },
        ...variableBindings2.length === 0 ? {} : { variableBindings: variableBindings2 },
        ...overrides === void 0 ? {} : { textStyleOverrides: overrides },
        raw: normalized
      };
      segments.push(segment);
    }
    if (characters.length > 0 && previousEnd !== characters.length) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
        severity: "warning",
        message: "Styled text segments did not cover the complete characters value.",
        phase: "collection",
        source: sourceForNode(node),
        propertyPath: "$.getStyledTextSegments",
        causedDataLoss: true
      });
      complete = false;
    }
    return { segments, dependencyRefs, complete };
  }
  function collectPaintsFromNormalized(node, _property, values, diagnostics) {
    const holder = {
      id: safeNodeId(node),
      name: safeNodeName(node) ?? "",
      fills: values
    };
    const collected = collectPaints(holder, "fills", diagnostics, _property);
    if (collected === void 0 || "$type" in collected) {
      return [];
    }
    return collected;
  }
  function collectTextData(node, diagnostics) {
    const charactersResult = readOptional(node, "characters", diagnostics);
    const charactersValue = charactersResult.present && typeof charactersResult.value === "string" ? charactersResult.value : void 0;
    if (charactersResult.present && charactersResult.value !== void 0 && typeof charactersResult.value !== "string") {
      diagnoseUnexpectedSupportedShape(node, "characters", diagnostics);
    }
    const characters = charactersValue ?? {
      $type: "unavailable",
      reason: "property-access-failed"
    };
    const normalizedFields = [
      "fontName",
      "fontSize",
      "fontWeight",
      "textCase",
      "textDecoration",
      "letterSpacing",
      "lineHeight",
      "leadingTrim",
      "hyperlink",
      "listOptions"
    ];
    const normalized = {};
    for (const property of normalizedFields) {
      const value = optionalNormalized(node, property, diagnostics);
      if (value !== void 0) {
        normalized[property] = value;
      }
    }
    const openTypeValue = readOptional(node, "openTypeFeatures", diagnostics);
    const openTypeFeatures = openTypeValue.value === figma.mixed ? FIGMA_MIXED_VALUE : openTypeValue.present ? jsonObject2(
      normalizeValue(
        node,
        "openTypeFeatures",
        openTypeValue.value,
        diagnostics
      )
    ) : void 0;
    const textStyle = styleReference(node, "textStyleId", diagnostics);
    const textAutoResize = optionalString(node, "textAutoResize", diagnostics);
    const textTruncation = optionalString(node, "textTruncation", diagnostics);
    const maxLines = optionalNumber(node, "maxLines", diagnostics);
    const paragraphIndent = optionalNumberOrMixed(
      node,
      "paragraphIndent",
      diagnostics
    );
    const paragraphSpacing = optionalNumberOrMixed(
      node,
      "paragraphSpacing",
      diagnostics
    );
    const listSpacing = optionalNumberOrMixed(node, "listSpacing", diagnostics);
    const hangingPunctuation = optionalBoolean(
      node,
      "hangingPunctuation",
      diagnostics
    );
    const hangingList = optionalBoolean(node, "hangingList", diagnostics);
    const missingFont = optionalBoolean(node, "hasMissingFont", diagnostics);
    if (missingFont === true) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.textMissingFont,
        severity: "warning",
        message: "The text node reports a missing font; the document was not modified or fonts loaded.",
        phase: "collection",
        source: sourceForNode(node),
        propertyPath: "$.hasMissingFont",
        causedDataLoss: false
      });
    }
    const alignHorizontal = optionalString(
      node,
      "textAlignHorizontal",
      diagnostics
    );
    const alignVertical = optionalString(node, "textAlignVertical", diagnostics);
    const autoRename = optionalBoolean(node, "autoRename", diagnostics);
    const segments = charactersValue === void 0 ? { segments: [], dependencyRefs: [], complete: false } : collectStyledTextSegments(node, diagnostics, charactersValue);
    const text = {
      characters,
      segments: segments.segments,
      ...normalized,
      ...openTypeFeatures === void 0 ? {} : { openTypeFeatures },
      ...textStyle === void 0 ? {} : { textStyle },
      ...textAutoResize === void 0 ? {} : { textAutoResize },
      ...textTruncation === void 0 ? {} : { textTruncation },
      ...maxLines === void 0 ? {} : { maxLines },
      ...paragraphIndent === void 0 ? {} : { paragraphIndent },
      ...paragraphSpacing === void 0 ? {} : { paragraphSpacing },
      ...listSpacing === void 0 ? {} : { listSpacing },
      ...hangingPunctuation === void 0 ? {} : { hangingPunctuation },
      ...hangingList === void 0 ? {} : { hangingList },
      ...missingFont === void 0 ? {} : { missingFont },
      ...alignHorizontal === void 0 ? {} : { alignHorizontal },
      ...alignVertical === void 0 ? {} : { alignVertical },
      ...autoRename === void 0 ? {} : { autoRename }
    };
    return {
      text,
      complete: segments.complete,
      dependencyRefs: segments.dependencyRefs
    };
  }
  function collectVectorData(node, diagnostics) {
    const rawFillGeometry = optionalNormalized(node, "fillGeometry", diagnostics);
    const fillGeometry = Array.isArray(rawFillGeometry) ? rawFillGeometry : void 0;
    const vectorNetwork = jsonObject2(
      optionalNormalized(node, "vectorNetwork", diagnostics)
    );
    const rawPaths = optionalNormalized(node, "vectorPaths", diagnostics);
    const vectorPaths = Array.isArray(rawPaths) ? rawPaths : void 0;
    const handleValue = readOptional(node, "handleMirroring", diagnostics);
    const handleMirroring = handleValue.value === figma.mixed ? FIGMA_MIXED_VALUE : typeof handleValue.value === "string" ? handleValue.value : void 0;
    const windingRule = optionalString(node, "windingRule", diagnostics);
    return {
      ...fillGeometry === void 0 ? {} : { fillGeometry },
      ...vectorNetwork === void 0 ? {} : { vectorNetwork },
      ...vectorPaths === void 0 ? {} : { vectorPaths },
      ...handleMirroring === void 0 ? {} : { handleMirroring },
      ...windingRule === void 0 ? {} : { windingRule }
    };
  }
  function collectVariableModes(node, property, diagnostics) {
    const result = readOptional(node, property, diagnostics);
    if (!result.present) {
      return void 0;
    }
    if (result.value === null || typeof result.value !== "object" || Array.isArray(result.value)) {
      diagnoseUnexpectedSupportedShape(node, property, diagnostics);
      return void 0;
    }
    const modes = [];
    for (const [collectionId, modeId] of Object.entries(
      result.value
    ).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      if (typeof modeId !== "string") {
        diagnoseUnexpectedSupportedShape(
          node,
          `${property}.${collectionId}`,
          diagnostics
        );
      } else {
        modes.push({ collectionId, modeId });
      }
    }
    return modes;
  }
  function collectComponentPropertyReferences(node, diagnostics) {
    const result = readOptional(node, "componentPropertyReferences", diagnostics);
    if (!result.present) {
      return void 0;
    }
    if (result.value === null) {
      return null;
    }
    if (typeof result.value !== "object" || Array.isArray(result.value)) {
      diagnoseUnexpectedSupportedShape(
        node,
        "componentPropertyReferences",
        diagnostics
      );
      return void 0;
    }
    const record = result.value;
    const references = {};
    for (const property of ["visible", "characters", "mainComponent"]) {
      if (typeof record[property] === "string") {
        references[property] = record[property];
      } else if (record[property] !== void 0) {
        diagnoseUnexpectedSupportedShape(
          node,
          `componentPropertyReferences.${property}`,
          diagnostics
        );
      }
    }
    return references;
  }
  function collectExportSettings(node, diagnostics) {
    const result = readOptional(node, "exportSettings", diagnostics);
    if (!result.present) {
      return void 0;
    }
    if (!Array.isArray(result.value)) {
      diagnoseUnexpectedSupportedShape(node, "exportSettings", diagnostics);
      return [];
    }
    return result.value.flatMap((setting, index) => {
      const raw = normalizeObjectArrayItem(
        node,
        `exportSettings[${index}]`,
        setting,
        diagnostics
      );
      if (raw === void 0 || typeof raw.format !== "string") {
        diagnoseUnexpectedSupportedShape(
          node,
          `exportSettings[${index}]`,
          diagnostics
        );
        return [];
      }
      return [
        {
          format: raw.format,
          ...typeof raw.suffix === "string" ? { suffix: raw.suffix } : {},
          ...jsonObject2(raw.constraint) === void 0 ? {} : { constraint: jsonObject2(raw.constraint) },
          ...typeof raw.contentsOnly === "boolean" ? { contentsOnly: raw.contentsOnly } : {},
          ...typeof raw.useAbsoluteBounds === "boolean" ? { useAbsoluteBounds: raw.useAbsoluteBounds } : {},
          ...typeof raw.colorProfile === "string" ? { colorProfile: raw.colorProfile } : {},
          ...typeof raw.svgOutlineText === "boolean" ? { svgOutlineText: raw.svgOutlineText } : {},
          ...typeof raw.svgIdAttribute === "boolean" ? { svgIdAttribute: raw.svgIdAttribute } : {},
          ...typeof raw.svgSimplifyStroke === "boolean" ? { svgSimplifyStroke: raw.svgSimplifyStroke } : {}
        }
      ];
    });
  }
  var FAMILY_PROPERTY_NAMES = [
    "arcData",
    "booleanOperation",
    "sectionContentsHidden",
    "detachedInfo",
    "innerRadius",
    "isAsset",
    "isExposedInstance",
    "numberOfFixedChildren",
    "overlayBackground",
    "overlayBackgroundInteraction",
    "overlayPositionType",
    "pointCount",
    "targetAspectRatio",
    "textPathStartData",
    "transformModifiers",
    "vectorNetwork",
    "vectorPaths"
  ];
  function collectFamilyProperties(node, diagnostics) {
    const properties = {};
    for (const property of FAMILY_PROPERTY_NAMES) {
      const value = optionalNormalized(node, property, diagnostics);
      if (value !== void 0) {
        properties[property] = value;
      }
    }
    return Object.keys(properties).length === 0 ? void 0 : properties;
  }
  function childrenOf(node, diagnostics) {
    const diagnosticStart = diagnostics.size();
    const result = readOptional(node, "children", diagnostics, "error");
    if (!result.present) {
      return {
        children: [],
        complete: diagnostics.size() === diagnosticStart
      };
    }
    if (result.value === void 0) {
      diagnoseUnexpectedSupportedShape(node, "children", diagnostics);
      return { children: [], complete: false };
    }
    if (!Array.isArray(result.value)) {
      diagnoseUnexpectedSupportedShape(node, "children", diagnostics);
      return { children: [], complete: false };
    }
    return {
      children: result.value,
      complete: true
    };
  }
  function deduplicateReferences(references) {
    const byIdentity = /* @__PURE__ */ new Map();
    for (const reference of references) {
      const signature = JSON.stringify([reference.kind, reference.id]);
      const existing = byIdentity.get(signature);
      const existingRichness = (existing?.name === void 0 ? 0 : 1) + (existing?.key === void 0 ? 0 : 1) + (existing?.remote === void 0 ? 0 : 1);
      const candidateRichness = (reference.name === void 0 ? 0 : 1) + (reference.key === void 0 ? 0 : 1) + (reference.remote === void 0 ? 0 : 1);
      if (existing === void 0 || candidateRichness > existingRichness) {
        byIdentity.set(signature, reference);
      }
    }
    return sortUnorderedSourceRefs([...byIdentity.values()]);
  }
  function dependencyRefsFromNode(node) {
    const references = [];
    const work = [node];
    while (work.length > 0) {
      const current = work.pop();
      if (current === void 0) {
        continue;
      }
      references.push(
        ...(current.variableBindings ?? []).map((binding) => binding.variable),
        ...(current.explicitVariableModes ?? []).map((mode) => ({
          kind: "collection",
          id: mode.collectionId
        })),
        ...(current.resolvedVariableModes ?? []).map((mode) => ({
          kind: "collection",
          id: mode.collectionId
        }))
      );
      const visual = current.visual;
      if (visual !== void 0) {
        for (const reference of [
          visual.fillStyle,
          visual.strokeStyle,
          visual.effectStyle,
          visual.gridStyle,
          visual.backgroundStyle
        ]) {
          if (reference !== void 0 && reference !== null && !(typeof reference === "object" && "$type" in reference)) {
            references.push(reference);
          }
        }
        const appendBindings = (items) => {
          for (const item of items) {
            if (typeof item === "object" && item !== null && "boundVariables" in item && Array.isArray(item.boundVariables)) {
              for (const binding of item.boundVariables) {
                references.push(binding.variable);
              }
            }
          }
        };
        for (const collection of [
          visual.fills,
          visual.strokes,
          visual.effects,
          visual.backgrounds
        ]) {
          if (Array.isArray(collection)) {
            const items = collection;
            appendBindings(items);
            for (const item of items) {
              if (typeof item === "object" && item !== null && "gradientStops" in item) {
                const stops = item.gradientStops;
                if (Array.isArray(stops)) {
                  appendBindings(stops);
                }
              }
            }
          }
        }
      }
      if (current.layout?.grids !== void 0 && Array.isArray(current.layout.grids)) {
        for (const grid of current.layout.grids) {
          references.push(
            ...(grid.boundVariables ?? []).map((binding) => binding.variable)
          );
        }
      }
      if (current.family === "text") {
        const textStyle = current.text.textStyle;
        if (textStyle !== void 0 && textStyle !== null && !("$type" in textStyle)) {
          references.push(textStyle);
        }
        for (const segment of current.text.segments) {
          for (const style of [segment.textStyle, segment.fillStyle]) {
            if (style !== void 0 && style !== null && !("$type" in style)) {
              references.push(style);
            }
          }
          references.push(
            ...(segment.variableBindings ?? []).map(
              (binding) => binding.variable
            )
          );
          if (Array.isArray(segment.fills)) {
            for (const paint of segment.fills) {
              references.push(
                ...(paint.boundVariables ?? []).map(
                  (binding) => binding.variable
                )
              );
              for (const stop of paint.gradientStops ?? []) {
                references.push(
                  ...(stop.boundVariables ?? []).map(
                    (binding) => binding.variable
                  )
                );
              }
            }
          }
        }
      }
      if (current.family === "component") {
        references.push(current.componentData.component);
        if (current.componentData.componentSet !== void 0) {
          references.push(current.componentData.componentSet);
        }
      }
      if (current.family === "instance") {
        if (current.instanceData.mainComponent !== void 0) {
          references.push(current.instanceData.mainComponent);
        }
        references.push(...current.instanceData.swapTargets ?? []);
        references.push(
          ...(current.instanceData.componentProperties ?? []).flatMap(
            (property) => property.variableBindings.map((binding) => binding.variable)
          )
        );
      }
      if ("children" in current) {
        for (let index = current.children.length - 1; index >= 0; index -= 1) {
          const child = current.children[index];
          if (child !== void 0) {
            work.push(child);
          }
        }
      }
    }
    return references;
  }
  function buildNode(node, page, children2, childOrder, diagnostics, diagnosticStart, annotations, reactionIds, collectedText, enrichment) {
    const idResult = readOptional(node, "id", diagnostics, "error");
    const nameResult = readOptional(node, "name", diagnostics, "error");
    const typeResult = readOptional(node, "type", diagnostics, "error");
    const visibleResult = readOptional(node, "visible", diagnostics, "error");
    const lockedResult = readOptional(node, "locked", diagnostics, "error");
    const nodeId2 = idResult.present && typeof idResult.value === "string" ? idResult.value : safeNodeId(node);
    const nodeName = nameResult.present && typeof nameResult.value === "string" ? nameResult.value : safeNodeName(node);
    const nodeType2 = typeResult.present && typeof typeResult.value === "string" ? typeResult.value : "UNKNOWN";
    const source = {
      kind: "node",
      id: nodeId2,
      ...nodeName === void 0 ? {} : { name: nodeName }
    };
    const parentResult = readOptional(node, "parent", diagnostics, "warning");
    let parentRef;
    let parentType;
    if (parentResult.present && parentResult.value !== null && typeof parentResult.value === "object") {
      try {
        const parent = parentResult.value;
        parentType = typeof parent.type === "string" ? parent.type : void 0;
        if (parentType !== "PAGE" && parentType !== "DOCUMENT" && typeof parent.id === "string") {
          parentRef = {
            kind: "node",
            id: parent.id,
            ...typeof parent.name === "string" ? { name: parent.name } : {}
          };
        }
      } catch (error) {
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message: "A parent reference could not be read and remains explicit in diagnostics.",
          phase: "collection",
          source,
          propertyPath: "$.parent",
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
      }
    }
    const geometry = collectGeometry(node, diagnostics);
    const layout = collectLayout(node, diagnostics);
    const visual = collectVisual(node, diagnostics);
    const variableBindings2 = collectVariableBindings(node, diagnostics);
    const explicitVariableModes = collectVariableModes(
      node,
      "explicitVariableModes",
      diagnostics
    );
    const resolvedVariableModes = collectVariableModes(
      node,
      "resolvedVariableModes",
      diagnostics
    );
    const collectedComponentPropertyReferences = collectComponentPropertyReferences(node, diagnostics);
    const componentPropertyReferences2 = enrichment?.componentPropertyReferencesByNodeId.has(nodeId2) === true ? enrichment.componentPropertyReferencesByNodeId.get(nodeId2) : collectedComponentPropertyReferences;
    const exportSettings = collectExportSettings(node, diagnostics);
    const familyProperties = collectFamilyProperties(node, diagnostics);
    const commonWithoutDiagnostics = {
      source,
      nodeType: nodeType2,
      ...nodeName === void 0 ? {} : { name: nodeName },
      ...page === void 0 ? {} : { page },
      ...parentRef === void 0 ? {} : { parent: parentRef },
      ...childOrder === void 0 || childOrder < 0 ? {} : { childOrder },
      ...visibleResult.present && typeof visibleResult.value === "boolean" ? { visible: visibleResult.value } : {},
      ...lockedResult.present && typeof lockedResult.value === "boolean" ? { locked: lockedResult.value } : {},
      ...geometry === void 0 ? {} : { geometry },
      ...layout === void 0 ? {} : { layout },
      ...visual === void 0 ? {} : { visual },
      ...variableBindings2 === void 0 ? {} : { variableBindings: variableBindings2 },
      ...explicitVariableModes === void 0 ? {} : { explicitVariableModes },
      ...resolvedVariableModes === void 0 || resolvedVariableModes.length === 0 ? {} : { resolvedVariableModes },
      ...componentPropertyReferences2 === void 0 ? {} : { componentPropertyReferences: componentPropertyReferences2 },
      ...exportSettings === void 0 ? {} : { exportSettings },
      ...familyProperties === void 0 ? {} : { familyProperties },
      ...enrichment?.slotLimitViolationsByNodeId.get(nodeId2) === void 0 ? {} : {
        slotLimitViolations: enrichment.slotLimitViolationsByNodeId.get(nodeId2)
      },
      ...annotations === void 0 ? {} : { annotations },
      ...reactionIds === void 0 ? {} : { reactionIds },
      assetRefs: []
    };
    if (!KNOWN_NODE_TYPES.has(nodeType2)) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.irUnknownNodeType,
        severity: "warning",
        message: "An unknown node type was retained with common properties, children, and raw fallback metadata.",
        phase: "collection",
        source,
        propertyPath: "$.type",
        causedDataLoss: false
      });
      return {
        ...commonWithoutDiagnostics,
        family: "unknown",
        unsupportedNodeType: nodeType2,
        raw: {
          $type: "unsupported",
          reason: "unknown",
          runtimeType: "figma-node"
        },
        children: children2,
        diagnosticIds: diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
      };
    }
    if (nodeType2 === "TEXT" || nodeType2 === "TEXT_PATH") {
      return {
        ...commonWithoutDiagnostics,
        family: "text",
        text: collectedText?.text ?? collectTextData(node, diagnostics).text,
        diagnosticIds: diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
      };
    }
    if (VECTOR_NODE_TYPES.has(nodeType2)) {
      return {
        ...commonWithoutDiagnostics,
        family: "vector",
        vector: collectVectorData(node, diagnostics),
        children: children2,
        diagnosticIds: diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
      };
    }
    if (nodeType2 === "COMPONENT" || nodeType2 === "COMPONENT_SET") {
      const componentData = enrichment?.componentDataByNodeId.get(nodeId2);
      return {
        ...commonWithoutDiagnostics,
        family: "component",
        componentData: componentData ?? (enrichment === void 0 ? {
          metadataCoverage: {
            status: "not-collected",
            reason: "Component variants, property definitions, and relationships were not collected in this adapter context."
          },
          component: {
            kind: "component",
            id: nodeId2,
            ...nodeName === void 0 ? {} : { name: nodeName }
          }
        } : {
          metadataCoverage: {
            status: "partial",
            reason: "Supported component metadata was inaccessible during component collection."
          },
          component: {
            kind: "component",
            id: nodeId2,
            ...nodeName === void 0 ? {} : { name: nodeName }
          }
        }),
        children: children2,
        diagnosticIds: diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
      };
    }
    if (nodeType2 === "INSTANCE") {
      const instanceData = enrichment?.instanceDataByNodeId.get(nodeId2);
      return {
        ...commonWithoutDiagnostics,
        family: "instance",
        instanceData: instanceData ?? (enrichment === void 0 ? {
          metadataCoverage: {
            status: "not-collected",
            reason: "Instance properties, overrides, swap targets, and main-component resolution were not collected in this adapter context."
          }
        } : {
          metadataCoverage: {
            status: "partial",
            reason: "Supported instance metadata was inaccessible during instance collection."
          }
        }),
        children: children2,
        diagnosticIds: diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
      };
    }
    if (children2.length > 0 || CONTAINER_NODE_TYPES.has(nodeType2)) {
      return {
        ...commonWithoutDiagnostics,
        family: "container",
        children: children2,
        diagnosticIds: diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
      };
    }
    return {
      ...commonWithoutDiagnostics,
      family: "leaf",
      properties: {},
      diagnosticIds: diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
    };
  }
  async function collectNodeTree(root, page, diagnostics, cancellation, enrichment) {
    const collectionDiagnosticStart = diagnostics.size();
    const work = [{ node: root, exiting: false }];
    const childLists = /* @__PURE__ */ new Map();
    const built = /* @__PURE__ */ new Map();
    const interactionByNode = /* @__PURE__ */ new Map();
    const diagnosticStartByNode = /* @__PURE__ */ new Map();
    const reactions = [];
    const supplementalDependencies = [];
    const nodesById = /* @__PURE__ */ new Map();
    let textSegmentsComplete = true;
    let interactionsComplete = true;
    let childrenComplete = true;
    let visited = 0;
    while (work.length > 0) {
      cancellation.throwIfCancelled();
      const item = work.pop();
      if (item === void 0) {
        break;
      }
      if (!item.exiting) {
        nodesById.set(safeNodeId(item.node), item.node);
        diagnosticStartByNode.set(item.node, diagnostics.size());
        const interactions2 = collectNodeInteractions(item.node, diagnostics);
        interactionByNode.set(item.node, interactions2);
        reactions.push(...interactions2.reactions);
        supplementalDependencies.push(...interactions2.dependencyRefs);
        interactionsComplete &&= interactions2.complete;
        const childResult = childrenOf(item.node, diagnostics);
        const children3 = childResult.children;
        childrenComplete &&= childResult.complete;
        childLists.set(item.node, children3);
        work.push({
          node: item.node,
          exiting: true,
          ...item.childOrder === void 0 ? {} : { childOrder: item.childOrder }
        });
        for (let index = children3.length - 1; index >= 0; index -= 1) {
          const child = children3[index];
          if (child !== void 0) {
            work.push({ node: child, exiting: false, childOrder: index });
          }
        }
        visited += 1;
        if (visited % 50 === 0) {
          await yieldToFigma();
          cancellation.throwIfCancelled();
        }
        continue;
      }
      const children2 = childLists.get(item.node) ?? [];
      const childIr = children2.map((child) => {
        const result = built.get(child);
        if (result === void 0) {
          throw new Error("A child node was not collected before its parent.");
        }
        return result;
      });
      const interactions = interactionByNode.get(item.node) ?? {
        annotations: [],
        reactions: [],
        annotationsAvailable: false,
        reactionsAvailable: false,
        dependencyRefs: [],
        complete: false
      };
      let collectedText;
      try {
        const runtimeType2 = item.node.type;
        if (runtimeType2 === "TEXT" || runtimeType2 === "TEXT_PATH") {
          collectedText = collectTextData(item.node, diagnostics);
          textSegmentsComplete &&= collectedText.complete;
          supplementalDependencies.push(...collectedText.dependencyRefs);
        }
      } catch (error) {
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message: "A node type could not be read while collecting styled text metadata.",
          phase: "collection",
          source: sourceForNode(item.node),
          propertyPath: "$.type",
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
        textSegmentsComplete = false;
      }
      built.set(
        item.node,
        buildNode(
          item.node,
          page,
          childIr,
          item.childOrder,
          diagnostics,
          diagnosticStartByNode.get(item.node) ?? diagnostics.size(),
          interactions.annotationsAvailable ? interactions.annotations : void 0,
          interactions.reactionsAvailable ? interactions.reactions.map((reaction) => reaction.id) : void 0,
          collectedText,
          enrichment
        )
      );
    }
    const tree = built.get(root);
    if (tree === void 0) {
      throw new Error("The selected root could not be collected.");
    }
    let componentMetadataComplete = true;
    const metadataWork = [tree];
    while (metadataWork.length > 0) {
      const current = metadataWork.pop();
      if (current === void 0) {
        continue;
      }
      if (current.family === "component" && current.componentData.metadataCoverage.status !== "collected" || current.family === "instance" && current.instanceData.metadataCoverage.status !== "collected") {
        componentMetadataComplete = false;
      }
      if ("children" in current) {
        for (const child of current.children) {
          metadataWork.push(child);
        }
      }
    }
    const dependencyRefsComplete = diagnostics.listSince(collectionDiagnosticStart).every((diagnostic) => !diagnostic.causedDataLoss) && componentMetadataComplete;
    return {
      tree,
      nodesById,
      dependencyRefs: deduplicateReferences([
        ...dependencyRefsFromNode(tree),
        ...supplementalDependencies
      ]),
      reactions,
      nodeCount: visited,
      coverage: {
        childrenComplete,
        dependencyRefsComplete,
        textSegmentsComplete,
        interactionsComplete
      }
    };
  }

  // src/main/resource-normalization.ts
  function figmaVariableAlias(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return void 0;
    }
    const record = value;
    return record.type === "VARIABLE_ALIAS" && typeof record.id === "string" ? variableAlias(record.id) : void 0;
  }
  function normalizeCollectedResource(value, diagnostics, source, propertyPath) {
    return normalizeJsonSafeValue(value, {
      diagnostics,
      phase: "collection",
      source,
      propertyPath,
      classifySpecialValue: figmaVariableAlias
    }).value;
  }
  function asJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
  }
  function collectVariableBindingsFromValue(value, propertyPath) {
    if (value === void 0) {
      return [];
    }
    const bindings = /* @__PURE__ */ new Map();
    const visit = (candidate, path) => {
      if (Array.isArray(candidate)) {
        for (const [index, item] of candidate.entries()) {
          visit(item, `${path}[${index}]`);
        }
        return;
      }
      if (typeof candidate !== "object" || candidate === null) {
        return;
      }
      const object = candidate;
      const variableId2 = object.$type === "variable-alias" && typeof object.variableId === "string" ? object.variableId : object.type === "VARIABLE_ALIAS" && typeof object.id === "string" ? object.id : void 0;
      if (variableId2 !== void 0) {
        const binding = {
          propertyPath: path,
          variable: { kind: "variable", id: variableId2 }
        };
        bindings.set(JSON.stringify([path, variableId2]), binding);
        return;
      }
      for (const key of Object.keys(object).sort()) {
        const child = object[key];
        if (child !== void 0) {
          visit(child, `${path}[${JSON.stringify(key)}]`);
        }
      }
    };
    visit(value, propertyPath);
    return [...bindings.values()];
  }
  function variableIdsFromBindings(bindings) {
    return [...new Set(bindings.map((binding) => binding.variable.id))].sort();
  }

  // src/main/collect-styles.ts
  function defaultApi2() {
    return figma;
  }
  function sourceForStyle(style) {
    return {
      kind: "style",
      id: style.id,
      key: style.key,
      name: style.name,
      remote: style.remote
    };
  }
  async function readLocalStyleKind(label, read, options) {
    options.cancellation.throwIfCancelled();
    try {
      const styles = await read();
      options.cancellation.throwIfCancelled();
      return { items: styles, complete: true };
    } catch (error) {
      options.cancellation.throwIfCancelled();
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.styleCollectionFailed,
        severity: "error",
        message: `Local ${label} styles could not be read; the styles index is incomplete.`,
        phase: "collection",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return { items: [], complete: false };
    }
  }
  async function includeStyleById(id, api, stylesById, options) {
    if (stylesById.has(id)) {
      return;
    }
    options.cancellation.throwIfCancelled();
    try {
      const style = await api.getStyleByIdAsync(id);
      options.cancellation.throwIfCancelled();
      if (style === null) {
        options.diagnostics.add({
          code: DIAGNOSTIC_CODES.styleReferenceUnavailable,
          severity: "warning",
          message: "A referenced style is not accessible and was not imported.",
          phase: "collection",
          source: { kind: "style", id },
          causedDataLoss: true
        });
        return;
      }
      stylesById.set(style.id, style);
    } catch (error) {
      options.cancellation.throwIfCancelled();
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.styleReferenceReadFailed,
        severity: "warning",
        message: "A referenced style could not be read and was not imported.",
        phase: "collection",
        source: { kind: "style", id },
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
    }
  }
  function normalizedProperties(style, diagnostics) {
    const values = {
      type: style.type,
      ...style.descriptionMarkdown === void 0 ? {} : { descriptionMarkdown: style.descriptionMarkdown },
      ...style.documentationLinks === void 0 ? {} : { documentationLinks: style.documentationLinks },
      ...style.boundVariables === void 0 ? {} : { boundVariables: style.boundVariables }
    };
    if (style.type === "PAINT") {
      values.paints = style.paints ?? [];
    } else if (style.type === "EFFECT") {
      values.effects = style.effects ?? [];
    } else if (style.type === "GRID") {
      values.layoutGrids = style.layoutGrids ?? [];
    } else {
      for (const property of [
        "fontSize",
        "textDecoration",
        "fontName",
        "letterSpacing",
        "lineHeight",
        "leadingTrim",
        "paragraphIndent",
        "paragraphSpacing",
        "listSpacing",
        "hangingPunctuation",
        "hangingList",
        "textCase"
      ]) {
        const value = style[property];
        if (value !== void 0) {
          values[property] = value;
        }
      }
    }
    return normalizeCollectedResource(
      values,
      diagnostics,
      sourceForStyle(style),
      ["properties"]
    );
  }
  function bindingsForProperties(properties) {
    return collectVariableBindingsFromValue(properties, "$.properties");
  }
  function paintItems(style, properties, diagnostics) {
    if (!Array.isArray(properties.paints)) {
      return [];
    }
    const result = [];
    for (const [index, value] of properties.paints.entries()) {
      const raw = asJsonObject(value);
      if (raw === void 0 || typeof raw.type !== "string") {
        diagnoseMalformedStyleItem(style, `$.paints[${index}]`, diagnostics);
        continue;
      }
      const bindings = collectVariableBindingsFromValue(
        raw.boundVariables,
        `$.paints[${index}].boundVariables`
      );
      result.push({
        paintType: raw.type,
        ...typeof raw.visible === "boolean" ? { visible: raw.visible } : {},
        ...typeof raw.opacity === "number" || raw.opacity === null ? { opacity: raw.opacity } : {},
        ...typeof raw.blendMode === "string" ? { blendMode: raw.blendMode } : {},
        ...typeof raw.imageHash === "string" || raw.imageHash === null ? { imageHash: raw.imageHash } : {},
        ...typeof raw.scaleMode === "string" ? { scaleMode: raw.scaleMode } : {},
        ...bindings.length === 0 ? {} : { boundVariables: bindings },
        raw
      });
    }
    return result;
  }
  function diagnoseMalformedStyleItem(style, propertyPath, diagnostics) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
      severity: "warning",
      message: "A supported style item had an unexpected runtime shape and was retained in the style raw properties.",
      phase: "collection",
      source: sourceForStyle(style),
      propertyPath,
      causedDataLoss: true
    });
  }
  function effectItems(style, properties, diagnostics) {
    if (!Array.isArray(properties.effects)) {
      return [];
    }
    const result = [];
    for (const [index, value] of properties.effects.entries()) {
      const raw = asJsonObject(value);
      if (raw === void 0 || typeof raw.type !== "string" || typeof raw.visible !== "boolean") {
        diagnoseMalformedStyleItem(style, `$.effects[${index}]`, diagnostics);
        continue;
      }
      const bindings = collectVariableBindingsFromValue(
        raw.boundVariables,
        `$.effects[${index}].boundVariables`
      );
      result.push({
        effectType: raw.type,
        visible: raw.visible,
        ...typeof raw.radius === "number" || raw.radius === null ? { radius: raw.radius } : {},
        ...typeof raw.spread === "number" || raw.spread === null ? { spread: raw.spread } : {},
        ...typeof raw.blendMode === "string" ? { blendMode: raw.blendMode } : {},
        ...bindings.length === 0 ? {} : { boundVariables: bindings },
        raw
      });
    }
    return result;
  }
  function gridItems(style, properties, diagnostics) {
    if (!Array.isArray(properties.layoutGrids)) {
      return [];
    }
    const result = [];
    for (const [index, value] of properties.layoutGrids.entries()) {
      const raw = asJsonObject(value);
      if (raw === void 0 || typeof raw.pattern !== "string") {
        diagnoseMalformedStyleItem(style, `$.layoutGrids[${index}]`, diagnostics);
        continue;
      }
      const bindings = collectVariableBindingsFromValue(
        raw.boundVariables,
        `$.layoutGrids[${index}].boundVariables`
      );
      result.push({
        pattern: raw.pattern,
        ...typeof raw.alignment === "string" ? { alignment: raw.alignment } : {},
        ...typeof raw.visible === "boolean" ? { visible: raw.visible } : {},
        ...typeof raw.sectionSize === "number" || raw.sectionSize === null ? { sectionSize: raw.sectionSize } : {},
        ...typeof raw.gutterSize === "number" || raw.gutterSize === null ? { gutterSize: raw.gutterSize } : {},
        ...typeof raw.offset === "number" || raw.offset === null ? { offset: raw.offset } : {},
        ...typeof raw.count === "number" || raw.count === null ? { count: raw.count } : {},
        ...bindings.length === 0 ? {} : { boundVariables: bindings },
        raw
      });
    }
    return result;
  }
  function referencedBy(styleId, options) {
    const unique = /* @__PURE__ */ new Map();
    for (const source of options.referencedByByStyleId.get(styleId) ?? []) {
      unique.set(
        JSON.stringify([
          source.kind,
          source.id,
          source.key,
          source.name,
          source.remote
        ]),
        source
      );
    }
    return sortUnorderedSourceRefs([...unique.values()]);
  }
  function collectStyle(style, diagnosticStart, options) {
    const source = sourceForStyle(style);
    const properties = normalizedProperties(style, options.diagnostics);
    const variableBindings2 = bindingsForProperties(properties);
    const common = () => ({
      source,
      description: style.description,
      properties,
      variableBindings: variableBindings2,
      referencedBy: referencedBy(style.id, options),
      diagnosticIds: options.diagnostics.listSince(diagnosticStart).filter(
        (diagnostic) => diagnostic.source?.kind === "style" && diagnostic.source.id === style.id
      ).map((diagnostic) => diagnostic.id)
    });
    if (style.type === "PAINT") {
      const paints = paintItems(style, properties, options.diagnostics);
      return {
        ...common(),
        styleType: "paint",
        paints,
        assetRefs: []
      };
    }
    if (style.type === "TEXT") {
      return { ...common(), styleType: "text", properties };
    }
    if (style.type === "EFFECT") {
      const effects = effectItems(style, properties, options.diagnostics);
      return {
        ...common(),
        styleType: "effect",
        effects
      };
    }
    if (style.type === "GRID") {
      const grids = gridItems(style, properties, options.diagnostics);
      return {
        ...common(),
        styleType: "grid",
        grids
      };
    }
    const raw = normalizeCollectedResource(style, options.diagnostics, source, [
      "raw"
    ]);
    return {
      ...common(),
      styleType: "unknown",
      raw: asJsonObject(raw) ?? {
        $type: "unsupported",
        runtimeType: typeof style,
        reason: "unknown"
      }
    };
  }
  async function collectStyles(options) {
    const diagnosticStart = options.diagnostics.size();
    const api = options.api ?? defaultApi2();
    const localReads = [
      await readLocalStyleKind(
        "paint",
        () => api.getLocalPaintStylesAsync(),
        options
      ),
      await readLocalStyleKind(
        "text",
        () => api.getLocalTextStylesAsync(),
        options
      ),
      await readLocalStyleKind(
        "effect",
        () => api.getLocalEffectStylesAsync(),
        options
      ),
      await readLocalStyleKind(
        "grid",
        () => api.getLocalGridStylesAsync(),
        options
      )
    ];
    const localGroups = localReads.map((read) => read.items);
    const localStyles = localGroups.flat();
    const stylesById = new Map(localStyles.map((style) => [style.id, style]));
    for (const styleId of [...new Set(options.referencedStyleIds)].sort()) {
      await includeStyleById(styleId, api, stylesById, options);
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    const styles = [...stylesById.values()].sort(
      (left, right) => compareSourceRefs(sourceForStyle(left), sourceForStyle(right))
    ).map((style) => collectStyle(style, diagnosticStart, options));
    options.cancellation.throwIfCancelled();
    const referencedVariableIds = variableIdsFromBindings(
      styles.flatMap((style) => {
        const nested = style.styleType === "paint" ? style.paints.flatMap((paint) => paint.boundVariables ?? []) : style.styleType === "effect" ? style.effects.flatMap((effect) => effect.boundVariables ?? []) : style.styleType === "grid" ? style.grids.flatMap((grid) => grid.boundVariables ?? []) : [];
        return [...style.variableBindings, ...nested];
      })
    );
    const artifact = {
      kind: "design-ir-styles",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      styles,
      diagnosticIds: options.diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
    };
    return {
      artifact,
      localCount: localStyles.filter((style) => style.remote === false).length,
      accessibleReferences: styles.map((style) => style.source),
      referencedVariableIds,
      localEnumerationComplete: localReads.every((read) => read.complete)
    };
  }

  // src/shared/aliases.ts
  var AliasResolutionContractError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "AliasResolutionContractError";
    }
  };
  function compareStrings(left, right) {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  }
  function compareStates(left, right) {
    return compareStrings(left.variableId, right.variableId) || compareStrings(left.modeId, right.modeId);
  }
  function stateKey(state) {
    return JSON.stringify([state.variableId, state.modeId]);
  }
  function contextKey(context) {
    return JSON.stringify(
      [...context.entries()].sort(
        ([left], [right]) => compareStrings(left, right)
      )
    );
  }
  function issueSignature(parts) {
    return JSON.stringify(parts);
  }
  function orderedModes(requestedOrder) {
    return [...requestedOrder];
  }
  function isMissingModeValue(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const objectValue2 = value;
    return objectValue2.$type === "unavailable" && objectValue2.reason === "missing-mode";
  }
  function canonicalCycle(states) {
    if (states.length === 0) {
      return states;
    }
    let minimumIndex = 0;
    for (let index = 1; index < states.length; index += 1) {
      const candidate = states[index];
      const minimum = states[minimumIndex];
      if (candidate !== void 0 && minimum !== void 0 && compareStates(candidate, minimum) < 0) {
        minimumIndex = index;
      }
    }
    const rotated = [
      ...states.slice(minimumIndex),
      ...states.slice(0, minimumIndex)
    ];
    const first = rotated[0];
    return first === void 0 ? rotated : [...rotated, first];
  }
  function cycleFromState(states, startIndex) {
    const rotated = [...states.slice(startIndex), ...states.slice(0, startIndex)];
    const first = rotated[0];
    return first === void 0 ? [] : [...rotated.map((state) => state.variableId), first.variableId];
  }
  function formatCycle(states) {
    return states.map((state) => `${state.variableId}@${state.modeId}`).join(" -> ");
  }
  function resolveVariableAliases(input) {
    const diagnosticStart = input.diagnostics.size();
    const byId = /* @__PURE__ */ new Map();
    for (const variable of input.variables) {
      if (byId.has(variable.source.id)) {
        throw new AliasResolutionContractError(
          "Alias resolution requires unique variable source IDs."
        );
      }
      byId.set(variable.source.id, variable);
    }
    const modeOrderByCollection = /* @__PURE__ */ new Map();
    for (const collection of input.collections) {
      if (modeOrderByCollection.has(collection.id)) {
        throw new AliasResolutionContractError(
          "Alias resolution requires unique collection IDs."
        );
      }
      if (collection.modeOrder.length === 0 || new Set(collection.modeOrder).size !== collection.modeOrder.length) {
        throw new AliasResolutionContractError(
          "Alias resolution requires each collection to declare a non-empty, duplicate-free mode order."
        );
      }
      modeOrderByCollection.set(collection.id, collection.modeOrder);
    }
    for (const variable of input.variables) {
      const collectionModes = modeOrderByCollection.get(variable.collectionId);
      if (collectionModes === void 0) {
        throw new AliasResolutionContractError(
          "Alias resolution requires every variable to reference a declared collection."
        );
      }
      const declaredModes = new Set(collectionModes);
      const valueModes = Object.keys(variable.valuesByMode);
      if (valueModes.some((modeId) => !declaredModes.has(modeId))) {
        throw new AliasResolutionContractError(
          "Alias resolution values must use modes declared by their collection."
        );
      }
      if (collectionModes.some(
        (modeId) => !Object.hasOwn(variable.valuesByMode, modeId)
      )) {
        throw new AliasResolutionContractError(
          "Alias resolution requires an explicit raw or tagged unavailable value for every declared mode."
        );
      }
    }
    for (const [collectionId, modeId] of Object.entries(
      input.selectedModesByCollection ?? {}
    )) {
      const collectionModes = modeOrderByCollection.get(collectionId);
      if (collectionModes === void 0 || !collectionModes.includes(modeId)) {
        throw new AliasResolutionContractError(
          "Alias resolution context must select a declared mode from a declared collection."
        );
      }
    }
    const issues = /* @__PURE__ */ new Map();
    const cachesByContext = /* @__PURE__ */ new Map();
    const baseModeContext = /* @__PURE__ */ new Map();
    for (const [collectionId, modes] of modeOrderByCollection) {
      if (modes.length === 1 && modes[0] !== void 0) {
        baseModeContext.set(collectionId, modes[0]);
      }
    }
    for (const [collectionId, modeId] of Object.entries(
      input.selectedModesByCollection ?? {}
    )) {
      baseModeContext.set(collectionId, modeId);
    }
    const targetMode = (current, currentModeId, target, context) => {
      if (target.collectionId === current.collectionId) {
        return { kind: "mode", modeId: currentModeId };
      }
      const contextualMode = context.get(target.collectionId);
      if (contextualMode !== void 0) {
        return { kind: "mode", modeId: contextualMode };
      }
      const modes = modeOrderByCollection.get(target.collectionId);
      const onlyMode = modes?.length === 1 ? modes[0] : void 0;
      return onlyMode === void 0 ? { kind: "requires-consumer-context" } : { kind: "mode", modeId: onlyMode };
    };
    const walk = (start, modeContext) => {
      const cacheIdentifier = contextKey(modeContext);
      let cache = cachesByContext.get(cacheIdentifier);
      if (cache === void 0) {
        cache = /* @__PURE__ */ new Map();
        cachesByContext.set(cacheIdentifier, cache);
      }
      const states = [];
      const localIndexes = /* @__PURE__ */ new Map();
      let current = start;
      let outcome;
      for (; ; ) {
        const currentKey = stateKey(current);
        const cached = cache.get(currentKey);
        if (cached !== void 0) {
          outcome = cached;
          break;
        }
        const cycleStart = localIndexes.get(currentKey);
        if (cycleStart !== void 0) {
          const cycleStates = states.slice(cycleStart);
          const canonical = canonicalCycle(cycleStates);
          for (let index = 0; index < cycleStates.length; index += 1) {
            const cycleState = cycleStates[index];
            if (cycleState !== void 0) {
              cache.set(stateKey(cycleState), {
                status: "cycle",
                aliasChain: cycleFromState(cycleStates, index),
                cycle: canonical
              });
            }
          }
          outcome = cache.get(currentKey);
          if (outcome === void 0) {
            throw new AliasResolutionContractError(
              "Alias cycle resolution failed to produce a stable result."
            );
          }
          break;
        }
        localIndexes.set(currentKey, states.length);
        states.push(current);
        const variable = byId.get(current.variableId);
        if (variable === void 0) {
          outcome = {
            status: "missing-reference",
            aliasChain: [current.variableId],
            missingId: current.variableId
          };
          cache.set(currentKey, outcome);
          break;
        }
        if (!Object.hasOwn(variable.valuesByMode, current.modeId)) {
          outcome = {
            status: "missing-mode",
            aliasChain: [current.variableId],
            missingId: current.variableId
          };
          cache.set(currentKey, outcome);
          break;
        }
        const rawValue = variable.valuesByMode[current.modeId];
        if (rawValue === void 0) {
          throw new AliasResolutionContractError(
            "Alias resolution values must be canonical JSON values."
          );
        }
        if (isMissingModeValue(rawValue)) {
          outcome = {
            status: "missing-mode",
            aliasChain: [current.variableId],
            missingId: current.variableId
          };
          cache.set(currentKey, outcome);
          break;
        }
        if (!isVariableAliasValue(rawValue)) {
          outcome = {
            status: "resolved",
            resolved: rawValue,
            aliasChain: [current.variableId]
          };
          cache.set(currentKey, outcome);
          break;
        }
        const target = byId.get(rawValue.variableId);
        if (target === void 0) {
          current = {
            variableId: rawValue.variableId,
            modeId: current.modeId
          };
          continue;
        }
        const nextMode = targetMode(
          variable,
          current.modeId,
          target,
          modeContext
        );
        if (nextMode.kind === "requires-consumer-context") {
          outcome = {
            status: "requires-consumer-context",
            aliasChain: [current.variableId, target.source.id],
            contextCollectionId: target.collectionId
          };
          cache.set(currentKey, outcome);
          break;
        }
        current = {
          variableId: target.source.id,
          modeId: nextMode.modeId
        };
      }
      for (let index = states.length - 1; index >= 0; index -= 1) {
        const state = states[index];
        if (state === void 0) {
          continue;
        }
        const key = stateKey(state);
        const stateResult = cache.get(key);
        if (stateResult !== void 0) {
          outcome = stateResult;
          continue;
        }
        if (outcome === void 0) {
          throw new AliasResolutionContractError(
            "Alias resolution failed to retain its terminal result."
          );
        }
        outcome = {
          ...outcome,
          aliasChain: [state.variableId, ...outcome.aliasChain]
        };
        cache.set(key, outcome);
      }
      const result = cache.get(stateKey(start));
      if (result === void 0) {
        throw new AliasResolutionContractError(
          "Alias resolution failed to produce a result for the starting variable."
        );
      }
      return result;
    };
    const sortedVariables = [...input.variables].sort(
      (left, right) => compareSourceRefs(left.source, right.source)
    );
    const resolvedVariables = sortedVariables.map((variable) => {
      const values = orderedModes(
        modeOrderByCollection.get(variable.collectionId) ?? []
      ).map((modeId) => {
        const raw = variable.valuesByMode[modeId];
        if (raw === void 0) {
          throw new AliasResolutionContractError(
            "Alias resolution values must be canonical JSON values."
          );
        }
        const modeContext = new Map(baseModeContext);
        modeContext.set(variable.collectionId, modeId);
        const result = walk(
          { variableId: variable.source.id, modeId },
          modeContext
        );
        if (result.status === "requires-consumer-context") {
          const collectionId = result.contextCollectionId ?? "unknown-collection";
          const signature = issueSignature([
            "requires-consumer-context",
            variable.source.id,
            modeId,
            collectionId
          ]);
          issues.set(signature, {
            signature,
            code: DIAGNOSTIC_CODES.variableAliasRequiresConsumerContext,
            severity: "warning",
            message: `Variable alias resolution for mode "${modeId}" requires a consuming node mode for collection "${collectionId}".`,
            source: variable.source,
            modeId,
            causedDataLoss: false
          });
        } else if (result.status === "missing-reference") {
          const missingId = result.missingId ?? "unknown";
          const signature = issueSignature([
            "missing-reference",
            variable.source.id,
            modeId,
            missingId
          ]);
          issues.set(signature, {
            signature,
            code: DIAGNOSTIC_CODES.variableAliasMissingReference,
            severity: "warning",
            message: `Variable alias target "${missingId}" is not accessible for mode "${modeId}".`,
            source: variable.source,
            modeId,
            causedDataLoss: true
          });
        } else if (result.status === "missing-mode") {
          const missingId = result.missingId ?? "unknown";
          const signature = issueSignature([
            "missing-mode",
            variable.source.id,
            modeId,
            missingId
          ]);
          issues.set(signature, {
            signature,
            code: DIAGNOSTIC_CODES.variableAliasMissingMode,
            severity: "warning",
            message: `Variable "${missingId}" has no accessible raw value for mode "${modeId}".`,
            source: variable.source,
            modeId,
            causedDataLoss: true
          });
        } else if (result.status === "cycle") {
          const cycle = result.cycle ?? [];
          const canonicalSourceId = cycle[0]?.variableId ?? variable.source.id;
          const canonicalSource = byId.get(canonicalSourceId)?.source ?? variable.source;
          const signature = issueSignature([
            "cycle",
            cycle.map((state) => [state.variableId, state.modeId])
          ]);
          issues.set(signature, {
            signature,
            code: DIAGNOSTIC_CODES.variableAliasCycle,
            severity: "error",
            message: `Variable alias cycle detected: ${formatCycle(cycle)}.`,
            source: canonicalSource,
            modeId: cycle[0]?.modeId ?? modeId,
            causedDataLoss: true
          });
        }
        return {
          modeId,
          raw,
          status: result.status,
          ...result.resolved === void 0 ? {} : { resolved: result.resolved },
          aliasChain: result.aliasChain,
          resolutionContext: [...modeContext.entries()].sort(([left], [right]) => compareStrings(left, right)).map(([collectionId, contextModeId]) => ({
            collectionId,
            modeId: contextModeId
          }))
        };
      });
      return {
        source: variable.source,
        values
      };
    });
    const sortedIssues = [...issues.values()].sort(
      (left, right) => compareStrings(left.signature, right.signature)
    );
    for (const issue of sortedIssues) {
      input.diagnostics.add({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        phase: "alias-resolution",
        source: issue.source,
        propertyPath: `$.valuesByMode[${JSON.stringify(issue.modeId)}]`,
        causedDataLoss: issue.causedDataLoss
      });
    }
    return {
      variables: resolvedVariables,
      diagnostics: input.diagnostics.listSince(diagnosticStart)
    };
  }

  // src/main/collect-variables.ts
  function sourceForVariable(variable) {
    return {
      kind: "variable",
      id: variable.id,
      key: variable.key,
      name: variable.name,
      remote: variable.remote
    };
  }
  function sourceForCollection(collection) {
    return {
      kind: "collection",
      id: collection.id,
      key: collection.key,
      name: collection.name,
      remote: collection.remote
    };
  }
  function aliasId(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return void 0;
    }
    const object = value;
    return object.type === "VARIABLE_ALIAS" && typeof object.id === "string" ? object.id : void 0;
  }
  function missingModeValue() {
    return { $type: "unavailable", reason: "missing-mode" };
  }
  function defaultApi3() {
    return {
      getLocalVariableCollectionsAsync: async () => await figma.variables.getLocalVariableCollectionsAsync(),
      getLocalVariablesAsync: async () => await figma.variables.getLocalVariablesAsync(),
      getVariableByIdAsync: async (id) => await figma.variables.getVariableByIdAsync(
        id
      ),
      getVariableCollectionByIdAsync: async (id) => await figma.variables.getVariableCollectionByIdAsync(id)
    };
  }
  async function readLocalCollections(api, options) {
    options.cancellation.throwIfCancelled();
    try {
      const collections = await api.getLocalVariableCollectionsAsync();
      options.cancellation.throwIfCancelled();
      return { items: collections, complete: true };
    } catch (error) {
      options.cancellation.throwIfCancelled();
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.variableCollectionFailed,
        severity: "error",
        message: "Local variable collections could not be read; the variables index is incomplete.",
        phase: "collection",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return { items: [], complete: false };
    }
  }
  async function readLocalVariables(api, options) {
    options.cancellation.throwIfCancelled();
    try {
      const variables = await api.getLocalVariablesAsync();
      options.cancellation.throwIfCancelled();
      return { items: variables, complete: true };
    } catch (error) {
      options.cancellation.throwIfCancelled();
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.variableCollectionFailed,
        severity: "error",
        message: "Local variables could not be read; the variables index is incomplete.",
        phase: "collection",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return { items: [], complete: false };
    }
  }
  async function includeVariableById(id, api, variablesById, options) {
    if (variablesById.has(id)) {
      return;
    }
    options.cancellation.throwIfCancelled();
    try {
      const variable = await api.getVariableByIdAsync(id);
      options.cancellation.throwIfCancelled();
      if (variable === null) {
        options.diagnostics.add({
          code: DIAGNOSTIC_CODES.variableReferenceUnavailable,
          severity: "warning",
          message: "A referenced variable is not accessible and was not imported.",
          phase: "collection",
          source: { kind: "variable", id },
          causedDataLoss: true
        });
        return;
      }
      variablesById.set(variable.id, variable);
    } catch (error) {
      options.cancellation.throwIfCancelled();
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.variableReferenceReadFailed,
        severity: "warning",
        message: "A referenced variable could not be read and was not imported.",
        phase: "collection",
        source: { kind: "variable", id },
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
    }
  }
  async function includeCollectionById(id, api, collectionsById, options) {
    if (collectionsById.has(id)) {
      return;
    }
    options.cancellation.throwIfCancelled();
    try {
      const collection = await api.getVariableCollectionByIdAsync(id);
      options.cancellation.throwIfCancelled();
      if (collection === null) {
        options.diagnostics.add({
          code: DIAGNOSTIC_CODES.variableCollectionUnavailable,
          severity: "warning",
          message: "The collection for an accessible referenced variable is not accessible and was not imported.",
          phase: "collection",
          source: { kind: "collection", id },
          causedDataLoss: true
        });
        return;
      }
      collectionsById.set(collection.id, collection);
    } catch (error) {
      options.cancellation.throwIfCancelled();
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.variableCollectionFailed,
        severity: "warning",
        message: "The collection for an accessible referenced variable could not be read and was not imported.",
        phase: "collection",
        source: { kind: "collection", id },
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
    }
  }
  async function includeCollectionClosure(initialIds, api, collectionsById, options) {
    const pending = new Set(initialIds);
    const attempted = /* @__PURE__ */ new Set();
    while (true) {
      const id = [...pending].filter((item) => !attempted.has(item)).sort()[0];
      if (id === void 0) {
        return;
      }
      attempted.add(id);
      await includeCollectionById(id, api, collectionsById, options);
      const collection = collectionsById.get(id);
      if (collection !== void 0 && collection.isExtension) {
        if (collection.parentVariableCollectionId !== void 0) {
          pending.add(collection.parentVariableCollectionId);
        }
        if (collection.rootVariableCollectionId !== void 0) {
          pending.add(collection.rootVariableCollectionId);
        }
      }
    }
  }
  function normalizeVariableValues(variable, collection, rawValuesByMode, options, propertyPrefix = "valuesByMode") {
    const source = sourceForVariable(variable);
    const result = {};
    const knownModes = new Set(collection.modes.map((mode) => mode.modeId));
    for (const mode of collection.modes) {
      if (!Object.hasOwn(rawValuesByMode, mode.modeId)) {
        result[mode.modeId] = missingModeValue();
        continue;
      }
      const raw = rawValuesByMode[mode.modeId];
      const targetId = aliasId(raw);
      result[mode.modeId] = targetId === void 0 ? normalizeCollectedResource(raw, options.diagnostics, source, [
        propertyPrefix,
        mode.modeId
      ]) : variableAlias(targetId);
    }
    for (const modeId of Object.keys(rawValuesByMode).sort()) {
      if (!knownModes.has(modeId)) {
        options.diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "error",
          message: "A variable exposed a value for a mode absent from its accessible collection; that value cannot be ordered safely.",
          phase: "collection",
          source,
          propertyPath: `$.${propertyPrefix}[${JSON.stringify(modeId)}]`,
          causedDataLoss: true
        });
      }
    }
    return result;
  }
  function collectionIr(collection, options, publishStatus) {
    const variableOverrides = collection.variableOverrides === void 0 ? void 0 : normalizeCollectedResource(
      collection.variableOverrides,
      options.diagnostics,
      sourceForCollection(collection),
      ["variableOverrides"]
    );
    return {
      source: sourceForCollection(collection),
      defaultModeId: collection.defaultModeId,
      modes: collection.modes.map((mode) => ({
        id: mode.modeId,
        name: mode.name,
        ...mode.parentModeId === void 0 ? {} : { parentModeId: mode.parentModeId }
      })),
      variableIds: [...collection.variableIds],
      hiddenFromPublishing: collection.hiddenFromPublishing,
      ...publishStatus === void 0 ? {} : { publishStatus },
      isExtension: collection.isExtension,
      ...collection.parentVariableCollectionId === void 0 ? {} : {
        parentVariableCollectionId: collection.parentVariableCollectionId
      },
      ...collection.rootVariableCollectionId === void 0 ? {} : { rootVariableCollectionId: collection.rootVariableCollectionId },
      ...variableOverrides === void 0 ? {} : { variableOverrides }
    };
  }
  async function readPublishStatus(resource, source, options) {
    if (resource.getPublishStatusAsync === void 0) {
      return void 0;
    }
    options.cancellation.throwIfCancelled();
    try {
      const status = await resource.getPublishStatusAsync();
      options.cancellation.throwIfCancelled();
      return status;
    } catch (error) {
      options.cancellation.throwIfCancelled();
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.resourcePublishStatusFailed,
        severity: "warning",
        message: "A supported resource publish status could not be read.",
        phase: "collection",
        source,
        propertyPath: "$.getPublishStatusAsync",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return void 0;
    }
  }
  function collectAliasIds(value, target) {
    const directId = aliasId(value);
    if (directId !== void 0) {
      target.add(directId);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collectAliasIds(item, target);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const key of Object.keys(value).sort()) {
      collectAliasIds(value[key], target);
    }
  }
  async function readValuesByMode(variable, collection, options) {
    if (!collection.isExtension) {
      return variable.valuesByMode;
    }
    if (variable.valuesByModeForCollectionAsync === void 0) {
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.variableCollectionFailed,
        severity: "error",
        message: "An extended variable collection requires inherited mode values, but the required async API is unavailable.",
        phase: "collection",
        source: sourceForVariable(variable),
        propertyPath: "$.valuesByModeForCollectionAsync",
        causedDataLoss: true
      });
      return {};
    }
    options.cancellation.throwIfCancelled();
    try {
      const values = await variable.valuesByModeForCollectionAsync(collection);
      options.cancellation.throwIfCancelled();
      return values;
    } catch (error) {
      options.cancellation.throwIfCancelled();
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.variableCollectionFailed,
        severity: "error",
        message: "Inherited or overridden values for an extended variable collection could not be read.",
        phase: "collection",
        source: sourceForVariable(variable),
        propertyPath: "$.valuesByModeForCollectionAsync",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      return {};
    }
  }
  function valueViewKey(variableId2, collectionId) {
    return JSON.stringify([variableId2, collectionId]);
  }
  async function collectVariables(options) {
    const diagnosticStart = options.diagnostics.size();
    const api = options.api ?? defaultApi3();
    const localCollectionRead = await readLocalCollections(api, options);
    const localVariableRead = await readLocalVariables(api, options);
    const localCollections = localCollectionRead.items;
    const localVariables = localVariableRead.items;
    const collectionsById = new Map(
      localCollections.map((collection) => [collection.id, collection])
    );
    const variablesById = new Map(
      localVariables.map((variable) => [variable.id, variable])
    );
    const pendingIds = new Set(options.referencedVariableIds);
    for (const variable of localVariables) {
      collectAliasIds(variable.valuesByMode, pendingIds);
    }
    for (const collection of localCollections) {
      collectAliasIds(collection.variableOverrides, pendingIds);
    }
    const attempted = /* @__PURE__ */ new Set();
    while (true) {
      const nextId = [...pendingIds].filter((id) => !attempted.has(id)).sort()[0];
      if (nextId === void 0) {
        break;
      }
      attempted.add(nextId);
      await includeVariableById(nextId, api, variablesById, options);
      const included = variablesById.get(nextId);
      if (included !== void 0) {
        collectAliasIds(included.valuesByMode, pendingIds);
      }
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    await includeCollectionClosure(
      [
        ...options.referencedCollectionIds ?? [],
        ...new Set(
          [...variablesById.values()].map(
            (variable) => variable.variableCollectionId
          )
        )
      ],
      api,
      collectionsById,
      options
    );
    const orderedExtendedCollections = [...collectionsById.values()].filter((collection) => collection.isExtension).sort(
      (left, right) => compareSourceRefs(sourceForCollection(left), sourceForCollection(right))
    );
    for (const collection of orderedExtendedCollections) {
      for (const variableId2 of collection.variableIds) {
        await includeVariableById(variableId2, api, variablesById, options);
        const variable = variablesById.get(variableId2);
        if (variable !== void 0) {
          await includeCollectionClosure(
            [variable.variableCollectionId],
            api,
            collectionsById,
            options
          );
        }
      }
    }
    const overrideAliasIds = /* @__PURE__ */ new Set();
    for (const collection of collectionsById.values()) {
      collectAliasIds(collection.variableOverrides, overrideAliasIds);
    }
    for (const id of [...overrideAliasIds].sort()) {
      await includeVariableById(id, api, variablesById, options);
      const included = variablesById.get(id);
      if (included !== void 0) {
        await includeCollectionClosure(
          [included.variableCollectionId],
          api,
          collectionsById,
          options
        );
      }
    }
    const rawValuesByVariableId = /* @__PURE__ */ new Map();
    const extendedValuesByVariableAndCollection = /* @__PURE__ */ new Map();
    const valuesAttempted = /* @__PURE__ */ new Set();
    while (true) {
      const nextVariable = [...variablesById.values()].filter((variable) => !valuesAttempted.has(variable.id)).sort(
        (left, right) => compareSourceRefs(sourceForVariable(left), sourceForVariable(right))
      )[0];
      if (nextVariable === void 0) {
        break;
      }
      valuesAttempted.add(nextVariable.id);
      const collection = collectionsById.get(nextVariable.variableCollectionId);
      if (collection === void 0) {
        continue;
      }
      const rawValues = await readValuesByMode(nextVariable, collection, options);
      rawValuesByVariableId.set(nextVariable.id, rawValues);
      const discoveredIds = /* @__PURE__ */ new Set();
      collectAliasIds(rawValues, discoveredIds);
      for (const id of [...discoveredIds].sort()) {
        await includeVariableById(id, api, variablesById, options);
        const included = variablesById.get(id);
        if (included !== void 0) {
          await includeCollectionClosure(
            [included.variableCollectionId],
            api,
            collectionsById,
            options
          );
        }
      }
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    for (const collection of orderedExtendedCollections) {
      for (const variableId2 of collection.variableIds) {
        const variable = variablesById.get(variableId2);
        if (variable === void 0) {
          continue;
        }
        const values = await readValuesByMode(variable, collection, options);
        extendedValuesByVariableAndCollection.set(
          valueViewKey(variable.id, collection.id),
          values
        );
        const discoveredIds = /* @__PURE__ */ new Set();
        collectAliasIds(values, discoveredIds);
        for (const id of [...discoveredIds].sort()) {
          await includeVariableById(id, api, variablesById, options);
          const included = variablesById.get(id);
          if (included !== void 0) {
            await includeCollectionClosure(
              [included.variableCollectionId],
              api,
              collectionsById,
              options
            );
          }
        }
        await yieldToFigma();
        options.cancellation.throwIfCancelled();
      }
    }
    while (true) {
      const nextVariable = [...variablesById.values()].filter((variable) => !valuesAttempted.has(variable.id)).sort(
        (left, right) => compareSourceRefs(sourceForVariable(left), sourceForVariable(right))
      )[0];
      if (nextVariable === void 0) {
        break;
      }
      valuesAttempted.add(nextVariable.id);
      const collection = collectionsById.get(nextVariable.variableCollectionId);
      if (collection === void 0) {
        continue;
      }
      const rawValues = await readValuesByMode(nextVariable, collection, options);
      rawValuesByVariableId.set(nextVariable.id, rawValues);
      const discoveredIds = /* @__PURE__ */ new Set();
      collectAliasIds(rawValues, discoveredIds);
      for (const id of [...discoveredIds].sort()) {
        await includeVariableById(id, api, variablesById, options);
        const included = variablesById.get(id);
        if (included !== void 0) {
          await includeCollectionClosure(
            [included.variableCollectionId],
            api,
            collectionsById,
            options
          );
        }
      }
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    const variablesWithCollections = [];
    for (const variable of variablesById.values()) {
      if (!collectionsById.has(variable.variableCollectionId)) {
        options.diagnostics.add({
          code: DIAGNOSTIC_CODES.variableCollectionUnavailable,
          severity: "warning",
          message: "An accessible variable cannot be serialized safely because its collection and mode order are unavailable.",
          phase: "collection",
          source: sourceForVariable(variable),
          propertyPath: "$.variableCollectionId",
          causedDataLoss: true
        });
        continue;
      }
      variablesWithCollections.push(variable);
    }
    const aliasInputs = variablesWithCollections.map((variable) => ({
      source: sourceForVariable(variable),
      collectionId: variable.variableCollectionId,
      valuesByMode: normalizeVariableValues(
        variable,
        collectionsById.get(variable.variableCollectionId),
        rawValuesByVariableId.get(variable.id) ?? variable.valuesByMode,
        options
      )
    }));
    const orderedCollectionResources = [...collectionsById.values()].sort(
      (left, right) => compareSourceRefs(sourceForCollection(left), sourceForCollection(right))
    );
    const collectionPublishStatus = /* @__PURE__ */ new Map();
    for (const collection of orderedCollectionResources) {
      const status = await readPublishStatus(
        collection,
        sourceForCollection(collection),
        options
      );
      if (status !== void 0) {
        collectionPublishStatus.set(collection.id, status);
      }
    }
    const collections = orderedCollectionResources.map(
      (collection) => collectionIr(
        collection,
        options,
        collectionPublishStatus.get(collection.id)
      )
    );
    options.cancellation.throwIfCancelled();
    const resolution = resolveVariableAliases({
      variables: aliasInputs,
      collections: collections.map((collection) => ({
        id: collection.source.id,
        modeOrder: collection.modes.map((mode) => mode.id)
      })),
      diagnostics: options.diagnostics
    });
    options.cancellation.throwIfCancelled();
    const extendedValuesByVariableId = /* @__PURE__ */ new Map();
    for (const collection of orderedExtendedCollections) {
      const memberIds = new Set(collection.variableIds);
      const viewInputs = variablesWithCollections.map((variable) => {
        const owningCollection = collectionsById.get(
          variable.variableCollectionId
        );
        const isMember = memberIds.has(variable.id);
        return {
          source: sourceForVariable(variable),
          collectionId: isMember ? collection.id : variable.variableCollectionId,
          valuesByMode: normalizeVariableValues(
            variable,
            isMember ? collection : owningCollection,
            isMember ? extendedValuesByVariableAndCollection.get(
              valueViewKey(variable.id, collection.id)
            ) ?? {} : rawValuesByVariableId.get(variable.id) ?? variable.valuesByMode,
            options,
            isMember ? `extendedCollectionValues[${JSON.stringify(collection.id)}]` : "valuesByMode"
          )
        };
      });
      const viewResolution = resolveVariableAliases({
        variables: viewInputs,
        collections: collections.map((candidate) => ({
          id: candidate.source.id,
          modeOrder: candidate.modes.map((mode) => mode.id)
        })),
        diagnostics: options.diagnostics
      });
      for (const resolved of viewResolution.variables) {
        if (!memberIds.has(resolved.source.id)) {
          continue;
        }
        const views = extendedValuesByVariableId.get(resolved.source.id) ?? [];
        views.push({ collectionId: collection.id, values: resolved.values });
        extendedValuesByVariableId.set(resolved.source.id, views);
      }
    }
    const metadataById = new Map(
      [...variablesById.values()].map((variable) => [variable.id, variable])
    );
    const variablePublishStatus = /* @__PURE__ */ new Map();
    for (const variable of [...variablesWithCollections].sort(
      (left, right) => compareSourceRefs(sourceForVariable(left), sourceForVariable(right))
    )) {
      const status = await readPublishStatus(
        variable,
        sourceForVariable(variable),
        options
      );
      if (status !== void 0) {
        variablePublishStatus.set(variable.id, status);
      }
    }
    const variables = resolution.variables.map((resolved) => {
      const variable = metadataById.get(resolved.source.id);
      const source = sourceForVariable(variable);
      const codeSyntax = normalizeCollectedResource(
        variable.codeSyntax,
        options.diagnostics,
        source,
        ["codeSyntax"]
      );
      return {
        source,
        collectionId: variable.variableCollectionId,
        resolvedType: variable.resolvedType,
        description: variable.description,
        scopes: [...variable.scopes],
        codeSyntax,
        hiddenFromPublishing: variable.hiddenFromPublishing,
        ...variablePublishStatus.get(variable.id) === void 0 ? {} : { publishStatus: variablePublishStatus.get(variable.id) },
        values: resolved.values,
        ...extendedValuesByVariableId.get(variable.id) === void 0 ? {} : {
          extendedCollectionValues: extendedValuesByVariableId.get(
            variable.id
          )
        },
        diagnosticIds: options.diagnostics.listSince(diagnosticStart).filter(
          (diagnostic) => diagnostic.source?.kind === "variable" && diagnostic.source.id === variable.id
        ).map((diagnostic) => diagnostic.id)
      };
    });
    const diagnosticIds = options.diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id);
    const artifact = {
      kind: "design-ir-variables",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      collections,
      variables,
      diagnosticIds
    };
    return {
      artifact,
      localCount: localVariables.filter((variable) => variable.remote === false).length,
      accessibleReferences: variables.map((variable) => variable.source),
      localEnumerationComplete: localCollectionRead.complete && localVariableRead.complete
    };
  }

  // src/shared/png.ts
  var PngContractError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "PngContractError";
    }
  };
  var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  function planPreviewExport(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new PngContractError(
        "Preview source dimensions must be finite and positive."
      );
    }
    const longestDimension = Math.max(width, height);
    if (longestDimension <= 4096) {
      return {
        constraint: { type: "SCALE", value: 1 },
        scale: 1
      };
    }
    return {
      constraint: {
        type: width >= height ? "WIDTH" : "HEIGHT",
        value: 4096
      },
      scale: 4096 / longestDimension
    };
  }
  function readUint32BigEndian(bytes, offset) {
    return bytes[offset] * 16777216 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3];
  }
  function readPngDimensions(bytes) {
    if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") {
      throw new PngContractError("Preview bytes are not a canonical PNG stream.");
    }
    const width = readUint32BigEndian(bytes, 16);
    const height = readUint32BigEndian(bytes, 20);
    if (width <= 0 || height <= 0) {
      throw new PngContractError("PNG preview dimensions must be positive.");
    }
    return { width, height };
  }

  // src/main/export-preview.ts
  var ENTIRE_FILE_PREVIEW_NODE_TYPES = /* @__PURE__ */ new Set([
    "FRAME",
    "COMPONENT",
    "COMPONENT_SET"
  ]);
  function isEligibleEntireFilePreviewNode(node) {
    return ENTIRE_FILE_PREVIEW_NODE_TYPES.has(node.type) && node.visible && Number.isFinite(node.width) && Number.isFinite(node.height) && node.width > 0 && node.height > 0;
  }
  function selectEntireFilePreviewCandidates(page) {
    const candidates = [];
    for (const pageChild of page.children) {
      if (isEligibleEntireFilePreviewNode(pageChild)) {
        candidates.push(pageChild);
        continue;
      }
      if (pageChild.type !== "SECTION" || !pageChild.visible || pageChild.sectionContentsHidden === true) {
        continue;
      }
      for (const sectionChild of pageChild.children ?? []) {
        if (isEligibleEntireFilePreviewNode(sectionChild)) {
          candidates.push(sectionChild);
        }
      }
    }
    return candidates;
  }
  function previewBounds(root) {
    const bounds = root.absoluteRenderBounds ?? root.absoluteBoundingBox ?? null;
    if (bounds === null || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
      throw new Error("Preview bounds are unavailable.");
    }
    return bounds;
  }
  async function exportNodePreview(node, snapshotId, diagnostics, cancellation, entryByteLimit) {
    const path = archivePaths.preview(snapshotId, node.id);
    try {
      cancellation.throwIfCancelled();
      const bounds = previewBounds(node);
      const plan = planPreviewExport(bounds.width, bounds.height);
      cancellation.throwIfCancelled();
      const bytes = await node.exportAsync({
        format: "PNG",
        constraint: plan.constraint
      });
      cancellation.throwIfCancelled();
      await assertArchiveEntryFits(bytes, {
        byteLimit: entryByteLimit,
        checkpoint: () => cancellation.throwIfCancelled()
      });
      const dimensions = readPngDimensions(bytes);
      if (Math.max(dimensions.width, dimensions.height) > 4096) {
        throw new Error("The bounded preview exceeded its maximum dimension.");
      }
      cancellation.throwIfCancelled();
      const contentSha256 = sha256Hex(bytes);
      cancellation.throwIfCancelled();
      return {
        bytes,
        preview: {
          sourceNode: { kind: "node", id: node.id, name: node.name },
          archivePath: path,
          mediaType: "image/png",
          sourceBounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height
          },
          exportedBounds: {
            x: 0,
            y: 0,
            width: dimensions.width,
            height: dimensions.height
          },
          scale: plan.scale,
          byteLength: bytes.length,
          contentSha256,
          diagnosticIds: []
        }
      };
    } catch (error) {
      if (error instanceof ExportCancelledError) {
        throw error;
      }
      cancellation.throwIfCancelled();
      if (error instanceof ArchiveProducerSafetyError && error.code === "archive-capacity-exceeded") {
        const diagnostic2 = diagnostics.add({
          code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
          severity: "error",
          message: "A preview exceeded the safe single-entry archive limit and is absent.",
          phase: "preview",
          source: { kind: "node", id: node.id, name: node.name },
          artifactPath: path,
          causedDataLoss: true
        });
        return { diagnosticId: diagnostic2.id };
      }
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.previewExportFailed,
        severity: "error",
        message: "A required preview could not be exported and is absent.",
        phase: "preview",
        source: { kind: "node", id: node.id, name: node.name },
        artifactPath: path,
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "unknown")
      });
      return { diagnosticId: diagnostic.id };
    }
  }
  var exportSelectedRootPreview = exportNodePreview;

  // src/main/export-entire-file.ts
  var EXPORTER_PACKAGE_VERSION = "0.2.0";
  function elapsedMs(start, now) {
    const elapsed = now() - start;
    return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0;
  }
  function pageLabel(pageIndex, pageTotal) {
    return `Page ${pageIndex + 1} of ${pageTotal}`;
  }
  function componentCollectionLabel(pageIndex, pageTotal, progress) {
    const stage = progress.stage === "instance-lookup" ? "instance resolution" : progress.stage === "id-lookup" ? "dependency resolution" : progress.stage === "complete" ? "component graph complete" : "component graph";
    return `${pageLabel(pageIndex, pageTotal)}; ${stage}; ${progress.traversedNodes} nodes; ${progress.instanceLookupsCompleted}/${progress.instanceLookupsStarted} instance lookups; ${progress.idLookupsCompleted}/${progress.idLookupsStarted} dependency lookups; ${progress.definitionsDiscovered} definitions; ${progress.reusedDefinitionTraversals} reused; ${progress.duplicateDefinitionQueuesSkipped} duplicate queues skipped`;
  }
  function postProgress(options, phase, completed, total, currentLabel, durationMs) {
    void options.postMessage({
      type: "progress",
      protocolVersion: PROTOCOL_VERSION,
      exportId: options.exportId,
      phase,
      completed,
      ...total === void 0 ? {} : { total },
      ...currentLabel === void 0 ? {} : { currentLabel },
      ...durationMs === void 0 ? {} : { durationMs }
    });
  }
  function sourceRefForPage(page) {
    return { kind: "page", id: page.id, name: page.name };
  }
  function emittedRequirement(path) {
    return { path, status: "emitted" };
  }
  function unavailableRequirement(path, diagnosticId) {
    return { path, status: "unavailable", diagnosticId };
  }
  function entryMessage(exportId, descriptor) {
    return {
      type: "archive-entry",
      protocolVersion: PROTOCOL_VERSION,
      exportId,
      path: descriptor.metadata.path,
      mediaType: descriptor.metadata.mediaType,
      compression: descriptor.metadata.compression,
      data: descriptor.data
    };
  }
  async function emitEntry(options, requirements, path, mediaType, compression, data) {
    options.cancellation.throwIfCancelled();
    await options.postMessage(
      entryMessage(options.exportId, {
        metadata: {
          path,
          mediaType,
          compression,
          uncompressedByteLength: data.length
        },
        data
      })
    );
    requirements.push(emittedRequirement(path));
    options.cancellation.throwIfCancelled();
  }
  function collectionCount(value, complete, reason) {
    return complete ? { status: "collected", value, coverage: "file-local" } : {
      status: "partial",
      value,
      coverage: "file-local",
      reason
    };
  }
  function referenceKey(reference) {
    return `${reference.kind}\0${reference.id}`;
  }
  function addReference(target, reference) {
    const key = referenceKey(reference);
    const existing = target.get(key);
    if (existing === void 0 || existing.name === void 0 && reference.name !== void 0 || existing.key === void 0 && reference.key !== void 0) {
      target.set(key, reference);
    }
  }
  function directStyleReferences(node) {
    const references = [];
    for (const reference of [
      node.visual?.fillStyle,
      node.visual?.strokeStyle,
      node.visual?.effectStyle,
      node.visual?.gridStyle,
      node.visual?.backgroundStyle,
      ...node.family === "text" ? [
        node.text.textStyle,
        ...node.text.segments.flatMap((segment) => [
          segment.textStyle,
          segment.fillStyle
        ])
      ] : []
    ]) {
      if (reference !== void 0 && reference !== null && !("$type" in reference) && reference.kind === "style") {
        references.push(reference);
      }
    }
    return references;
  }
  async function mergeStyleUsageFromTree(tree, target, cancellation) {
    const work = [tree];
    let visited = 0;
    while (work.length > 0) {
      cancellation.throwIfCancelled();
      const node = work.pop();
      if (node === void 0) {
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
          if (child !== void 0) {
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
  function dependencyKey(dependency) {
    return `${referenceKey(dependency.from)}\0${referenceKey(
      dependency.to
    )}\0${dependency.relationship}`;
  }
  function mergeComponents(collected, state) {
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
  function assetKey(asset) {
    return `${asset.assetKind}\0${asset.source.id}\0${asset.archivePath}`;
  }
  function deduplicateAssets2(assets) {
    const byKey = /* @__PURE__ */ new Map();
    for (const asset of assets) {
      byKey.set(assetKey(asset), asset);
    }
    return [...byKey.values()].sort((left, right) => {
      const leftKey = assetKey(left);
      const rightKey = assetKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }
  async function serializePageArtifact(artifact, normalizedTrees, pageDiagnosticStart, pagePath, diagnostics, options) {
    const preflightOptions = {
      byteLimit: options.pageArtifactByteLimit,
      checkpoint: () => options.cancellation.throwIfCancelled()
    };
    try {
      await assertCanonicalJsonFits(artifact, preflightOptions);
    } catch (error) {
      if (error instanceof ExportCancelledError) {
        throw error;
      }
      options.cancellation.throwIfCancelled();
      if (!(error instanceof ArchiveProducerSafetyError) || error.code !== "archive-capacity-exceeded") {
        throw error;
      }
      diagnostics.add({
        code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
        severity: "error",
        message: "A canonical page's normalized trees exceeded the safe single-entry archive limit. The page index retains direct-root order, references, reactions, assets, previews, diagnostics, and any available raw fallback, but its normalized trees are absent.",
        phase: "serialization",
        source: artifact.source,
        artifactPath: pagePath,
        propertyPath: "$.normalizedTrees",
        causedDataLoss: true
      });
      normalizedTrees.length = 0;
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
      const fallback = {
        ...artifact,
        normalizedTrees: [],
        coverage: {
          ...artifact.coverage,
          textSegments: {
            status: "partial",
            reason: "Normalized page trees were omitted after exceeding the safe single-entry archive limit, so styled text segments are not present in canonical node context."
          },
          annotationsAndAccessibility: {
            status: "partial",
            reason: "Normalized page trees were omitted after exceeding the safe single-entry archive limit, so annotations are not present in canonical node context; the installed Plugin API exposes no accessibility/ARIA fields."
          }
        },
        diagnosticIds: diagnostics.listSince(pageDiagnosticStart).map((diagnostic) => diagnostic.id)
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
  function emptyComponents(diagnosticId) {
    return {
      index: {
        kind: "design-ir-components",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        definitions: [],
        dependencies: [],
        diagnosticIds: diagnosticId === void 0 ? [] : [diagnosticId]
      },
      componentDataByNodeId: /* @__PURE__ */ new Map(),
      instanceDataByNodeId: /* @__PURE__ */ new Map(),
      componentPropertyReferencesByNodeId: /* @__PURE__ */ new Map(),
      slotLimitViolationsByNodeId: /* @__PURE__ */ new Map(),
      dependencyRefs: [],
      complete: diagnosticId === void 0,
      definitionNodesById: /* @__PURE__ */ new Map()
    };
  }
  function clearCollectedMap(values) {
    values.clear();
  }
  function releaseCollectedComponents(components) {
    components.index.definitions.length = 0;
    components.index.dependencies.length = 0;
    components.index.diagnosticIds.length = 0;
    components.dependencyRefs.length = 0;
    clearCollectedMap(components.componentDataByNodeId);
    clearCollectedMap(components.instanceDataByNodeId);
    clearCollectedMap(components.componentPropertyReferencesByNodeId);
    clearCollectedMap(components.slotLimitViolationsByNodeId);
    clearCollectedMap(components.definitionNodesById);
  }
  function withRootMetadata(tree, rawArtifact, diagnosticIds) {
    return {
      ...tree,
      ...rawArtifact === void 0 ? {} : { rawArtifact },
      diagnosticIds
    };
  }
  async function exportRaw(target, source, path, api, diagnostics, cancellation, entryByteLimit) {
    try {
      cancellation.throwIfCancelled();
      const raw = await target.exportAsync({ format: "JSON_REST_V1" });
      cancellation.throwIfCancelled();
      const normalized = normalizeJsonSafeValue(raw, {
        diagnostics,
        phase: "normalization",
        source,
        classifySpecialValue: (value) => value === api.mixed ? { $type: "figma-mixed" } : void 0
      }).value;
      cancellation.throwIfCancelled();
      const text = serializeCanonicalJson(normalized);
      cancellation.throwIfCancelled();
      await assertArchiveEntryFits(text, {
        byteLimit: entryByteLimit,
        checkpoint: () => cancellation.throwIfCancelled()
      });
      return {
        artifact: { path, mediaType: "application/json" },
        text
      };
    } catch (error) {
      if (error instanceof ExportCancelledError) {
        throw error;
      }
      cancellation.throwIfCancelled();
      if (error instanceof ArchiveProducerSafetyError && error.code === "archive-capacity-exceeded") {
        const diagnostic2 = diagnostics.add({
          code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
          severity: "error",
          message: source.kind === "page" ? "A page raw REST-like artifact exceeded the safe single-entry archive limit and is absent; normalized page IR continues." : "A component raw REST-like artifact exceeded the safe single-entry archive limit and is absent; normalized component IR continues.",
          phase: "raw",
          source,
          artifactPath: path,
          causedDataLoss: true
        });
        return { diagnosticId: diagnostic2.id };
      }
      if (error instanceof ArchiveProducerSafetyError) {
        throw error;
      }
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.rawExportFailed,
        severity: "error",
        message: source.kind === "page" ? "A page raw REST-like export failed; normalized page IR continues when available." : "A component raw REST-like export failed; normalized component IR continues when available.",
        phase: "raw",
        source,
        artifactPath: path,
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "unknown")
      });
      return { diagnosticId: diagnostic.id };
    }
  }
  async function emitRawArtifact(target, source, path, api, diagnostics, requirements, options) {
    const result = await exportRaw(
      target,
      source,
      path,
      api,
      diagnostics,
      options.cancellation,
      options.optionalArtifactByteLimit
    );
    if ("text" in result) {
      await emitEntry(
        options,
        requirements,
        result.artifact.path,
        result.artifact.mediaType,
        "deflate",
        result.text
      );
      return result.artifact;
    }
    requirements.push(unavailableRequirement(path, result.diagnosticId));
    return void 0;
  }
  function owningPageRefForNode(node) {
    const visited = /* @__PURE__ */ new Set();
    let current = node;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      if (current.type === "PAGE") {
        return sourceRefForPage(current);
      }
      current = current.parent;
    }
    return void 0;
  }
  async function emitComponentDefinition(definition, node, components, componentSummaryIds, snapshotId, api, diagnostics, requirements, assets, options) {
    const path = archivePaths.irComponentDefinition(
      snapshotId,
      definition.source.id
    );
    const rawPath = archivePaths.rawRestComponent(
      snapshotId,
      definition.source.id
    );
    const diagnosticStart = diagnostics.size();
    if (node === void 0) {
      const irDiagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.componentDefinitionExportFailed,
        severity: "error",
        message: "An indexed component definition has no accessible node for canonical export.",
        phase: "collection",
        source: definition.source,
        artifactPath: path,
        causedDataLoss: true
      });
      const rawDiagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.rawExportFailed,
        severity: "error",
        message: "An indexed component definition has no accessible node for its raw REST-like fallback.",
        phase: "raw",
        source: definition.source,
        artifactPath: rawPath,
        causedDataLoss: true
      });
      requirements.push(
        unavailableRequirement(path, irDiagnostic.id),
        unavailableRequirement(rawPath, rawDiagnostic.id)
      );
      for (const markdown of projectComponentMarkdown(
        snapshotId,
        {
          ...definition,
          diagnosticIds: [
            ...definition.diagnosticIds,
            irDiagnostic.id,
            rawDiagnostic.id
          ]
        },
        void 0,
        {
          dependencies: components.index.dependencies,
          componentSummaryIds
        }
      )) {
        await emitEntry(
          options,
          requirements,
          markdown.path,
          "text/markdown",
          "deflate",
          markdown.text
        );
      }
      return {
        dependencyRefs: [],
        styleUsage: /* @__PURE__ */ new Map(),
        diagnosticIds: [irDiagnostic.id, rawDiagnostic.id]
      };
    }
    const rawArtifact = await emitRawArtifact(
      node,
      definition.source,
      rawPath,
      api,
      diagnostics,
      requirements,
      options
    );
    try {
      options.cancellation.throwIfCancelled();
      const collected = await collectNodeTree(
        node,
        owningPageRefForNode(node),
        diagnostics,
        options.cancellation,
        components
      );
      options.cancellation.throwIfCancelled();
      const collectedAssets = await assets.collectTree(
        collected.tree,
        collected.nodesById
      );
      options.cancellation.throwIfCancelled();
      const styleUsage = /* @__PURE__ */ new Map();
      try {
        await mergeStyleUsageFromTree(
          collectedAssets.tree,
          styleUsage,
          options.cancellation
        );
      } catch (error) {
        if (error instanceof ExportCancelledError || error instanceof ArchiveProducerSafetyError) {
          throw error;
        }
        options.cancellation.throwIfCancelled();
        diagnostics.add({
          code: DIAGNOSTIC_CODES.componentDefinitionExportFailed,
          severity: "error",
          message: "A component definition's style-usage index could not be completed; its canonical definition remains available.",
          phase: "collection",
          source: definition.source,
          artifactPath: path,
          propertyPath: "$.styleUsage",
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "unknown")
        });
      }
      const diagnosticIds = [
        .../* @__PURE__ */ new Set([
          ...diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id),
          ...collectedAssets.diagnosticIds
        ])
      ];
      const normalizedTree = withRootMetadata(
        collectedAssets.tree,
        rawArtifact,
        diagnosticIds
      );
      const artifact = {
        kind: "design-ir-component-definition",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        source: definition.source,
        dependencyRefs: collected.dependencyRefs,
        normalizedTree,
        reactions: collected.reactions,
        assets: collectedAssets.assets,
        coverage: {
          dependencies: collected.coverage.dependencyRefsComplete ? { status: "collected" } : {
            status: "partial",
            reason: "Some component dependency references were inaccessible."
          },
          reactions: collected.coverage.interactionsComplete ? { status: "collected" } : {
            status: "partial",
            reason: "Some component reactions were inaccessible."
          },
          assets: collectedAssets.complete ? { status: "collected" } : {
            status: "partial",
            reason: "One or more component raster or vector assets were unavailable."
          },
          textSegments: collected.coverage.textSegmentsComplete ? { status: "collected" } : {
            status: "partial",
            reason: "Some component text segments were inaccessible."
          },
          annotationsAndAccessibility: collected.coverage.interactionsComplete ? { status: "collected" } : {
            status: "partial",
            reason: "Some annotations were inaccessible; the installed Plugin API exposes no accessibility/ARIA fields."
          }
        },
        ...rawArtifact === void 0 ? {} : { rawArtifact },
        diagnosticIds
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
        text
      );
      for (const markdown of projectComponentMarkdown(
        snapshotId,
        definition,
        artifact,
        {
          dependencies: components.index.dependencies,
          componentSummaryIds
        }
      )) {
        await emitEntry(
          options,
          requirements,
          markdown.path,
          "text/markdown",
          "deflate",
          markdown.text
        );
      }
      return {
        dependencyRefs: collected.dependencyRefs,
        styleUsage,
        diagnosticIds
      };
    } catch (error) {
      if (error instanceof ExportCancelledError || error instanceof ArchiveProducerSafetyError) {
        throw error;
      }
      options.cancellation.throwIfCancelled();
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.componentDefinitionExportFailed,
        severity: "error",
        message: "A component definition could not be normalized; its raw fallback remains available when export succeeded.",
        phase: "collection",
        source: definition.source,
        artifactPath: path,
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "unknown")
      });
      requirements.push(unavailableRequirement(path, diagnostic.id));
      const failureDiagnosticIds = diagnostics.listSince(diagnosticStart).map((item) => item.id);
      for (const markdown of projectComponentMarkdown(
        snapshotId,
        {
          ...definition,
          diagnosticIds: [
            .../* @__PURE__ */ new Set([...definition.diagnosticIds, ...failureDiagnosticIds])
          ]
        },
        void 0,
        {
          dependencies: components.index.dependencies,
          componentSummaryIds
        }
      )) {
        await emitEntry(
          options,
          requirements,
          markdown.path,
          "text/markdown",
          "deflate",
          markdown.text
        );
      }
      return {
        dependencyRefs: [],
        styleUsage: /* @__PURE__ */ new Map(),
        diagnosticIds: failureDiagnosticIds
      };
    }
  }
  async function mergeLocalComponentCount(nodesById, state, diagnostics, cancellation) {
    let visited = 0;
    for (const [nodeId2, node] of nodesById) {
      cancellation.throwIfCancelled();
      try {
        if ((node.type === "COMPONENT" || node.type === "COMPONENT_SET") && node.remote === false) {
          state.localComponentIds.add(nodeId2);
        }
      } catch (error) {
        state.localComponentEnumerationComplete = false;
        diagnostics.add({
          code: DIAGNOSTIC_CODES.pageCollectionFailed,
          severity: "error",
          message: "A page-local component could not be classified for the exact file-wide count.",
          phase: "collection",
          source: { kind: "node", id: nodeId2 },
          propertyPath: "$.type|$.remote",
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
      }
      visited += 1;
      if (visited % 50 === 0) {
        await yieldToFigma();
        cancellation.throwIfCancelled();
      }
    }
  }
  function mergeStyleUsage(target, incoming) {
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
  async function stabilizePageLoads(pages, options) {
    const now = options.now ?? Date.now;
    const loadResults = [];
    for (const [pageIndex, page] of pages.entries()) {
      options.cancellation.throwIfCancelled();
      postProgress(
        options,
        "page-loading",
        pageIndex,
        pages.length,
        pageLabel(pageIndex, pages.length)
      );
      const loadStarted = now();
      try {
        await page.loadAsync();
        options.cancellation.throwIfCancelled();
        loadResults.push("loaded");
      } catch (error) {
        if (error instanceof ExportCancelledError || error instanceof ArchiveProducerSafetyError) {
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
        elapsedMs(loadStarted, now)
      );
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    const retryPageIndexes = loadResults.flatMap(
      (status, pageIndex) => status === "retry" ? [pageIndex] : []
    );
    const outcomes = loadResults.map(
      (status) => status === "loaded" ? { status } : void 0
    );
    for (const [retryIndex, pageIndex] of retryPageIndexes.entries()) {
      const page = pages[pageIndex];
      if (page === void 0) {
        throw new Error("A page retry target was not recorded.");
      }
      options.cancellation.throwIfCancelled();
      postProgress(
        options,
        "page-loading",
        retryIndex,
        retryPageIndexes.length,
        `${pageLabel(pageIndex, pages.length)}; retry`
      );
      const retryStarted = now();
      try {
        await page.loadAsync();
        options.cancellation.throwIfCancelled();
        outcomes[pageIndex] = { status: "loaded" };
      } catch (error) {
        if (error instanceof ExportCancelledError || error instanceof ArchiveProducerSafetyError) {
          throw error;
        }
        options.cancellation.throwIfCancelled();
        outcomes[pageIndex] = {
          status: "failed",
          technicalCause: normalizeSafeTechnicalCause(error, "unknown")
        };
      }
      postProgress(
        options,
        "page-loading",
        retryIndex + 1,
        retryPageIndexes.length,
        `${pageLabel(pageIndex, pages.length)}; retry`,
        elapsedMs(retryStarted, now)
      );
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    return outcomes.map((outcome) => {
      if (outcome === void 0) {
        throw new Error("A final page load outcome was not recorded.");
      }
      return outcome;
    });
  }
  function materializeDirectPageChildrenBestEffort(page, cancellation) {
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
  async function attemptRawPageStabilization(page, options) {
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
    materializeDirectPageChildrenBestEffort(page, options.cancellation);
    options.cancellation.throwIfCancelled();
    let outcome;
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
        technicalCause: normalizeSafeTechnicalCause(error, "unknown")
      };
    }
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
    return outcome;
  }
  async function stabilizePageRawExports(pages, loadOutcomes, options) {
    if (pages.length !== loadOutcomes.length) {
      throw new Error("Page load outcomes do not match the document page count.");
    }
    const now = options.now ?? Date.now;
    const firstAttempts = [];
    for (const [pageIndex, page] of pages.entries()) {
      options.cancellation.throwIfCancelled();
      postProgress(
        options,
        "raw",
        pageIndex,
        pages.length,
        `${pageLabel(pageIndex, pages.length)}; stabilization`
      );
      const attemptStarted = now();
      const loadOutcome = loadOutcomes[pageIndex];
      if (loadOutcome === void 0) {
        throw new Error("A page load outcome was not recorded.");
      }
      if (loadOutcome.status === "failed") {
        firstAttempts.push(void 0);
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
        elapsedMs(attemptStarted, now)
      );
    }
    const retryPageIndexes = firstAttempts.flatMap(
      (outcome, pageIndex) => outcome?.status === "failed" ? [pageIndex] : []
    );
    const outcomes = loadOutcomes.map(
      (loadOutcome, pageIndex) => {
        if (loadOutcome.status === "failed") {
          return {
            status: "load-failed",
            technicalCause: loadOutcome.technicalCause
          };
        }
        return firstAttempts[pageIndex]?.status === "stabilized" ? { status: "ready" } : void 0;
      }
    );
    for (const [retryIndex, pageIndex] of retryPageIndexes.entries()) {
      const page = pages[pageIndex];
      if (page === void 0) {
        throw new Error("A raw stabilization retry target was not recorded.");
      }
      options.cancellation.throwIfCancelled();
      postProgress(
        options,
        "raw",
        retryIndex,
        retryPageIndexes.length,
        `${pageLabel(pageIndex, pages.length)}; stabilization retry`
      );
      const retryStarted = now();
      const retry = await attemptRawPageStabilization(page, options);
      outcomes[pageIndex] = retry.status === "stabilized" ? { status: "ready" } : {
        status: "raw-stabilization-failed",
        technicalCause: retry.technicalCause
      };
      postProgress(
        options,
        "raw",
        retryIndex + 1,
        retryPageIndexes.length,
        `${pageLabel(pageIndex, pages.length)}; stabilization retry`,
        elapsedMs(retryStarted, now)
      );
    }
    return outcomes.map((outcome) => {
      if (outcome === void 0) {
        throw new Error("A final page preparation outcome was not recorded.");
      }
      return outcome;
    });
  }
  async function processPage(page, pageIndex, pageTotal, preparationOutcome, snapshotId, api, discovery, diagnostics, requirements, assets, options) {
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
        message: "A page could not be loaded, so its raw REST-like artifact is unavailable.",
        phase: "page-loading",
        source,
        artifactPath: rawPath,
        causedDataLoss: true,
        technicalCause: preparationOutcome.technicalCause
      });
      const irDiagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.pageLoadFailed,
        severity: "error",
        message: "A page could not be loaded, so its canonical trees, roots, assets, previews, and component count contribution are unavailable.",
        phase: "page-loading",
        source,
        artifactPath: pagePath,
        causedDataLoss: true,
        technicalCause: preparationOutcome.technicalCause
      });
      requirements.push(
        unavailableRequirement(rawPath, rawDiagnostic.id),
        unavailableRequirement(pagePath, irDiagnostic.id)
      );
      return { childNodeIds: [], nodeCount: 0 };
    }
    let roots;
    try {
      options.cancellation.throwIfCancelled();
      roots = [...page.children];
      options.cancellation.throwIfCancelled();
    } catch (error) {
      if (error instanceof ExportCancelledError || error instanceof ArchiveProducerSafetyError) {
        throw error;
      }
      options.cancellation.throwIfCancelled();
      discovery.localComponentEnumerationComplete = false;
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.pageCollectionFailed,
        severity: "error",
        message: "A loaded page's direct children could not be read, so its canonical page artifact is unavailable.",
        phase: "collection",
        source,
        artifactPath: pagePath,
        propertyPath: "$.children",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
      requirements.push(unavailableRequirement(pagePath, diagnostic.id));
    }
    const emitPageRaw = async () => {
      postProgress(
        options,
        "raw",
        pageIndex,
        pageTotal,
        pageLabel(pageIndex, pageTotal)
      );
      const rawStarted = now();
      let rawArtifact2;
      if (preparationOutcome.status === "raw-stabilization-failed") {
        const diagnostic = diagnostics.add({
          code: DIAGNOSTIC_CODES.rawExportFailed,
          severity: "error",
          message: "A page raw REST-like export could not be stabilized and is unavailable; normalized page IR continues when available.",
          phase: "raw",
          source,
          artifactPath: rawPath,
          causedDataLoss: true,
          technicalCause: preparationOutcome.technicalCause
        });
        requirements.push(unavailableRequirement(rawPath, diagnostic.id));
      } else {
        rawArtifact2 = await emitRawArtifact(
          page,
          source,
          rawPath,
          api,
          diagnostics,
          requirements,
          options
        );
      }
      postProgress(
        options,
        "raw",
        pageIndex + 1,
        pageTotal,
        pageLabel(pageIndex, pageTotal),
        elapsedMs(rawStarted, now)
      );
      return rawArtifact2;
    };
    if (roots === void 0) {
      await emitPageRaw();
      return { childNodeIds: [], nodeCount: 0 };
    }
    const childNodeIds = roots.map((root) => root.id);
    const componentCollectionStarted = now();
    let pageComponents;
    try {
      pageComponents = await collectComponents({
        roots,
        adapter: {
          getNodeByIdAsync: async (id) => {
            options.cancellation.throwIfCancelled();
            const node = await api.getNodeByIdAsync(id);
            options.cancellation.throwIfCancelled();
            return node;
          }
        },
        diagnostics,
        cancellation: options.cancellation,
        session: discovery.components.collectionSession,
        onProgress: (progress) => {
          postProgress(
            options,
            "collection",
            progress.traversedNodes + progress.instanceLookupsCompleted + progress.idLookupsCompleted,
            void 0,
            componentCollectionLabel(pageIndex, pageTotal, progress),
            elapsedMs(componentCollectionStarted, now)
          );
        }
      });
    } catch (error) {
      if (error instanceof ExportCancelledError || error instanceof ArchiveProducerSafetyError) {
        throw error;
      }
      options.cancellation.throwIfCancelled();
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.pageCollectionFailed,
        severity: "error",
        message: "Page component metadata collection failed; structural collection continues without invented metadata.",
        phase: "collection",
        source,
        propertyPath: "$.components",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "unknown")
      });
      pageComponents = emptyComponents(diagnostic.id);
    }
    mergeComponents(pageComponents, discovery.components);
    const definitionsToEmit = [];
    for (const definition of pageComponents.index.definitions) {
      options.cancellation.throwIfCancelled();
      const definitionPath = archivePaths.irComponentDefinition(
        snapshotId,
        definition.source.id
      );
      const definitionWithArtifact = {
        ...definition,
        definitionArtifact: {
          path: definitionPath,
          mediaType: "application/json"
        }
      };
      const existing = discovery.components.definitions.get(definition.source.id);
      discovery.components.definitions.set(
        definition.source.id,
        existing === void 0 ? definitionWithArtifact : {
          ...existing,
          definitionArtifact: {
            path: definitionPath,
            mediaType: "application/json"
          }
        }
      );
      if (discovery.components.emittedDefinitionIds.has(definition.source.id)) {
        continue;
      }
      discovery.components.emittedDefinitionIds.add(definition.source.id);
      definitionsToEmit.push({
        definition: definitionWithArtifact,
        node: pageComponents.definitionNodesById.get(definition.source.id)
      });
    }
    const definitionProgressLabel = `${pageLabel(pageIndex, pageTotal)}; component artifacts`;
    postProgress(
      options,
      "collection",
      0,
      definitionsToEmit.length,
      definitionProgressLabel
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
        options
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
        elapsedMs(definitionStarted, now)
      );
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    const normalizedTrees = [];
    const dependencyRefs = /* @__PURE__ */ new Map();
    const reactions = [];
    const pageAssets = [];
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
        `${pageLabel(pageIndex, pageTotal)}; root ${rootIndex + 1} of ${roots.length}`
      );
      try {
        const collected = await collectNodeTree(
          root,
          source,
          diagnostics,
          options.cancellation,
          pageComponents
        );
        nodeCount += collected.nodeCount;
        await mergeLocalComponentCount(
          collected.nodesById,
          discovery,
          diagnostics,
          options.cancellation
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
          `${pageLabel(pageIndex, pageTotal)}; root ${rootIndex + 1} of ${roots.length}`
        );
        const collectedAssets = await assets.collectTree(
          collected.tree,
          collected.nodesById
        );
        let styleUsageComplete = true;
        try {
          await mergeStyleUsageFromTree(
            collectedAssets.tree,
            discovery.styleUsage,
            options.cancellation
          );
        } catch (error) {
          if (error instanceof ExportCancelledError || error instanceof ArchiveProducerSafetyError) {
            throw error;
          }
          options.cancellation.throwIfCancelled();
          styleUsageComplete = false;
          diagnostics.add({
            code: DIAGNOSTIC_CODES.pageCollectionFailed,
            severity: "error",
            message: "Style-usage indexing for a normalized page root failed; the canonical root and emitted assets remain available.",
            phase: "collection",
            source: { kind: "node", id: root.id },
            propertyPath: "$.styleUsage",
            causedDataLoss: true,
            technicalCause: normalizeSafeTechnicalCause(error, "unknown")
          });
        }
        const diagnosticIds = [
          .../* @__PURE__ */ new Set([
            ...diagnostics.listSince(rootDiagnosticStart).map((diagnostic) => diagnostic.id),
            ...collectedAssets.diagnosticIds
          ])
        ];
        const tree = withRootMetadata(
          collectedAssets.tree,
          void 0,
          diagnosticIds
        );
        normalizedTrees.push(tree);
        for (const reference of collected.dependencyRefs) {
          addReference(dependencyRefs, reference);
          addReference(discovery.dependencyRefs, reference);
        }
        reactions.push(...collected.reactions);
        pageAssets.push(...collectedAssets.assets);
        dependenciesComplete &&= collected.coverage.dependencyRefsComplete && styleUsageComplete;
        reactionsComplete &&= collected.coverage.interactionsComplete;
        assetsComplete &&= collectedAssets.complete;
        textSegmentsComplete &&= collected.coverage.textSegmentsComplete;
        annotationsComplete &&= collected.coverage.interactionsComplete;
      } catch (error) {
        if (error instanceof ExportCancelledError || error instanceof ArchiveProducerSafetyError) {
          throw error;
        }
        options.cancellation.throwIfCancelled();
        if (!componentCountCaptured) {
          discovery.localComponentEnumerationComplete = false;
        }
        diagnostics.add({
          code: DIAGNOSTIC_CODES.pageCollectionFailed,
          severity: "error",
          message: "A direct page root could not be normalized; other page roots and the page raw fallback continue.",
          phase: "collection",
          source: { kind: "node", id: root.id },
          propertyPath: "$.normalizedTrees",
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "unknown")
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
        pageLabel(pageIndex, pageTotal)
      );
      postProgress(
        options,
        "asset",
        rootIndex + 1,
        roots.length,
        pageLabel(pageIndex, pageTotal)
      );
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    let previewNodes = [];
    try {
      previewNodes = selectEntireFilePreviewCandidates({
        children: roots
      });
    } catch (error) {
      options.cancellation.throwIfCancelled();
      diagnostics.add({
        code: DIAGNOSTIC_CODES.pageCollectionFailed,
        severity: "error",
        message: "Entire-file preview eligibility could not be determined for a loaded page.",
        phase: "preview",
        source,
        propertyPath: "$.previews",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access")
      });
    }
    const previews = [];
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
        `${pageLabel(pageIndex, pageTotal)}; preview ${previewIndex + 1} of ${previewNodes.length}`
      );
      const preview = await exportNodePreview(
        previewNode,
        snapshotId,
        diagnostics,
        options.cancellation,
        options.optionalArtifactByteLimit
      );
      if ("bytes" in preview) {
        await emitEntry(
          options,
          requirements,
          preview.preview.archivePath,
          preview.preview.mediaType,
          "store",
          preview.bytes
        );
        previews.push(preview.preview);
      } else {
        requirements.push(
          unavailableRequirement(
            archivePaths.preview(snapshotId, previewNode.id),
            preview.diagnosticId
          )
        );
      }
      postProgress(
        options,
        "preview",
        previewIndex + 1,
        previewNodes.length,
        pageLabel(pageIndex, pageTotal)
      );
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    const rootCount = roots.length;
    roots.length = 0;
    previewNodes.length = 0;
    releaseCollectedComponents(pageComponents);
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
    const rawArtifact = await emitPageRaw();
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
    const pageDiagnosticIds = diagnostics.listSince(pageDiagnosticStart).map((diagnostic) => diagnostic.id);
    const pageDependencyRefs = [
      ...sortUnorderedSourceRefs([...dependencyRefs.values()])
    ];
    const deduplicatedPageAssets = [...deduplicateAssets2(pageAssets)];
    const artifact = {
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
        dependencies: dependenciesComplete ? { status: "collected" } : {
          status: "partial",
          reason: "One or more page roots or dependency references were unavailable."
        },
        reactions: reactionsComplete ? { status: "collected" } : {
          status: "partial",
          reason: "One or more page reactions were unavailable."
        },
        assets: assetsComplete ? { status: "collected" } : {
          status: "partial",
          reason: "One or more page raster or vector assets were unavailable."
        },
        textSegments: textSegmentsComplete ? { status: "collected" } : {
          status: "partial",
          reason: "One or more page text segments were unavailable."
        },
        annotationsAndAccessibility: annotationsComplete ? { status: "collected" } : {
          status: "partial",
          reason: "Some annotations were inaccessible; the installed Plugin API exposes no accessibility/ARIA fields."
        }
      },
      ...rawArtifact === void 0 ? {} : { rawArtifact },
      diagnosticIds: pageDiagnosticIds
    };
    options.cancellation.throwIfCancelled();
    postProgress(
      options,
      "serialization",
      pageIndex,
      pageTotal,
      pageLabel(pageIndex, pageTotal)
    );
    const serializedPage = await serializePageArtifact(
      artifact,
      normalizedTrees,
      pageDiagnosticStart,
      pagePath,
      diagnostics,
      options
    );
    const pageMarkdown = projectPageMarkdown(
      snapshotId,
      serializedPage.artifact,
      discovery.components.emittedDefinitionIds
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
    const artifactRef = {
      path: pagePath,
      mediaType: "application/json"
    };
    await emitEntry(
      options,
      requirements,
      pagePath,
      artifactRef.mediaType,
      "deflate",
      serializedPage.text
    );
    for (const markdown of pageMarkdown) {
      await emitEntry(
        options,
        requirements,
        markdown.path,
        "text/markdown",
        "deflate",
        markdown.text
      );
    }
    const stats = assets.stats();
    const newAssetCount = stats.rasterContents - initialAssetStats.rasterContents + (stats.vectorNodes - initialAssetStats.vectorNodes);
    postProgress(
      options,
      "serialization",
      pageIndex + 1,
      pageTotal,
      `${pageLabel(pageIndex, pageTotal)}; ${rootCount} roots; ${nodeCount} nodes; ${newAssetCount} new assets`,
      elapsedMs(pageStarted, now)
    );
    return {
      artifactRef,
      markdownPath: archivePaths.agentPage(snapshotId, page.id),
      childNodeIds,
      nodeCount
    };
  }
  function createDocument(snapshotId, api, pages, currentPageId, pageArtifacts, globalArtifacts, discovery, diagnostics) {
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
          "Local variable enumeration was incomplete."
        ),
        localStyles: collectionCount(
          globalArtifacts.styles.localCount,
          globalArtifacts.styles.localEnumerationComplete,
          "Local style enumeration was incomplete."
        ),
        localComponents: collectionCount(
          discovery.localComponentIds.size,
          discovery.localComponentEnumerationComplete,
          "One or more pages could not contribute to the exact file-local component count."
        )
      },
      artifacts: {
        variables: {
          path: archivePaths.irVariables(snapshotId),
          mediaType: "application/json"
        },
        styles: {
          path: archivePaths.irStyles(snapshotId),
          mediaType: "application/json"
        },
        components: {
          path: archivePaths.irComponents(snapshotId),
          mediaType: "application/json"
        },
        nodeArtifacts: pageArtifacts
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
        "annotations"
      ],
      limitations: [
        "Pages receive sequential PageNode.loadAsync() and discarded raw-export stabilization passes before incremental page processing; the Plugin API exposes no method to unload a page after it has been loaded, while each stabilization result and exporter-owned page tree or buffer is released as soon as its phase permits.",
        "The installed @figma/plugin-typings@1.133.0 surface exposes annotations but no accessibility or ARIA node properties.",
        "Inaccessible referenced definitions remain unresolved with diagnostics and are never imported.",
        "Raster bytes are limited to image fills reachable through loaded pages, accessible component definitions, and paint styles.",
        "If a canonical page's normalized trees exceed the safe single-entry archive limit, its page artifact remains as a partial index with exact direct-root order, references, reactions, assets, previews, diagnostics, and any available raw fallback; ARCHIVE_ENTRY_TOO_LARGE identifies the omitted trees.",
        `Raw, canonical, raster, SVG, and preview artifacts that fail are absent only with source-attributed diagnostics under ${snapshotId}.`
      ],
      diagnosticIds: diagnostics.list().map((diagnostic) => diagnostic.id)
    };
  }
  async function runEntireFileExport(options) {
    const api = options.api ?? figma;
    const snapshotId = requireSnapshotId(options.snapshotId);
    const diagnostics = new DiagnosticBag("diagnostic");
    const requirements = [];
    const pages = [...api.root.children];
    const currentPageId = api.currentPage.id;
    const discovery = {
      components: {
        definitions: /* @__PURE__ */ new Map(),
        dependencies: /* @__PURE__ */ new Map(),
        diagnosticIds: /* @__PURE__ */ new Set(),
        emittedDefinitionIds: /* @__PURE__ */ new Set(),
        dependencyRefs: /* @__PURE__ */ new Map(),
        collectionSession: new ComponentCollectionSession()
      },
      dependencyRefs: /* @__PURE__ */ new Map(),
      styleUsage: /* @__PURE__ */ new Map(),
      localComponentIds: /* @__PURE__ */ new Set(),
      localComponentEnumerationComplete: true
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
            data
          );
        },
        unavailable: (path, diagnosticId) => {
          requirements.push(unavailableRequirement(path, diagnosticId));
        }
      }
    });
    options.cancellation.throwIfCancelled();
    postProgress(options, "scope", 0, pages.length);
    void options.postMessage({
      type: "export-started",
      protocolVersion: PROTOCOL_VERSION,
      requestId: options.requestId,
      exportId: options.exportId,
      scopeSummary: { kind: "entire-file", pageCount: pages.length }
    });
    postProgress(options, "scope", pages.length, pages.length);
    const pagePreparationOutcomes = await stabilizePageRawExports(
      pages,
      await stabilizePageLoads(pages, options),
      options
    );
    const pageArtifacts = [];
    const pageMarkdownPaths = [];
    const orderedRootIds = [];
    for (const [pageIndex, page] of pages.entries()) {
      options.cancellation.throwIfCancelled();
      const preparationOutcome = pagePreparationOutcomes[pageIndex];
      if (preparationOutcome === void 0) {
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
        options
      );
      orderedRootIds.push(...result.childNodeIds);
      pageMarkdownPaths.push(result.markdownPath);
      if (result.artifactRef !== void 0) {
        pageArtifacts.push(result.artifactRef);
      }
      options.onPageReleased?.({
        pageIndex,
        rootCount: result.childNodeIds.length,
        nodeCount: result.nodeCount
      });
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    const componentIndex = {
      kind: "design-ir-components",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      definitions: sortUnorderedComponentDefinitions([
        ...discovery.components.definitions.values()
      ]),
      dependencies: sortUnorderedComponentDependencies([
        ...discovery.components.dependencies.values()
      ]),
      diagnosticIds: [...discovery.components.diagnosticIds].sort()
    };
    for (const reference of discovery.components.dependencyRefs.values()) {
      addReference(discovery.dependencyRefs, reference);
    }
    postProgress(options, "collection", 0, 2, "Global styles");
    const stylesCollected = await collectStyles({
      referencedStyleIds: [...discovery.dependencyRefs.values()].filter((reference) => reference.kind === "style").map((reference) => reference.id),
      referencedByByStyleId: discovery.styleUsage,
      diagnostics,
      cancellation: options.cancellation,
      api
    });
    postProgress(options, "asset", 0, 1, "Global styles");
    const styleAssets = await assets.collectStyles(stylesCollected.artifact);
    const styles = {
      ...stylesCollected,
      artifact: styleAssets.artifact
    };
    postProgress(options, "asset", 1, 1, "Global styles");
    postProgress(options, "collection", 1, 2, "Global variables");
    const variables = await collectVariables({
      referencedVariableIds: [...discovery.dependencyRefs.values()].filter((reference) => reference.kind === "variable").map((reference) => reference.id).concat(styles.referencedVariableIds),
      referencedCollectionIds: [...discovery.dependencyRefs.values()].filter((reference) => reference.kind === "collection").map((reference) => reference.id),
      diagnostics,
      cancellation: options.cancellation,
      api: api.variables
    });
    postProgress(options, "collection", 2, 2, "Global variables");
    const globalArtifacts = {
      components: componentIndex,
      styles,
      variables
    };
    for (const [path, artifact] of [
      [archivePaths.irComponents(snapshotId), componentIndex],
      [archivePaths.irStyles(snapshotId), styles.artifact],
      [archivePaths.irVariables(snapshotId), variables.artifact]
    ]) {
      options.cancellation.throwIfCancelled();
      const text = serializeCanonicalJson(artifact);
      options.cancellation.throwIfCancelled();
      await emitEntry(
        options,
        requirements,
        path,
        "application/json",
        "deflate",
        text
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
      diagnostics
    );
    const documentPath = archivePaths.irDocument(snapshotId);
    await emitEntry(
      options,
      requirements,
      documentPath,
      "application/json",
      "deflate",
      serializeCanonicalJson(document)
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
      serializeCanonicalJson(diagnosticsArtifact)
    );
    postProgress(options, "serialization", 2, 3, "Agent indexes");
    for (const markdown of projectGlobalMarkdown(
      snapshotId,
      document,
      variables.artifact,
      styles.artifact,
      componentIndex,
      pageMarkdownPaths,
      summary
    )) {
      await emitEntry(
        options,
        requirements,
        markdown.path,
        "text/markdown",
        "deflate",
        markdown.text
      );
    }
    postProgress(options, "serialization", 3, 3, "Agent indexes");
    void options.postMessage({
      type: "diagnostic-summary",
      protocolVersion: PROTOCOL_VERSION,
      exportId: options.exportId,
      counts: summary.counts,
      completeness: summary.completeness
    });
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
    const manifestDraft = {
      archiveVersion: ARCHIVE_FORMAT_VERSION,
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      exporter: {
        packageName: "figma-design-ir",
        packageVersion: EXPORTER_PACKAGE_VERSION
      },
      snapshotId,
      exportedAtUtc: options.exportedAtUtc ?? (/* @__PURE__ */ new Date()).toISOString(),
      editorType: "figma",
      document: { name: api.root.name },
      scope: { kind: "entire-file", orderedRootIds },
      ownerConfirmedCurrent: true,
      counts: {
        pages: pages.length,
        roots: orderedRootIds.length,
        artifacts: requirements.filter(
          (requirement) => requirement.status === "emitted"
        ).length
      },
      diagnosticCounts: summary.counts,
      completeness: summary.completeness,
      capabilities: document.capabilities,
      pluginApiLimitations: document.limitations
    };
    postProgress(options, "archive", 0, void 0, "Finalizing locally");
    void options.postMessage({
      type: "export-ready",
      protocolVersion: PROTOCOL_VERSION,
      exportId: options.exportId,
      manifestDraft,
      artifacts: requirements
    });
  }
  function classifyEntireFileExportFailure(error) {
    void error;
    return "collection-failed";
  }

  // src/shared/scope.ts
  var SelectionScopeError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "SelectionScopeError";
    }
  };
  function compareStrings2(left, right) {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  }
  function compareTreePaths(left, right) {
    const sharedLength = Math.min(left.length, right.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const leftIndex = left[index];
      const rightIndex = right[index];
      if (leftIndex === void 0 || rightIndex === void 0) {
        throw new SelectionScopeError(
          "A selected node has an invalid document tree path."
        );
      }
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
    }
    return left.length - right.length;
  }
  function documentTreePath(node) {
    const reversedPath = [];
    const visited = /* @__PURE__ */ new Set();
    let current = node;
    while (current.parent !== null) {
      if (visited.has(current)) {
        throw new SelectionScopeError(
          "A selected node has a cyclic document ancestry."
        );
      }
      visited.add(current);
      const childIndex = current.parent.children.indexOf(current);
      if (childIndex < 0) {
        throw new SelectionScopeError(
          "A selected node is absent from its parent child order."
        );
      }
      reversedPath.push(childIndex);
      current = current.parent;
    }
    return reversedPath.reverse();
  }
  function nodeSource2(node) {
    return {
      kind: "node",
      id: node.id,
      ...node.name === void 0 ? {} : { name: node.name }
    };
  }
  function selectedAncestor(node, selectedIds) {
    let current = node.parent;
    const visited = /* @__PURE__ */ new Set();
    while (current !== null) {
      if (visited.has(current)) {
        throw new SelectionScopeError(
          "A selected node has a cyclic document ancestry."
        );
      }
      visited.add(current);
      if (selectedIds.has(current.id)) {
        return current;
      }
      current = current.parent;
    }
    return void 0;
  }
  function resolveSelectionRoots(selection, diagnostics) {
    if (selection.length === 0) {
      throw new SelectionScopeError("Current selection is empty.");
    }
    const diagnosticStart = diagnostics.size();
    const paths = /* @__PURE__ */ new Map();
    for (const node of selection) {
      paths.set(node, documentTreePath(node));
    }
    const ordered = [...selection].sort((left, right) => {
      const leftPath = paths.get(left);
      const rightPath = paths.get(right);
      if (leftPath === void 0 || rightPath === void 0) {
        throw new SelectionScopeError(
          "A selected node path could not be resolved."
        );
      }
      return compareTreePaths(leftPath, rightPath) || compareStrings2(left.id, right.id);
    });
    const allSelectedIds = new Set(ordered.map((node) => node.id));
    const retainedIds = /* @__PURE__ */ new Set();
    const roots = [];
    for (const node of ordered) {
      if (retainedIds.has(node.id)) {
        diagnostics.add({
          code: DIAGNOSTIC_CODES.scopeDuplicateRoot,
          severity: "info",
          message: "A duplicate selected root was removed defensively.",
          phase: "scope",
          source: nodeSource2(node),
          causedDataLoss: false
        });
        continue;
      }
      const ancestor = selectedAncestor(node, allSelectedIds);
      if (ancestor !== void 0) {
        diagnostics.add({
          code: DIAGNOSTIC_CODES.scopeNestedRoot,
          severity: "info",
          message: "A selected root nested under another selected root was removed defensively; its subtree remains in the ancestor export.",
          phase: "scope",
          source: nodeSource2(node),
          causedDataLoss: false
        });
        continue;
      }
      retainedIds.add(node.id);
      roots.push(node);
    }
    return {
      roots,
      diagnostics: diagnostics.listSince(diagnosticStart)
    };
  }

  // src/main/export-selection.ts
  var EXPORTER_PACKAGE_VERSION2 = "0.2.0";
  function directStyleReferences2(node) {
    const references = [];
    for (const reference of [
      node.visual?.fillStyle,
      node.visual?.strokeStyle,
      node.visual?.effectStyle,
      node.visual?.gridStyle,
      node.visual?.backgroundStyle,
      ...node.family === "text" ? [
        node.text.textStyle,
        ...node.text.segments.flatMap((segment) => [
          segment.textStyle,
          segment.fillStyle
        ])
      ] : []
    ]) {
      if (reference !== void 0 && reference !== null && !("$type" in reference) && reference.kind === "style") {
        references.push(reference);
      }
    }
    return references;
  }
  function styleUsageFromTree(tree) {
    const usage = /* @__PURE__ */ new Map();
    const work = [tree];
    while (work.length > 0) {
      const node = work.pop();
      if (node === void 0) {
        continue;
      }
      for (const reference of directStyleReferences2(node)) {
        const sources = usage.get(reference.id) ?? [];
        if (!sources.some((source) => source.id === node.source.id)) {
          sources.push(node.source);
        }
        usage.set(reference.id, sources);
      }
      if ("children" in node) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          const child = node.children[index];
          if (child !== void 0) {
            work.push(child);
          }
        }
      }
    }
    return usage;
  }
  function mergeStyleUsage2(results) {
    const merged = /* @__PURE__ */ new Map();
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
  function collectionCount2(value, complete, coverage2, reason) {
    return complete ? { status: "collected", value, coverage: coverage2 } : { status: "partial", value, coverage: coverage2, reason };
  }
  function postProgress2(options, phase, completed, total, currentLabel) {
    void options.postMessage({
      type: "progress",
      protocolVersion: PROTOCOL_VERSION,
      exportId: options.exportId,
      phase,
      completed,
      ...total === void 0 ? {} : { total },
      ...currentLabel === void 0 ? {} : { currentLabel }
    });
  }
  function sourceRefForPage2(page) {
    return {
      kind: "page",
      id: page.id,
      name: page.name
    };
  }
  function owningPageRefForNode2(node, source, diagnostics) {
    const visited = /* @__PURE__ */ new Set();
    let current = node;
    while (!visited.has(current)) {
      visited.add(current);
      let parent;
      try {
        parent = Reflect.get(current, "parent");
      } catch (error) {
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message: "The owning page for a reachable component definition could not be read.",
          phase: "collection",
          source,
          propertyPath: "$.parent.page",
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
        return void 0;
      }
      if (parent === null || typeof parent !== "object") {
        return void 0;
      }
      try {
        const type = Reflect.get(parent, "type");
        if (type === "PAGE") {
          const id = Reflect.get(parent, "id");
          const name = Reflect.get(parent, "name");
          if (typeof id === "string") {
            return {
              kind: "page",
              id,
              ...typeof name === "string" ? { name } : {}
            };
          }
          diagnostics.add({
            code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
            severity: "warning",
            message: "The owning page for a reachable component definition has an unsupported identifier shape.",
            phase: "collection",
            source,
            propertyPath: "$.parent.page.id",
            causedDataLoss: true
          });
          return void 0;
        }
        if (type === "DOCUMENT") {
          return void 0;
        }
      } catch (error) {
        diagnostics.add({
          code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
          severity: "warning",
          message: "The owning page metadata for a reachable component definition could not be read.",
          phase: "collection",
          source,
          propertyPath: "$.parent.page",
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access")
        });
        return void 0;
      }
      current = parent;
    }
    diagnostics.add({
      code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
      severity: "warning",
      message: "The ancestor chain for a reachable component definition contains a cycle.",
      phase: "collection",
      source,
      propertyPath: "$.parent",
      causedDataLoss: true
    });
    return void 0;
  }
  function emittedRequirement2(path) {
    return { path, status: "emitted" };
  }
  function unavailableRequirement2(path, diagnosticId) {
    return { path, status: "unavailable", diagnosticId };
  }
  function entryMessage2(exportId, descriptor) {
    return {
      type: "archive-entry",
      protocolVersion: PROTOCOL_VERSION,
      exportId,
      path: descriptor.metadata.path,
      mediaType: descriptor.metadata.mediaType,
      compression: descriptor.metadata.compression,
      data: descriptor.data
    };
  }
  async function emitEntry2(options, requirements, path, mediaType, compression, data) {
    options.cancellation.throwIfCancelled();
    await options.postMessage(
      entryMessage2(options.exportId, {
        metadata: {
          path,
          mediaType,
          compression,
          uncompressedByteLength: typeof data === "string" ? data.length : data.length
        },
        data
      })
    );
    requirements.push(emittedRequirement2(path));
    options.cancellation.throwIfCancelled();
  }
  async function exportRawRoot(root, snapshotId, diagnostics, cancellation, entryByteLimit) {
    const path = archivePaths.rawRestRoot(snapshotId, root.id);
    try {
      cancellation.throwIfCancelled();
      const raw = await root.exportAsync({ format: "JSON_REST_V1" });
      cancellation.throwIfCancelled();
      const normalized = normalizeJsonSafeValue(raw, {
        diagnostics,
        phase: "normalization",
        source: { kind: "node", id: root.id, name: root.name },
        classifySpecialValue: (value) => value === figma.mixed ? { $type: "figma-mixed" } : void 0
      }).value;
      const text = serializeCanonicalJson(normalized);
      await assertArchiveEntryFits(text, {
        byteLimit: entryByteLimit,
        checkpoint: () => cancellation.throwIfCancelled()
      });
      return {
        artifact: { path, mediaType: "application/json" },
        text
      };
    } catch (error) {
      if (error instanceof ExportCancelledError) {
        throw error;
      }
      cancellation.throwIfCancelled();
      if (error instanceof ArchiveProducerSafetyError && error.code === "archive-capacity-exceeded") {
        const diagnostic2 = diagnostics.add({
          code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
          severity: "error",
          message: "The selected root raw REST-like artifact exceeded the safe single-entry archive limit and is absent; normalized IR continues.",
          phase: "raw",
          source: { kind: "node", id: root.id, name: root.name },
          artifactPath: path,
          causedDataLoss: true
        });
        return { diagnosticId: diagnostic2.id };
      }
      if (error instanceof ArchiveProducerSafetyError) {
        throw error;
      }
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.rawExportFailed,
        severity: "error",
        message: "The selected root raw REST-like export failed; normalized IR continues without that fallback.",
        phase: "collection",
        source: { kind: "node", id: root.id, name: root.name },
        artifactPath: path,
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "unknown")
      });
      return { diagnosticId: diagnostic.id };
    }
  }
  async function exportRawComponent(node, source, snapshotId, diagnostics, cancellation, entryByteLimit) {
    const path = archivePaths.rawRestComponent(snapshotId, source.id);
    try {
      cancellation.throwIfCancelled();
      const raw = await node.exportAsync({ format: "JSON_REST_V1" });
      cancellation.throwIfCancelled();
      const normalized = normalizeJsonSafeValue(raw, {
        diagnostics,
        phase: "normalization",
        source,
        classifySpecialValue: (value) => value === figma.mixed ? { $type: "figma-mixed" } : void 0
      }).value;
      const text = serializeCanonicalJson(normalized);
      await assertArchiveEntryFits(text, {
        byteLimit: entryByteLimit,
        checkpoint: () => cancellation.throwIfCancelled()
      });
      return {
        artifact: { path, mediaType: "application/json" },
        text
      };
    } catch (error) {
      if (error instanceof ExportCancelledError) {
        throw error;
      }
      cancellation.throwIfCancelled();
      if (error instanceof ArchiveProducerSafetyError && error.code === "archive-capacity-exceeded") {
        const diagnostic2 = diagnostics.add({
          code: DIAGNOSTIC_CODES.archiveEntryTooLarge,
          severity: "error",
          message: "A reachable component raw REST-like artifact exceeded the safe single-entry archive limit and is absent; normalized component IR continues.",
          phase: "raw",
          source,
          artifactPath: path,
          causedDataLoss: true
        });
        return { diagnosticId: diagnostic2.id };
      }
      if (error instanceof ArchiveProducerSafetyError) {
        throw error;
      }
      const diagnostic = diagnostics.add({
        code: DIAGNOSTIC_CODES.rawExportFailed,
        severity: "error",
        message: "A reachable component raw REST-like fallback could not be exported; normalized component IR remains available but the archive is incomplete.",
        phase: "collection",
        source,
        artifactPath: path,
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "unknown")
      });
      return { diagnosticId: diagnostic.id };
    }
  }
  async function collectComponentDefinitionArtifacts(components, snapshotId, diagnostics, requirements, options) {
    const results = [];
    const componentSummaryIds = new Set(
      components.index.definitions.filter(
        (definition) => components.definitionNodesById.has(definition.source.id)
      ).map((definition) => definition.source.id)
    );
    for (const definition of components.index.definitions) {
      const node = components.definitionNodesById.get(definition.source.id);
      if (node === void 0) {
        continue;
      }
      const diagnosticStart = diagnostics.size();
      const page = owningPageRefForNode2(node, definition.source, diagnostics);
      const collected = await collectNodeTree(
        node,
        page,
        diagnostics,
        options.cancellation,
        components
      );
      postProgress2(
        options,
        "asset",
        results.length,
        components.index.definitions.length
      );
      const raw = await exportRawComponent(
        node,
        definition.source,
        snapshotId,
        diagnostics,
        options.cancellation,
        options.optionalArtifactByteLimit
      );
      if ("text" in raw) {
        await emitEntry2(
          options,
          requirements,
          raw.artifact.path,
          raw.artifact.mediaType,
          "deflate",
          raw.text
        );
      } else {
        requirements.push(
          unavailableRequirement2(
            archivePaths.rawRestComponent(snapshotId, definition.source.id),
            raw.diagnosticId
          )
        );
      }
      const diagnosticIds = [
        .../* @__PURE__ */ new Set([
          ...diagnostics.listSince(diagnosticStart).map((diagnostic) => diagnostic.id)
        ])
      ];
      const rawArtifact = "artifact" in raw ? raw.artifact : void 0;
      const normalizedTree = withRootMetadata2(
        collected.tree,
        rawArtifact,
        diagnosticIds
      );
      const artifact = {
        kind: "design-ir-component-definition",
        schemaVersion: DESIGN_IR_SCHEMA_VERSION,
        source: definition.source,
        dependencyRefs: collected.dependencyRefs,
        normalizedTree,
        reactions: collected.reactions,
        assets: [],
        coverage: {
          dependencies: collected.coverage.dependencyRefsComplete ? { status: "collected" } : {
            status: "partial",
            reason: "Some dependency references were inaccessible while collecting the reachable component definition."
          },
          reactions: collected.coverage.interactionsComplete ? { status: "collected" } : {
            status: "partial",
            reason: "Some reactions were inaccessible while collecting the reachable component definition."
          },
          assets: {
            status: "not-collected",
            reason: "Binary assets are exported only for selected roots; component trees keep exact vector geometry and text values instead."
          },
          textSegments: collected.coverage.textSegmentsComplete ? { status: "collected" } : {
            status: "partial",
            reason: "Some styled text segments were inaccessible while collecting the reachable component definition."
          },
          annotationsAndAccessibility: collected.coverage.interactionsComplete ? { status: "collected" } : {
            status: "partial",
            reason: "Some annotations were inaccessible; the installed Plugin API exposes no accessibility/ARIA fields."
          }
        },
        ...rawArtifact === void 0 ? {} : { rawArtifact },
        diagnosticIds
      };
      const path = archivePaths.irComponentDefinition(
        snapshotId,
        definition.source.id
      );
      const definitionWithArtifact = {
        ...definition,
        definitionArtifact: { path, mediaType: "application/json" }
      };
      await emitEntry2(
        options,
        requirements,
        path,
        "application/json",
        "deflate",
        serializeCanonicalJson(artifact)
      );
      for (const markdown of projectComponentMarkdown(
        snapshotId,
        definitionWithArtifact,
        artifact,
        {
          dependencies: components.index.dependencies,
          componentSummaryIds
        }
      )) {
        await emitEntry2(
          options,
          requirements,
          markdown.path,
          "text/markdown",
          "deflate",
          markdown.text
        );
      }
      results.push({
        componentId: definition.source.id,
        artifactRef: { path, mediaType: "application/json" },
        dependencyRefs: collected.dependencyRefs,
        styleUsage: styleUsageFromTree(collected.tree),
        diagnosticIds,
        complete: collected.coverage.dependencyRefsComplete && collected.coverage.interactionsComplete && collected.coverage.textSegmentsComplete
      });
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
    return results;
  }
  function withRootMetadata2(tree, rawArtifact, diagnosticIds) {
    return {
      ...tree,
      ...rawArtifact === void 0 ? {} : { rawArtifact },
      diagnosticIds
    };
  }
  async function collectRootArtifact(root, rootIndex, rootTotal, page, snapshotId, diagnostics, requirements, components, assets, options) {
    const rootDiagnosticStart = diagnostics.size();
    options.cancellation.throwIfCancelled();
    postProgress2(
      options,
      "collection",
      rootIndex,
      rootTotal,
      `Root ${rootIndex + 1} of ${rootTotal}`
    );
    const collected = await collectNodeTree(
      root,
      page,
      diagnostics,
      options.cancellation,
      components
    );
    postProgress2(options, "asset", rootIndex, rootTotal);
    const collectedAssets = await assets.collectTree(
      collected.tree,
      collected.nodesById
    );
    postProgress2(options, "raw", rootIndex, rootTotal);
    const raw = await exportRawRoot(
      root,
      snapshotId,
      diagnostics,
      options.cancellation,
      options.optionalArtifactByteLimit
    );
    if ("text" in raw) {
      await emitEntry2(
        options,
        requirements,
        raw.artifact.path,
        raw.artifact.mediaType,
        "deflate",
        raw.text
      );
    } else {
      requirements.push(
        unavailableRequirement2(
          archivePaths.rawRestRoot(snapshotId, root.id),
          raw.diagnosticId
        )
      );
    }
    postProgress2(options, "preview", rootIndex, rootTotal);
    const preview = await exportSelectedRootPreview(
      root,
      snapshotId,
      diagnostics,
      options.cancellation,
      options.optionalArtifactByteLimit
    );
    if ("bytes" in preview) {
      await emitEntry2(
        options,
        requirements,
        preview.preview.archivePath,
        preview.preview.mediaType,
        "store",
        preview.bytes
      );
    } else {
      requirements.push(
        unavailableRequirement2(
          archivePaths.preview(snapshotId, root.id),
          preview.diagnosticId
        )
      );
    }
    const rootDiagnosticIds = [
      .../* @__PURE__ */ new Set([
        ...diagnostics.listSince(rootDiagnosticStart).map((diagnostic) => diagnostic.id),
        ...collectedAssets.diagnosticIds
      ])
    ];
    const rawArtifact = "artifact" in raw ? raw.artifact : void 0;
    const normalizedTree = withRootMetadata2(
      collectedAssets.tree,
      rawArtifact,
      rootDiagnosticIds
    );
    const artifact = {
      kind: "design-ir-root-index",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      source: { kind: "node", id: root.id, name: root.name },
      dependencyRefs: collected.dependencyRefs,
      normalizedTree,
      reactions: collected.reactions,
      assets: collectedAssets.assets,
      previews: "preview" in preview ? [preview.preview] : [],
      coverage: {
        dependencies: collected.coverage.dependencyRefsComplete ? { status: "collected" } : {
          status: "partial",
          reason: "Some supported dependency references were inaccessible during root collection."
        },
        reactions: collected.coverage.interactionsComplete ? { status: "collected" } : {
          status: "partial",
          reason: "Some supported reactions were inaccessible during collection."
        },
        assets: collectedAssets.complete ? { status: "collected" } : {
          status: "partial",
          reason: "One or more reachable raster or standalone vector assets could not be exported."
        },
        textSegments: collected.coverage.textSegmentsComplete ? { status: "collected" } : {
          status: "partial",
          reason: "Some styled text segments were inaccessible during collection."
        },
        annotationsAndAccessibility: collected.coverage.interactionsComplete ? { status: "collected" } : {
          status: "partial",
          reason: "Some annotations were inaccessible; the installed Plugin API exposes no accessibility/ARIA fields."
        }
      },
      ...rawArtifact === void 0 ? {} : { rawArtifact },
      diagnosticIds: rootDiagnosticIds
    };
    const artifactRef = {
      path: archivePaths.irNodeRoot(snapshotId, root.id),
      mediaType: "application/json"
    };
    await emitEntry2(
      options,
      requirements,
      artifactRef.path,
      artifactRef.mediaType,
      "deflate",
      serializeCanonicalJson(artifact)
    );
    postProgress2(options, "collection", rootIndex + 1, rootTotal);
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
    return {
      artifact,
      artifactRef,
      dependencyRefs: collected.dependencyRefs,
      styleUsage: styleUsageFromTree(collectedAssets.tree)
    };
  }
  function createDocument2(snapshotId, page, roots, rootResults, globalArtifacts, diagnostics) {
    return {
      kind: "design-ir-document",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      source: { kind: "document", id: figma.root.id, name: figma.root.name },
      name: figma.root.name,
      pages: [sourceRefForPage2(page)],
      currentPageId: page.id,
      selectedRootIds: roots.map((root) => root.id),
      counts: {
        localVariables: collectionCount2(
          globalArtifacts.variables.localCount,
          globalArtifacts.variables.localEnumerationComplete,
          "file-local",
          "Local variable enumeration was incomplete."
        ),
        localStyles: collectionCount2(
          globalArtifacts.styles.localCount,
          globalArtifacts.styles.localEnumerationComplete,
          "file-local",
          "Local style enumeration was incomplete."
        ),
        localComponents: collectionCount2(
          globalArtifacts.components.index.definitions.filter(
            (definition) => definition.source.remote === false
          ).length,
          globalArtifacts.components.complete,
          "selected-reachable",
          "Some selected or reachable component metadata was inaccessible."
        )
      },
      artifacts: {
        variables: {
          path: archivePaths.irVariables(snapshotId),
          mediaType: "application/json"
        },
        styles: {
          path: archivePaths.irStyles(snapshotId),
          mediaType: "application/json"
        },
        components: {
          path: archivePaths.irComponents(snapshotId),
          mediaType: "application/json"
        },
        nodeArtifacts: rootResults.map((result) => result.artifactRef)
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
        "annotations"
      ],
      limitations: [
        "Selection roots use deterministic document/canvas order because Plugin API selection order is unspecified.",
        "The installed @figma/plugin-typings@1.133.0 surface exposes annotations but no accessibility or ARIA node properties.",
        "Component counts and per-definition IR cover only definitions instantiated by the selected roots (including nested instances and swap targets); sibling variants and owning component sets are not exported, and exact file-wide local component counts require an Entire file export.",
        "Inaccessible referenced definitions remain unresolved with diagnostics and are never imported.",
        "Raster and standalone-SVG bytes are exported only for image fills and vector nodes reachable through the selected roots; raster bytes referenced exclusively by component definitions or paint styles are omitted.",
        `Raw, raster, SVG, and preview artifacts that fail are absent only with source-attributed diagnostics under ${snapshotId}.`
      ],
      diagnosticIds: diagnostics.list().map((diagnostic) => diagnostic.id)
    };
  }
  async function runSelectionExport(options) {
    const snapshotId = requireSnapshotId(options.snapshotId);
    const diagnostics = new DiagnosticBag("diagnostic");
    const requirements = [];
    const assetSession = new AssetCollectionSession({
      snapshotId,
      diagnostics,
      cancellation: options.cancellation,
      entryByteLimit: options.optionalArtifactByteLimit,
      emitter: {
        emit: async (path, mediaType, compression, data) => {
          await emitEntry2(
            options,
            requirements,
            path,
            mediaType,
            compression,
            data
          );
        },
        unavailable: (path, diagnosticId) => {
          requirements.push(unavailableRequirement2(path, diagnosticId));
        }
      }
    });
    options.cancellation.throwIfCancelled();
    postProgress2(options, "scope", 0);
    const originalSelection = [...figma.currentPage.selection];
    const resolution = resolveSelectionRoots(
      originalSelection,
      diagnostics
    );
    const roots = resolution.roots;
    void options.postMessage({
      type: "export-started",
      protocolVersion: PROTOCOL_VERSION,
      requestId: options.requestId,
      exportId: options.exportId,
      scopeSummary: {
        kind: "current-selection",
        rootCount: roots.length
      }
    });
    postProgress2(options, "scope", roots.length, roots.length);
    const page = figma.currentPage;
    const pageRef = sourceRefForPage2(page);
    postProgress2(options, "collection", 0, roots.length + 3, "Components");
    const collectedComponents = await collectComponents({
      roots,
      adapter: {
        getNodeByIdAsync: async (id) => {
          options.cancellation.throwIfCancelled();
          const node = await figma.getNodeByIdAsync(id);
          options.cancellation.throwIfCancelled();
          return node;
        }
      },
      diagnostics,
      cancellation: options.cancellation,
      componentScope: "used"
    });
    const componentDefinitionResults = await collectComponentDefinitionArtifacts(
      collectedComponents,
      snapshotId,
      diagnostics,
      requirements,
      options
    );
    const definitionArtifactById = new Map(
      componentDefinitionResults.map((result) => [
        result.componentId,
        result.artifactRef
      ])
    );
    const components = {
      ...collectedComponents,
      index: {
        ...collectedComponents.index,
        definitions: collectedComponents.index.definitions.map((definition) => {
          const definitionArtifact = definitionArtifactById.get(
            definition.source.id
          );
          return definitionArtifact === void 0 ? definition : { ...definition, definitionArtifact };
        }),
        diagnosticIds: [
          .../* @__PURE__ */ new Set([
            ...collectedComponents.index.diagnosticIds,
            ...componentDefinitionResults.flatMap(
              (result) => result.diagnosticIds
            )
          ])
        ]
      }
    };
    const rootResults = [];
    for (const [index, root] of roots.entries()) {
      options.cancellation.throwIfCancelled();
      if (root.removed) {
        for (const path of [
          archivePaths.rawRestRoot(snapshotId, root.id),
          archivePaths.irNodeRoot(snapshotId, root.id),
          archivePaths.preview(snapshotId, root.id)
        ]) {
          const diagnostic = diagnostics.add({
            code: DIAGNOSTIC_CODES.scopeRootRemoved,
            severity: "error",
            message: "A required selected-root artifact is unavailable because the root was removed before collection.",
            phase: "scope",
            source: { kind: "node", id: root.id },
            artifactPath: path,
            causedDataLoss: true
          });
          requirements.push(unavailableRequirement2(path, diagnostic.id));
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
          options
        )
      );
    }
    const scopeDependencies = [
      ...rootResults.flatMap((result) => result.dependencyRefs),
      ...componentDefinitionResults.flatMap((result) => result.dependencyRefs)
    ];
    const styleUsage = mergeStyleUsage2([
      ...rootResults,
      ...componentDefinitionResults
    ]);
    postProgress2(
      options,
      "collection",
      roots.length + 1,
      roots.length + 3,
      "Styles"
    );
    const collectedStyles = await collectStyles({
      referencedStyleIds: scopeDependencies.filter((reference) => reference.kind === "style").map((reference) => reference.id),
      referencedByByStyleId: styleUsage,
      diagnostics,
      cancellation: options.cancellation
    });
    postProgress2(options, "asset", roots.length + 1, roots.length + 2, "Styles");
    const styles = collectedStyles;
    postProgress2(
      options,
      "collection",
      roots.length + 2,
      roots.length + 3,
      "Variables"
    );
    const variables = await collectVariables({
      referencedVariableIds: [...scopeDependencies, ...components.dependencyRefs].filter((reference) => reference.kind === "variable").map((reference) => reference.id).concat(styles.referencedVariableIds),
      referencedCollectionIds: scopeDependencies.filter((reference) => reference.kind === "collection").map((reference) => reference.id),
      diagnostics,
      cancellation: options.cancellation
    });
    const globalArtifacts = { components, styles, variables };
    for (const [path, artifact] of [
      [archivePaths.irComponents(snapshotId), components.index],
      [archivePaths.irStyles(snapshotId), styles.artifact],
      [archivePaths.irVariables(snapshotId), variables.artifact]
    ]) {
      await emitEntry2(
        options,
        requirements,
        path,
        "application/json",
        "deflate",
        serializeCanonicalJson(artifact)
      );
    }
    postProgress2(options, "collection", roots.length + 3, roots.length + 3);
    options.cancellation.throwIfCancelled();
    postProgress2(options, "serialization", 0, 3);
    const document = createDocument2(
      snapshotId,
      page,
      roots,
      rootResults,
      globalArtifacts,
      diagnostics
    );
    const documentPath = archivePaths.irDocument(snapshotId);
    await emitEntry2(
      options,
      requirements,
      documentPath,
      "application/json",
      "deflate",
      serializeCanonicalJson(document)
    );
    postProgress2(options, "serialization", 1, 3);
    const diagnosticsArtifact = createDiagnosticsArtifact(diagnostics.list());
    const summary = diagnosticsArtifact.summary;
    const diagnosticsPath = archivePaths.diagnostics(snapshotId);
    await emitEntry2(
      options,
      requirements,
      diagnosticsPath,
      "application/json",
      "deflate",
      serializeCanonicalJson(diagnosticsArtifact)
    );
    postProgress2(options, "serialization", 2, 3, "Agent summaries");
    for (const markdown of projectSelectionPageMarkdown(
      snapshotId,
      pageRef,
      rootResults.map((result) => result.artifact),
      new Set(componentDefinitionResults.map((result) => result.componentId))
    )) {
      await emitEntry2(
        options,
        requirements,
        markdown.path,
        "text/markdown",
        "deflate",
        markdown.text
      );
    }
    for (const markdown of projectGlobalMarkdown(
      snapshotId,
      document,
      variables.artifact,
      styles.artifact,
      components.index,
      [archivePaths.agentPage(snapshotId, pageRef.id)],
      summary
    )) {
      await emitEntry2(
        options,
        requirements,
        markdown.path,
        "text/markdown",
        "deflate",
        markdown.text
      );
    }
    postProgress2(options, "serialization", 3, 3, "Agent indexes");
    void options.postMessage({
      type: "diagnostic-summary",
      protocolVersion: PROTOCOL_VERSION,
      exportId: options.exportId,
      counts: summary.counts,
      completeness: summary.completeness
    });
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
    const manifestDraft = {
      archiveVersion: ARCHIVE_FORMAT_VERSION,
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      exporter: {
        packageName: "figma-design-ir",
        packageVersion: EXPORTER_PACKAGE_VERSION2
      },
      snapshotId,
      exportedAtUtc: options.exportedAtUtc ?? (/* @__PURE__ */ new Date()).toISOString(),
      editorType: "figma",
      document: { name: figma.root.name },
      scope: {
        kind: "current-selection",
        orderedRootIds: roots.map((root) => root.id)
      },
      ownerConfirmedCurrent: true,
      counts: {
        pages: 1,
        roots: roots.length,
        artifacts: requirements.filter(
          (requirement) => requirement.status === "emitted"
        ).length
      },
      diagnosticCounts: summary.counts,
      completeness: summary.completeness,
      capabilities: document.capabilities,
      pluginApiLimitations: document.limitations
    };
    postProgress2(options, "archive", 0, void 0, "Finalizing locally");
    void options.postMessage({
      type: "export-ready",
      protocolVersion: PROTOCOL_VERSION,
      exportId: options.exportId,
      manifestDraft,
      artifacts: requirements
    });
  }
  function classifySelectionExportFailure(error) {
    if (error instanceof SelectionScopeError) {
      return error.message === "Current selection is empty." ? "scope-empty" : "scope-invalid";
    }
    return "collection-failed";
  }

  // src/main/code.ts
  figma.showUI(__html__, {
    width: 380,
    height: 600,
    title: "Figma Design IR",
    themeColors: true
  });
  var ArchiveEntryDeliveryError = class extends Error {
    constructor() {
      super("Archive entry delivery acknowledgement failed.");
      this.name = "ArchiveEntryDeliveryError";
    }
  };
  var ExportUiDelivery = class {
    #exportId;
    #cancellation;
    #postMessage;
    #expectedSequence = 1;
    #pending = null;
    #failure = null;
    #entryPreflightActive = false;
    #readyPosted = false;
    #closed = false;
    constructor(exportId, cancellation, postMessage2) {
      this.#exportId = exportId;
      this.#cancellation = cancellation;
      this.#postMessage = postMessage2;
    }
    get failure() {
      return this.#failure;
    }
    #fail(requestedFailure = new ArchiveEntryDeliveryError()) {
      const failure = this.#failure ?? requestedFailure;
      this.#failure = failure;
      this.#entryPreflightActive = false;
      const pending = this.#pending;
      this.#pending = null;
      pending?.reject(failure);
      return failure;
    }
    #failProducerSafety(code) {
      this.#cancellation.cancel();
      this.#closed = true;
      return this.#fail(new ArchiveProducerSafetyError(code));
    }
    #throwIfPreflightStopped() {
      if (this.#failure !== null) {
        throw this.#failure;
      }
      if (this.#closed) {
        throw new ExportCancelledError();
      }
      this.#cancellation.throwIfCancelled();
    }
    async #preflightAndPostEntry(message) {
      try {
        this.#throwIfPreflightStopped();
        if (this.#expectedSequence > ARCHIVE_MAX_PRE_MANIFEST_ENTRY_COUNT) {
          throw this.#failProducerSafety("archive-entry-limit-exceeded");
        }
        try {
          await assertArchiveEntryFits(message.data, {
            checkpoint: () => this.#throwIfPreflightStopped()
          });
        } catch (error) {
          if (error instanceof ArchiveProducerSafetyError && error.code === "archive-capacity-exceeded") {
            throw this.#failProducerSafety(error.code);
          }
          throw error;
        }
        this.#throwIfPreflightStopped();
        const sequence = this.#expectedSequence;
        const outgoingMessage = { ...message, sequence };
        const acknowledged = new Promise((resolve, reject) => {
          this.#pending = {
            sequence,
            resolve,
            reject
          };
        });
        void acknowledged.catch(() => void 0);
        this.#entryPreflightActive = false;
        if (!this.#postMessage(outgoingMessage)) {
          this.cancel();
          throw new ExportCancelledError();
        }
        return acknowledged;
      } finally {
        this.#entryPreflightActive = false;
      }
    }
    post(message) {
      if (this.#failure !== null) {
        throw this.#failure;
      }
      if (this.#closed) {
        throw new ExportCancelledError();
      }
      if ("exportId" in message && message.exportId !== this.#exportId) {
        throw this.#fail();
      }
      if (this.#readyPosted) {
        throw this.#fail();
      }
      if (message.type === "archive-entry") {
        if (this.#entryPreflightActive || this.#pending !== null) {
          throw this.#fail();
        }
        this.#entryPreflightActive = true;
        const delivery = this.#preflightAndPostEntry(message);
        void delivery.catch(() => void 0);
        return delivery;
      }
      if (message.type === "export-ready") {
        if (this.#entryPreflightActive || this.#pending !== null) {
          throw this.#fail();
        }
        this.#readyPosted = true;
      }
      if (!this.#postMessage(message)) {
        this.cancel();
        throw new ExportCancelledError();
      }
    }
    accept(message) {
      if (this.#closed || this.#failure !== null) {
        return true;
      }
      const pending = this.#pending;
      if (message.exportId !== this.#exportId || pending === null || message.sequence !== pending.sequence || message.sequence !== this.#expectedSequence) {
        this.#fail();
        return false;
      }
      this.#pending = null;
      this.#expectedSequence += 1;
      pending.resolve();
      return true;
    }
    cancel() {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      this.#entryPreflightActive = false;
      const pending = this.#pending;
      this.#pending = null;
      pending?.reject(new ExportCancelledError());
    }
  };
  var exportSequence = 0;
  var activeExport = null;
  var pluginClosing = false;
  function nextExportId() {
    exportSequence += 1;
    return `export-${String(exportSequence).padStart(6, "0")}`;
  }
  function postToUi(message) {
    if (pluginClosing) {
      return false;
    }
    try {
      figma.ui.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }
  function sendInitialization() {
    if (pluginClosing) {
      return;
    }
    if (figma.editorType !== "figma" || figma.pluginId === void 0) {
      figma.closePlugin("Figma Design IR requires Figma Design.");
      return;
    }
    const message = {
      type: "initialize-result",
      protocolVersion: PROTOCOL_VERSION,
      document: {
        name: figma.root.name,
        pageCount: figma.root.children.length,
        selectionCount: figma.currentPage.selection.length
      },
      capabilities: {
        exportAvailable: true,
        supportedScopes: ["current-selection", "entire-file"]
      },
      runtime: {
        editorType: figma.editorType,
        pluginId: figma.pluginId
      }
    };
    postToUi(message);
  }
  function postFailure(exportId, requestId, code, error) {
    postToUi({
      type: "export-failed",
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      exportId,
      safeError: {
        code,
        ...error === void 0 ? {} : { technicalCause: normalizeSafeTechnicalCause(error, "unknown") }
      }
    });
  }
  function startExport(snapshotId, requestId, scope) {
    const exportId = nextExportId();
    if (pluginClosing) {
      return;
    }
    if (activeExport !== null) {
      postFailure(exportId, requestId, "export-in-progress");
      return;
    }
    const cancellation = new ExportCancellationToken();
    const delivery = new ExportUiDelivery(exportId, cancellation, postToUi);
    const operation = {
      exportId,
      requestId,
      cancellation,
      delivery
    };
    activeExport = operation;
    const runExport = scope === "entire-file" ? runEntireFileExport : runSelectionExport;
    void runExport({
      exportId,
      requestId,
      snapshotId,
      cancellation,
      postMessage: (message) => delivery.post(message)
    }).then(() => {
      if (delivery.failure !== null) {
        throw delivery.failure;
      }
      cancellation.throwIfCancelled();
    }).catch((error) => {
      const deliveryFailure = delivery.failure;
      if (deliveryFailure instanceof ArchiveProducerSafetyError) {
        cancellation.cancel();
        postFailure(exportId, requestId, deliveryFailure.code, deliveryFailure);
        return;
      }
      if (deliveryFailure !== null) {
        cancellation.cancel();
        postFailure(exportId, requestId, "archive-failed", deliveryFailure);
        return;
      }
      if (error instanceof ExportCancelledError || cancellation.cancelled) {
        postToUi({
          type: "export-cancelled",
          protocolVersion: PROTOCOL_VERSION,
          exportId
        });
        return;
      }
      postFailure(
        exportId,
        requestId,
        scope === "entire-file" ? classifyEntireFileExportFailure(error) : classifySelectionExportFailure(error),
        error
      );
    }).finally(() => {
      delivery.cancel();
      if (activeExport === operation) {
        activeExport = null;
      }
    });
  }
  figma.ui.onmessage = (rawMessage) => {
    const message = parseUiToMainMessage(rawMessage);
    if (message === null) {
      return;
    }
    switch (message.type) {
      case "initialize-request":
        sendInitialization();
        break;
      case "ping-request":
        postToUi({
          type: "pong-result",
          protocolVersion: PROTOCOL_VERSION,
          requestId: message.requestId
        });
        break;
      case "start-export":
        startExport(message.snapshotId, message.requestId, message.scope);
        break;
      case "cancel-export":
        if (activeExport?.exportId === message.exportId) {
          activeExport.cancellation.cancel();
          activeExport.delivery.cancel();
        }
        break;
      case "archive-entry-accepted":
        if (activeExport?.exportId === message.exportId) {
          if (!activeExport.delivery.accept(message)) {
            activeExport.cancellation.cancel();
          }
        }
        break;
    }
  };
  figma.on("selectionchange", sendInitialization);
  figma.on("close", () => {
    pluginClosing = true;
    activeExport?.cancellation.cancel();
    activeExport?.delivery.cancel();
    activeExport = null;
  });
})();
