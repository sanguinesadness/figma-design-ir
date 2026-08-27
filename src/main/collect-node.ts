import {
  DIAGNOSTIC_CODES,
  normalizeSafeTechnicalCause,
  type DiagnosticBag,
  type DiagnosticSeverity,
} from "../shared/diagnostics";
import {
  FIGMA_MIXED_VALUE,
  type EffectIR,
  type ExportSettingIR,
  type ExplicitVariableModeIR,
  type ComponentNodeDataIR,
  type ComponentPropertyReferencesIR,
  type InstanceNodeDataIR,
  type JsonObject,
  type JsonValue,
  type LayoutGridIR,
  type MixedValue,
  type NodeCommonIR,
  type NodeGeometryIR,
  type NodeIR,
  type NodeLayoutIR,
  type NodeVisualIR,
  type PaintIR,
  type ReactionIR,
  type SourceRef,
  type SlotLimitViolationIR,
  type StrokeGeometryIR,
  type TextDataIR,
  type TextStyleRunIR,
  type TransformIR,
  type UnavailableValue,
  type VariableBindingIR,
  type VectorDataIR,
} from "../shared/ir";
import { normalizeJsonSafeValue } from "../shared/normalization";
import { sortUnorderedSourceRefs } from "../shared/serialization";
import { ExportCancellationToken, yieldToFigma } from "./cancellation";
import { collectNodeInteractions } from "./collect-interactions";

export interface CollectedNodeTree {
  readonly tree: NodeIR;
  readonly nodesById: ReadonlyMap<string, SceneNode>;
  readonly dependencyRefs: readonly SourceRef[];
  readonly reactions: readonly ReactionIR[];
  readonly nodeCount: number;
  readonly coverage: {
    readonly childrenComplete: boolean;
    readonly dependencyRefsComplete: boolean;
    readonly textSegmentsComplete: boolean;
    readonly interactionsComplete: boolean;
  };
}

export interface NodeCollectionEnrichment {
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
}

interface ReadResult {
  readonly present: boolean;
  readonly value?: unknown;
}

const KNOWN_NODE_TYPES = new Set([
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
  "VECTOR",
]);

const VECTOR_NODE_TYPES = new Set([
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "LINE",
  "POLYGON",
  "RECTANGLE",
  "STAR",
  "VECTOR",
]);

const CONTAINER_NODE_TYPES = new Set([
  "COMPONENT",
  "COMPONENT_SET",
  "FRAME",
  "GROUP",
  "INSTANCE",
  "SECTION",
  "SLOT",
  "TRANSFORM_GROUP",
]);

function safeNodeId(node: SceneNode): string {
  try {
    return node.id;
  } catch {
    return "unavailable-node";
  }
}

function safeNodeName(node: SceneNode): string | undefined {
  try {
    return node.name;
  } catch {
    return undefined;
  }
}

function sourceForNode(node: SceneNode): SourceRef & { readonly kind: "node" } {
  const name = safeNodeName(node);
  return {
    kind: "node",
    id: safeNodeId(node),
    ...(name === undefined ? {} : { name }),
  };
}

function readOptional(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
  severity: DiagnosticSeverity = "warning",
): ReadResult {
  try {
    if (!(property in node)) {
      return { present: false };
    }
    return {
      present: true,
      value: (node as unknown as Record<string, unknown>)[property],
    };
  } catch (error) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
      severity,
      message:
        "A supported node property could not be read and remains explicit in diagnostics.",
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: `$.${property}`,
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return { present: false };
  }
}

function normalizeValue(
  node: SceneNode,
  property: string,
  value: unknown,
  diagnostics: DiagnosticBag,
): JsonValue {
  const propertyPath: (string | number)[] = [];
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
    classifySpecialValue: (candidate) =>
      candidate === figma.mixed ? FIGMA_MIXED_VALUE : undefined,
  }).value;
}

function optionalString(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
): string | undefined {
  const result = readOptional(node, property, diagnostics);
  if (!result.present || result.value === undefined) {
    return undefined;
  }
  if (typeof result.value !== "string") {
    diagnoseUnexpectedSupportedShape(node, property, diagnostics);
    return undefined;
  }
  return result.value;
}

function optionalBoolean(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
): boolean | undefined {
  const result = readOptional(node, property, diagnostics);
  if (!result.present || result.value === undefined) {
    return undefined;
  }
  if (typeof result.value !== "boolean") {
    diagnoseUnexpectedSupportedShape(node, property, diagnostics);
    return undefined;
  }
  return result.value;
}

function optionalNumber(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
): number | null | undefined {
  const result = readOptional(node, property, diagnostics);
  return numberFromRead(node, property, result, diagnostics);
}

function optionalNumberOrMixed(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
): number | null | MixedValue | undefined {
  const result = readOptional(node, property, diagnostics);
  return result.value === figma.mixed
    ? FIGMA_MIXED_VALUE
    : numberFromRead(node, property, result, diagnostics);
}

function numberFromRead(
  node: SceneNode,
  property: string,
  result: ReadResult,
  diagnostics: DiagnosticBag,
): number | null | undefined {
  if (!result.present) {
    return undefined;
  }
  if (result.value === null) {
    return null;
  }
  if (typeof result.value !== "number") {
    if (result.value !== undefined) {
      diagnoseUnexpectedSupportedShape(node, property, diagnostics);
    }
    return undefined;
  }
  const normalized = normalizeValue(node, property, result.value, diagnostics);
  return typeof normalized === "number" || normalized === null
    ? normalized
    : undefined;
}

function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function optionalNormalized(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
): JsonValue | undefined {
  const result = readOptional(node, property, diagnostics);
  return !result.present
    ? undefined
    : normalizeValue(node, property, result.value, diagnostics);
}

function objectNumber(
  node: SceneNode,
  property: string,
  object: Record<string, unknown>,
  key: string,
  diagnostics: DiagnosticBag,
): number | null {
  const value = object[key];
  const normalized = normalizeJsonSafeValue(value, {
    diagnostics,
    phase: "collection",
    source: sourceForNode(node),
    propertyPath: [property, key],
    classifySpecialValue: (candidate) =>
      candidate === figma.mixed ? FIGMA_MIXED_VALUE : undefined,
  }).value;
  return typeof normalized === "number" ? normalized : null;
}

function readRect(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
): NodeGeometryIR["absoluteBounds"] | undefined {
  const result = readOptional(node, property, diagnostics);
  if (
    !result.present ||
    result.value === null ||
    typeof result.value !== "object"
  ) {
    return result.value === null ? null : undefined;
  }
  const record = result.value as Record<string, unknown>;
  return {
    x: objectNumber(node, property, record, "x", diagnostics),
    y: objectNumber(node, property, record, "y", diagnostics),
    width: objectNumber(node, property, record, "width", diagnostics),
    height: objectNumber(node, property, record, "height", diagnostics),
  };
}

function readTransform(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
): TransformIR | undefined {
  const result = readOptional(node, property, diagnostics);
  if (
    !result.present ||
    !Array.isArray(result.value) ||
    result.value.length !== 2 ||
    !result.value.every((row) => Array.isArray(row) && row.length === 3)
  ) {
    return undefined;
  }
  const rows = result.value as readonly (readonly unknown[])[];
  const normalizeCell = (
    value: unknown,
    row: number,
    column: number,
  ): number | null => {
    const normalized = normalizeJsonSafeValue(value, {
      diagnostics,
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: [property, row, column],
      classifySpecialValue: (candidate) =>
        candidate === figma.mixed ? FIGMA_MIXED_VALUE : undefined,
    }).value;
    return typeof normalized === "number" ? normalized : null;
  };
  return [
    [
      normalizeCell(rows[0]?.[0], 0, 0),
      normalizeCell(rows[0]?.[1], 0, 1),
      normalizeCell(rows[0]?.[2], 0, 2),
    ],
    [
      normalizeCell(rows[1]?.[0], 1, 0),
      normalizeCell(rows[1]?.[1], 1, 1),
      normalizeCell(rows[1]?.[2], 1, 2),
    ],
  ];
}

