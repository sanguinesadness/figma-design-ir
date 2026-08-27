import { ExportCancellationToken, yieldToFigma } from "./cancellation";
import {
  DIAGNOSTIC_CODES,
  normalizeSafeTechnicalCause,
  type DiagnosticBag,
} from "../shared/diagnostics";
import {
  DESIGN_IR_SCHEMA_VERSION,
  variableAlias,
  type CollectionCoverageIR,
  type ComponentDefinitionIR,
  type ComponentDependencyIR,
  type ComponentNodeDataIR,
  type ComponentPreferredValueIR,
  type ComponentPropertyDefinitionIR,
  type ComponentPropertyReferencesIR,
  type ComponentPropertyValueIR,
  type ComponentsIndexIR,
  type ComponentSlotSettingsIR,
  type InstanceNodeDataIR,
  type InstanceOverrideIR,
  type JsonObject,
  type JsonValue,
  type SlotLimitViolationIR,
  type SourceRef,
  type VariableBindingIR,
} from "../shared/ir";
import { normalizeJsonSafeValue } from "../shared/normalization";
import {
  sortUnorderedComponentDefinitions,
  sortUnorderedComponentDependencies,
  sortUnorderedSourceRefs,
} from "../shared/serialization";

export interface ComponentCollectorAdapter {
  readonly getNodeByIdAsync: (id: string) => Promise<SceneNode | null>;
}

export interface CollectComponentsOptions {
  readonly roots: readonly SceneNode[];
  readonly adapter: ComponentCollectorAdapter;
  readonly diagnostics: DiagnosticBag;
  readonly cancellation: ExportCancellationToken;
  readonly session?: ComponentCollectionSession;
  readonly onProgress?: (progress: ComponentCollectionProgress) => void;
}

export interface ComponentCollectionProgress {
  readonly stage: "traversal" | "instance-lookup" | "id-lookup" | "complete";
  readonly traversedNodes: number;
  readonly definitionsDiscovered: number;
  readonly instanceLookupsStarted: number;
  readonly instanceLookupsCompleted: number;
  readonly idLookupsStarted: number;
  readonly idLookupsCompleted: number;
  readonly reusedDefinitionTraversals: number;
  readonly duplicateDefinitionQueuesSkipped: number;
}

/**
 * Export-scoped, in-memory reuse for immutable component identity lookups.
 * Keys are opaque Plugin API IDs only. No values are persisted or logged.
 */
export class ComponentCollectionSession {
  readonly #definitionsById = new Map<string, ComponentDefinitionIR>();
  readonly #definitionsByKey = new Map<string, ComponentDefinitionIR>();

  definitionById(id: string): ComponentDefinitionIR | undefined {
    return this.#definitionsById.get(id);
  }

  definitionByKey(key: string): ComponentDefinitionIR | undefined {
    return this.#definitionsByKey.get(key);
  }

  rememberDefinitions(definitions: readonly ComponentDefinitionIR[]): void {
    for (const definition of definitions) {
      if (!this.#definitionsById.has(definition.source.id)) {
        this.#definitionsById.set(definition.source.id, definition);
      }
      const key = definition.source.key;
      if (key !== undefined && !this.#definitionsByKey.has(key)) {
        this.#definitionsByKey.set(key, definition);
      }
    }
  }
}

export interface CollectedComponents {
  readonly index: ComponentsIndexIR;
  readonly componentDataByNodeId: ReadonlyMap<string, ComponentNodeDataIR>;
  readonly instanceDataByNodeId: ReadonlyMap<string, InstanceNodeDataIR>;
  readonly componentPropertyReferencesByNodeId: ReadonlyMap<
    string,
    ComponentPropertyReferencesIR | null
  >;
  readonly slotLimitViolationsByNodeId: ReadonlyMap<
    string,
    readonly SlotLimitViolationIR[]
  >;
  readonly dependencyRefs: readonly SourceRef[];
  readonly complete: boolean;
  readonly definitionNodesById: ReadonlyMap<string, SceneNode>;
}

interface CollectionState {
  complete: boolean;
}

interface ReadResult {
  readonly ok: boolean;
  readonly present: boolean;
  readonly value?: unknown;
}

interface PropertyDefinitionResult {
  readonly definitions: readonly ComponentPropertyDefinitionIR[];
  readonly ids: readonly string[];
  readonly variantAxes: NonNullable<ComponentDefinitionIR["variantAxes"]>;
  readonly swapTargetIds: readonly string[];
  readonly preferredTargetKeys: readonly string[];
  readonly available: boolean;
  readonly complete: boolean;
}

interface ComponentPropertyValuesResult {
  readonly values?: readonly ComponentPropertyValueIR[];
  readonly swapTargetIds: readonly string[];
  readonly preferredTargetKeys: readonly string[];
  readonly variableRefs: readonly SourceRef[];
}

interface TraversalItem {
  readonly node: SceneNode;
  readonly ownerComponent?: SourceRef & { readonly kind: "component" };
}

function basicNodeSource(
  node: SceneNode,
): SourceRef & { readonly kind: "node" } {
  let id = "unavailable-node";
  let name: string | undefined;
  try {
    if (typeof node.id === "string") {
      id = node.id;
    }
  } catch {
    // The originating property read owns the content-safe diagnostic.
  }
  try {
    if (typeof node.name === "string") {
      name = node.name;
    }
  } catch {
    // The originating property read owns the content-safe diagnostic.
  }
  return { kind: "node", id, ...(name === undefined ? {} : { name }) };
}

