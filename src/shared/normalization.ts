import {
  DIAGNOSTIC_CODES,
  DiagnosticBag,
  normalizeSafeTechnicalCause,
  type Diagnostic,
  type DiagnosticDraft,
  type DiagnosticPhase,
} from "./diagnostics";
import type {
  JsonValue,
  SourceRef,
  TaggedIrValue,
  UnavailableValue,
  UnsupportedValue,
} from "./ir";

export type PropertyPathSegment = string | number;

export type SpecialValueClassifier = (
  value: unknown,
  propertyPath: readonly PropertyPathSegment[],
) => TaggedIrValue | undefined;

export interface NormalizationOptions {
  readonly diagnostics: DiagnosticBag;
  readonly phase?: DiagnosticPhase;
  readonly source?: SourceRef;
  readonly propertyPath?: readonly PropertyPathSegment[];
  readonly classifySpecialValue?: SpecialValueClassifier;
}

export interface NormalizationResult {
  readonly value: JsonValue;
  readonly diagnostics: readonly Diagnostic[];
}

function formatObjectKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
}

export function formatPropertyPath(
  segments: readonly PropertyPathSegment[],
): string {
  return segments.reduce<string>(
    (path, segment) =>
      typeof segment === "number"
        ? `${path}[${segment}]`
        : `${path}${formatObjectKey(segment)}`,
    "$",
  );
}