function collectGeometry(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): NodeGeometryIR | undefined {
  const x = optionalNumber(node, "x", diagnostics);
  const y = optionalNumber(node, "y", diagnostics);
  const width = optionalNumber(node, "width", diagnostics);
  const height = optionalNumber(node, "height", diagnostics);
  const localBounds =
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
      ? undefined
      : { x, y, width, height };
  const absoluteBounds = readRect(node, "absoluteBoundingBox", diagnostics);
  const absoluteRenderBounds = readRect(
    node,
    "absoluteRenderBounds",
    diagnostics,
  );
  const relativeTransform = readTransform(
    node,
    "relativeTransform",
    diagnostics,
  );
  const absoluteTransform = readTransform(
    node,
    "absoluteTransform",
    diagnostics,
  );
  const rotation = optionalNumber(node, "rotation", diagnostics);
  const constraintsResult = readOptional(node, "constraints", diagnostics);
  const constraints =
    constraintsResult.present &&
    typeof constraintsResult.value === "object" &&
    constraintsResult.value !== null &&
    typeof (constraintsResult.value as Record<string, unknown>).horizontal ===
      "string" &&
    typeof (constraintsResult.value as Record<string, unknown>).vertical ===
      "string"
      ? {
          horizontal: (constraintsResult.value as Record<string, string>)
            .horizontal!,
          vertical: (constraintsResult.value as Record<string, string>)
            .vertical!,
        }
      : undefined;

  const geometry: NodeGeometryIR = {
    ...(localBounds === undefined ? {} : { localBounds }),
    ...(absoluteBounds === undefined ? {} : { absoluteBounds }),
    ...(absoluteRenderBounds === undefined ? {} : { absoluteRenderBounds }),
    ...(relativeTransform === undefined ? {} : { relativeTransform }),
    ...(absoluteTransform === undefined ? {} : { absoluteTransform }),
    ...(rotation === undefined ? {} : { rotation }),
    ...(constraints === undefined ? {} : { constraints }),
    ...numberProperties(node, diagnostics, [
      "minWidth",
      "maxWidth",
      "minHeight",
      "maxHeight",
    ]),
  };
  return Object.keys(geometry).length === 0 ? undefined : geometry;
}

function numberProperties(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  properties: readonly string[],
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const property of properties) {
    const value = optionalNumber(node, property, diagnostics);
    if (value !== undefined) {
      result[property] = value;
    }
  }
  return result;
}

function collectLayout(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): NodeLayoutIR | undefined {
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
    ["gridChildVerticalAlign", "gridChildVerticalAlign"],
  ] as const;
  const layout = {} as Record<string, unknown>;
  for (const [sourceProperty, irProperty] of stringMapping) {
    const value = optionalString(node, sourceProperty, diagnostics);
    if (value !== undefined) {
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
      "gridColumnSpan",
    ]),
  );
  for (const property of [
    "itemReverseZIndex",
    "strokesIncludedInLayout",
  ] as const) {
    const value = optionalBoolean(node, property, diagnostics);
    if (value !== undefined) {
      layout[property] = value;
    }
  }

  const grids = collectLayoutGrids(node, diagnostics);
  if (grids !== undefined) {
    layout.grids = grids;
  }
  const inferredAutoLayout = optionalNormalized(
    node,
    "inferredAutoLayout",
    diagnostics,
  );
  if (
    inferredAutoLayout === null ||
    jsonObject(inferredAutoLayout) !== undefined
  ) {
    layout.inferredAutoLayout = inferredAutoLayout;
  }
  for (const [property, irProperty] of [
    ["gridRowSizes", "gridRowSizes"],
    ["gridColumnSizes", "gridColumnSizes"],
  ] as const) {
    const normalized = optionalNormalized(node, property, diagnostics);
    if (Array.isArray(normalized)) {
      const tracks: JsonObject[] = [];
      for (const [index, track] of (
        normalized as readonly JsonValue[]
      ).entries()) {
        const object = jsonObject(track);
        if (object === undefined) {
          diagnoseUnexpectedSupportedShape(
            node,
            `${property}[${index}]`,
            diagnostics,
          );
        } else {
          tracks.push(object);
        }
      }
      layout[irProperty] = tracks;
    } else if (normalized !== undefined) {
      diagnoseUnexpectedSupportedShape(node, property, diagnostics);
    }
  }
  return Object.keys(layout).length === 0 ? undefined : layout;
}

function normalizeObjectArrayItem(
  node: SceneNode,
  property: string,
  value: unknown,
  diagnostics: DiagnosticBag,
): JsonObject | undefined {
  return jsonObject(normalizeValue(node, property, value, diagnostics));
}

function diagnoseUnexpectedSupportedShape(
  node: SceneNode,
  propertyPath: string,
  diagnostics: DiagnosticBag,
): void {
  diagnostics.add({
    code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
    severity: "warning",
    message:
      "A supported property had an unexpected shape and remains explicit in diagnostics.",
    phase: "collection",
    source: sourceForNode(node),
    propertyPath: `$.${propertyPath}`,
    causedDataLoss: true,
  });
}

function variableBindingsFromJson(
  value: JsonValue | undefined,
  propertyPath: string,
): readonly VariableBindingIR[] {
  if (value === undefined) {
    return [];
  }
  const bindings: VariableBindingIR[] = [];
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
    if (object.type === "VARIABLE_ALIAS" && typeof object.id === "string") {
      bindings.push({
        propertyPath: path,
        variable: { kind: "variable", id: object.id },
      });
      return;
    }
    for (const key of Object.keys(object).sort()) {
      const child = object[key];
      if (child !== undefined) {
        visit(child, `${path}.${key}`);
      }
    }
  };
  visit(value, propertyPath);
  return bindings;
}

function colorFromJson(value: JsonValue | undefined): PaintIR["color"] {
  const object = value === undefined ? undefined : jsonObject(value);
  if (object === undefined) {
    return undefined;
  }
  const component = (key: "r" | "g" | "b" | "a"): number | null => {
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
    a: component("a"),
  };
}

function transformFromJson(
  value: JsonValue | undefined,
): TransformIR | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 3 &&
        row.every((cell) => typeof cell === "number" || cell === null),
    )
  ) {
    return undefined;
  }
  return value as unknown as TransformIR;
}

