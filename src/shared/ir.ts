export const ARCHIVE_FORMAT_VERSION = "1.0.0" as const;
export const DESIGN_IR_SCHEMA_VERSION = "1.0.0" as const;

export type SourceKind =
  | "document"
  | "page"
  | "node"
  | "variable"
  | "collection"
  | "style"
  | "component"
  | "asset";

export interface SourceRef {
  readonly kind: SourceKind;
  readonly id: string;
  readonly key?: string;
  readonly name?: string;
  readonly remote?: boolean;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type MixedValue = JsonObject & {
  readonly $type: "figma-mixed";
};

export type UnavailableValue = JsonObject & {
  readonly $type: "unavailable";
  readonly reason:
    | "inaccessible"
    | "missing-mode"
    | "not-loaded"
    | "not-supported"
    | "property-access-failed";
};

export type UnsupportedValue = JsonObject & {
  readonly $type: "unsupported";
  readonly runtimeType: string;
  readonly reason:
    | "bigint"
    | "cyclic-reference"
    | "function"
    | "non-plain-object"
    | "array-extra-property"
    | "symbol-keyed-property"
    | "symbol"
    | "undefined"
    | "unknown";
};

export type VariableAliasValue = JsonObject & {
  readonly $type: "variable-alias";
  readonly variableId: string;
};

export type TaggedIrValue =
  MixedValue | UnavailableValue | UnsupportedValue | VariableAliasValue;

export const FIGMA_MIXED_VALUE: MixedValue = Object.freeze({
  $type: "figma-mixed",
});

export function variableAlias(variableId: string): VariableAliasValue {
  return {
    $type: "variable-alias",
    variableId,
  };
}

export function isVariableAliasValue(
  value: JsonValue,
): value is VariableAliasValue {
  const objectValue = value as JsonObject;
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    objectValue.$type === "variable-alias" &&
    typeof objectValue.variableId === "string"
  );
}

export interface ArtifactRef {
  readonly path: string;
  readonly mediaType: string;
}

export interface Vector2IR {
  readonly x: number | null;
  readonly y: number | null;
}

export interface RectIR extends Vector2IR {
  readonly width: number | null;
  readonly height: number | null;
}

export type TransformIR = readonly [
  readonly [number | null, number | null, number | null],
  readonly [number | null, number | null, number | null],
];

export interface ColorIR {
  readonly r: number | null;
  readonly g: number | null;
  readonly b: number | null;
  readonly a: number | null;
}

export interface VariableBindingIR {
  readonly propertyPath: string;
  readonly variable: SourceRef;
}

export interface ExplicitVariableModeIR {
  readonly collectionId: string;
  readonly modeId: string;
}

export interface ComponentPropertyReferencesIR {
  readonly visible?: string;
  readonly characters?: string;
  readonly mainComponent?: string;
}

export type SlotLimitViolationIR =
  "BELOW_MIN" | "ABOVE_MAX" | "HAS_NON_PREFERRED";

export interface NodeGeometryIR {
  readonly localBounds?: RectIR;
  readonly absoluteBounds?: RectIR | null;
  readonly absoluteRenderBounds?: RectIR | null;
  readonly relativeTransform?: TransformIR;
  readonly absoluteTransform?: TransformIR;
  readonly rotation?: number | null;
  readonly constraints?: {
    readonly horizontal: string;
    readonly vertical: string;
  };
  readonly minWidth?: number | null;
  readonly maxWidth?: number | null;
  readonly minHeight?: number | null;
  readonly maxHeight?: number | null;
}

export interface LayoutGridIR {
  readonly pattern: string;
  readonly alignment?: string;
  readonly sectionSize?: number | null;
  readonly gutterSize?: number | null;
  readonly offset?: number | null;
  readonly count?: number | null;
  readonly color?: ColorIR;
  readonly visible?: boolean;
  readonly boundVariables?: readonly VariableBindingIR[];
  readonly raw?: JsonObject;
}

