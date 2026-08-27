import {
  DIAGNOSTIC_CODES,
  normalizeSafeTechnicalCause,
  type DiagnosticBag,
} from "../shared/diagnostics";
import {
  DESIGN_IR_SCHEMA_VERSION,
  type EffectIR,
  type JsonObject,
  type JsonValue,
  type LayoutGridIR,
  type PaintIR,
  type SourceRef,
  type StyleIR,
  type StylesIndexIR,
  type VariableBindingIR,
} from "../shared/ir";
import {
  compareSourceRefs,
  sortUnorderedSourceRefs,
} from "../shared/serialization";
import { ExportCancellationToken, yieldToFigma } from "./cancellation";
import {
  asJsonObject,
  collectVariableBindingsFromValue,
  normalizeCollectedResource,
  variableIdsFromBindings,
} from "./resource-normalization";

export type ReadableStyleType = "PAINT" | "TEXT" | "EFFECT" | "GRID";

export interface ReadableStyle {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly remote: boolean;
  readonly type: ReadableStyleType;
  readonly description: string;
  readonly descriptionMarkdown?: string;
  readonly documentationLinks?: readonly { readonly uri: string }[];
  readonly boundVariables?: unknown;
  readonly paints?: readonly unknown[];
  readonly effects?: readonly unknown[];
  readonly layoutGrids?: readonly unknown[];
  readonly fontSize?: unknown;
  readonly textDecoration?: unknown;
  readonly fontName?: unknown;
  readonly letterSpacing?: unknown;
  readonly lineHeight?: unknown;
  readonly leadingTrim?: unknown;
  readonly paragraphIndent?: unknown;
  readonly paragraphSpacing?: unknown;
  readonly listSpacing?: unknown;
  readonly hangingPunctuation?: unknown;
  readonly hangingList?: unknown;
  readonly textCase?: unknown;
}

export interface StyleCollectorApi {
  getLocalPaintStylesAsync(): Promise<readonly ReadableStyle[]>;
  getLocalTextStylesAsync(): Promise<readonly ReadableStyle[]>;
  getLocalEffectStylesAsync(): Promise<readonly ReadableStyle[]>;
  getLocalGridStylesAsync(): Promise<readonly ReadableStyle[]>;
  getStyleByIdAsync(id: string): Promise<ReadableStyle | null>;
}

export interface CollectStylesOptions {
  readonly referencedStyleIds: readonly string[];
  readonly referencedByByStyleId: ReadonlyMap<string, readonly SourceRef[]>;
  readonly diagnostics: DiagnosticBag;
  readonly cancellation: ExportCancellationToken;
  readonly api?: StyleCollectorApi;
}

export interface CollectedStyles {
  readonly artifact: StylesIndexIR;
  readonly localCount: number;
  readonly accessibleReferences: readonly (SourceRef & {
    readonly kind: "style";
  })[];
  readonly referencedVariableIds: readonly string[];
  readonly localEnumerationComplete: boolean;
}

interface LocalStyleReadResult {
  readonly items: readonly ReadableStyle[];
  readonly complete: boolean;
}

function defaultApi(): StyleCollectorApi {
  return figma;
}

function sourceForStyle(
  style: ReadableStyle,
): SourceRef & { readonly kind: "style" } {
  return {
    kind: "style",
    id: style.id,
    key: style.key,
    name: style.name,
    remote: style.remote,
  };
}

async function readLocalStyleKind(
  label: string,
  read: () => Promise<readonly ReadableStyle[]>,
  options: CollectStylesOptions,
): Promise<LocalStyleReadResult> {
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
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return { items: [], complete: false };
  }
}

async function includeStyleById(
  id: string,
  api: StyleCollectorApi,
  stylesById: Map<string, ReadableStyle>,
  options: CollectStylesOptions,
): Promise<void> {
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
        causedDataLoss: true,
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
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
  }
}

function normalizedProperties(
  style: ReadableStyle,
  diagnostics: DiagnosticBag,
): JsonObject {
  const values: Record<string, unknown> = {
    type: style.type,
    ...(style.descriptionMarkdown === undefined
      ? {}
      : { descriptionMarkdown: style.descriptionMarkdown }),
    ...(style.documentationLinks === undefined
      ? {}
      : { documentationLinks: style.documentationLinks }),
    ...(style.boundVariables === undefined
      ? {}
      : { boundVariables: style.boundVariables }),
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
      "textCase",
    ] as const) {
      const value = style[property];
      if (value !== undefined) {
        values[property] = value;
      }
    }
  }
  return normalizeCollectedResource(
    values,
    diagnostics,
    sourceForStyle(style),
    ["properties"],
  ) as JsonObject;
}