function collectPaints(
  node: SceneNode,
  property: "fills" | "strokes" | "backgrounds",
  diagnostics: DiagnosticBag,
  diagnosticPath: string = property,
): readonly PaintIR[] | MixedValue | undefined {
  const result = readOptional(node, property, diagnostics);
  if (!result.present) {
    return undefined;
  }
  if (result.value === figma.mixed) {
    return FIGMA_MIXED_VALUE;
  }
  if (!Array.isArray(result.value)) {
    if (result.value !== undefined) {
      diagnoseUnexpectedSupportedShape(node, property, diagnostics);
    }
    return undefined;
  }
  const paints: PaintIR[] = [];
  for (const [index, paint] of result.value.entries()) {
    const raw = normalizeObjectArrayItem(
      node,
      `${diagnosticPath}[${index}]`,
      paint,
      diagnostics,
    );
    if (raw === undefined || typeof raw.type !== "string") {
      diagnoseUnexpectedSupportedShape(
        node,
        `${diagnosticPath}[${index}]`,
        diagnostics,
      );
      continue;
    }
    let gradientStops: PaintIR["gradientStops"];
    if (raw.gradientStops !== undefined) {
      if (!Array.isArray(raw.gradientStops)) {
        diagnoseUnexpectedSupportedShape(
          node,
          `${diagnosticPath}[${index}].gradientStops`,
          diagnostics,
        );
      } else {
        const collectedStops: NonNullable<PaintIR["gradientStops"]>[number][] =
          [];
        for (const [stopIndex, candidate] of (
          raw.gradientStops as readonly JsonValue[]
        ).entries()) {
          const stop = jsonObject(candidate);
          const color = stop === undefined ? undefined : jsonObject(stop.color);
          const validPosition =
            stop !== undefined &&
            (typeof stop.position === "number" || stop.position === null);
          const validColor =
            color !== undefined &&
            [color.r, color.g, color.b, color.a].every(
              (component) =>
                typeof component === "number" || component === null,
            );
          if (!validPosition || !validColor) {
            diagnoseUnexpectedSupportedShape(
              node,
              `${diagnosticPath}[${index}].gradientStops[${stopIndex}]`,
              diagnostics,
            );
            continue;
          }
          const bindings = variableBindingsFromJson(
            stop.boundVariables,
            `$.${diagnosticPath}[${index}].gradientStops[${stopIndex}].boundVariables`,
          );
          collectedStops.push({
            position: stop.position as number | null,
            color: {
              r: color.r as number | null,
              g: color.g as number | null,
              b: color.b as number | null,
              a: color.a as number | null,
            },
            ...(bindings.length === 0 ? {} : { boundVariables: bindings }),
          });
        }
        gradientStops = collectedStops;
      }
    }
    paints.push({
      paintType: raw.type,
      ...(typeof raw.visible === "boolean" ? { visible: raw.visible } : {}),
      ...(typeof raw.opacity === "number" || raw.opacity === null
        ? { opacity: raw.opacity }
        : {}),
      ...(typeof raw.blendMode === "string"
        ? { blendMode: raw.blendMode }
        : {}),
      ...(colorFromJson(raw.color) === undefined
        ? {}
        : { color: colorFromJson(raw.color)! }),
      ...(gradientStops === undefined ? {} : { gradientStops }),
      ...(transformFromJson(raw.gradientTransform) === undefined
        ? {}
        : { gradientTransform: transformFromJson(raw.gradientTransform)! }),
      ...(typeof raw.imageHash === "string" || raw.imageHash === null
        ? { imageHash: raw.imageHash }
        : {}),
      ...(typeof raw.scaleMode === "string"
        ? { scaleMode: raw.scaleMode }
        : {}),
      ...(transformFromJson(raw.imageTransform) === undefined
        ? {}
        : { imageTransform: transformFromJson(raw.imageTransform)! }),
      ...(typeof raw.scalingFactor === "number" || raw.scalingFactor === null
        ? { scalingFactor: raw.scalingFactor }
        : {}),
      ...(typeof raw.rotation === "number" || raw.rotation === null
        ? { rotation: raw.rotation }
        : {}),
      ...(jsonObject(raw.filters) === undefined
        ? {}
        : { filters: jsonObject(raw.filters)! }),
      ...(variableBindingsFromJson(
        raw.boundVariables,
        `$.${diagnosticPath}[${index}].boundVariables`,
      ).length === 0
        ? {}
        : {
            boundVariables: variableBindingsFromJson(
              raw.boundVariables,
              `$.${diagnosticPath}[${index}].boundVariables`,
            ),
          }),
      raw,
    });
  }
  return paints;
}

function collectEffects(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): readonly EffectIR[] | MixedValue | undefined {
  const result = readOptional(node, "effects", diagnostics);
  if (!result.present) {
    return undefined;
  }
  if (result.value === figma.mixed) {
    return FIGMA_MIXED_VALUE;
  }
  if (!Array.isArray(result.value)) {
    if (result.value !== undefined) {
      diagnoseUnexpectedSupportedShape(node, "effects", diagnostics);
    }
    return undefined;
  }
  const effects: EffectIR[] = [];
  for (const [index, effect] of result.value.entries()) {
    const raw = normalizeObjectArrayItem(
      node,
      `effects[${index}]`,
      effect,
      diagnostics,
    );
    if (
      raw === undefined ||
      typeof raw.type !== "string" ||
      typeof raw.visible !== "boolean"
    ) {
      diagnoseUnexpectedSupportedShape(node, `effects[${index}]`, diagnostics);
      continue;
    }
    effects.push({
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
      ...(colorFromJson(raw.color) === undefined
        ? {}
        : { color: colorFromJson(raw.color)! }),
      ...(jsonObject(raw.offset) === undefined
        ? {}
        : {
            offset: {
              x:
                typeof jsonObject(raw.offset)!.x === "number" ||
                jsonObject(raw.offset)!.x === null
                  ? (jsonObject(raw.offset)!.x as number | null)
                  : null,
              y:
                typeof jsonObject(raw.offset)!.y === "number" ||
                jsonObject(raw.offset)!.y === null
                  ? (jsonObject(raw.offset)!.y as number | null)
                  : null,
            },
          }),
      ...(variableBindingsFromJson(
        raw.boundVariables,
        `$.effects[${index}].boundVariables`,
      ).length === 0
        ? {}
        : {
            boundVariables: variableBindingsFromJson(
              raw.boundVariables,
              `$.effects[${index}].boundVariables`,
            ),
          }),
      raw,
    });
  }
  return effects;
}

function collectLayoutGrids(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): readonly LayoutGridIR[] | MixedValue | undefined {
  const result = readOptional(node, "layoutGrids", diagnostics);
  if (!result.present) {
    return undefined;
  }
  if (result.value === figma.mixed) {
    return FIGMA_MIXED_VALUE;
  }
  if (!Array.isArray(result.value)) {
    if (result.value !== undefined) {
      diagnoseUnexpectedSupportedShape(node, "layoutGrids", diagnostics);
    }
    return undefined;
  }
  const grids: LayoutGridIR[] = [];
  for (const [index, grid] of result.value.entries()) {
    const raw = normalizeObjectArrayItem(
      node,
      `layoutGrids[${index}]`,
      grid,
      diagnostics,
    );
    if (raw === undefined || typeof raw.pattern !== "string") {
      diagnoseUnexpectedSupportedShape(
        node,
        `layoutGrids[${index}]`,
        diagnostics,
      );
      continue;
    }
    grids.push({
      pattern: raw.pattern,
      ...(typeof raw.alignment === "string"
        ? { alignment: raw.alignment }
        : {}),
      ...(typeof raw.visible === "boolean" ? { visible: raw.visible } : {}),
      ...Object.fromEntries(
        ["sectionSize", "gutterSize", "offset", "count"].flatMap((key) =>
          typeof raw[key] === "number" || raw[key] === null
            ? [[key, raw[key]]]
            : [],
        ),
      ),
      ...(colorFromJson(raw.color) === undefined
        ? {}
        : { color: colorFromJson(raw.color)! }),
      ...(variableBindingsFromJson(
        raw.boundVariables,
        `$.layoutGrids[${index}].boundVariables`,
      ).length === 0
        ? {}
        : {
            boundVariables: variableBindingsFromJson(
              raw.boundVariables,
              `$.layoutGrids[${index}].boundVariables`,
            ),
          }),
      raw,
    });
  }
  return grids;
}