export interface NodeLayoutIR {
  readonly mode?: string;
  readonly wrap?: string;
  readonly sizingHorizontal?: string;
  readonly sizingVertical?: string;
  readonly primaryAxisSizingMode?: string;
  readonly counterAxisSizingMode?: string;
  readonly primaryAxisAlignItems?: string;
  readonly counterAxisAlignItems?: string;
  readonly counterAxisAlignContent?: string;
  readonly itemSpacing?: number | null;
  readonly counterAxisSpacing?: number | null;
  readonly paddingTop?: number | null;
  readonly paddingRight?: number | null;
  readonly paddingBottom?: number | null;
  readonly paddingLeft?: number | null;
  readonly layoutPositioning?: string;
  readonly layoutGrow?: number | null;
  readonly layoutAlign?: string;
  readonly overflowDirection?: string;
  readonly itemReverseZIndex?: boolean;
  readonly strokesIncludedInLayout?: boolean;
  readonly inferredAutoLayout?: JsonObject | null;
  readonly grids?: readonly LayoutGridIR[] | MixedValue;
  readonly gridRowCount?: number | null;
  readonly gridColumnCount?: number | null;
  readonly gridRowGap?: number | null;
  readonly gridColumnGap?: number | null;
  readonly gridRowSizes?: readonly JsonObject[];
  readonly gridColumnSizes?: readonly JsonObject[];
  readonly gridAutoTracks?: string;
  readonly gridItemsPositioning?: string;
  readonly gridRowAnchorIndex?: number | null;
  readonly gridColumnAnchorIndex?: number | null;
  readonly gridRowSpan?: number | null;
  readonly gridColumnSpan?: number | null;
  readonly gridChildHorizontalAlign?: string;
  readonly gridChildVerticalAlign?: string;
}

export interface GradientStopIR {
  readonly position: number | null;
  readonly color: ColorIR;
  readonly boundVariables?: readonly VariableBindingIR[];
}

export interface PaintIR {
  readonly paintType: string;
  readonly visible?: boolean;
  readonly opacity?: number | null;
  readonly blendMode?: string;
  readonly color?: ColorIR;
  readonly gradientStops?: readonly GradientStopIR[];
  readonly gradientTransform?: TransformIR;
  readonly imageHash?: string | null;
  readonly scaleMode?: string;
  readonly imageTransform?: TransformIR;
  readonly scalingFactor?: number | null;
  readonly rotation?: number | null;
  readonly filters?: JsonObject;
  readonly boundVariables?: readonly VariableBindingIR[];
  readonly raw?: JsonObject;
}

export interface EffectIR {
  readonly effectType: string;
  readonly visible: boolean;
  readonly radius?: number | null;
  readonly spread?: number | null;
  readonly color?: ColorIR;
  readonly offset?: Vector2IR;
  readonly blendMode?: string;
  readonly boundVariables?: readonly VariableBindingIR[];
  readonly raw?: JsonObject;
}

export interface StrokeGeometryIR {
  readonly weight?: number | null | MixedValue;
  readonly topWeight?: number | null;
  readonly rightWeight?: number | null;
  readonly bottomWeight?: number | null;
  readonly leftWeight?: number | null;
  readonly align?: string;
  readonly cap?: JsonValue;
  readonly join?: string | MixedValue;
  readonly miterLimit?: number | null;
  readonly dashPattern?: readonly (number | null)[];
}

