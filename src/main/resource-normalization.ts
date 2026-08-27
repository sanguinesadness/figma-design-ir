import type { DiagnosticBag } from "../shared/diagnostics";
import {
  variableAlias,
  type JsonObject,
  type JsonValue,
  type SourceRef,
  type VariableBindingIR,
} from "../shared/ir";
import {
  normalizeJsonSafeValue,
  type PropertyPathSegment,
} from "../shared/normalization";

function figmaVariableAlias(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return record.type === "VARIABLE_ALIAS" && typeof record.id === "string"
    ? variableAlias(record.id)
    : undefined;
}

export function normalizeCollectedResource(
  value: unknown,
  diagnostics: DiagnosticBag,
  source: SourceRef,
  propertyPath: readonly PropertyPathSegment[],
): JsonValue {
  return normalizeJsonSafeValue(value, {
    diagnostics,
    phase: "collection",
    source,
    propertyPath,
    classifySpecialValue: figmaVariableAlias,
  }).value;
}

export function asJsonObject(value: JsonValue): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function collectVariableBindingsFromValue(
  value: JsonValue | undefined,
  propertyPath: string,
): readonly VariableBindingIR[] {
  if (value === undefined) {
    return [];
  }

  const bindings = new Map<string, VariableBindingIR>();
  const visit = (candidate: JsonValue, path: string): void => {
    if (Array.isArray(candidate)) {
      for (const [index, item] of (
        candidate as readonly JsonValue[]
      ).entries()) {
        visit(item, `${path}[${index}]`);
      }
      return;
    }
    if (typeof candidate !== "object" || candidate === null) {
      return;
    }

    const object = candidate as JsonObject;
    const variableId =
      object.$type === "variable-alias" && typeof object.variableId === "string"
        ? object.variableId
        : object.type === "VARIABLE_ALIAS" && typeof object.id === "string"
          ? object.id
          : undefined;
    if (variableId !== undefined) {
      const binding: VariableBindingIR = {
        propertyPath: path,
        variable: { kind: "variable", id: variableId },
      };
      bindings.set(JSON.stringify([path, variableId]), binding);
      return;
    }

    for (const key of Object.keys(object).sort()) {
      const child = object[key];
      if (child !== undefined) {
        visit(child, `${path}[${JSON.stringify(key)}]`);
      }
    }
  };

  visit(value, propertyPath);
  return [...bindings.values()];
}

export function variableIdsFromBindings(
  bindings: readonly VariableBindingIR[],
): readonly string[] {
  return [...new Set(bindings.map((binding) => binding.variable.id))].sort();
}