function readProperty(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): ReadResult {
  try {
    if (!Reflect.has(node, property)) {
      return { ok: true, present: false };
    }
    return {
      ok: true,
      present: true,
      value: Reflect.get(node, property),
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
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return { ok: false, present: false };
  }
}

function invalidShapeDiagnostic(
  node: SceneNode,
  propertyPath: string,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): void {
  state.complete = false;
  diagnostics.add({
    code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
    severity: "warning",
    message: "Supported component metadata had an unexpected runtime shape.",
    phase: "collection",
    source: basicNodeSource(node),
    propertyPath,
    causedDataLoss: true,
  });
}

function nodeId(node: SceneNode): string | undefined {
  try {
    return typeof node.id === "string" ? node.id : undefined;
  } catch {
    return undefined;
  }
}

function nodeType(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): string | undefined {
  const result = readProperty(node, "type", diagnostics, state);
  return result.ok && typeof result.value === "string"
    ? result.value
    : undefined;
}

function componentSource(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): (SourceRef & { readonly kind: "component" }) | undefined {
  const id = readProperty(node, "id", diagnostics, state);
  if (!id.ok || typeof id.value !== "string") {
    invalidShapeDiagnostic(node, "$.id", diagnostics, state);
    return undefined;
  }
  const name = readProperty(node, "name", diagnostics, state);
  const key = readProperty(node, "key", diagnostics, state);
  const remote = readProperty(node, "remote", diagnostics, state);
  return {
    kind: "component",
    id: id.value,
    ...(name.ok && typeof name.value === "string" ? { name: name.value } : {}),
    ...(key.ok && typeof key.value === "string" && key.value.length > 0
      ? { key: key.value }
      : {}),
    ...(remote.ok && typeof remote.value === "boolean"
      ? { remote: remote.value }
      : {}),
  };
}

function normalizeRuntimeValue(
  node: SceneNode,
  propertyPath: readonly (string | number)[],
  value: unknown,
  diagnostics: DiagnosticBag,
): JsonValue {
  return normalizeJsonSafeValue(value, {
    diagnostics,
    phase: "collection",
    source: basicNodeSource(node),
    propertyPath,
    classifySpecialValue: (candidate) => {
      if (typeof candidate !== "object" || candidate === null) {
        return undefined;
      }
      try {
        const record = candidate as Record<string, unknown>;
        return record.type === "VARIABLE_ALIAS" && typeof record.id === "string"
          ? variableAlias(record.id)
          : undefined;
      } catch {
        return undefined;
      }
    },
  }).value;
}

function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function variableId(value: JsonValue | undefined): string | undefined {
  const object = jsonObject(value);
  if (object === undefined) {
    return undefined;
  }
  return object.$type === "variable-alias" &&
    typeof object.variableId === "string"
    ? object.variableId
    : object.type === "VARIABLE_ALIAS" && typeof object.id === "string"
      ? object.id
      : undefined;
}

function variableBindings(
  node: SceneNode,
  propertyPath: readonly (string | number)[],
  value: unknown,
  diagnostics: DiagnosticBag,
): readonly VariableBindingIR[] {
  if (value === undefined) {
    return [];
  }
  const normalized = jsonObject(
    normalizeRuntimeValue(node, propertyPath, value, diagnostics),
  );
  if (normalized === undefined) {
    return [];
  }
  return Object.keys(normalized)
    .sort()
    .flatMap((field): readonly VariableBindingIR[] => {
      const id = variableId(normalized[field]);
      return id === undefined
        ? []
        : [{ propertyPath: field, variable: { kind: "variable", id } }];
    });
}

function preferredValues(
  node: SceneNode,
  propertyPath: readonly (string | number)[],
  value: unknown,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): readonly ComponentPreferredValueIR[] {
  if (value === undefined) {
    return [];
  }
  const normalized = normalizeRuntimeValue(
    node,
    propertyPath,
    value,
    diagnostics,
  );
  if (!Array.isArray(normalized)) {
    invalidShapeDiagnostic(
      node,
      `$.${propertyPath.join(".")}`,
      diagnostics,
      state,
    );
    return [];
  }
  return (normalized as readonly JsonValue[]).flatMap(
    (candidate, index): readonly ComponentPreferredValueIR[] => {
      const object = jsonObject(candidate);
      if (
        object === undefined ||
        (object.type !== "COMPONENT" && object.type !== "COMPONENT_SET") ||
        typeof object.key !== "string"
      ) {
        invalidShapeDiagnostic(
          node,
          `$.${propertyPath.join(".")}[${index}]`,
          diagnostics,
          state,
        );
        return [];
      }
      return [{ type: object.type, key: object.key }];
    },
  );
}

function slotSettings(
  value: JsonValue | undefined,
): ComponentSlotSettingsIR | undefined {
  const object = jsonObject(value);
  if (object === undefined) {
    return undefined;
  }
  const result: ComponentSlotSettingsIR = {
    ...(typeof object.stretchChildOnInsert === "boolean"
      ? { stretchChildOnInsert: object.stretchChildOnInsert }
      : {}),
    ...(typeof object.displayEmptyByDefault === "boolean"
      ? { displayEmptyByDefault: object.displayEmptyByDefault }
      : {}),
    ...(typeof object.minChildren === "number" || object.minChildren === null
      ? { minChildren: object.minChildren }
      : {}),
    ...(typeof object.maxChildren === "number" || object.maxChildren === null
      ? { maxChildren: object.maxChildren }
      : {}),
    ...(typeof object.allowPreferredValuesOnly === "boolean"
      ? { allowPreferredValuesOnly: object.allowPreferredValuesOnly }
      : {}),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function propertyDefinitions(
  owner: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): PropertyDefinitionResult {
  const diagnosticStart = diagnostics.size();
  const read = readProperty(
    owner,
    "componentPropertyDefinitions",
    diagnostics,
    state,
  );
  if (!read.ok) {
    return {
      definitions: [],
      ids: [],
      variantAxes: [],
      swapTargetIds: [],
      preferredTargetKeys: [],
      available: false,
      complete: false,
    };
  }
  if (!read.present || read.value === undefined) {
    return {
      definitions: [],
      ids: [],
      variantAxes: [],
      swapTargetIds: [],
      preferredTargetKeys: [],
      available: true,
      complete: true,
    };
  }
  if (
    typeof read.value !== "object" ||
    read.value === null ||
    Array.isArray(read.value)
  ) {
    invalidShapeDiagnostic(
      owner,
      "$.componentPropertyDefinitions",
      diagnostics,
      state,
    );
    return {
      definitions: [],
      ids: [],
      variantAxes: [],
      swapTargetIds: [],
      preferredTargetKeys: [],
      available: false,
      complete: false,
    };
  }

  const definitions: ComponentPropertyDefinitionIR[] = [];
  const axes: NonNullable<ComponentDefinitionIR["variantAxes"]>[number][] = [];
  const swapTargetIds: string[] = [];
  const preferredTargetKeys: string[] = [];
  for (const opaqueName of Object.keys(read.value).sort()) {
    let definition: unknown;
    try {
      definition = (read.value as Record<string, unknown>)[opaqueName];
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
        technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
      });
      continue;
    }
    if (typeof definition !== "object" || definition === null) {
      invalidShapeDiagnostic(
        owner,
        `$.componentPropertyDefinitions[${JSON.stringify(opaqueName)}]`,
        diagnostics,
        state,
      );
      continue;
    }
    const record = definition as Record<string, unknown>;
    const propertyType =
      typeof record.type === "string" ? record.type : "UNKNOWN";
    if (propertyType === "UNKNOWN") {
      invalidShapeDiagnostic(
        owner,
        `$.componentPropertyDefinitions[${JSON.stringify(opaqueName)}].type`,
        diagnostics,
        state,
      );
    }
    const defaultValue = normalizeRuntimeValue(
      owner,
      ["componentPropertyDefinitions", opaqueName, "defaultValue"],
      record.defaultValue,
      diagnostics,
    );
    const preferred = preferredValues(
      owner,
      ["componentPropertyDefinitions", opaqueName, "preferredValues"],
      record.preferredValues,
      diagnostics,
      state,
    );
    const bindings = variableBindings(
      owner,
      ["componentPropertyDefinitions", opaqueName, "boundVariables"],
      record.boundVariables,
      diagnostics,
    );
    let variants: string[] | undefined;
    if (record.variantOptions !== undefined) {
      if (!Array.isArray(record.variantOptions)) {
        invalidShapeDiagnostic(
          owner,
          `$.componentPropertyDefinitions[${JSON.stringify(opaqueName)}].variantOptions`,
          diagnostics,
          state,
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
              state,
            );
          }
        }
      }
    }
    const normalizedSlotSettings = slotSettings(
      record.slotSettings === undefined
        ? undefined
        : normalizeRuntimeValue(
            owner,
            ["componentPropertyDefinitions", opaqueName, "slotSettings"],
            record.slotSettings,
            diagnostics,
          ),
    );
    definitions.push({
      id: opaqueName,
      name: opaqueName,
      propertyType,
      defaultValue,
      preferredValues: preferred,
      ...(variants === undefined ? {} : { variantOptions: variants }),
      ...(typeof record.description === "string"
        ? { description: record.description }
        : {}),
      ...(normalizedSlotSettings === undefined
        ? {}
        : { slotSettings: normalizedSlotSettings }),
      variableBindings: bindings,
    });
    if (propertyType === "VARIANT" && variants !== undefined) {
      axes.push({ name: opaqueName, values: variants });
    }
    if (
      propertyType === "INSTANCE_SWAP" &&
      typeof record.defaultValue === "string"
    ) {
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
    complete: diagnostics
      .listSince(diagnosticStart)
      .every((diagnostic) => !diagnostic.causedDataLoss),
  };
}