export interface NodeVisualIR {
  readonly opacity?: number | null;
  readonly blendMode?: string;
  readonly isMask?: boolean;
  readonly maskType?: string;
  readonly clipsContent?: boolean;
  readonly fills?: readonly PaintIR[] | MixedValue;
  readonly strokes?: readonly PaintIR[] | MixedValue;
  readonly strokeGeometry?: StrokeGeometryIR;
  readonly effects?: readonly EffectIR[] | MixedValue;
  readonly backgrounds?: readonly PaintIR[] | MixedValue;
  readonly cornerRadius?: number | null | MixedValue;
  readonly cornerRadii?: readonly (number | null)[];
  readonly cornerSmoothing?: number | null;
  readonly fillStyle?: SourceRef | null | MixedValue;
  readonly strokeStyle?: SourceRef | null | MixedValue;
  readonly effectStyle?: SourceRef | null | MixedValue;
  readonly gridStyle?: SourceRef | null | MixedValue;
  readonly backgroundStyle?: SourceRef | null | MixedValue;
}

export interface ExportSettingIR {
  readonly format: string;
  readonly suffix?: string;
  readonly constraint?: JsonObject;
  readonly contentsOnly?: boolean;
  readonly useAbsoluteBounds?: boolean;
  readonly colorProfile?: string;
  readonly svgOutlineText?: boolean;
  readonly svgIdAttribute?: boolean;
  readonly svgSimplifyStroke?: boolean;
}

export interface SvgStringExportSettingIR {
  readonly format: "SVG_STRING";
  readonly suffix?: string;
  readonly contentsOnly?: boolean;
  readonly useAbsoluteBounds?: boolean;
  readonly colorProfile?: "DOCUMENT" | "SRGB" | "DISPLAY_P3_V4";
  readonly svgOutlineText?: boolean;
  readonly svgIdAttribute?: boolean;
  readonly svgSimplifyStroke?: boolean;
}

export interface AnnotationPropertyIR {
  readonly type: string;
}

export interface AnnotationIR {
  readonly label?: string;
  readonly labelMarkdown?: string;
  readonly categoryId?: string;
  readonly properties?: readonly AnnotationPropertyIR[];
  readonly raw?: JsonObject;
}

export interface AccessibilityIR {
  readonly role?: string;
  readonly label?: string;
  readonly description?: string;
  readonly properties?: JsonObject;
}

export interface NodeCommonIR {
  readonly source: SourceRef & { readonly kind: "node" };
  readonly nodeType: string;
  readonly name?: string;
  readonly page?: SourceRef & { readonly kind: "page" };
  readonly parent?: SourceRef;
  readonly childOrder?: number;
  readonly visible?: boolean;
  readonly locked?: boolean;
  readonly geometry?: NodeGeometryIR;
  readonly layout?: NodeLayoutIR;
  readonly visual?: NodeVisualIR;
  readonly variableBindings?: readonly VariableBindingIR[];
  readonly explicitVariableModes?: readonly ExplicitVariableModeIR[];
  readonly resolvedVariableModes?: readonly ExplicitVariableModeIR[];
  readonly componentPropertyReferences?: ComponentPropertyReferencesIR | null;
  readonly slotLimitViolations?: readonly SlotLimitViolationIR[];
  readonly exportSettings?: readonly ExportSettingIR[];
  readonly familyProperties?: JsonObject;
  readonly annotations?: readonly AnnotationIR[];
  readonly accessibility?: AccessibilityIR;
  readonly reactionIds?: readonly string[];
  readonly assetRefs: readonly AssetRefIR[];
  readonly rawArtifact?: ArtifactRef;
  readonly diagnosticIds: readonly string[];
}

export interface ContainerNodeIR extends NodeCommonIR {
  readonly family: "container";
  readonly children: readonly NodeIR[];
}