function styleReference(
  node: SceneNode,
  property: string,
  diagnostics: DiagnosticBag,
): SourceRef | null | MixedValue | undefined {
  const result = readOptional(node, property, diagnostics);
  if (!result.present) {
    return undefined;
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
  return undefined;
}

function collectVisual(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): NodeVisualIR | undefined {
  const opacity = optionalNumber(node, "opacity", diagnostics);
  const blendMode = optionalString(node, "blendMode", diagnostics);
  const isMask = optionalBoolean(node, "isMask", diagnostics);
  const maskType = optionalString(node, "maskType", diagnostics);
  const clipsContent = optionalBoolean(node, "clipsContent", diagnostics);
  const visual: NodeVisualIR = {
    ...(opacity === undefined ? {} : { opacity }),
    ...(blendMode === undefined ? {} : { blendMode }),
    ...(isMask === undefined ? {} : { isMask }),
    ...(maskType === undefined ? {} : { maskType }),
    ...(clipsContent === undefined ? {} : { clipsContent }),
  };
  const fills = collectPaints(node, "fills", diagnostics);
  const strokes = collectPaints(node, "strokes", diagnostics);
  const backgrounds = collectPaints(node, "backgrounds", diagnostics);
  const effects = collectEffects(node, diagnostics);
  const cornerRadiusResult = readOptional(node, "cornerRadius", diagnostics);
  const cornerRadius =
    cornerRadiusResult.value === figma.mixed
      ? FIGMA_MIXED_VALUE
      : typeof cornerRadiusResult.value === "number"
        ? optionalNumber(node, "cornerRadius", diagnostics)
        : undefined;
  const cornerRadiiValue = optionalNormalized(node, "cornerRadii", diagnostics);
  const cornerRadii =
    Array.isArray(cornerRadiiValue) &&
    cornerRadiiValue.every(
      (value) => typeof value === "number" || value === null,
    )
      ? (cornerRadiiValue as readonly (number | null)[])
      : undefined;
  const cornerSmoothing = optionalNumber(node, "cornerSmoothing", diagnostics);
  const strokeGeometry = collectStrokeGeometry(node, diagnostics);
  const fillStyle = styleReference(node, "fillStyleId", diagnostics);
  const strokeStyle = styleReference(node, "strokeStyleId", diagnostics);
  const effectStyle = styleReference(node, "effectStyleId", diagnostics);
  const gridStyle = styleReference(node, "gridStyleId", diagnostics);
  const backgroundStyle = styleReference(
    node,
    "backgroundStyleId",
    diagnostics,
  );
  const result: NodeVisualIR = {
    ...visual,
    ...(fills === undefined ? {} : { fills }),
    ...(strokes === undefined ? {} : { strokes }),
    ...(backgrounds === undefined ? {} : { backgrounds }),
    ...(effects === undefined ? {} : { effects }),
    ...(strokeGeometry === undefined ? {} : { strokeGeometry }),
    ...(cornerRadius === undefined ? {} : { cornerRadius }),
    ...(cornerRadii === undefined ? {} : { cornerRadii }),
    ...(cornerSmoothing === undefined ? {} : { cornerSmoothing }),
    ...(fillStyle === undefined ? {} : { fillStyle }),
    ...(strokeStyle === undefined ? {} : { strokeStyle }),
    ...(effectStyle === undefined ? {} : { effectStyle }),
    ...(gridStyle === undefined ? {} : { gridStyle }),
    ...(backgroundStyle === undefined ? {} : { backgroundStyle }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function collectStrokeGeometry(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): StrokeGeometryIR | undefined {
  const weightValue = readOptional(node, "strokeWeight", diagnostics);
  const weight =
    weightValue.value === figma.mixed
      ? FIGMA_MIXED_VALUE
      : numberFromRead(node, "strokeWeight", weightValue, diagnostics);
  const topWeight = optionalNumber(node, "strokeTopWeight", diagnostics);
  const rightWeight = optionalNumber(node, "strokeRightWeight", diagnostics);
  const bottomWeight = optionalNumber(node, "strokeBottomWeight", diagnostics);
  const leftWeight = optionalNumber(node, "strokeLeftWeight", diagnostics);
  const align = optionalString(node, "strokeAlign", diagnostics);
  const cap = optionalNormalized(node, "strokeCap", diagnostics);
  const joinValue = readOptional(node, "strokeJoin", diagnostics);
  const join =
    joinValue.value === figma.mixed
      ? FIGMA_MIXED_VALUE
      : typeof joinValue.value === "string"
        ? joinValue.value
        : undefined;
  const miterLimit = optionalNumber(node, "strokeMiterLimit", diagnostics);
  const dashValue = optionalNormalized(node, "dashPattern", diagnostics);
  const dashPattern =
    Array.isArray(dashValue) &&
    dashValue.every((value) => typeof value === "number" || value === null)
      ? (dashValue as readonly (number | null)[])
      : undefined;
  const result: StrokeGeometryIR = {
    ...(weight === undefined ? {} : { weight }),
    ...(topWeight === undefined ? {} : { topWeight }),
    ...(rightWeight === undefined ? {} : { rightWeight }),
    ...(bottomWeight === undefined ? {} : { bottomWeight }),
    ...(leftWeight === undefined ? {} : { leftWeight }),
    ...(align === undefined ? {} : { align }),
    ...(cap === undefined ? {} : { cap }),
    ...(join === undefined ? {} : { join }),
    ...(miterLimit === undefined ? {} : { miterLimit }),
    ...(dashPattern === undefined ? {} : { dashPattern }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

function collectVariableBindings(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): readonly VariableBindingIR[] | undefined {
  const result = readOptional(node, "boundVariables", diagnostics);
  if (!result.present) {
    return undefined;
  }
  if (result.value === undefined) {
    return [];
  }
  const normalized = normalizeValue(
    node,
    "boundVariables",
    result.value,
    diagnostics,
  );
  return variableBindingsFromJson(normalized, "$.boundVariables");
}

const STYLED_TEXT_FIELDS = [
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
  "openTypeFeatures",
] as const;

interface CollectedTextData {
  readonly text: TextDataIR;
  readonly complete: boolean;
  readonly dependencyRefs: readonly SourceRef[];
}

function segmentStyleReference(
  value: JsonValue | undefined,
): SourceRef | null | MixedValue | undefined {
  if (value === null || value === "") {
    return null;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as JsonObject).$type === "figma-mixed"
  ) {
    return FIGMA_MIXED_VALUE;
  }
  return typeof value === "string" ? { kind: "style", id: value } : undefined;
}

function collectStyledTextSegments(
  node: SceneNode,
  diagnostics: DiagnosticBag,
  characters: string,
): {
  readonly segments: readonly TextStyleRunIR[];
  readonly dependencyRefs: readonly SourceRef[];
  readonly complete: boolean;
} {
  let getter: unknown;
  try {
    getter = (node as unknown as Record<string, unknown>).getStyledTextSegments;
  } catch (error) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
      severity: "warning",
      message:
        "Styled text segments could not be read; complete characters remain available.",
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: "$.getStyledTextSegments",
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return { segments: [], dependencyRefs: [], complete: false };
  }
  if (typeof getter !== "function") {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
      severity: "warning",
      message:
        "The styled text segment reader was unavailable; complete characters remain available.",
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: "$.getStyledTextSegments",
      causedDataLoss: true,
    });
    return { segments: [], dependencyRefs: [], complete: false };
  }

  let rawSegments: unknown;
  try {
    rawSegments = getter.call(node, STYLED_TEXT_FIELDS);
  } catch (error) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
      severity: "warning",
      message:
        "Styled text segments could not be read; complete characters remain available.",
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: "$.getStyledTextSegments",
      causedDataLoss: true,
      technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
    });
    return { segments: [], dependencyRefs: [], complete: false };
  }
  if (!Array.isArray(rawSegments)) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
      severity: "warning",
      message:
        "Styled text segments returned an unsupported value; complete characters remain available.",
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: "$.getStyledTextSegments",
      causedDataLoss: true,
    });
    return { segments: [], dependencyRefs: [], complete: false };
  }

  const segments: TextStyleRunIR[] = [];
  const dependencyRefs: SourceRef[] = [];
  let complete = true;
  let previousEnd = 0;
  for (const [index, rawSegment] of rawSegments.entries()) {
    const normalized = jsonObject(
      normalizeValue(
        node,
        `getStyledTextSegments[${index}]`,
        rawSegment,
        diagnostics,
      ),
    );
    if (normalized === undefined) {
      complete = false;
      continue;
    }
    const start = normalized.start;
    const end = normalized.end;
    const segmentCharacters = normalized.characters;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start !== previousEnd ||
      end < start ||
      end > characters.length ||
      typeof segmentCharacters !== "string" ||
      segmentCharacters !== characters.slice(start, end)
    ) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
        severity: "warning",
        message:
          "A styled text segment had inconsistent UTF-16 offsets and was not represented as complete.",
        phase: "collection",
        source: sourceForNode(node),
        propertyPath: `$.getStyledTextSegments[${index}]`,
        causedDataLoss: true,
      });
      complete = false;
      continue;
    }
    previousEnd = end;
    const textStyle = segmentStyleReference(normalized.textStyleId);
    const fillStyle = segmentStyleReference(normalized.fillStyleId);
    for (const reference of [textStyle, fillStyle]) {
      if (
        reference !== undefined &&
        reference !== null &&
        !("$type" in reference)
      ) {
        dependencyRefs.push(reference);
      }
    }
    const variableBindings = variableBindingsFromJson(
      normalized.boundVariables,
      `$.getStyledTextSegments[${index}].boundVariables`,
    );
    dependencyRefs.push(...variableBindings.map((binding) => binding.variable));
    const fills = Array.isArray(normalized.fills)
      ? collectPaintsFromNormalized(
          node,
          `getStyledTextSegments[${index}].fills`,
          normalized.fills,
          diagnostics,
        )
      : undefined;
    if (fills !== undefined) {
      for (const paint of fills) {
        dependencyRefs.push(
          ...(paint.boundVariables ?? []).map(
            (binding: VariableBindingIR) => binding.variable,
          ),
        );
      }
    }
    const normalizedFields: Record<string, JsonValue> = {};
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
      "hyperlink",
    ] as const) {
      const value = normalized[property];
      if (value !== undefined) {
        normalizedFields[property] = value;
      }
    }
    const listOptions = jsonObject(normalized.listOptions);
    const openTypeFeatures = jsonObject(normalized.openTypeFeatures);
    let overrides: { readonly type: string }[] | undefined;
    if (normalized.textStyleOverrides !== undefined) {
      if (!Array.isArray(normalized.textStyleOverrides)) {
        diagnoseUnexpectedSupportedShape(
          node,
          `getStyledTextSegments[${index}].textStyleOverrides`,
          diagnostics,
        );
        complete = false;
      } else {
        overrides = [];
        for (const [overrideIndex, candidate] of (
          normalized.textStyleOverrides as readonly JsonValue[]
        ).entries()) {
          const override = jsonObject(candidate);
          if (override === undefined || typeof override.type !== "string") {
            diagnoseUnexpectedSupportedShape(
              node,
              `getStyledTextSegments[${index}].textStyleOverrides[${overrideIndex}]`,
              diagnostics,
            );
            complete = false;
          } else {
            overrides.push({ type: override.type });
          }
        }
      }
    }
    const segment: TextStyleRunIR = {
      start,
      end,
      characters: segmentCharacters,
      ...normalizedFields,
      ...(typeof normalized.fontStyle === "string"
        ? { fontStyle: normalized.fontStyle }
        : {}),
      ...(typeof normalized.textDecorationSkipInk === "boolean" ||
      normalized.textDecorationSkipInk === null
        ? { textDecorationSkipInk: normalized.textDecorationSkipInk }
        : {}),
      ...(fills === undefined ? {} : { fills }),
      ...(textStyle === undefined ? {} : { textStyle }),
      ...(fillStyle === undefined ? {} : { fillStyle }),
      ...(listOptions === undefined ? {} : { listOptions }),
      ...(typeof normalized.listSpacing === "number" ||
      normalized.listSpacing === null
        ? { listSpacing: normalized.listSpacing }
        : {}),
      ...(typeof normalized.indentation === "number" ||
      normalized.indentation === null
        ? { indentation: normalized.indentation }
        : {}),
      ...(typeof normalized.paragraphIndent === "number" ||
      normalized.paragraphIndent === null
        ? { paragraphIndent: normalized.paragraphIndent }
        : {}),
      ...(typeof normalized.paragraphSpacing === "number" ||
      normalized.paragraphSpacing === null
        ? { paragraphSpacing: normalized.paragraphSpacing }
        : {}),
      ...(openTypeFeatures === undefined ? {} : { openTypeFeatures }),
      ...(variableBindings.length === 0 ? {} : { variableBindings }),
      ...(overrides === undefined ? {} : { textStyleOverrides: overrides }),
      raw: normalized,
    };
    segments.push(segment);
  }
  if (characters.length > 0 && previousEnd !== characters.length) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.textSegmentsCollectionFailed,
      severity: "warning",
      message:
        "Styled text segments did not cover the complete characters value.",
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: "$.getStyledTextSegments",
      causedDataLoss: true,
    });
    complete = false;
  }
  return { segments, dependencyRefs, complete };
}