function variantProperties(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): ComponentDefinitionIR["variantProperties"] {
  const read = readProperty(node, "variantProperties", diagnostics, state);
  if (!read.ok) {
    return undefined;
  }
  if (!read.present || read.value === null || read.value === undefined) {
    return [];
  }
  if (typeof read.value !== "object" || Array.isArray(read.value)) {
    invalidShapeDiagnostic(node, "$.variantProperties", diagnostics, state);
    return undefined;
  }
  return Object.keys(read.value)
    .sort()
    .flatMap((property): readonly { property: string; value: string }[] => {
      let value: unknown;
      try {
        value = (read.value as Record<string, unknown>)[property];
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
          technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
        });
        return [];
      }
      if (typeof value !== "string") {
        invalidShapeDiagnostic(
          node,
          `$.variantProperties[${JSON.stringify(property)}]`,
          diagnostics,
          state,
        );
        return [];
      }
      return [{ property, value }];
    });
}

function documentationLinks(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): readonly string[] | undefined {
  const read = readProperty(node, "documentationLinks", diagnostics, state);
  if (!read.ok) {
    return undefined;
  }
  if (!read.present || read.value === undefined) {
    return [];
  }
  if (!Array.isArray(read.value)) {
    invalidShapeDiagnostic(node, "$.documentationLinks", diagnostics, state);
    return undefined;
  }
  return read.value.flatMap((link, index): readonly string[] => {
    if (typeof link !== "object" || link === null) {
      invalidShapeDiagnostic(
        node,
        `$.documentationLinks[${index}]`,
        diagnostics,
        state,
      );
      return [];
    }
    try {
      const uri = (link as Record<string, unknown>).uri;
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
        technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
      });
      return [];
    }
    invalidShapeDiagnostic(
      node,
      `$.documentationLinks[${index}].uri`,
      diagnostics,
      state,
    );
    return [];
  });
}