function runtimeType(value: unknown): string {
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

function unsupportedValue(
  reason: UnsupportedValue["reason"],
  value: unknown,
): UnsupportedValue {
  return {
    $type: "unsupported",
    reason,
    runtimeType: runtimeType(value),
  };
}

function inaccessibleProperty(): UnavailableValue {
  return {
    $type: "unavailable",
    reason: "property-access-failed",
  };
}

function isArrayIndexKey(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

export function normalizeJsonSafeValue(
  input: unknown,
  options: NormalizationOptions,
): NormalizationResult {
  const diagnostics = options.diagnostics;
  const diagnosticStart = diagnostics.size();
  const activeObjects = new WeakMap<object, string>();
  const phase = options.phase ?? "normalization";

  const addDiagnostic = (
    draft: Omit<DiagnosticDraft, "phase" | "source">,
  ): void => {
    diagnostics.add({
      ...draft,
      phase,
      ...(options.source === undefined ? {} : { source: options.source }),
    });
  };

  const normalize = (
    value: unknown,
    path: readonly PropertyPathSegment[],
  ): JsonValue => {
    if (options.classifySpecialValue !== undefined) {
      try {
        const specialValue = options.classifySpecialValue(value, path);
        if (specialValue !== undefined) {
          return specialValue;
        }
      } catch (error) {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationSpecialClassifierFailed,
          severity: "error",
          message:
            "A special Figma-like value could not be classified safely and was preserved as an unsupported tagged value.",
          propertyPath: formatPropertyPath(path),
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "normalization"),
        });
        return unsupportedValue("unknown", value);
      }
    }

    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }

    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        return value;
      }

      addDiagnostic({
        code: DIAGNOSTIC_CODES.normalizationNonFiniteNumber,
        severity: "warning",
        message:
          "A non-finite numeric value was replaced with null for canonical JSON.",
        propertyPath: formatPropertyPath(path),
        causedDataLoss: true,
      });
      return null;
    }

    if (typeof value === "undefined") {
      addDiagnostic({
        code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
        severity: "warning",
        message:
          "An undefined value was preserved as an explicit unsupported tagged value.",
        propertyPath: formatPropertyPath(path),
        causedDataLoss: true,
      });
      return unsupportedValue("undefined", value);
    }

    if (typeof value === "bigint") {
      addDiagnostic({
        code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
        severity: "warning",
        message:
          "A bigint value was preserved as an explicit unsupported tagged value.",
        propertyPath: formatPropertyPath(path),
        causedDataLoss: true,
      });
      return unsupportedValue("bigint", value);
    }

    if (typeof value === "symbol") {
      addDiagnostic({
        code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
        severity: "warning",
        message:
          "A symbol value was preserved as an explicit unsupported tagged value.",
        propertyPath: formatPropertyPath(path),
        causedDataLoss: true,
      });
      return unsupportedValue("symbol", value);
    }

    if (typeof value === "function") {
      addDiagnostic({
        code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
        severity: "warning",
        message:
          "A function value was preserved as an explicit unsupported tagged value.",
        propertyPath: formatPropertyPath(path),
        causedDataLoss: true,
      });
      return unsupportedValue("function", value);
    }

    if (typeof value !== "object") {
      addDiagnostic({
        code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
        severity: "warning",
        message:
          "An unknown runtime value was preserved as an explicit unsupported tagged value.",
        propertyPath: formatPropertyPath(path),
        causedDataLoss: true,
      });
      return unsupportedValue("unknown", value);
    }

    const objectValue = value;
    const currentPath = formatPropertyPath(path);
    const firstSeenAt = activeObjects.get(objectValue);
    if (firstSeenAt !== undefined) {
      addDiagnostic({
        code: DIAGNOSTIC_CODES.normalizationCycle,
        severity: "error",
        message: `A cyclic runtime value referencing ${firstSeenAt} was preserved as an explicit unsupported tagged value.`,
        propertyPath: currentPath,
        causedDataLoss: true,
      });
      return unsupportedValue("cyclic-reference", value);
    }

    activeObjects.set(objectValue, currentPath);
    try {
      let arrayValue: boolean;
      try {
        arrayValue = Array.isArray(objectValue);
      } catch (error) {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
          severity: "error",
          message:
            "The runtime value kind could not be inspected and was preserved as an unsupported tagged value.",
          propertyPath: currentPath,
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
        });
        return unsupportedValue("unknown", value);
      }

      if (arrayValue) {
        const runtimeArray = objectValue as readonly unknown[];
        let length: number;
        let ownStringKeys: string[];
        let ownSymbolKeys: symbol[];
        try {
          length = runtimeArray.length;
          ownStringKeys = Object.keys(objectValue);
          ownSymbolKeys = Object.getOwnPropertySymbols(objectValue);
        } catch (error) {
          addDiagnostic({
            code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
            severity: "error",
            message:
              "The runtime array structure could not be inspected and was preserved as an unsupported tagged value.",
            propertyPath: currentPath,
            causedDataLoss: true,
            technicalCause: normalizeSafeTechnicalCause(
              error,
              "property-access",
            ),
          });
          return unsupportedValue("unknown", value);
        }

        if (
          ownSymbolKeys.length > 0 ||
          ownStringKeys.some((key) => !isArrayIndexKey(key, length))
        ) {
          addDiagnostic({
            code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
            severity: "warning",
            message:
              "An array with non-index properties was preserved as an explicit unsupported tagged value.",
            propertyPath: currentPath,
            causedDataLoss: true,
          });
          return unsupportedValue(
            ownSymbolKeys.length > 0
              ? "symbol-keyed-property"
              : "array-extra-property",
            value,
          );
        }

        const normalizedArray: JsonValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const childPath = [...path, index];
          try {
            normalizedArray.push(normalize(runtimeArray[index], childPath));
          } catch (error) {
            addDiagnostic({
              code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
              severity: "error",
              message:
                "A runtime array item could not be read and was preserved as an unavailable tagged value.",
              propertyPath: formatPropertyPath(childPath),
              causedDataLoss: true,
              technicalCause: normalizeSafeTechnicalCause(
                error,
                "property-access",
              ),
            });
            normalizedArray.push(inaccessibleProperty());
          }
        }
        return normalizedArray;
      }

      let prototype: object | null;
      try {
        prototype = Object.getPrototypeOf(objectValue) as object | null;
      } catch (error) {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
          severity: "error",
          message:
            "The runtime value prototype could not be inspected and was preserved as an unsupported tagged value.",
          propertyPath: currentPath,
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
        });
        return unsupportedValue("non-plain-object", value);
      }

      if (prototype !== Object.prototype && prototype !== null) {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
          severity: "warning",
          message:
            "A non-plain runtime object was preserved as an explicit unsupported tagged value.",
          propertyPath: currentPath,
          causedDataLoss: true,
        });
        return unsupportedValue("non-plain-object", value);
      }

      let keys: string[];
      let symbolKeys: symbol[];
      try {
        keys = Object.keys(objectValue).sort();
        symbolKeys = Object.getOwnPropertySymbols(objectValue);
      } catch (error) {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
          severity: "error",
          message:
            "The runtime object keys could not be read and were preserved as an unsupported tagged value.",
          propertyPath: currentPath,
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
        });
        return unsupportedValue("unknown", value);
      }

      if (symbolKeys.length > 0) {
        addDiagnostic({
          code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
          severity: "warning",
          message:
            "An object with symbol-keyed properties was preserved as an explicit unsupported tagged value.",
          propertyPath: currentPath,
          causedDataLoss: true,
        });
        return unsupportedValue("symbol-keyed-property", value);
      }

      const normalizedObject = Object.create(null) as Record<string, JsonValue>;
      for (const key of keys) {
        const childPath = [...path, key];
        try {
          normalizedObject[key] = normalize(
            (objectValue as Record<string, unknown>)[key],
            childPath,
          );
        } catch (error) {
          addDiagnostic({
            code: DIAGNOSTIC_CODES.normalizationPropertyAccessFailed,
            severity: "error",
            message:
              "A runtime object property could not be read and was preserved as an unavailable tagged value.",
            propertyPath: formatPropertyPath(childPath),
            causedDataLoss: true,
            technicalCause: normalizeSafeTechnicalCause(
              error,
              "property-access",
            ),
          });
          normalizedObject[key] = inaccessibleProperty();
        }
      }

      return normalizedObject;
    } finally {
      activeObjects.delete(objectValue);
    }
  };

  return {
    value: normalize(input, options.propertyPath ?? []),
    diagnostics: diagnostics.listSince(diagnosticStart),
  };
}