function bindingsForProperties(
  properties: JsonObject,
): readonly VariableBindingIR[] {
  return collectVariableBindingsFromValue(properties, "$.properties");
}

function paintItems(
  style: ReadableStyle,
  properties: JsonObject,
  diagnostics: DiagnosticBag,
): readonly PaintIR[] {
  if (!Array.isArray(properties.paints)) {
    return [];
  }
  const result: PaintIR[] = [];
  for (const [index, value] of (
    properties.paints as readonly JsonValue[]
  ).entries()) {
    const raw = asJsonObject(value);
    if (raw === undefined || typeof raw.type !== "string") {
      diagnoseMalformedStyleItem(style, `$.paints[${index}]`, diagnostics);
      continue;
    }
    const bindings = collectVariableBindingsFromValue(
      raw.boundVariables,
      `$.paints[${index}].boundVariables`,
    );
    result.push({
      paintType: raw.type,
      ...(typeof raw.visible === "boolean" ? { visible: raw.visible } : {}),
      ...(typeof raw.opacity === "number" || raw.opacity === null
        ? { opacity: raw.opacity }
        : {}),
      ...(typeof raw.blendMode === "string"
        ? { blendMode: raw.blendMode }
        : {}),
      ...(typeof raw.imageHash === "string" || raw.imageHash === null
        ? { imageHash: raw.imageHash }
        : {}),
      ...(typeof raw.scaleMode === "string"
        ? { scaleMode: raw.scaleMode }
        : {}),
      ...(bindings.length === 0 ? {} : { boundVariables: bindings }),
      raw,
    });
  }
  return result;
}

function diagnoseMalformedStyleItem(
  style: ReadableStyle,
  propertyPath: string,
  diagnostics: DiagnosticBag,
): void {
  diagnostics.add({
    code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
    severity: "warning",
    message:
      "A supported style item had an unexpected runtime shape and was retained in the style raw properties.",
    phase: "collection",
    source: sourceForStyle(style),
    propertyPath,
    causedDataLoss: true,
  });
}

function effectItems(
  style: ReadableStyle,
  properties: JsonObject,
  diagnostics: DiagnosticBag,
): readonly EffectIR[] {
  if (!Array.isArray(properties.effects)) {
    return [];
  }
  const result: EffectIR[] = [];
  for (const [index, value] of (
    properties.effects as readonly JsonValue[]
  ).entries()) {
    const raw = asJsonObject(value);
    if (
      raw === undefined ||
      typeof raw.type !== "string" ||
      typeof raw.visible !== "boolean"
    ) {
      diagnoseMalformedStyleItem(style, `$.effects[${index}]`, diagnostics);
      continue;
    }
    const bindings = collectVariableBindingsFromValue(
      raw.boundVariables,
      `$.effects[${index}].boundVariables`,
    );
    result.push({
      effectType: raw.type,
      visible: raw.visible,
      ...(typeof raw.radius === "number" || raw.radius === null
        ? { radius: raw.radius }
        : {}),
      ...(typeof raw.spread === "number" || raw.spread === null
        ? { spread: raw.spread }
        : {}),
      ...(typeof raw.blendMode === "string"
        ? { blendMode: raw.blendMode }
        : {}),
      ...(bindings.length === 0 ? {} : { boundVariables: bindings }),
      raw,
    });
  }
  return result;
}

function gridItems(
  style: ReadableStyle,
  properties: JsonObject,
  diagnostics: DiagnosticBag,
): readonly LayoutGridIR[] {
  if (!Array.isArray(properties.layoutGrids)) {
    return [];
  }
  const result: LayoutGridIR[] = [];
  for (const [index, value] of (
    properties.layoutGrids as readonly JsonValue[]
  ).entries()) {
    const raw = asJsonObject(value);
    if (raw === undefined || typeof raw.pattern !== "string") {
      diagnoseMalformedStyleItem(style, `$.layoutGrids[${index}]`, diagnostics);
      continue;
    }
    const bindings = collectVariableBindingsFromValue(
      raw.boundVariables,
      `$.layoutGrids[${index}].boundVariables`,
    );
    result.push({
      pattern: raw.pattern,
      ...(typeof raw.alignment === "string"
        ? { alignment: raw.alignment }
        : {}),
      ...(typeof raw.visible === "boolean" ? { visible: raw.visible } : {}),
      ...(typeof raw.sectionSize === "number" || raw.sectionSize === null
        ? { sectionSize: raw.sectionSize }
        : {}),
      ...(typeof raw.gutterSize === "number" || raw.gutterSize === null
        ? { gutterSize: raw.gutterSize }
        : {}),
      ...(typeof raw.offset === "number" || raw.offset === null
        ? { offset: raw.offset }
        : {}),
      ...(typeof raw.count === "number" || raw.count === null
        ? { count: raw.count }
        : {}),
      ...(bindings.length === 0 ? {} : { boundVariables: bindings }),
      raw,
    });
  }
  return result;
}