function componentPropertyReferences(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): ComponentPropertyReferencesIR | null | undefined {
  const read = readProperty(
    node,
    "componentPropertyReferences",
    diagnostics,
    state,
  );
  if (!read.ok || !read.present) {
    return undefined;
  }
  if (read.value === null) {
    return null;
  }
  if (typeof read.value !== "object" || Array.isArray(read.value)) {
    invalidShapeDiagnostic(
      node,
      "$.componentPropertyReferences",
      diagnostics,
      state,
    );
    return undefined;
  }
  const record = read.value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const property of ["visible", "characters", "mainComponent"] as const) {
    if (typeof record[property] === "string") {
      result[property] = record[property];
    } else if (record[property] !== undefined) {
      invalidShapeDiagnostic(
        node,
        `$.componentPropertyReferences.${property}`,
        diagnostics,
        state,
      );
    }
  }
  return result;
}

function slotLimitViolations(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): readonly SlotLimitViolationIR[] | undefined {
  const read = readProperty(node, "limitViolations", diagnostics, state);
  if (!read.ok || !read.present) {
    return undefined;
  }
  if (
    !Array.isArray(read.value) ||
    !read.value.every(
      (value) =>
        value === "BELOW_MIN" ||
        value === "ABOVE_MAX" ||
        value === "HAS_NON_PREFERRED",
    )
  ) {
    invalidShapeDiagnostic(node, "$.limitViolations", diagnostics, state);
    return undefined;
  }
  return [...(read.value as readonly SlotLimitViolationIR[])].sort();
}

function componentPropertyValues(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): ComponentPropertyValuesResult {
  const read = readProperty(node, "componentProperties", diagnostics, state);
  if (!read.ok) {
    return {
      swapTargetIds: [],
      preferredTargetKeys: [],
      variableRefs: [],
    };
  }
  if (!read.present || read.value === undefined) {
    return {
      values: [],
      swapTargetIds: [],
      preferredTargetKeys: [],
      variableRefs: [],
    };
  }
  if (
    typeof read.value !== "object" ||
    read.value === null ||
    Array.isArray(read.value)
  ) {
    invalidShapeDiagnostic(node, "$.componentProperties", diagnostics, state);
    return {
      swapTargetIds: [],
      preferredTargetKeys: [],
      variableRefs: [],
    };
  }
  const values: ComponentPropertyValueIR[] = [];
  const swaps: string[] = [];
  const keys: string[] = [];
  const variableRefs: SourceRef[] = [];
  for (const opaqueName of Object.keys(read.value).sort()) {
    let property: unknown;
    try {
      property = (read.value as Record<string, unknown>)[opaqueName];
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
        technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
      });
      continue;
    }
    if (typeof property !== "object" || property === null) {
      invalidShapeDiagnostic(
        node,
        `$.componentProperties[${JSON.stringify(opaqueName)}]`,
        diagnostics,
        state,
      );
      continue;
    }
    const record = property as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "UNKNOWN";
    const value = normalizeRuntimeValue(
      node,
      ["componentProperties", opaqueName, "value"],
      record.value,
      diagnostics,
    );
    const preferred = preferredValues(
      node,
      ["componentProperties", opaqueName, "preferredValues"],
      record.preferredValues,
      diagnostics,
      state,
    );
    const bindings = variableBindings(
      node,
      ["componentProperties", opaqueName, "boundVariables"],
      record.boundVariables,
      diagnostics,
    );
    values.push({
      id: opaqueName,
      name: opaqueName,
      propertyType: type,
      value,
      ...(record.preferredValues === undefined
        ? {}
        : { preferredValues: preferred }),
      variableBindings: bindings,
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
    variableRefs,
  };
}