function collectPaintsFromNormalized(
  node: SceneNode,
  _property: string,
  values: readonly JsonValue[],
  diagnostics: DiagnosticBag,
): readonly PaintIR[] {
  const holder = {
    id: safeNodeId(node),
    name: safeNodeName(node) ?? "",
    fills: values,
  } as unknown as SceneNode;
  const collected = collectPaints(holder, "fills", diagnostics, _property);
  if (collected === undefined || "$type" in collected) {
    return [];
  }
  return collected;
}

function collectTextData(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): CollectedTextData {
  const charactersResult = readOptional(node, "characters", diagnostics);
  const charactersValue =
    charactersResult.present && typeof charactersResult.value === "string"
      ? charactersResult.value
      : undefined;
  if (
    charactersResult.present &&
    charactersResult.value !== undefined &&
    typeof charactersResult.value !== "string"
  ) {
    diagnoseUnexpectedSupportedShape(node, "characters", diagnostics);
  }
  const characters: string | UnavailableValue = charactersValue ?? {
    $type: "unavailable",
    reason: "property-access-failed",
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
    "listOptions",
  ] as const;
  const normalized: Record<string, JsonValue> = {};
  for (const property of normalizedFields) {
    const value = optionalNormalized(node, property, diagnostics);
    if (value !== undefined) {
      normalized[property] = value;
    }
  }
  const openTypeValue = readOptional(node, "openTypeFeatures", diagnostics);
  const openTypeFeatures =
    openTypeValue.value === figma.mixed
      ? FIGMA_MIXED_VALUE
      : openTypeValue.present
        ? jsonObject(
            normalizeValue(
              node,
              "openTypeFeatures",
              openTypeValue.value,
              diagnostics,
            ),
          )
        : undefined;
  const textStyle = styleReference(node, "textStyleId", diagnostics);
  const textAutoResize = optionalString(node, "textAutoResize", diagnostics);
  const textTruncation = optionalString(node, "textTruncation", diagnostics);
  const maxLines = optionalNumber(node, "maxLines", diagnostics);
  const paragraphIndent = optionalNumberOrMixed(
    node,
    "paragraphIndent",
    diagnostics,
  );
  const paragraphSpacing = optionalNumberOrMixed(
    node,
    "paragraphSpacing",
    diagnostics,
  );
  const listSpacing = optionalNumberOrMixed(node, "listSpacing", diagnostics);
  const hangingPunctuation = optionalBoolean(
    node,
    "hangingPunctuation",
    diagnostics,
  );
  const hangingList = optionalBoolean(node, "hangingList", diagnostics);
  const missingFont = optionalBoolean(node, "hasMissingFont", diagnostics);
  if (missingFont === true) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.textMissingFont,
      severity: "warning",
      message:
        "The text node reports a missing font; the document was not modified or fonts loaded.",
      phase: "collection",
      source: sourceForNode(node),
      propertyPath: "$.hasMissingFont",
      causedDataLoss: false,
    });
  }
  const alignHorizontal = optionalString(
    node,
    "textAlignHorizontal",
    diagnostics,
  );
  const alignVertical = optionalString(node, "textAlignVertical", diagnostics);
  const autoRename = optionalBoolean(node, "autoRename", diagnostics);
  const segments =
    charactersValue === undefined
      ? { segments: [], dependencyRefs: [], complete: false }
      : collectStyledTextSegments(node, diagnostics, charactersValue);
  const text: TextDataIR = {
    characters,
    segments: segments.segments,
    ...normalized,
    ...(openTypeFeatures === undefined ? {} : { openTypeFeatures }),
    ...(textStyle === undefined ? {} : { textStyle }),
    ...(textAutoResize === undefined ? {} : { textAutoResize }),
    ...(textTruncation === undefined ? {} : { textTruncation }),
    ...(maxLines === undefined ? {} : { maxLines }),
    ...(paragraphIndent === undefined ? {} : { paragraphIndent }),
    ...(paragraphSpacing === undefined ? {} : { paragraphSpacing }),
    ...(listSpacing === undefined ? {} : { listSpacing }),
    ...(hangingPunctuation === undefined ? {} : { hangingPunctuation }),
    ...(hangingList === undefined ? {} : { hangingList }),
    ...(missingFont === undefined ? {} : { missingFont }),
    ...(alignHorizontal === undefined ? {} : { alignHorizontal }),
    ...(alignVertical === undefined ? {} : { alignVertical }),
    ...(autoRename === undefined ? {} : { autoRename }),
  };
  return {
    text,
    complete: segments.complete,
    dependencyRefs: segments.dependencyRefs,
  };
}