function referencedBy(
  styleId: string,
  options: CollectStylesOptions,
): readonly SourceRef[] {
  const unique = new Map<string, SourceRef>();
  for (const source of options.referencedByByStyleId.get(styleId) ?? []) {
    unique.set(
      JSON.stringify([
        source.kind,
        source.id,
        source.key,
        source.name,
        source.remote,
      ]),
      source,
    );
  }
  return sortUnorderedSourceRefs([...unique.values()]);
}

function collectStyle(
  style: ReadableStyle,
  diagnosticStart: number,
  options: CollectStylesOptions,
): StyleIR {
  const source = sourceForStyle(style);
  const properties = normalizedProperties(style, options.diagnostics);
  const variableBindings = bindingsForProperties(properties);
  const common = () => ({
    source,
    description: style.description,
    properties,
    variableBindings,
    referencedBy: referencedBy(style.id, options),
    diagnosticIds: options.diagnostics
      .listSince(diagnosticStart)
      .filter(
        (diagnostic) =>
          diagnostic.source?.kind === "style" &&
          diagnostic.source.id === style.id,
      )
      .map((diagnostic) => diagnostic.id),
  });

  if (style.type === "PAINT") {
    const paints = paintItems(style, properties, options.diagnostics);
    return {
      ...common(),
      styleType: "paint",
      paints,
      assetRefs: [],
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
      effects,
    };
  }
  if (style.type === "GRID") {
    const grids = gridItems(style, properties, options.diagnostics);
    return {
      ...common(),
      styleType: "grid",
      grids,
    };
  }
  const raw = normalizeCollectedResource(style, options.diagnostics, source, [
    "raw",
  ]);
  return {
    ...common(),
    styleType: "unknown",
    raw: asJsonObject(raw) ?? {
      $type: "unsupported",
      runtimeType: typeof style,
      reason: "unknown",
    },
  };
}

export async function collectStyles(
  options: CollectStylesOptions,
): Promise<CollectedStyles> {
  const diagnosticStart = options.diagnostics.size();
  const api = options.api ?? defaultApi();
  const localReads = [
    await readLocalStyleKind(
      "paint",
      () => api.getLocalPaintStylesAsync(),
      options,
    ),
    await readLocalStyleKind(
      "text",
      () => api.getLocalTextStylesAsync(),
      options,
    ),
    await readLocalStyleKind(
      "effect",
      () => api.getLocalEffectStylesAsync(),
      options,
    ),
    await readLocalStyleKind(
      "grid",
      () => api.getLocalGridStylesAsync(),
      options,
    ),
  ];
  const localGroups = localReads.map((read) => read.items);
  const localStyles = localGroups.flat();
  const stylesById = new Map(localStyles.map((style) => [style.id, style]));

  for (const styleId of [...new Set(options.referencedStyleIds)].sort()) {
    await includeStyleById(styleId, api, stylesById, options);
    await yieldToFigma();
    options.cancellation.throwIfCancelled();
  }

  const styles = [...stylesById.values()]
    .sort((left, right) =>
      compareSourceRefs(sourceForStyle(left), sourceForStyle(right)),
    )
    .map((style) => collectStyle(style, diagnosticStart, options));
  options.cancellation.throwIfCancelled();
  const referencedVariableIds = variableIdsFromBindings(
    styles.flatMap((style) => {
      const nested =
        style.styleType === "paint"
          ? style.paints.flatMap((paint) => paint.boundVariables ?? [])
          : style.styleType === "effect"
            ? style.effects.flatMap((effect) => effect.boundVariables ?? [])
            : style.styleType === "grid"
              ? style.grids.flatMap((grid) => grid.boundVariables ?? [])
              : [];
      return [...style.variableBindings, ...nested];
    }),
  );
  const artifact: StylesIndexIR = {
    kind: "design-ir-styles",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    styles,
    diagnosticIds: options.diagnostics
      .listSince(diagnosticStart)
      .map((diagnostic) => diagnostic.id),
  };
  return {
    artifact,
    localCount: localStyles.filter((style) => style.remote === false).length,
    accessibleReferences: styles.map((style) => style.source),
    referencedVariableIds,
    localEnumerationComplete: localReads.every((read) => read.complete),
  };
}
