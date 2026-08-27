import { resolveVariableAliases } from "../shared/aliases";
import {
  DIAGNOSTIC_CODES,
  normalizeSafeTechnicalCause,
  type DiagnosticBag,
} from "../shared/diagnostics";
import {
  DESIGN_IR_SCHEMA_VERSION,
  variableAlias,
  type JsonObject,
  type JsonValue,
  type SourceRef,
  type VariableCollectionIR,
  type VariableIR,
  type VariablesIndexIR,
} from "../shared/ir";
import { compareSourceRefs } from "../shared/serialization";
import { ExportCancellationToken, yieldToFigma } from "./cancellation";
import { normalizeCollectedResource } from "./resource-normalization";

export interface ReadableVariableCollection {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly remote: boolean;
  readonly hiddenFromPublishing: boolean;
  readonly isExtension: boolean;
  readonly parentVariableCollectionId?: string;
  readonly rootVariableCollectionId?: string;
  readonly variableOverrides?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly defaultModeId: string;
  readonly modes: readonly {
    readonly modeId: string;
    readonly name: string;
    readonly parentModeId?: string;
  }[];
  readonly variableIds: readonly string[];
  readonly getPublishStatusAsync?: () => Promise<string>;
}

export interface ReadableVariable {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly remote: boolean;
  readonly variableCollectionId: string;
  readonly resolvedType: string;
  readonly description: string;
  readonly scopes: readonly string[];
  readonly codeSyntax: Readonly<Record<string, string | undefined>>;
  readonly hiddenFromPublishing: boolean;
  readonly valuesByMode: Readonly<Record<string, unknown>>;
  readonly getPublishStatusAsync?: () => Promise<string>;
  readonly valuesByModeForCollectionAsync?: (
    collection: ReadableVariableCollection,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

export interface VariableCollectorApi {
  getLocalVariableCollectionsAsync(): Promise<
    readonly ReadableVariableCollection[]
  >;
  getLocalVariablesAsync(): Promise<readonly ReadableVariable[]>;
  getVariableByIdAsync(id: string): Promise<ReadableVariable | null>;
  getVariableCollectionByIdAsync(
    id: string,
  ): Promise<ReadableVariableCollection | null>;
}

export interface CollectVariablesOptions {
  readonly referencedVariableIds: readonly string[];
  readonly referencedCollectionIds?: readonly string[];
  readonly diagnostics: DiagnosticBag;
  readonly cancellation: ExportCancellationToken;
  readonly api?: VariableCollectorApi;
}

export interface CollectedVariables {
  readonly artifact: VariablesIndexIR;
  readonly localCount: number;
  readonly accessibleReferences: readonly (SourceRef & {
    readonly kind: "variable";
  })[];
  readonly localEnumerationComplete: boolean;
}

interface LocalReadResult<T> {
  readonly items: readonly T[];
  readonly complete: boolean;
}

function sourceForVariable(
  variable: ReadableVariable,
): SourceRef & { readonly kind: "variable" } {
  return {
    kind: "variable",
    id: variable.id,
    key: variable.key,
    name: variable.name,
    remote: variable.remote,
  };
}

function sourceForCollection(
  collection: ReadableVariableCollection,
): SourceRef & { readonly kind: "collection" } {
  return {
    kind: "collection",
    id: collection.id,
    key: collection.key,
    name: collection.name,
    remote: collection.remote,
  };
}

function aliasId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  return object.type === "VARIABLE_ALIAS" && typeof object.id === "string"
    ? object.id
    : undefined;
}

function missingModeValue(): JsonObject {
  return { $type: "unavailable", reason: "missing-mode" };
}

function defaultApi(): VariableCollectorApi {
  return {
    getLocalVariableCollectionsAsync: async () =>
      await figma.variables.getLocalVariableCollectionsAsync(),
    getLocalVariablesAsync: async () =>
      (await figma.variables.getLocalVariablesAsync()) as unknown as readonly ReadableVariable[],
    getVariableByIdAsync: async (id) =>
      (await figma.variables.getVariableByIdAsync(
        id,
      )) as unknown as ReadableVariable | null,
    getVariableCollectionByIdAsync: async (id) =>
      await figma.variables.getVariableCollectionByIdAsync(id),
  };
}

async function readLocalCollections(
  api: VariableCollectorApi,
  options: CollectVariablesOptions,
): Promise<LocalReadResult<ReadableVariableCollection>> {
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
      message:
        "Local variable collections could not be read; the variables index is incomplete.",
      phase: "collection",
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return { items: [], complete: false };
  }
}