function collectVectorData(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): VectorDataIR {
  const rawFillGeometry = optionalNormalized(node, "fillGeometry", diagnostics);
  const fillGeometry = Array.isArray(rawFillGeometry)
    ? (rawFillGeometry as readonly JsonValue[])
    : undefined;
  const vectorNetwork = jsonObject(
    optionalNormalized(node, "vectorNetwork", diagnostics),
  );
  const rawPaths = optionalNormalized(node, "vectorPaths", diagnostics);
  const vectorPaths = Array.isArray(rawPaths)
    ? (rawPaths as readonly JsonValue[])
    : undefined;
  const handleValue = readOptional(node, "handleMirroring", diagnostics);
  const handleMirroring =
    handleValue.value === figma.mixed
      ? FIGMA_MIXED_VALUE
      : typeof handleValue.value === "string"
        ? handleValue.value
        : undefined;
  const windingRule = optionalString(node, "windingRule", diagnostics);
  return {
    ...(fillGeometry === undefined ? {} : { fillGeometry }),
    ...(vectorNetwork === undefined ? {} : { vectorNetwork }),
    ...(vectorPaths === undefined ? {} : { vectorPaths }),
    ...(handleMirroring === undefined ? {} : { handleMirroring }),
    ...(windingRule === undefined ? {} : { windingRule }),
  };
}

function collectVariableModes(
  node: SceneNode,
  property: "explicitVariableModes" | "resolvedVariableModes",
  diagnostics: DiagnosticBag,
): readonly ExplicitVariableModeIR[] | undefined {
  const result = readOptional(node, property, diagnostics);
  if (!result.present) {
    return undefined;
  }
  if (
    result.value === null ||
    typeof result.value !== "object" ||
    Array.isArray(result.value)
  ) {
    diagnoseUnexpectedSupportedShape(node, property, diagnostics);
    return undefined;
  }
  const modes: ExplicitVariableModeIR[] = [];
  for (const [collectionId, modeId] of Object.entries(
    result.value as Record<string, unknown>,
  ).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (typeof modeId !== "string") {
      diagnoseUnexpectedSupportedShape(
        node,
        `${property}.${collectionId}`,
        diagnostics,
      );
    } else {
      modes.push({ collectionId, modeId });
    }
  }
  return modes;
}

function collectComponentPropertyReferences(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): NodeCommonIR["componentPropertyReferences"] | undefined {
  const result = readOptional(node, "componentPropertyReferences", diagnostics);
  if (!result.present) {
    return undefined;
  }
  if (result.value === null) {
    return null;
  }
  if (typeof result.value !== "object" || Array.isArray(result.value)) {
    diagnoseUnexpectedSupportedShape(
      node,
      "componentPropertyReferences",
      diagnostics,
    );
    return undefined;
  }
  const record = result.value as Record<string, unknown>;
  const references: Record<string, string> = {};
  for (const property of ["visible", "characters", "mainComponent"] as const) {
    if (typeof record[property] === "string") {
      references[property] = record[property];
    } else if (record[property] !== undefined) {
      diagnoseUnexpectedSupportedShape(
        node,
        `componentPropertyReferences.${property}`,
        diagnostics,
      );
    }
  }
  return references;
}

function collectExportSettings(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): readonly ExportSettingIR[] | undefined {
  const result = readOptional(node, "exportSettings", diagnostics);
  if (!result.present) {
    return undefined;
  }
  if (!Array.isArray(result.value)) {
    diagnoseUnexpectedSupportedShape(node, "exportSettings", diagnostics);
    return [];
  }
  return result.value.flatMap((setting, index): readonly ExportSettingIR[] => {
    const raw = normalizeObjectArrayItem(
      node,
      `exportSettings[${index}]`,
      setting,
      diagnostics,
    );
    if (raw === undefined || typeof raw.format !== "string") {
      diagnoseUnexpectedSupportedShape(
        node,
        `exportSettings[${index}]`,
        diagnostics,
      );
      return [];
    }
    return [
      {
        format: raw.format,
        ...(typeof raw.suffix === "string" ? { suffix: raw.suffix } : {}),
        ...(jsonObject(raw.constraint) === undefined
          ? {}
          : { constraint: jsonObject(raw.constraint)! }),
        ...(typeof raw.contentsOnly === "boolean"
          ? { contentsOnly: raw.contentsOnly }
          : {}),
        ...(typeof raw.useAbsoluteBounds === "boolean"
          ? { useAbsoluteBounds: raw.useAbsoluteBounds }
          : {}),
        ...(typeof raw.colorProfile === "string"
          ? { colorProfile: raw.colorProfile }
          : {}),
        ...(typeof raw.svgOutlineText === "boolean"
          ? { svgOutlineText: raw.svgOutlineText }
          : {}),
        ...(typeof raw.svgIdAttribute === "boolean"
          ? { svgIdAttribute: raw.svgIdAttribute }
          : {}),
        ...(typeof raw.svgSimplifyStroke === "boolean"
          ? { svgSimplifyStroke: raw.svgSimplifyStroke }
          : {}),
      },
    ];
  });
}

const FAMILY_PROPERTY_NAMES = [
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
  "vectorPaths",
] as const;

function collectFamilyProperties(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): JsonObject | undefined {
  const properties: Record<string, JsonValue> = {};
  for (const property of FAMILY_PROPERTY_NAMES) {
    const value = optionalNormalized(node, property, diagnostics);
    if (value !== undefined) {
      properties[property] = value;
    }
  }
  return Object.keys(properties).length === 0 ? undefined : properties;
}

function childrenOf(
  node: SceneNode,
  diagnostics: DiagnosticBag,
): {
  readonly children: readonly SceneNode[];
  readonly complete: boolean;
} {
  const diagnosticStart = diagnostics.size();
  const result = readOptional(node, "children", diagnostics, "error");
  if (!result.present) {
    return {
      children: [],
      complete: diagnostics.size() === diagnosticStart,
    };
  }
  if (result.value === undefined) {
    diagnoseUnexpectedSupportedShape(node, "children", diagnostics);
    return { children: [], complete: false };
  }
  if (!Array.isArray(result.value)) {
    diagnoseUnexpectedSupportedShape(node, "children", diagnostics);
    return { children: [], complete: false };
  }
  return {
    children: result.value as readonly SceneNode[],
    complete: true,
  };
}

function deduplicateReferences(
  references: readonly SourceRef[],
): readonly SourceRef[] {
  const byIdentity = new Map<string, SourceRef>();
  for (const reference of references) {
    const signature = JSON.stringify([reference.kind, reference.id]);
    const existing = byIdentity.get(signature);
    const existingRichness =
      (existing?.name === undefined ? 0 : 1) +
      (existing?.key === undefined ? 0 : 1) +
      (existing?.remote === undefined ? 0 : 1);
    const candidateRichness =
      (reference.name === undefined ? 0 : 1) +
      (reference.key === undefined ? 0 : 1) +
      (reference.remote === undefined ? 0 : 1);
    if (existing === undefined || candidateRichness > existingRichness) {
      byIdentity.set(signature, reference);
    }
  }
  return sortUnorderedSourceRefs([...byIdentity.values()]);
}