export interface TextStyleRunIR {
  readonly start: number;
  readonly end: number;
  readonly characters: string;
  readonly fontName?: JsonValue;
  readonly fontSize?: JsonValue;
  readonly fontWeight?: JsonValue;
  readonly fontStyle?: string;
  readonly textCase?: JsonValue;
  readonly textDecoration?: JsonValue;
  readonly textDecorationStyle?: JsonValue;
  readonly textDecorationOffset?: JsonValue;
  readonly textDecorationThickness?: JsonValue;
  readonly textDecorationColor?: JsonValue;
  readonly textDecorationSkipInk?: boolean | null;
  readonly letterSpacing?: JsonValue;
  readonly lineHeight?: JsonValue;
  readonly fills?: readonly PaintIR[] | MixedValue;
  readonly textStyle?: SourceRef | null | MixedValue;
  readonly fillStyle?: SourceRef | null | MixedValue;
  readonly hyperlink?: JsonValue;
  readonly listOptions?: JsonObject;
  readonly listSpacing?: number | null;
  readonly indentation?: number | null;
  readonly paragraphIndent?: number | null;
  readonly paragraphSpacing?: number | null;
  readonly openTypeFeatures?: JsonObject;
  readonly variableBindings?: readonly VariableBindingIR[];
  readonly textStyleOverrides?: readonly TextStyleOverrideIR[];
  readonly raw?: JsonObject;
}

export interface TextStyleOverrideIR {
  readonly type: string;
}

export interface TextDataIR {
  readonly characters: string | UnavailableValue;
  readonly segments: readonly TextStyleRunIR[];
  readonly fontName?: JsonValue;
  readonly fontSize?: JsonValue;
  readonly fontWeight?: JsonValue;
  readonly textCase?: JsonValue;
  readonly textDecoration?: JsonValue;
  readonly letterSpacing?: JsonValue;
  readonly lineHeight?: JsonValue;
  readonly leadingTrim?: JsonValue;
  readonly textStyle?: SourceRef | null | MixedValue;
  readonly hyperlink?: JsonValue;
  readonly listOptions?: JsonObject;
  readonly openTypeFeatures?: JsonObject | MixedValue;
  readonly alignHorizontal?: string;
  readonly alignVertical?: string;
  readonly autoRename?: boolean;
  readonly textAutoResize?: string;
  readonly textTruncation?: string;
  readonly maxLines?: number | null;
  readonly paragraphIndent?: number | null | MixedValue;
  readonly paragraphSpacing?: number | null | MixedValue;
  readonly listSpacing?: number | null | MixedValue;
  readonly hangingPunctuation?: boolean;
  readonly hangingList?: boolean;
  readonly missingFont?: boolean;
}

export type CollectionCoverageIR =
  | {
      readonly status: "collected";
    }
  | {
      readonly status: "partial" | "not-collected";
      readonly reason: string;
    };

export interface NodeArtifactCoverageIR {
  readonly dependencies: CollectionCoverageIR;
  readonly reactions: CollectionCoverageIR;
  readonly assets: CollectionCoverageIR;
  readonly textSegments: CollectionCoverageIR;
  readonly annotationsAndAccessibility: CollectionCoverageIR;
}

export interface TextNodeIR extends NodeCommonIR {
  readonly family: "text";
  readonly text: TextDataIR;
}

export interface VectorDataIR {
  readonly fillGeometry?: readonly JsonValue[];
  readonly vectorNetwork?: JsonObject;
  readonly vectorPaths?: readonly JsonValue[];
  readonly handleMirroring?: string | MixedValue;
  readonly windingRule?: string;
}

export interface VectorNodeIR extends NodeCommonIR {
  readonly family: "vector";
  readonly vector: VectorDataIR;
  readonly children: readonly NodeIR[];
}

export interface ComponentNodeDataIR {
  readonly metadataCoverage: CollectionCoverageIR;
  readonly component: SourceRef & { readonly kind: "component" };
  readonly componentSet?: SourceRef & { readonly kind: "component" };
  readonly variantProperties?: readonly {
    readonly property: string;
    readonly value: string;
  }[];
  readonly propertyDefinitionIds?: readonly string[];
}

export interface ComponentNodeIR extends NodeCommonIR {
  readonly family: "component";
  readonly componentData: ComponentNodeDataIR;
  readonly children: readonly NodeIR[];
}