async function readLocalVariables(
  api: VariableCollectorApi,
  options: CollectVariablesOptions,
): Promise<LocalReadResult<ReadableVariable>> {
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
      message:
        "Local variables could not be read; the variables index is incomplete.",
      phase: "collection",
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return { items: [], complete: false };
  }
}

async function includeVariableById(
  id: string,
  api: VariableCollectorApi,
  variablesById: Map<string, ReadableVariable>,
  options: CollectVariablesOptions,
): Promise<void> {
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
        message:
          "A referenced variable is not accessible and was not imported.",
        phase: "collection",
        source: { kind: "variable", id },
        causedDataLoss: true,
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
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
  }
}

async function includeCollectionById(
  id: string,
  api: VariableCollectorApi,
  collectionsById: Map<string, ReadableVariableCollection>,
  options: CollectVariablesOptions,
): Promise<void> {
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
        message:
          "The collection for an accessible referenced variable is not accessible and was not imported.",
        phase: "collection",
        source: { kind: "collection", id },
        causedDataLoss: true,
      });
      return;
    }
    collectionsById.set(collection.id, collection);
  } catch (error) {
    options.cancellation.throwIfCancelled();
    options.diagnostics.add({
      code: DIAGNOSTIC_CODES.variableCollectionFailed,
      severity: "warning",
      message:
        "The collection for an accessible referenced variable could not be read and was not imported.",
      phase: "collection",
      source: { kind: "collection", id },
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
  }
}

async function includeCollectionClosure(
  initialIds: readonly string[],
  api: VariableCollectorApi,
  collectionsById: Map<string, ReadableVariableCollection>,
  options: CollectVariablesOptions,
): Promise<void> {
  const pending = new Set(initialIds);
  const attempted = new Set<string>();
  while (true) {
    const id = [...pending].filter((item) => !attempted.has(item)).sort()[0];
    if (id === undefined) {
      return;
    }
    attempted.add(id);
    await includeCollectionById(id, api, collectionsById, options);
    const collection = collectionsById.get(id);
    if (collection !== undefined && collection.isExtension) {
      if (collection.parentVariableCollectionId !== undefined) {
        pending.add(collection.parentVariableCollectionId);
      }
      if (collection.rootVariableCollectionId !== undefined) {
        pending.add(collection.rootVariableCollectionId);
      }
    }
  }
}

function normalizeVariableValues(
  variable: ReadableVariable,
  collection: ReadableVariableCollection,
  rawValuesByMode: Readonly<Record<string, unknown>>,
  options: CollectVariablesOptions,
  propertyPrefix = "valuesByMode",
): Readonly<Record<string, JsonValue>> {
  const source = sourceForVariable(variable);
  const result: Record<string, JsonValue> = {};
  const knownModes = new Set(collection.modes.map((mode) => mode.modeId));
  for (const mode of collection.modes) {
    if (!Object.hasOwn(rawValuesByMode, mode.modeId)) {
      result[mode.modeId] = missingModeValue();
      continue;
    }
    const raw = rawValuesByMode[mode.modeId];
    const targetId = aliasId(raw);
    result[mode.modeId] =
      targetId === undefined
        ? normalizeCollectedResource(raw, options.diagnostics, source, [
            propertyPrefix,
            mode.modeId,
          ])
        : variableAlias(targetId);
  }
  for (const modeId of Object.keys(rawValuesByMode).sort()) {
    if (!knownModes.has(modeId)) {
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
        severity: "error",
        message:
          "A variable exposed a value for a mode absent from its accessible collection; that value cannot be ordered safely.",
        phase: "collection",
        source,
        propertyPath: `$.${propertyPrefix}[${JSON.stringify(modeId)}]`,
        causedDataLoss: true,
      });
    }
  }
  return result;
}