function dependencyRefsFromNode(node: NodeIR): readonly SourceRef[] {
  const references: SourceRef[] = [];
  const work: NodeIR[] = [node];
  while (work.length > 0) {
    const current = work.pop();
    if (current === undefined) {
      continue;
    }
    references.push(
      ...(current.variableBindings ?? []).map((binding) => binding.variable),
      ...(current.explicitVariableModes ?? []).map((mode) => ({
        kind: "collection" as const,
        id: mode.collectionId,
      })),
      ...(current.resolvedVariableModes ?? []).map((mode) => ({
        kind: "collection" as const,
        id: mode.collectionId,
      })),
    );
    const visual = current.visual;
    if (visual !== undefined) {
      for (const reference of [
        visual.fillStyle,
        visual.strokeStyle,
        visual.effectStyle,
        visual.gridStyle,
        visual.backgroundStyle,
      ]) {
        if (
          reference !== undefined &&
          reference !== null &&
          !(typeof reference === "object" && "$type" in reference)
        ) {
          references.push(reference);
        }
      }
      const appendBindings = (items: readonly unknown[]): void => {
        for (const item of items) {
          if (
            typeof item === "object" &&
            item !== null &&
            "boundVariables" in item &&
            Array.isArray(item.boundVariables)
          ) {
            for (const binding of item.boundVariables as readonly VariableBindingIR[]) {
              references.push(binding.variable);
            }
          }
        }
      };
      for (const collection of [
        visual.fills,
        visual.strokes,
        visual.effects,
        visual.backgrounds,
      ]) {
        if (Array.isArray(collection)) {
          const items = collection as readonly unknown[];
          appendBindings(items);
          for (const item of items) {
            if (
              typeof item === "object" &&
              item !== null &&
              "gradientStops" in item
            ) {
              const stops = (item as { readonly gradientStops?: unknown })
                .gradientStops;
              if (Array.isArray(stops)) {
                appendBindings(stops as readonly unknown[]);
              }
            }
          }
        }
      }
    }
    if (
      current.layout?.grids !== undefined &&
      Array.isArray(current.layout.grids)
    ) {
      for (const grid of current.layout.grids as readonly LayoutGridIR[]) {
        references.push(
          ...(grid.boundVariables ?? []).map((binding) => binding.variable),
        );
      }
    }
    if (current.family === "text") {
      const textStyle = current.text.textStyle;
      if (
        textStyle !== undefined &&
        textStyle !== null &&
        !("$type" in textStyle)
      ) {
        references.push(textStyle);
      }
      for (const segment of current.text.segments) {
        for (const style of [segment.textStyle, segment.fillStyle]) {
          if (style !== undefined && style !== null && !("$type" in style)) {
            references.push(style);
          }
        }
        references.push(
          ...(segment.variableBindings ?? []).map(
            (binding) => binding.variable,
          ),
        );
        if (Array.isArray(segment.fills)) {
          for (const paint of segment.fills as readonly PaintIR[]) {
            references.push(
              ...(paint.boundVariables ?? []).map(
                (binding: VariableBindingIR) => binding.variable,
              ),
            );
            for (const stop of paint.gradientStops ?? []) {
              references.push(
                ...(stop.boundVariables ?? []).map(
                  (binding: VariableBindingIR) => binding.variable,
                ),
              );
            }
          }
        }
      }
    }
    if (current.family === "component") {
      references.push(current.componentData.component);
      if (current.componentData.componentSet !== undefined) {
        references.push(current.componentData.componentSet);
      }
    }
    if (current.family === "instance") {
      if (current.instanceData.mainComponent !== undefined) {
        references.push(current.instanceData.mainComponent);
      }
      references.push(...(current.instanceData.swapTargets ?? []));
      references.push(
        ...(current.instanceData.componentProperties ?? []).flatMap(
          (property) =>
            property.variableBindings.map((binding) => binding.variable),
        ),
      );
    }
    if ("children" in current) {
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        const child = current.children[index];
        if (child !== undefined) {
          work.push(child);
        }
      }
    }
  }
  return references;
}

function buildNode(
  node: SceneNode,
  page: (SourceRef & { readonly kind: "page" }) | undefined,
  children: readonly NodeIR[],
  childOrder: number | undefined,
  diagnostics: DiagnosticBag,
  diagnosticStart: number,
  annotations: NodeCommonIR["annotations"],
  reactionIds: NodeCommonIR["reactionIds"],
  collectedText: CollectedTextData | undefined,
  enrichment: NodeCollectionEnrichment | undefined,
): NodeIR {
  const idResult = readOptional(node, "id", diagnostics, "error");
  const nameResult = readOptional(node, "name", diagnostics, "error");
  const typeResult = readOptional(node, "type", diagnostics, "error");
  const visibleResult = readOptional(node, "visible", diagnostics, "error");
  const lockedResult = readOptional(node, "locked", diagnostics, "error");
  const nodeId =
    idResult.present && typeof idResult.value === "string"
      ? idResult.value
      : safeNodeId(node);
  const nodeName =
    nameResult.present && typeof nameResult.value === "string"
      ? nameResult.value
      : safeNodeName(node);
  const nodeType =
    typeResult.present && typeof typeResult.value === "string"
      ? typeResult.value
      : "UNKNOWN";
  const source: SourceRef & { readonly kind: "node" } = {
    kind: "node",
    id: nodeId,
    ...(nodeName === undefined ? {} : { name: nodeName }),
  };
  const parentResult = readOptional(node, "parent", diagnostics, "warning");
  let parentRef: SourceRef | undefined;
  let parentType: string | undefined;
  if (
    parentResult.present &&
    parentResult.value !== null &&
    typeof parentResult.value === "object"
  ) {
    try {
      const parent = parentResult.value as {
        readonly id?: unknown;
        readonly name?: unknown;
        readonly type?: unknown;
      };
      parentType = typeof parent.type === "string" ? parent.type : undefined;
      if (
        parentType !== "PAGE" &&
        parentType !== "DOCUMENT" &&
        typeof parent.id === "string"
      ) {
        parentRef = {
          kind: "node",
          id: parent.id,
          ...(typeof parent.name === "string" ? { name: parent.name } : {}),
        };
      }
    } catch (error) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
        severity: "warning",
        message:
          "A parent reference could not be read and remains explicit in diagnostics.",
        phase: "collection",
        source,
        propertyPath: "$.parent",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
      });
    }
  }
  const geometry = collectGeometry(node, diagnostics);
  const layout = collectLayout(node, diagnostics);
  const visual = collectVisual(node, diagnostics);
  const variableBindings = collectVariableBindings(node, diagnostics);
  const explicitVariableModes = collectVariableModes(
    node,
    "explicitVariableModes",
    diagnostics,
  );
  const resolvedVariableModes = collectVariableModes(
    node,
    "resolvedVariableModes",
    diagnostics,
  );
  const collectedComponentPropertyReferences =
    collectComponentPropertyReferences(node, diagnostics);
  const componentPropertyReferences =
    enrichment?.componentPropertyReferencesByNodeId.has(nodeId) === true
      ? enrichment.componentPropertyReferencesByNodeId.get(nodeId)
      : collectedComponentPropertyReferences;
  const exportSettings = collectExportSettings(node, diagnostics);
  const familyProperties = collectFamilyProperties(node, diagnostics);
  const commonWithoutDiagnostics: Omit<NodeCommonIR, "diagnosticIds"> = {
    source,
    nodeType,
    ...(nodeName === undefined ? {} : { name: nodeName }),
    ...(page === undefined ? {} : { page }),
    ...(parentRef === undefined ? {} : { parent: parentRef }),
    ...(childOrder === undefined || childOrder < 0 ? {} : { childOrder }),
    ...(visibleResult.present && typeof visibleResult.value === "boolean"
      ? { visible: visibleResult.value }
      : {}),
    ...(lockedResult.present && typeof lockedResult.value === "boolean"
      ? { locked: lockedResult.value }
      : {}),
    ...(geometry === undefined ? {} : { geometry }),
    ...(layout === undefined ? {} : { layout }),
    ...(visual === undefined ? {} : { visual }),
    ...(variableBindings === undefined ? {} : { variableBindings }),
    ...(explicitVariableModes === undefined ? {} : { explicitVariableModes }),
    ...(resolvedVariableModes === undefined ||
    resolvedVariableModes.length === 0
      ? {}
      : { resolvedVariableModes }),
    ...(componentPropertyReferences === undefined
      ? {}
      : { componentPropertyReferences }),
    ...(exportSettings === undefined ? {} : { exportSettings }),
    ...(familyProperties === undefined ? {} : { familyProperties }),
    ...(enrichment?.slotLimitViolationsByNodeId.get(nodeId) === undefined
      ? {}
      : {
          slotLimitViolations:
            enrichment.slotLimitViolationsByNodeId.get(nodeId)!,
        }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(reactionIds === undefined ? {} : { reactionIds }),
    assetRefs: [],
  };

  if (!KNOWN_NODE_TYPES.has(nodeType)) {
    diagnostics.add({
      code: DIAGNOSTIC_CODES.irUnknownNodeType,
      severity: "warning",
      message:
        "An unknown node type was retained with common properties, children, and raw fallback metadata.",
      phase: "collection",
      source,
      propertyPath: "$.type",
      causedDataLoss: false,
    });
    return {
      ...commonWithoutDiagnostics,
      family: "unknown",
      unsupportedNodeType: nodeType,
      raw: {
        $type: "unsupported",
        reason: "unknown",
        runtimeType: "figma-node",
      },
      children,
      diagnosticIds: diagnostics
        .listSince(diagnosticStart)
        .map((diagnostic) => diagnostic.id),
    };
  }

  if (nodeType === "TEXT" || nodeType === "TEXT_PATH") {
    return {
      ...commonWithoutDiagnostics,
      family: "text",
      text: collectedText?.text ?? collectTextData(node, diagnostics).text,
      diagnosticIds: diagnostics
        .listSince(diagnosticStart)
        .map((diagnostic) => diagnostic.id),
    };
  }

  if (VECTOR_NODE_TYPES.has(nodeType)) {
    return {
      ...commonWithoutDiagnostics,
      family: "vector",
      vector: collectVectorData(node, diagnostics),
      children,
      diagnosticIds: diagnostics
        .listSince(diagnosticStart)
        .map((diagnostic) => diagnostic.id),
    };
  }

  if (nodeType === "COMPONENT" || nodeType === "COMPONENT_SET") {
    const componentData = enrichment?.componentDataByNodeId.get(nodeId);
    return {
      ...commonWithoutDiagnostics,
      family: "component",
      componentData:
        componentData ??
        (enrichment === undefined
          ? {
              metadataCoverage: {
                status: "not-collected",
                reason:
                  "Component variants, property definitions, and relationships were not collected in this adapter context.",
              },
              component: {
                kind: "component",
                id: nodeId,
                ...(nodeName === undefined ? {} : { name: nodeName }),
              },
            }
          : {
              metadataCoverage: {
                status: "partial",
                reason:
                  "Supported component metadata was inaccessible during component collection.",
              },
              component: {
                kind: "component",
                id: nodeId,
                ...(nodeName === undefined ? {} : { name: nodeName }),
              },
            }),
      children,
      diagnosticIds: diagnostics
        .listSince(diagnosticStart)
        .map((diagnostic) => diagnostic.id),
    };
  }

  if (nodeType === "INSTANCE") {
    const instanceData = enrichment?.instanceDataByNodeId.get(nodeId);
    return {
      ...commonWithoutDiagnostics,
      family: "instance",
      instanceData:
        instanceData ??
        (enrichment === undefined
          ? {
              metadataCoverage: {
                status: "not-collected",
                reason:
                  "Instance properties, overrides, swap targets, and main-component resolution were not collected in this adapter context.",
              },
            }
          : {
              metadataCoverage: {
                status: "partial",
                reason:
                  "Supported instance metadata was inaccessible during instance collection.",
              },
            }),
      children,
      diagnosticIds: diagnostics
        .listSince(diagnosticStart)
        .map((diagnostic) => diagnostic.id),
    };
  }

  if (children.length > 0 || CONTAINER_NODE_TYPES.has(nodeType)) {
    return {
      ...commonWithoutDiagnostics,
      family: "container",
      children,
      diagnosticIds: diagnostics
        .listSince(diagnosticStart)
        .map((diagnostic) => diagnostic.id),
    };
  }

  return {
    ...commonWithoutDiagnostics,
    family: "leaf",
    properties: {},
    diagnosticIds: diagnostics
      .listSince(diagnosticStart)
      .map((diagnostic) => diagnostic.id),
  };
}