export interface InstanceOverrideIR {
  readonly id: string;
  readonly overriddenFields: readonly string[];
}

export interface InstanceNodeDataIR {
  readonly metadataCoverage: CollectionCoverageIR;
  readonly mainComponent?: SourceRef & { readonly kind: "component" };
  readonly componentProperties?: readonly ComponentPropertyValueIR[];
  readonly overrides?: readonly InstanceOverrideIR[];
  readonly swapTargets?: readonly (SourceRef & {
    readonly kind: "component";
  })[];
  readonly exposedInstanceIds?: readonly string[];
  readonly scaleFactor?: number | null;
}

export interface InstanceNodeIR extends NodeCommonIR {
  readonly family: "instance";
  readonly instanceData: InstanceNodeDataIR;
  readonly children: readonly NodeIR[];
}

export interface LeafNodeIR extends NodeCommonIR {
  readonly family: "leaf";
  readonly properties: JsonObject;
}

export interface UnknownNodeIR extends NodeCommonIR {
  readonly family: "unknown";
  readonly unsupportedNodeType: string;
  readonly raw: JsonObject | UnsupportedValue;
  readonly children: readonly NodeIR[];
}

export type NodeIR =
  | ContainerNodeIR
  | TextNodeIR
  | VectorNodeIR
  | ComponentNodeIR
  | InstanceNodeIR
  | LeafNodeIR
  | UnknownNodeIR;

export interface DesignIrDocument {
  readonly kind: "design-ir-document";
  readonly schemaVersion: typeof DESIGN_IR_SCHEMA_VERSION;
  readonly source: SourceRef & { readonly kind: "document" };
  readonly name: string;
  readonly pages: readonly (SourceRef & { readonly kind: "page" })[];
  readonly currentPageId: string;
  readonly selectedRootIds: readonly string[];
  readonly counts: {
    readonly localVariables: CollectionCountIR;
    readonly localStyles: CollectionCountIR;
    readonly localComponents: CollectionCountIR;
  };
  readonly artifacts: {
    readonly variables?: ArtifactRef;
    readonly styles?: ArtifactRef;
    readonly components?: ArtifactRef;
    readonly nodeArtifacts: readonly ArtifactRef[];
  };
  readonly capabilities: readonly string[];
  readonly limitations: readonly string[];
  readonly diagnosticIds: readonly string[];
}

export type CollectionCountIR =
  | {
      readonly status: "collected";
      readonly value: number;
      readonly coverage?: "file-local" | "selected-reachable";
    }
  | {
      readonly status: "not-collected";
      readonly reason: string;
    }
  | {
      readonly status: "partial";
      readonly value: number;
      readonly reason: string;
      readonly coverage?: "file-local" | "selected-reachable";
    };

export interface DesignIrPageIndex {
  readonly kind: "design-ir-page-index";
  readonly schemaVersion: typeof DESIGN_IR_SCHEMA_VERSION;
  readonly source: SourceRef & { readonly kind: "page" };
  readonly childNodeIds: readonly string[];
  readonly dependencyRefs: readonly SourceRef[];
  readonly normalizedTrees: readonly NodeIR[];
  readonly reactions: readonly ReactionIR[];
  readonly assets: readonly AssetRefIR[];
  readonly previews: readonly PreviewRefIR[];
  readonly coverage: NodeArtifactCoverageIR;
  readonly rawArtifact?: ArtifactRef;
  readonly diagnosticIds: readonly string[];
}

export interface DesignIrRootIndex {
  readonly kind: "design-ir-root-index";
  readonly schemaVersion: typeof DESIGN_IR_SCHEMA_VERSION;
  readonly source: SourceRef & { readonly kind: "node" };
  readonly dependencyRefs: readonly SourceRef[];
  readonly normalizedTree: NodeIR;
  readonly reactions: readonly ReactionIR[];
  readonly assets: readonly AssetRefIR[];
  readonly previews: readonly PreviewRefIR[];
  readonly coverage: NodeArtifactCoverageIR;
  readonly rawArtifact?: ArtifactRef;
  readonly diagnosticIds: readonly string[];
}