function collectionIr(
  collection: ReadableVariableCollection,
  options: CollectVariablesOptions,
  publishStatus: string | undefined,
): VariableCollectionIR {
  const variableOverrides =
    collection.variableOverrides === undefined
      ? undefined
      : (normalizeCollectedResource(
          collection.variableOverrides,
          options.diagnostics,
          sourceForCollection(collection),
          ["variableOverrides"],
        ) as JsonObject);
  return {
    source: sourceForCollection(collection),
    defaultModeId: collection.defaultModeId,
    modes: collection.modes.map((mode) => ({
      id: mode.modeId,
      name: mode.name,
      ...(mode.parentModeId === undefined
        ? {}
        : { parentModeId: mode.parentModeId }),
    })),
    variableIds: [...collection.variableIds],
    hiddenFromPublishing: collection.hiddenFromPublishing,
    ...(publishStatus === undefined ? {} : { publishStatus }),
    isExtension: collection.isExtension,
    ...(collection.parentVariableCollectionId === undefined
      ? {}
      : {
          parentVariableCollectionId: collection.parentVariableCollectionId,
        }),
    ...(collection.rootVariableCollectionId === undefined
      ? {}
      : { rootVariableCollectionId: collection.rootVariableCollectionId }),
    ...(variableOverrides === undefined ? {} : { variableOverrides }),
  };
}

async function readPublishStatus(
  resource: ReadableVariable | ReadableVariableCollection,
  source: SourceRef,
  options: CollectVariablesOptions,
): Promise<string | undefined> {
  if (resource.getPublishStatusAsync === undefined) {
    return undefined;
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
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return undefined;
  }
}

function collectAliasIds(value: unknown, target: Set<string>): void {
  const directId = aliasId(value);
  if (directId !== undefined) {
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
    collectAliasIds((value as Record<string, unknown>)[key], target);
  }
}