export async function collectNodeTree(
  root: SceneNode,
  page: (SourceRef & { readonly kind: "page" }) | undefined,
  diagnostics: DiagnosticBag,
  cancellation: ExportCancellationToken,
  enrichment?: NodeCollectionEnrichment,
): Promise<CollectedNodeTree> {
  const collectionDiagnosticStart = diagnostics.size();
  const work: {
    readonly node: SceneNode;
    readonly exiting: boolean;
    readonly childOrder?: number;
  }[] = [{ node: root, exiting: false }];
  const childLists = new Map<SceneNode, readonly SceneNode[]>();
  const built = new Map<SceneNode, NodeIR>();
  const interactionByNode = new Map<
    SceneNode,
    ReturnType<typeof collectNodeInteractions>
  >();
  const diagnosticStartByNode = new Map<SceneNode, number>();
  const reactions: ReactionIR[] = [];
  const supplementalDependencies: SourceRef[] = [];
  const nodesById = new Map<string, SceneNode>();
  let textSegmentsComplete = true;
  let interactionsComplete = true;
  let childrenComplete = true;
  let visited = 0;

  while (work.length > 0) {
    cancellation.throwIfCancelled();
    const item = work.pop();
    if (item === undefined) {
      break;
    }

    if (!item.exiting) {
      nodesById.set(safeNodeId(item.node), item.node);
      diagnosticStartByNode.set(item.node, diagnostics.size());
      const interactions = collectNodeInteractions(item.node, diagnostics);
      interactionByNode.set(item.node, interactions);
      reactions.push(...interactions.reactions);
      supplementalDependencies.push(...interactions.dependencyRefs);
      interactionsComplete &&= interactions.complete;
      const childResult = childrenOf(item.node, diagnostics);
      const children = childResult.children;
      childrenComplete &&= childResult.complete;
      childLists.set(item.node, children);
      work.push({
        node: item.node,
        exiting: true,
        ...(item.childOrder === undefined
          ? {}
          : { childOrder: item.childOrder }),
      });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) {
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

    const children = childLists.get(item.node) ?? [];
    const childIr = children.map((child) => {
      const result = built.get(child);
      if (result === undefined) {
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
      complete: false,
    };
    let collectedText: CollectedTextData | undefined;
    try {
      const runtimeType = (item.node as unknown as { readonly type?: unknown })
        .type;
      if (runtimeType === "TEXT" || runtimeType === "TEXT_PATH") {
        collectedText = collectTextData(item.node, diagnostics);
        textSegmentsComplete &&= collectedText.complete;
        supplementalDependencies.push(...collectedText.dependencyRefs);
      }
    } catch (error) {
      diagnostics.add({
        code: DIAGNOSTIC_CODES.collectionPropertyAccessFailed,
        severity: "warning",
        message:
          "A node type could not be read while collecting styled text metadata.",
        phase: "collection",
        source: sourceForNode(item.node),
        propertyPath: "$.type",
        causedDataLoss: true,
        technicalCause: normalizeSafeTechnicalCause(error, "property-access"),
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
        interactions.annotationsAvailable
          ? interactions.annotations
          : undefined,
        interactions.reactionsAvailable
          ? interactions.reactions.map((reaction) => reaction.id)
          : undefined,
        collectedText,
        enrichment,
      ),
    );
  }

  const tree = built.get(root);
  if (tree === undefined) {
    throw new Error("The selected root could not be collected.");
  }
  let componentMetadataComplete = true;
  const metadataWork: NodeIR[] = [tree];
  while (metadataWork.length > 0) {
    const current = metadataWork.pop();
    if (current === undefined) {
      continue;
    }
    if (
      (current.family === "component" &&
        current.componentData.metadataCoverage.status !== "collected") ||
      (current.family === "instance" &&
        current.instanceData.metadataCoverage.status !== "collected")
    ) {
      componentMetadataComplete = false;
    }
    if ("children" in current) {
      for (const child of current.children) {
        metadataWork.push(child);
      }
    }
  }
  const dependencyRefsComplete =
    diagnostics
      .listSince(collectionDiagnosticStart)
      .every((diagnostic) => !diagnostic.causedDataLoss) &&
    componentMetadataComplete;
  return {
    tree,
    nodesById,
    dependencyRefs: deduplicateReferences([
      ...dependencyRefsFromNode(tree),
      ...supplementalDependencies,
    ]),
    reactions,
    nodeCount: visited,
    coverage: {
      childrenComplete,
      dependencyRefsComplete,
      textSegmentsComplete,
      interactionsComplete,
    },
  };
}