function instanceOverrides(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): readonly InstanceOverrideIR[] | undefined {
  const read = readProperty(node, "overrides", diagnostics, state);
  if (!read.ok) {
    return undefined;
  }
  if (!read.present || read.value === undefined) {
    return [];
  }
  if (!Array.isArray(read.value)) {
    invalidShapeDiagnostic(node, "$.overrides", diagnostics, state);
    return undefined;
  }
  return read.value
    .flatMap((override, index): readonly InstanceOverrideIR[] => {
      if (typeof override !== "object" || override === null) {
        invalidShapeDiagnostic(
          node,
          `$.overrides[${index}]`,
          diagnostics,
          state,
        );
        return [];
      }
      const record = override as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        !Array.isArray(record.overriddenFields) ||
        !record.overriddenFields.every((field) => typeof field === "string")
      ) {
        invalidShapeDiagnostic(
          node,
          `$.overrides[${index}]`,
          diagnostics,
          state,
        );
        return [];
      }
      return [
        {
          id: record.id,
          overriddenFields: [...record.overriddenFields].sort(),
        },
      ];
    })
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
}

function exposedInstanceIds(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): readonly string[] | undefined {
  const read = readProperty(node, "exposedInstances", diagnostics, state);
  if (!read.ok) {
    return undefined;
  }
  if (!read.present || read.value === undefined) {
    return [];
  }
  if (!Array.isArray(read.value)) {
    invalidShapeDiagnostic(node, "$.exposedInstances", diagnostics, state);
    return undefined;
  }
  return read.value
    .flatMap((instance, index): readonly string[] => {
      if (typeof instance !== "object" || instance === null) {
        invalidShapeDiagnostic(
          node,
          `$.exposedInstances[${index}]`,
          diagnostics,
          state,
        );
        return [];
      }
      try {
        const id = (instance as Record<string, unknown>).id;
        if (typeof id === "string") {
          return [id];
        }
        invalidShapeDiagnostic(
          node,
          `$.exposedInstances[${index}].id`,
          diagnostics,
          state,
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
          technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
        });
        return [];
      }
    })
    .sort();
}

function children(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  state: CollectionState,
): readonly SceneNode[] | undefined {
  const read = readProperty(node, "children", diagnostics, state);
  if (!read.ok) {
    return undefined;
  }
  if (!read.present || read.value === undefined) {
    return [];
  }
  if (!Array.isArray(read.value)) {
    invalidShapeDiagnostic(node, "$.children", diagnostics, state);
    return undefined;
  }
  return read.value as readonly SceneNode[];
}

function coverage(complete: boolean): CollectionCoverageIR {
  return complete
    ? { status: "collected" }
    : {
        status: "partial",
        reason: "Some supported component metadata was inaccessible.",
      };
}