async function readValuesByMode(
  variable: ReadableVariable,
  collection: ReadableVariableCollection,
  options: CollectVariablesOptions,
): Promise<Readonly<Record<string, unknown>>> {
  if (!collection.isExtension) {
    return variable.valuesByMode;
  }
  if (variable.valuesByModeForCollectionAsync === undefined) {
    options.diagnostics.add({
      code: DIAGNOSTIC_CODES.variableCollectionFailed,
      severity: "error",
      message:
        "An extended variable collection requires inherited mode values, but the required async API is unavailable.",
      phase: "collection",
      source: sourceForVariable(variable),
      propertyPath: "$.valuesByModeForCollectionAsync",
      causedDataLoss: true,
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
      message:
        "Inherited or overridden values for an extended variable collection could not be read.",
      phase: "collection",
      source: sourceForVariable(variable),
      propertyPath: "$.valuesByModeForCollectionAsync",
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return {};
  }
}

function valueViewKey(variableId: string, collectionId: string): string {
  return JSON.stringify([variableId, collectionId]);
}

export async function collectVariables(
  options: CollectVariablesOptions,
): Promise<CollectedVariables> {
  const diagnosticStart = options.diagnostics.size();
  const api = options.api ?? defaultApi();
  const localCollectionRead = await readLocalCollections(api, options);
  const localVariableRead = await readLocalVariables(api, options);
  const localCollections = localCollectionRead.items;
  const localVariables = localVariableRead.items;
  const collectionsById = new Map(
    localCollections.map((collection) => [collection.id, collection]),
  );
  const variablesById = new Map(
    localVariables.map((variable) => [variable.id, variable]),
  );

  const pendingIds = new Set(options.referencedVariableIds);
  for (const variable of localVariables) {
    collectAliasIds(variable.valuesByMode, pendingIds);
  }
  for (const collection of localCollections) {
    collectAliasIds(collection.variableOverrides, pendingIds);
  }

  const attempted = new Set<string>();
  while (true) {
    const nextId = [...pendingIds].filter((id) => !attempted.has(id)).sort()[0];
    if (nextId === undefined) {
      break;
    }
    attempted.add(nextId);
    await includeVariableById(nextId, api, variablesById, options);
    const included = variablesById.get(nextId);
    if (included !== undefined) {
      collectAliasIds(included.valuesByMode, pendingIds);
    }
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  await includeCollectionClosure(
    [
      ...(options.referencedCollectionIds ?? []),
      ...new Set(
        [...variablesById.values()].map(
          (variable) => variable.variableCollectionId,
        ),
      ),
    ],
    api,
    collectionsById,
    options,
  );

  const orderedExtendedCollections = [...collectionsById.values()]
    .filter((collection) => collection.isExtension)
    .sort((left, right) =>
      compareSourceRefs(sourceForCollection(left), sourceForCollection(right)),
    );
  for (const collection of orderedExtendedCollections) {
    for (const variableId of collection.variableIds) {
      await includeVariableById(variableId, api, variablesById, options);
      const variable = variablesById.get(variableId);
      if (variable !== undefined) {
        await includeCollectionClosure(
          [variable.variableCollectionId],
          api,
          collectionsById,
          options,
        );
      }
    }
  }

  const overrideAliasIds = new Set<string>();
  for (const collection of collectionsById.values()) {
    collectAliasIds(collection.variableOverrides, overrideAliasIds);
  }
  for (const id of [...overrideAliasIds].sort()) {
    await includeVariableById(id, api, variablesById, options);
    const included = variablesById.get(id);
    if (included !== undefined) {
      await includeCollectionClosure(
        [included.variableCollectionId],
        api,
        collectionsById,
        options,
      );
    }
  }

  const rawValuesByVariableId = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const extendedValuesByVariableAndCollection = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  const valuesAttempted = new Set<string>();
  while (true) {
    const nextVariable = [...variablesById.values()]
      .filter((variable) => !valuesAttempted.has(variable.id))
      .sort((left, right) =>
        compareSourceRefs(sourceForVariable(left), sourceForVariable(right)),
      )[0];
    if (nextVariable === undefined) {
      break;
    }
    valuesAttempted.add(nextVariable.id);
    const collection = collectionsById.get(nextVariable.variableCollectionId);
    if (collection === undefined) {
      continue;
    }
    const rawValues = await readValuesByMode(nextVariable, collection, options);
    rawValuesByVariableId.set(nextVariable.id, rawValues);
    const discoveredIds = new Set<string>();
    collectAliasIds(rawValues, discoveredIds);
    for (const id of [...discoveredIds].sort()) {
      await includeVariableById(id, api, variablesById, options);
      const included = variablesById.get(id);
      if (included !== undefined) {
        await includeCollectionClosure(
          [included.variableCollectionId],
          api,
          collectionsById,
          options,
        );
      }
    }
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  for (const collection of orderedExtendedCollections) {
    for (const variableId of collection.variableIds) {
      const variable = variablesById.get(variableId);
      if (variable === undefined) {
        continue;
      }
      const values = await readValuesByMode(variable, collection, options);
      extendedValuesByVariableAndCollection.set(
        valueViewKey(variable.id, collection.id),
        values,
      );
      const discoveredIds = new Set<string>();
      collectAliasIds(values, discoveredIds);
      for (const id of [...discoveredIds].sort()) {
        await includeVariableById(id, api, variablesById, options);
        const included = variablesById.get(id);
        if (included !== undefined) {
          await includeCollectionClosure(
            [included.variableCollectionId],
            api,
            collectionsById,
            options,
          );
        }
      }
      await yieldToFigma();
      options.cancellation.throwIfCancelled();
    }
  }

  // Extension values can expose aliases to variables not reached by the base
  // values. Continue the same iterative base-value closure before resolution.
  while (true) {
    const nextVariable = [...variablesById.values()]
      .filter((variable) => !valuesAttempted.has(variable.id))
      .sort((left, right) =>
        compareSourceRefs(sourceForVariable(left), sourceForVariable(right)),
      )[0];
    if (nextVariable === undefined) {
      break;
    }
    valuesAttempted.add(nextVariable.id);
    const collection = collectionsById.get(nextVariable.variableCollectionId);
    if (collection === undefined) {
      continue;
    }
    const rawValues = await readValuesByMode(nextVariable, collection, options);
    rawValuesByVariableId.set(nextVariable.id, rawValues);
    const discoveredIds = new Set<string>();
    collectAliasIds(rawValues, discoveredIds);
    for (const id of [...discoveredIds].sort()) {
      await includeVariableById(id, api, variablesById, options);
      const included = variablesById.get(id);
      if (included !== undefined) {
        await includeCollectionClosure(
          [included.variableCollectionId],
          api,
          collectionsById,
          options,
        );
      }
    }
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  const variablesWithCollections: ReadableVariable[] = [];
  for (const variable of variablesById.values()) {
    if (!collectionsById.has(variable.variableCollectionId)) {
      options.diagnostics.add({
        code: DIAGNOSTIC_CODES.variableCollectionUnavailable,
        severity: "warning",
        message:
          "An accessible variable cannot be serialized safely because its collection and mode order are unavailable.",
        phase: "collection",
        source: sourceForVariable(variable),
        propertyPath: "$.variableCollectionId",
        causedDataLoss: true,
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
      collectionsById.get(variable.variableCollectionId)!,
      rawValuesByVariableId.get(variable.id) ?? variable.valuesByMode,
      options,
    ),
  }));
  const orderedCollectionResources = [...collectionsById.values()].sort(
    (left, right) =>
      compareSourceRefs(sourceForCollection(left), sourceForCollection(right)),
  );
  const collectionPublishStatus = new Map<string, string>();
  for (const collection of orderedCollectionResources) {
    const status = await readPublishStatus(
      collection,
      sourceForCollection(collection),
      options,
    );
    if (status !== undefined) {
      collectionPublishStatus.set(collection.id, status);
    }
  }
  const collections = orderedCollectionResources.map((collection) =>
    collectionIr(
      collection,
      options,
      collectionPublishStatus.get(collection.id),
    ),
  );
  options.cancellation.throwIfCancelled();
  const resolution = resolveVariableAliases({
    variables: aliasInputs,
    collections: collections.map((collection) => ({
      id: collection.source.id,
      modeOrder: collection.modes.map((mode) => mode.id),
    })),
    diagnostics: options.diagnostics,
  });
  options.cancellation.throwIfCancelled();

  const extendedValuesByVariableId = new Map<
    string,
    {
      readonly collectionId: string;
      readonly values: (typeof resolution.variables)[number]["values"];
    }[]
  >();
  for (const collection of orderedExtendedCollections) {
    const memberIds = new Set(collection.variableIds);
    const viewInputs = variablesWithCollections.map((variable) => {
      const owningCollection = collectionsById.get(
        variable.variableCollectionId,
      )!;
      const isMember = memberIds.has(variable.id);
      return {
        source: sourceForVariable(variable),
        collectionId: isMember ? collection.id : variable.variableCollectionId,
        valuesByMode: normalizeVariableValues(
          variable,
          isMember ? collection : owningCollection,
          isMember
            ? (extendedValuesByVariableAndCollection.get(
                valueViewKey(variable.id, collection.id),
              ) ?? {})
            : (rawValuesByVariableId.get(variable.id) ?? variable.valuesByMode),
          options,
          isMember
            ? `extendedCollectionValues[${JSON.stringify(collection.id)}]`
            : "valuesByMode",
        ),
      };
    });
    const viewResolution = resolveVariableAliases({
      variables: viewInputs,
      collections: collections.map((candidate) => ({
        id: candidate.source.id,
        modeOrder: candidate.modes.map((mode) => mode.id),
      })),
      diagnostics: options.diagnostics,
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
    [...variablesById.values()].map((variable) => [variable.id, variable]),
  );
  const variablePublishStatus = new Map<string, string>();
  for (const variable of [...variablesWithCollections].sort((left, right) =>
    compareSourceRefs(sourceForVariable(left), sourceForVariable(right)),
  )) {
    const status = await readPublishStatus(
      variable,
      sourceForVariable(variable),
      options,
    );
    if (status !== undefined) {
      variablePublishStatus.set(variable.id, status);
    }
  }
  const variables: VariableIR[] = resolution.variables.map((resolved) => {
    const variable = metadataById.get(resolved.source.id)!;
    const source = sourceForVariable(variable);
    const codeSyntax = normalizeCollectedResource(
      variable.codeSyntax,
      options.diagnostics,
      source,
      ["codeSyntax"],
    ) as JsonObject;
    return {
      source,
      collectionId: variable.variableCollectionId,
      resolvedType: variable.resolvedType,
      description: variable.description,
      scopes: [...variable.scopes],
      codeSyntax,
      hiddenFromPublishing: variable.hiddenFromPublishing,
      ...(variablePublishStatus.get(variable.id) === undefined
        ? {}
        : { publishStatus: variablePublishStatus.get(variable.id)! }),
      values: resolved.values,
      ...(extendedValuesByVariableId.get(variable.id) === undefined
        ? {}
        : {
            extendedCollectionValues: extendedValuesByVariableId.get(
              variable.id,
            )!,
          }),
      diagnosticIds: options.diagnostics
        .listSince(diagnosticStart)
        .filter(
          (diagnostic) =>
            diagnostic.source?.kind === "variable" &&
            diagnostic.source.id === variable.id,
        )
        .map((diagnostic) => diagnostic.id),
    };
  });
  const diagnosticIds = options.diagnostics
    .listSince(diagnosticStart)
    .map((diagnostic) => diagnostic.id);
  const artifact: VariablesIndexIR = {
    kind: "design-ir-variables",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    collections,
    variables,
    diagnosticIds,
  };

  return {
    artifact,
    localCount: localVariables.filter((variable) => variable.remote === false)
      .length,
    accessibleReferences: variables.map((variable) => variable.source),
    localEnumerationComplete:
      localCollectionRead.complete && localVariableRead.complete,
  };
}