export interface VariableModeIR {
  readonly id: string;
  readonly name: string;
  readonly parentModeId?: string;
}

export interface VariableCollectionIR {
  readonly source: SourceRef & { readonly kind: "collection" };
  readonly defaultModeId: string;
  readonly modes: readonly VariableModeIR[];
  readonly variableIds: readonly string[];
  readonly hiddenFromPublishing?: boolean;
  readonly publishStatus?: string;
  readonly isExtension?: boolean;
  readonly parentVariableCollectionId?: string;
  readonly rootVariableCollectionId?: string;
  readonly variableOverrides?: JsonObject;
}

export type VariableResolutionStatus =
  | "resolved"
  | "requires-consumer-context"
  | "missing-reference"
  | "missing-mode"
  | "cycle";

export interface VariableModeValueIR {
  readonly modeId: string;
  readonly raw: JsonValue;
  readonly status: VariableResolutionStatus;
  readonly resolved?: JsonValue;
  readonly aliasChain: readonly string[];
  readonly resolutionContext: readonly ExplicitVariableModeIR[];
}

export interface VariableIR {
  readonly source: SourceRef & { readonly kind: "variable" };
  readonly collectionId: string;
  readonly resolvedType: string;
  readonly description?: string;
  readonly scopes: readonly string[];
  readonly codeSyntax: JsonObject;
  readonly hiddenFromPublishing?: boolean;
  readonly publishStatus?: string;
  readonly values: readonly VariableModeValueIR[];
  readonly extendedCollectionValues?: readonly VariableExtendedCollectionValuesIR[];
  readonly diagnosticIds: readonly string[];
}

export interface VariableExtendedCollectionValuesIR {
  readonly collectionId: string;
  readonly values: readonly VariableModeValueIR[];
}

export interface VariablesIndexIR {
  readonly kind: "design-ir-variables";
  readonly schemaVersion: typeof DESIGN_IR_SCHEMA_VERSION;
  readonly collections: readonly VariableCollectionIR[];
  readonly variables: readonly VariableIR[];
  readonly diagnosticIds: readonly string[];
}

export interface StyleCommonIR {
  readonly source: SourceRef & { readonly kind: "style" };
  readonly description?: string;
  readonly properties?: JsonObject;
  readonly variableBindings: readonly VariableBindingIR[];
  readonly referencedBy: readonly SourceRef[];
  readonly diagnosticIds: readonly string[];
}

export interface PaintStyleIR extends StyleCommonIR {
  readonly styleType: "paint";
  readonly paints: readonly PaintIR[];
  readonly assetRefs: readonly RasterAssetRefIR[];
}

export interface TextStyleIR extends StyleCommonIR {
  readonly styleType: "text";
  readonly properties: JsonObject;
}

export interface EffectStyleIR extends StyleCommonIR {
  readonly styleType: "effect";
  readonly effects: readonly EffectIR[];
}

export interface GridStyleIR extends StyleCommonIR {
  readonly styleType: "grid";
  readonly grids: readonly LayoutGridIR[];
}

export interface UnknownStyleIR extends StyleCommonIR {
  readonly styleType: "unknown";
  readonly raw: JsonObject | UnsupportedValue;
}

export type StyleIR =
  PaintStyleIR | TextStyleIR | EffectStyleIR | GridStyleIR | UnknownStyleIR;

export interface StylesIndexIR {
  readonly kind: "design-ir-styles";
  readonly schemaVersion: typeof DESIGN_IR_SCHEMA_VERSION;
  readonly styles: readonly StyleIR[];
  readonly diagnosticIds: readonly string[];
}