function deduplicateSourceRefs(
  references: readonly SourceRef[],
): readonly SourceRef[] {
  const seen = new Set<string>();
  return sortUnorderedSourceRefs(references).filter((reference) => {
    const signature = `${reference.kind}\u0000${reference.id}`;
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

function deduplicateDependencies(
  dependencies: readonly ComponentDependencyIR[],
): readonly ComponentDependencyIR[] {
  const seen = new Set<string>();
  return sortUnorderedComponentDependencies(dependencies).filter(
    (dependency) => {
      const signature = `${dependency.from.id}\u0000${dependency.to.id}\u0000${dependency.relationship}`;
      if (seen.has(signature)) {
        return false;
      }
      seen.add(signature);
      return true;
    },
  );
}

export async function collectComponents(
  options: CollectComponentsOptions,
): Promise<CollectedComponents> {
  const diagnosticStart = options.diagnostics.size();
  const state: CollectionState = { complete: true };
  const definitions = new Map<string, ComponentDefinitionIR>();
  const definitionNodesById = new Map<string, SceneNode>();
  const componentDataByNodeId = new Map<string, ComponentNodeDataIR>();
  const instanceDataByNodeId = new Map<string, InstanceNodeDataIR>();
  const propertyReferencesByNodeId = new Map<
    string,
    ComponentPropertyReferencesIR | null
  >();
  const slotLimitViolationsByNodeId = new Map<
    string,
    readonly SlotLimitViolationIR[]
  >();
  const propertyDefinitionCache = new Map<
    SceneNode,
    PropertyDefinitionResult
  >();
  const dependencies: ComponentDependencyIR[] = [];
  const dependencyRefs: SourceRef[] = [];
  const pendingIds = new Map<
    string,
    {
      readonly source: SourceRef;
      readonly owner?: SourceRef & { readonly kind: "component" };
    }
  >();
  const preferredEdges: {
    readonly owner: SourceRef & { readonly kind: "component" };
    readonly key: string;
  }[] = [];
  const exposedInstanceIdsByOwner = new Map<string, Set<string>>();
  const traversalQueue: TraversalItem[] = options.roots.map((node) => ({
    node,
  }));
  let traversalCursor = 0;
  const visitedContexts = new Set<string>();
  const resolvedIds = new Set<string>();
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
      return id === undefined ? [] : [id];
    }),
  );

  const reportProgress = (
    stage: ComponentCollectionProgress["stage"],
  ): void => {
    options.onProgress?.({
      stage,
      traversedNodes: traversedNodeCount,
      definitionsDiscovered,
      instanceLookupsStarted,
      instanceLookupsCompleted,
      idLookupsStarted,
      idLookupsCompleted,
      reusedDefinitionTraversals,
      duplicateDefinitionQueuesSkipped,
    });
  };

  const reportLookupBoundary = (
    stage: "instance-lookup" | "id-lookup",
    count: number,
  ): void => {
    if (count === 1 || count % 25 === 0) {
      reportProgress(stage);
    }
  };

  const reportReuseBoundary = (): void => {
    const reuseEvents =
      reusedDefinitionTraversals + duplicateDefinitionQueuesSkipped;
    if (reuseEvents === 1 || reuseEvents % 25 === 0) {
      reportProgress("traversal");
    }
  };

  reportProgress("traversal");

  const cachedDefinitions = (node: SceneNode): PropertyDefinitionResult => {
    const existing = propertyDefinitionCache.get(node);
    if (existing !== undefined) {
      return existing;
    }
    const result = propertyDefinitions(node, options.diagnostics, state);
    propertyDefinitionCache.set(node, result);
    dependencyRefs.push(
      ...result.definitions.flatMap((definition) =>
        definition.variableBindings.map((binding) => binding.variable),
      ),
    );
    return result;
  };

  const requestTarget = (
    id: string,
    source: SourceRef,
    owner?: SourceRef & { readonly kind: "component" },
  ): void => {
    dependencyRefs.push({ kind: "component", id });
    if (owner !== undefined) {
      dependencies.push({
        from: owner,
        to: { kind: "component", id },
        relationship: "swap",
      });
    }
    if (options.session?.definitionById(id) !== undefined) {
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
        ...(owner === undefined ? {} : { owner }),
      });
    }
  };

  const enqueueDefinitionNode = (node: SceneNode): void => {
    const id = nodeId(node);
    if (id !== undefined) {
      if (options.session?.definitionById(id) !== undefined) {
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
    traversalQueue.push({ node });
  };

  const enqueueMainComponent = (node: SceneNode): void => {
    const id = nodeId(node);
    if (id !== undefined && options.session?.definitionById(id) !== undefined) {
      reusedDefinitionTraversals += 1;
      reportReuseBoundary();
      return;
    }
    const parentRead = readProperty(node, "parent", options.diagnostics, state);
    if (
      parentRead.ok &&
      typeof parentRead.value === "object" &&
      parentRead.value !== null &&
      nodeType(parentRead.value as SceneNode, options.diagnostics, state) ===
        "COMPONENT_SET"
    ) {
      enqueueDefinitionNode(parentRead.value as SceneNode);
    }
    enqueueDefinitionNode(node);
  };

  while (traversalCursor < traversalQueue.length || pendingIds.size > 0) {
    options.cancellation.throwIfCancelled();
    const item = traversalQueue[traversalCursor];
    if (item !== undefined) {
      traversalCursor += 1;
      if (
        traversalCursor >= 512 &&
        traversalCursor * 2 >= traversalQueue.length
      ) {
        traversalQueue.splice(0, traversalCursor);
        traversalCursor = 0;
      }
    }
    if (item === undefined) {
      const requestEntry = pendingIds.entries().next().value as
        | [
            string,
            {
              readonly source: SourceRef;
              readonly owner?: SourceRef & { readonly kind: "component" };
            },
          ]
        | undefined;
      if (requestEntry === undefined) {
        break;
      }
      const [id, request] = requestEntry;
      pendingIds.delete(id);
      if (resolvedIds.has(id) || definitions.has(id)) {
        continue;
      }
      if (options.session?.definitionById(id) !== undefined) {
        reusedDefinitionTraversals += 1;
        reportReuseBoundary();
        continue;
      }
      resolvedIds.add(id);
      let resolved: SceneNode | null;
      idLookupsStarted += 1;
      reportLookupBoundary("id-lookup", idLookupsStarted);
      try {
        options.cancellation.throwIfCancelled();
        resolved = await options.adapter.getNodeByIdAsync(id);
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
          source: { kind: "component", id },
          propertyPath: `$.referencedBy[${JSON.stringify(request.source.id)}]`,
          causedDataLoss: true,
          technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
        });
        continue;
      }
      if (
        resolved === null ||
        !["COMPONENT", "COMPONENT_SET"].includes(
          nodeType(resolved, options.diagnostics, state) ?? "",
        )
      ) {
        state.complete = false;
        options.diagnostics.add({
          code: DIAGNOSTIC_CODES.componentDependencyUnavailable,
          severity: "warning",
          message: "A referenced component definition is not accessible.",
          phase: "collection",
          source: { kind: "component", id },
          propertyPath: `$.referencedBy[${JSON.stringify(request.source.id)}]`,
          causedDataLoss: true,
        });
        continue;
      }
      enqueueMainComponent(resolved);
      continue;
    }

    const id = nodeId(item.node);
    if (id === undefined) {
      invalidShapeDiagnostic(item.node, "$.id", options.diagnostics, state);
      continue;
    }
    const context = `${id}\u0000${item.ownerComponent?.id ?? ""}`;
    if (visitedContexts.has(context)) {
      continue;
    }
    visitedContexts.add(context);
    traversedNodeCount += 1;
    if (traversedNodeCount % 50 === 0) {
      reportProgress("traversal");
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }

    const references = componentPropertyReferences(
      item.node,
      options.diagnostics,
      state,
    );
    if (references !== undefined) {
      propertyReferencesByNodeId.set(id, references);
    }

    const type = nodeType(item.node, options.diagnostics, state);
    if (type === "SLOT") {
      const violations = slotLimitViolations(
        item.node,
        options.diagnostics,
        state,
      );
      if (violations !== undefined) {
        slotLimitViolationsByNodeId.set(id, violations);
      }
    }
    let childOwner = item.ownerComponent;
    if (type === "COMPONENT" || type === "COMPONENT_SET") {
      const definitionDiagnosticStart = options.diagnostics.size();
      const source = componentSource(item.node, options.diagnostics, state);
      if (source !== undefined) {
        let owningSet: (SourceRef & { readonly kind: "component" }) | undefined;
        let definitionsOwner = item.node;
        let canReadOwnDefinitions = type === "COMPONENT_SET";
        if (type === "COMPONENT") {
          const parent = readProperty(
            item.node,
            "parent",
            options.diagnostics,
            state,
          );
          if (!parent.ok) {
            canReadOwnDefinitions = false;
          } else if (
            typeof parent.value === "object" &&
            parent.value !== null &&
            nodeType(parent.value as SceneNode, options.diagnostics, state) ===
              "COMPONENT_SET"
          ) {
            owningSet = componentSource(
              parent.value as SceneNode,
              options.diagnostics,
              state,
            );
            definitionsOwner = parent.value as SceneNode;
            canReadOwnDefinitions = false;
            enqueueDefinitionNode(parent.value as SceneNode);
          } else {
            canReadOwnDefinitions = true;
          }
        }

        // This guard is deliberate: a variant component's inherited getter can
        // throw in Figma. Definitions are obtained from its owning set.
        const propertyMetadata =
          type === "COMPONENT_SET" || owningSet !== undefined
            ? cachedDefinitions(definitionsOwner)
            : canReadOwnDefinitions
              ? cachedDefinitions(item.node)
              : {
                  definitions: [],
                  ids: [],
                  variantAxes: [],
                  swapTargetIds: [],
                  preferredTargetKeys: [],
                  available: false,
                  complete: false,
                };
        const variants = variantProperties(
          item.node,
          options.diagnostics,
          state,
        );
        const description = readProperty(
          item.node,
          "description",
          options.diagnostics,
          state,
        );
        const markdown = readProperty(
          item.node,
          "descriptionMarkdown",
          options.diagnostics,
          state,
        );
        const defaultVariant =
          type === "COMPONENT_SET"
            ? readProperty(
                item.node,
                "defaultVariant",
                options.diagnostics,
                state,
              )
            : undefined;
        let defaultVariantId: string | undefined;
        if (
          defaultVariant?.present === true &&
          typeof defaultVariant.value === "object" &&
          defaultVariant.value !== null
        ) {
          try {
            const value = (defaultVariant.value as Record<string, unknown>).id;
            if (typeof value === "string") {
              defaultVariantId = value;
            } else {
              invalidShapeDiagnostic(
                item.node,
                "$.defaultVariant.id",
                options.diagnostics,
                state,
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
                "property-access",
              ),
            });
          }
        }
        const definition: ComponentDefinitionIR = {
          componentKind:
            type === "COMPONENT_SET" ? "component-set" : "component",
          source,
          nodeId: source.id,
          ...(owningSet === undefined ? {} : { componentSetId: owningSet.id }),
          ...(defaultVariantId === undefined ? {} : { defaultVariantId }),
          ...(propertyMetadata.available
            ? {
                variantAxes:
                  type === "COMPONENT_SET" ? propertyMetadata.variantAxes : [],
                propertyDefinitions:
                  type === "COMPONENT_SET" || owningSet === undefined
                    ? propertyMetadata.definitions
                    : [],
              }
            : {}),
          ...(variants === undefined ? {} : { variantProperties: variants }),
          ...(() => {
            const links = documentationLinks(
              item.node,
              options.diagnostics,
              state,
            );
            return links === undefined ? {} : { documentationLinks: links };
          })(),
          ...(description.ok && typeof description.value === "string"
            ? { description: description.value }
            : {}),
          ...(markdown.ok && typeof markdown.value === "string"
            ? { descriptionMarkdown: markdown.value }
            : {}),
          diagnosticIds: options.diagnostics
            .listSince(definitionDiagnosticStart)
            .map((diagnostic) => diagnostic.id),
        };
        if (!definitions.has(source.id)) {
          definitionsDiscovered += 1;
        }
        definitions.set(source.id, definition);
        definitionNodesById.set(source.id, item.node);
        componentDataByNodeId.set(source.id, {
          metadataCoverage: coverage(
            options.diagnostics
              .listSince(definitionDiagnosticStart)
              .every((diagnostic) => !diagnostic.causedDataLoss) &&
              propertyMetadata.complete,
          ),
          component: source,
          ...(owningSet === undefined ? {} : { componentSet: owningSet }),
          ...(variants === undefined ? {} : { variantProperties: variants }),
          ...(propertyMetadata.available
            ? { propertyDefinitionIds: propertyMetadata.ids }
            : {}),
        });
        childOwner = source;
        dependencyRefs.push(source);
        if (owningSet !== undefined) {
          dependencies.push({
            from: owningSet,
            to: source,
            relationship: "contains",
          });
        }
        for (const targetId of propertyMetadata.swapTargetIds) {
          requestTarget(targetId, source, source);
        }
        preferredEdges.push(
          ...propertyMetadata.preferredTargetKeys.map((key) => ({
            owner: source,
            key,
          })),
        );
      }
    } else if (type === "INSTANCE") {
      const instanceDiagnosticStart = options.diagnostics.size();
      const source = basicNodeSource(item.node);
      const isExposed = readProperty(
        item.node,
        "isExposedInstance",
        options.diagnostics,
        state,
      );
      if (item.ownerComponent !== undefined && isExposed.value === true) {
        const ownerIds =
          exposedInstanceIdsByOwner.get(item.ownerComponent.id) ??
          new Set<string>();
        ownerIds.add(id);
        exposedInstanceIdsByOwner.set(item.ownerComponent.id, ownerIds);
      }
      const values = componentPropertyValues(
        item.node,
        options.diagnostics,
        state,
      );
      dependencyRefs.push(...values.variableRefs);
      const overrides = instanceOverrides(
        item.node,
        options.diagnostics,
        state,
      );
      const exposed = exposedInstanceIds(item.node, options.diagnostics, state);
      const scale = readProperty(
        item.node,
        "scaleFactor",
        options.diagnostics,
        state,
      );
      const mainGetter = readProperty(
        item.node,
        "getMainComponentAsync",
        options.diagnostics,
        state,
      );
      let mainComponent:
        (SourceRef & { readonly kind: "component" }) | undefined;
      if (mainGetter.ok && typeof mainGetter.value === "function") {
        options.cancellation.throwIfCancelled();
        instanceLookupsStarted += 1;
        reportLookupBoundary("instance-lookup", instanceLookupsStarted);
        try {
          const resolved = (await Reflect.apply(
            mainGetter.value,
            item.node,
            [],
          )) as SceneNode | null;
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
              causedDataLoss: true,
            });
          } else {
            mainComponent = componentSource(
              resolved,
              options.diagnostics,
              state,
            );
            if (mainComponent !== undefined) {
              dependencyRefs.push(mainComponent);
              if (item.ownerComponent !== undefined) {
                dependencies.push({
                  from: item.ownerComponent,
                  to: mainComponent,
                  relationship: "instance",
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
              "property-access",
            ),
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
          causedDataLoss: true,
        });
      }
      const swapTargets = deduplicateSourceRefs(
        values.swapTargetIds.map((targetId) => ({
          kind: "component" as const,
          id: targetId,
        })),
      ) as readonly (SourceRef & { readonly kind: "component" })[];
      instanceDataByNodeId.set(id, {
        metadataCoverage: coverage(
          options.diagnostics
            .listSince(instanceDiagnosticStart)
            .every((diagnostic) => !diagnostic.causedDataLoss),
        ),
        ...(mainComponent === undefined ? {} : { mainComponent }),
        ...(values.values === undefined
          ? {}
          : { componentProperties: values.values }),
        ...(overrides === undefined ? {} : { overrides }),
        ...(values.values === undefined ? {} : { swapTargets }),
        ...(exposed === undefined ? {} : { exposedInstanceIds: exposed }),
        ...(scale.ok && typeof scale.value === "number"
          ? { scaleFactor: Number.isFinite(scale.value) ? scale.value : null }
          : {}),
      });
      for (const targetId of values.swapTargetIds) {
        requestTarget(targetId, source, item.ownerComponent ?? mainComponent);
      }
      const propertyOwner = item.ownerComponent ?? mainComponent;
      if (propertyOwner !== undefined) {
        preferredEdges.push(
          ...values.preferredTargetKeys.map((key) => ({
            owner: propertyOwner,
            key,
          })),
        );
      }
    }

    const nodeChildren = children(item.node, options.diagnostics, state);
    for (const child of nodeChildren ?? []) {
      traversalQueue.push({
        node: child,
        ...(childOwner === undefined ? {} : { ownerComponent: childOwner }),
      });
    }
  }

  for (const [id, definition] of definitions) {
    const exposedIds = exposedInstanceIdsByOwner.get(id);
    if (exposedIds !== undefined) {
      definitions.set(id, {
        ...definition,
        exposedInstanceIds: [...exposedIds].sort(),
      });
    }
  }

  const definitionsByKey = new Map<string, ComponentDefinitionIR>();
  for (const definition of definitions.values()) {
    if (definition.source.key !== undefined) {
      definitionsByKey.set(definition.source.key, definition);
    }
  }
  for (const request of preferredEdges) {
    const target =
      definitionsByKey.get(request.key) ??
      options.session?.definitionByKey(request.key);
    if (target !== undefined) {
      dependencies.push({
        from: request.owner,
        to: target.source,
        relationship: "preferred-value",
      });
    }
  }

  const enrichComponentRef = (
    reference: SourceRef & { readonly kind: "component" },
  ): SourceRef & { readonly kind: "component" } =>
    definitions.get(reference.id)?.source ??
    options.session?.definitionById(reference.id)?.source ??
    reference;
  const enrichedDependencies = dependencies.map((dependency) => ({
    ...dependency,
    from: enrichComponentRef(dependency.from),
    to: enrichComponentRef(dependency.to),
  }));
  const index: ComponentsIndexIR = {
    kind: "design-ir-components",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    definitions: sortUnorderedComponentDefinitions([...definitions.values()]),
    dependencies: deduplicateDependencies(enrichedDependencies),
    diagnosticIds: options.diagnostics
      .listSince(diagnosticStart)
      .map((diagnostic) => diagnostic.id),
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
      dependencyRefs.map((reference) =>
        reference.kind === "component"
          ? enrichComponentRef(
              reference as SourceRef & { readonly kind: "component" },
            )
          : reference,
      ),
    ),
    complete: state.complete,
    definitionNodesById,
  };
}