export interface ComponentPropertyDefinitionIR {
  readonly id: string;
  readonly name: string;
  readonly propertyType: string;
  readonly defaultValue: JsonValue;
  readonly preferredValues: readonly ComponentPreferredValueIR[];
  readonly variantOptions?: readonly string[];
  readonly description?: string;
  readonly slotSettings?: ComponentSlotSettingsIR;
  readonly variableBindings: readonly VariableBindingIR[];
}

export interface ComponentPropertyValueIR {
  readonly id: string;
  readonly name: string;
  readonly propertyType: string;
  readonly value: JsonValue;
  readonly preferredValues?: readonly ComponentPreferredValueIR[];
  readonly variableBindings: readonly VariableBindingIR[];
}

export interface ComponentPreferredValueIR {
  readonly type: "COMPONENT" | "COMPONENT_SET";
  readonly key: string;
}

export interface ComponentSlotSettingsIR {
  readonly stretchChildOnInsert?: boolean;
  readonly displayEmptyByDefault?: boolean;
  readonly minChildren?: number | null;
  readonly maxChildren?: number | null;
  readonly allowPreferredValuesOnly?: boolean;
}

export interface ComponentDefinitionIR {
  readonly componentKind: "component" | "component-set";
  readonly source: SourceRef & { readonly kind: "component" };
  readonly nodeId?: string;
  readonly componentSetId?: string;
  readonly defaultVariantId?: string;
  readonly variantAxes?: readonly {
    readonly name: string;
    readonly values: readonly string[];
  }[];
  readonly variantProperties?: readonly {
    readonly property: string;
    readonly value: string;
  }[];
  readonly propertyDefinitions?: readonly ComponentPropertyDefinitionIR[];
  readonly exposedInstanceIds?: readonly string[];
  readonly documentationLinks?: readonly string[];
  readonly description?: string;
  readonly descriptionMarkdown?: string;
  readonly definitionArtifact?: ArtifactRef;
  readonly diagnosticIds: readonly string[];
}

export interface DesignIrComponentDefinitionArtifact {
  readonly kind: "design-ir-component-definition";
  readonly schemaVersion: typeof DESIGN_IR_SCHEMA_VERSION;
  readonly source: SourceRef & { readonly kind: "component" };
  readonly dependencyRefs: readonly SourceRef[];
  readonly normalizedTree: NodeIR;
  readonly reactions: readonly ReactionIR[];
  readonly assets: readonly AssetRefIR[];
  readonly coverage: NodeArtifactCoverageIR;
  readonly rawArtifact?: ArtifactRef;
  readonly diagnosticIds: readonly string[];
}

export interface ComponentDependencyIR {
  readonly from: SourceRef & { readonly kind: "component" };
  readonly to: SourceRef & { readonly kind: "component" };
  readonly relationship: "contains" | "instance" | "preferred-value" | "swap";
}

export interface ComponentsIndexIR {
  readonly kind: "design-ir-components";
  readonly schemaVersion: typeof DESIGN_IR_SCHEMA_VERSION;
  readonly definitions: readonly ComponentDefinitionIR[];
  readonly dependencies: readonly ComponentDependencyIR[];
  readonly diagnosticIds: readonly string[];
}

export interface InteractionTriggerIR {
  readonly triggerType: string;
  readonly delaySeconds?: number | null;
  readonly device?: string;
  readonly keyCodes?: readonly number[];
  readonly mediaHitTime?: number | null;
  readonly raw?: JsonObject;
}

export interface TransitionIR {
  readonly transitionType: string;
  readonly easing?: JsonValue;
  readonly durationSeconds?: number | null;
  readonly direction?: string;
  readonly matchLayers?: boolean;
}

export interface NavigateActionIR {
  readonly actionType: "navigate";
  readonly destination?: SourceRef & { readonly kind: "node" };
  readonly navigation: string;
  readonly transition?: TransitionIR;
  readonly preserveScrollPosition?: boolean;
  readonly resetScrollPosition?: boolean;
  readonly resetVideoPosition?: boolean;
  readonly resetInteractiveComponents?: boolean;
  readonly raw?: JsonObject;
}

export interface OverlayActionIR {
  readonly actionType: "open-overlay" | "swap-overlay";
  readonly destination?: SourceRef & { readonly kind: "node" };
  readonly position?: string;
  readonly relativePosition?: Vector2IR;
  readonly background?: JsonObject;
  readonly transition?: TransitionIR;
  readonly raw?: JsonObject;
}

export interface SimpleActionIR {
  readonly actionType: "back" | "close-overlay" | "scroll-to";
  readonly destination?: SourceRef & { readonly kind: "node" };
  readonly transition?: TransitionIR;
  readonly raw?: JsonObject;
}

export interface VariableActionIR {
  readonly actionType: "set-variable" | "set-variable-mode" | "conditional";
  readonly variable?: SourceRef & { readonly kind: "variable" };
  readonly value?: JsonValue;
  readonly collection?: SourceRef & { readonly kind: "collection" };
  readonly modeId?: string;
  readonly condition?: JsonValue;
  readonly actions?: readonly InteractionActionIR[];
  readonly conditionalBlocks?: readonly ConditionalBlockIR[];
  readonly raw?: JsonObject;
}

export interface ConditionalBlockIR {
  readonly condition?: JsonValue;
  readonly actions: readonly InteractionActionIR[];
  readonly raw?: JsonObject;
}

export interface UnknownActionIR {
  readonly actionType: "unknown";
  readonly raw: JsonObject | UnsupportedValue;
  readonly diagnosticIds: readonly string[];
}

export interface UrlActionIR {
  readonly actionType: "url";
  readonly url: string;
  readonly openInNewTab?: boolean;
  readonly raw?: JsonObject;
}

export interface MediaActionIR {
  readonly actionType: "update-media-runtime";
  readonly destination?: SourceRef & { readonly kind: "node" };
  readonly mediaAction: string;
  readonly amountToSkip?: number | null;
  readonly newTimestamp?: number | null;
  readonly raw?: JsonObject;
}

export type InteractionActionIR =
  | NavigateActionIR
  | OverlayActionIR
  | SimpleActionIR
  | VariableActionIR
  | UrlActionIR
  | MediaActionIR
  | UnknownActionIR;

export interface ReactionIR {
  readonly id: string;
  readonly sourceNode: SourceRef & { readonly kind: "node" };
  readonly order: number;
  readonly trigger: InteractionTriggerIR | null;
  readonly actions: readonly InteractionActionIR[];
  readonly diagnosticIds: readonly string[];
}

export interface RasterAssetRefIR {
  readonly assetKind: "raster";
  readonly source: SourceRef & { readonly kind: "asset" };
  readonly imageHash: string;
  readonly contentSha256: string;
  readonly mediaType:
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp"
    | "application/octet-stream";
  readonly byteLength: number;
  readonly archivePath: string;
}

export interface VectorAssetRefIR {
  readonly assetKind: "vector";
  readonly source: SourceRef & { readonly kind: "asset" };
  readonly node: SourceRef & { readonly kind: "node" };
  readonly archivePath: string;
  readonly mediaType: "image/svg+xml";
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly eligibility: "explicit-svg-setting" | "top-level-vector-root";
  readonly exportSettings: SvgStringExportSettingIR;
}

export type AssetRefIR = RasterAssetRefIR | VectorAssetRefIR;

export interface PreviewRefIR {
  readonly sourceNode: SourceRef & { readonly kind: "node" };
  readonly archivePath: string;
  readonly mediaType: "image/png";
  readonly sourceBounds: RectIR;
  readonly exportedBounds: RectIR;
  readonly scale: number | null;
  readonly byteLength: number;
  readonly contentSha256: string;
  readonly diagnosticIds: readonly string[];
}
