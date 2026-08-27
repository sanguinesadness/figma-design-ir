// Every name, value, ID, and relationship in this fixture was invented for this
// repository. It is not derived from a real Figma file or private design data.

import { resolveVariableAliases } from "../../src/shared/aliases";
import { archivePaths, requireSnapshotId } from "../../src/shared/archive";
import {
  DIAGNOSTIC_CODES,
  DiagnosticBag,
  type Diagnostic,
} from "../../src/shared/diagnostics";
import {
  ARCHIVE_FORMAT_VERSION,
  DESIGN_IR_SCHEMA_VERSION,
  FIGMA_MIXED_VALUE,
  variableAlias,
  type AssetRefIR,
  type ComponentNodeIR,
  type ComponentsIndexIR,
  type ContainerNodeIR,
  type DesignIrDocument,
  type DesignIrPageIndex,
  type DesignIrRootIndex,
  type InstanceNodeIR,
  type JsonObject,
  type LeafNodeIR,
  type NodeCommonIR,
  type NodeIR,
  type PreviewRefIR,
  type ReactionIR,
  type SourceRef,
  type StylesIndexIR,
  type TextNodeIR,
  type UnknownNodeIR,
  type UnsupportedValue,
  type VariablesIndexIR,
  type VectorNodeIR,
} from "../../src/shared/ir";
import {
  sortUnorderedComponentDefinitions,
  sortUnorderedComponentDependencies,
} from "../../src/shared/serialization";

export const SYNTHETIC_UNICODE_TEXT = "Пример 中文 e\u0301 🚀 “quoted” —";

const SNAPSHOT_ID = requireSnapshotId("synthetic-design-ir");
const RASTER_SHA256 = "a".repeat(64);
const VECTOR_SHA256 = "b".repeat(64);
const PREVIEW_SHA256 = "c".repeat(64);

const documentRef = {
  kind: "document",
  id: "document:aurora-sandbox",
  name: "Aurora Sandbox",
} as const satisfies SourceRef;

const pageSpecimensRef = {
  kind: "page",
  id: "page:z-specimens",
  name: "Specimens",
} as const satisfies SourceRef;

const pageJourneyRef = {
  kind: "page",
  id: "page:a-journey",
  name: "Journey",
} as const satisfies SourceRef;

const rasterAsset: AssetRefIR = {
  assetKind: "raster",
  source: {
    kind: "asset",
    id: "image:invented-paper-grain",
    name: "Invented paper grain",
  },
  imageHash: "image:invented-paper-grain",
  contentSha256: RASTER_SHA256,
  mediaType: "image/png",
  byteLength: 67,
  archivePath: archivePaths.rasterAsset(SNAPSHOT_ID, RASTER_SHA256, "png"),
};

const vectorAsset: AssetRefIR = {
  assetKind: "vector",
  source: {
    kind: "asset",
    id: "asset:orbit-mark",
    name: "Orbit mark",
  },
  node: {
    kind: "node",
    id: "node:orbit-mark",
    name: "Orbit mark",
  },
  archivePath: archivePaths.vectorAsset(SNAPSHOT_ID, "node:orbit-mark"),
  mediaType: "image/svg+xml",
  byteLength: 143,
  contentSha256: VECTOR_SHA256,
  eligibility: "explicit-svg-setting",
  exportSettings: {
    format: "SVG_STRING",
    suffix: "-orbit",
    contentsOnly: true,
  },
};

function commonNode(
  id: string,
  name: string,
  nodeType: string,
  page: SourceRef & { readonly kind: "page" },
  childOrder: number,
  assetRefs: readonly AssetRefIR[] = [],
): NodeCommonIR {
  return {
    source: {
      kind: "node",
      id,
      name,
    },
    nodeType,
    name,
    page,
    childOrder,
    visible: true,
    locked: false,
    variableBindings: [],
    explicitVariableModes: [
      {
        collectionId: "collection:theme",
        modeId: "mode:night",
      },
    ],
    exportSettings: [],
    annotations: [],
    reactionIds: [],
    assetRefs,
    diagnosticIds: [],
  };
}

function buildTextNode(
  id = "node:multilingual-label",
  name = "Multilingual label",
): TextNodeIR {
  const firstRun = "Пример";
  const secondRun = SYNTHETIC_UNICODE_TEXT.slice(firstRun.length + 1);
  return {
    ...commonNode(id, name, "TEXT", pageSpecimensRef, 0),
    family: "text",
    visual: {
      opacity: 1,
      fills: FIGMA_MIXED_VALUE,
      cornerRadius: FIGMA_MIXED_VALUE,
    },
    text: {
      characters: SYNTHETIC_UNICODE_TEXT,
      segments: [
        {
          start: 0,
          end: firstRun.length,
          characters: firstRun,
          fontName: {
            family: "Synthetic Sans",
            style: "Regular",
          },
          fontSize: 16,
          textStyle: {
            kind: "style",
            id: "style:text-body",
            name: "Body invented",
          },
          openTypeFeatures: {
            liga: true,
          },
        },
        {
          start: firstRun.length + 1,
          end: SYNTHETIC_UNICODE_TEXT.length,
          characters: secondRun,
          fontName: {
            family: "Synthetic Sans",
            style: "Bold",
          },
          fontSize: 18,
          fills: [
            {
              paintType: "SOLID",
              color: { r: 0.96, g: 0.83, b: 0.37, a: 1 },
            },
          ],
          hyperlink: {
            type: "NODE",
            value: "node:journey-destination",
          },
          listOptions: {
            type: "UNORDERED",
          },
          paragraphSpacing: 8,
          variableBindings: [
            {
              propertyPath: "fills[0].color",
              variable: {
                kind: "variable",
                id: "variable:accent-chain",
                name: "Accent chain",
              },
            },
          ],
        },
      ],
      textAutoResize: "HEIGHT",
      textTruncation: "DISABLED",
      missingFont: false,
    },
  };
}

function buildVectorNode(): VectorNodeIR {
  return {
    ...commonNode(
      "node:orbit-mark",
      "Orbit mark",
      "BOOLEAN_OPERATION",
      pageSpecimensRef,
      1,
      [vectorAsset],
    ),
    family: "vector",
    vector: {
      windingRule: "NONZERO",
      vectorPaths: [
        {
          data: "M0 8 A8 8 0 1 0 16 8 A8 8 0 1 0 0 8 Z",
          windingRule: "NONZERO",
        },
      ],
    },
    children: [],
    exportSettings: [
      {
        format: "SVG",
        suffix: "-orbit",
        contentsOnly: true,
      },
    ],
  };
}

function buildComponentSetNode(): ComponentNodeIR {
  const variant: ComponentNodeIR = {
    ...commonNode(
      "node:signal-card-quiet",
      "State=Quiet",
      "COMPONENT",
      pageSpecimensRef,
      0,
    ),
    family: "component",
    parent: {
      kind: "node",
      id: "node:signal-card-set",
      name: "Signal card",
    },
    componentData: {
      metadataCoverage: { status: "collected" },
      component: {
        kind: "component",
        id: "component:signal-card-quiet",
        name: "Signal card / Quiet",
      },
      componentSet: {
        kind: "component",
        id: "component:signal-card-set",
        name: "Signal card",
      },
      variantProperties: [{ property: "State", value: "Quiet" }],
      propertyDefinitionIds: ["property:show-orbit"],
    },
    children: [buildTextNode("node:signal-card-label", "Signal card label")],
  };

  return {
    ...commonNode(
      "node:signal-card-set",
      "Signal card",
      "COMPONENT_SET",
      pageSpecimensRef,
      2,
    ),
    family: "component",
    componentData: {
      metadataCoverage: { status: "collected" },
      component: {
        kind: "component",
        id: "component:signal-card-set",
        name: "Signal card",
      },
      variantProperties: [],
      propertyDefinitionIds: ["property:show-orbit"],
    },
    children: [variant],
  };
}

function buildInstanceNode(): InstanceNodeIR {
  return {
    ...commonNode(
      "node:signal-card-instance",
      "Signal card instance",
      "INSTANCE",
      pageSpecimensRef,
      3,
      [rasterAsset],
    ),
    family: "instance",
    instanceData: {
      metadataCoverage: { status: "collected" },
      mainComponent: {
        kind: "component",
        id: "component:signal-card-quiet",
        name: "Signal card / Quiet",
      },
      componentProperties: [
        {
          id: "property:show-orbit",
          name: "Show orbit",
          propertyType: "BOOLEAN",
          value: true,
          variableBindings: [],
        },
      ],
      overrides: [
        {
          id: "node:signal-card-label",
          overriddenFields: ["characters"],
        },
      ],
      swapTargets: [],
      exposedInstanceIds: ["node:nested-beacon-instance"],
      scaleFactor: 1,
    },
    children: [],
    visual: {
      opacity: 1,
      fills: [
        {
          paintType: "IMAGE",
          imageHash: "image:invented-paper-grain",
          scaleMode: "FILL",
        },
      ],
      clipsContent: true,
    },
  };
}

const unsupportedNodePayload: UnsupportedValue = {
  $type: "unsupported",
  reason: "unknown",
  runtimeType: "synthetic-future-node",
};

function buildUnknownNode(diagnosticId: string): UnknownNodeIR {
  return {
    ...commonNode(
      "node:future-shape",
      "Future shape",
      "SYNTHETIC_FUTURE_NODE",
      pageSpecimensRef,
      4,
    ),
    family: "unknown",
    unsupportedNodeType: "SYNTHETIC_FUTURE_NODE",
    raw: unsupportedNodePayload,
    children: [],
    diagnosticIds: [diagnosticId],
  };
}

function buildSpecimensRoot(unknownNodeDiagnosticId: string): ContainerNodeIR {
  const children = [
    buildTextNode(),
    buildVectorNode(),
    buildComponentSetNode(),
    buildInstanceNode(),
    buildUnknownNode(unknownNodeDiagnosticId),
  ];
  return {
    ...commonNode(
      "node:specimens-root",
      "Specimen canvas",
      "FRAME",
      pageSpecimensRef,
      0,
      [rasterAsset],
    ),
    family: "container",
    children,
    geometry: {
      localBounds: { x: 0, y: 0, width: 1280, height: 920 },
      absoluteBounds: { x: 48, y: 64, width: 1280, height: 920 },
      relativeTransform: [
        [1, 0, 48],
        [0, 1, 64],
      ],
      rotation: -0,
      constraints: { horizontal: "MIN", vertical: "MIN" },
      minWidth: 320,
      maxWidth: 1440,
    },
    layout: {
      mode: "HORIZONTAL",
      wrap: "WRAP",
      primaryAxisSizingMode: "FIXED",
      counterAxisSizingMode: "AUTO",
      primaryAxisAlignItems: "MIN",
      counterAxisAlignItems: "CENTER",
      counterAxisAlignContent: "SPACE_BETWEEN",
      itemSpacing: 24,
      counterAxisSpacing: 16,
      paddingTop: 32,
      paddingRight: 40,
      paddingBottom: 32,
      paddingLeft: 40,
      overflowDirection: "VERTICAL_SCROLLING",
      grids: [
        {
          pattern: "COLUMNS",
          alignment: "STRETCH",
          gutterSize: 16,
          count: 12,
          color: { r: 0.2, g: 0.6, b: 0.9, a: 0.08 },
          visible: true,
        },
      ],
    },
    visual: {
      opacity: 0.97,
      blendMode: "PASS_THROUGH",
      clipsContent: true,
      fills: [
        {
          paintType: "SOLID",
          color: { r: 0.07, g: 0.09, b: 0.16, a: 1 },
          boundVariables: [
            {
              propertyPath: "color",
              variable: {
                kind: "variable",
                id: "variable:accent-chain",
                name: "Accent chain",
              },
            },
          ],
        },
      ],
      strokes: [
        {
          paintType: "SOLID",
          color: { r: 0.32, g: 0.38, b: 0.52, a: 1 },
        },
      ],
      strokeGeometry: {
        weight: 1,
        align: "INSIDE",
        dashPattern: [4, 2],
      },
      effects: [
        {
          effectType: "DROP_SHADOW",
          visible: true,
          radius: 18,
          spread: 0,
          color: { r: 0, g: 0, b: 0, a: 0.24 },
          offset: { x: 0, y: 8 },
          blendMode: "NORMAL",
        },
      ],
      cornerRadii: [24, 24, 16, 16],
      cornerSmoothing: 0.6,
    },
  };
}

function buildJourneyRoot(): ContainerNodeIR {
  const absoluteChild: LeafNodeIR = {
    ...commonNode(
      "node:absolute-chip",
      "Absolute chip",
      "RECTANGLE",
      pageJourneyRef,
      0,
    ),
    family: "leaf",
    layout: {
      layoutPositioning: "ABSOLUTE",
    },
    properties: {
      syntheticRole: "absolute-positioned-child",
    },
  };
  const hiddenChild: LeafNodeIR = {
    ...commonNode(
      "node:hidden-companion",
      "Hidden companion",
      "ELLIPSE",
      pageJourneyRef,
      1,
    ),
    family: "leaf",
    visible: false,
    properties: {
      syntheticRole: "hidden-node",
    },
  };
  const maskChild: VectorNodeIR = {
    ...commonNode("node:alpha-mask", "Alpha mask", "VECTOR", pageJourneyRef, 2),
    family: "vector",
    visual: {
      isMask: true,
      maskType: "ALPHA",
    },
    vector: {
      vectorPaths: [
        {
          data: "M0 0 H64 V64 H0 Z",
          windingRule: "NONZERO",
        },
      ],
    },
    children: [],
  };

  return {
    ...commonNode(
      "node:journey-destination",
      "Journey destination",
      "FRAME",
      pageJourneyRef,
      0,
    ),
    family: "container",
    children: [absoluteChild, hiddenChild, maskChild],
    geometry: {
      localBounds: { x: 0, y: 0, width: 4800, height: 900 },
      absoluteBounds: { x: 0, y: 0, width: 4800, height: 900 },
    },
    visual: {
      clipsContent: true,
    },
  };
}

function buildPageNote(): LeafNodeIR {
  return {
    ...commonNode("node:page-note", "Page note", "STAMP", pageSpecimensRef, 1),
    family: "leaf",
    properties: {
      syntheticNote: "Second direct page root preserves page child order.",
    },
  };
}

function buildAliasFixture(diagnostics: DiagnosticBag) {
  const source = (id: string, name: string) =>
    ({ kind: "variable", id, name }) as const;
  return resolveVariableAliases({
    collections: [
      {
        id: "collection:theme",
        modeOrder: ["mode:night", "mode:day"],
      },
    ],
    diagnostics,
    variables: [
      {
        source: source("variable:accent-base", "Accent base"),
        collectionId: "collection:theme",
        valuesByMode: {
          "mode:day": "#f4d35e",
          "mode:night": "#14213d",
        },
      },
      {
        source: source("variable:accent-alias", "Accent alias"),
        collectionId: "collection:theme",
        valuesByMode: {
          "mode:day": variableAlias("variable:accent-base"),
          "mode:night": variableAlias("variable:accent-base"),
        },
      },
      {
        source: source("variable:accent-chain", "Accent chain"),
        collectionId: "collection:theme",
        valuesByMode: {
          "mode:day": variableAlias("variable:accent-alias"),
          "mode:night": variableAlias("variable:accent-alias"),
        },
      },
      {
        source: source("variable:cycle-a", "Cycle A"),
        collectionId: "collection:theme",
        valuesByMode: {
          "mode:day": variableAlias("variable:cycle-b"),
          "mode:night": variableAlias("variable:cycle-b"),
        },
      },
      {
        source: source("variable:cycle-b", "Cycle B"),
        collectionId: "collection:theme",
        valuesByMode: {
          "mode:day": variableAlias("variable:cycle-a"),
          "mode:night": variableAlias("variable:cycle-a"),
        },
      },
      {
        source: source("variable:remote-gap", "Remote gap"),
        collectionId: "collection:theme",
        valuesByMode: {
          "mode:day": variableAlias("variable:unavailable-remote"),
          "mode:night": variableAlias("variable:unavailable-remote"),
        },
      },
    ],
  });
}

function buildVariables(diagnostics: DiagnosticBag): {
  readonly index: VariablesIndexIR;
  readonly diagnostics: readonly Diagnostic[];
} {
  const resolved = buildAliasFixture(diagnostics);
  const variables = resolved.variables.map((variable) => ({
    source: variable.source,
    collectionId: "collection:theme",
    resolvedType: "COLOR",
    description: "Invented two-mode color used only by the synthetic fixture.",
    scopes: ["ALL_FILLS"],
    codeSyntax: {
      WEB: `--${variable.source.id.replaceAll(":", "-")}`,
    },
    values: variable.values,
    diagnosticIds: resolved.diagnostics
      .filter((diagnostic) => diagnostic.source?.id === variable.source.id)
      .map((diagnostic) => diagnostic.id),
  }));

  return {
    index: {
      kind: "design-ir-variables",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      collections: [
        {
          source: {
            kind: "collection",
            id: "collection:theme",
            name: "Synthetic theme",
          },
          defaultModeId: "mode:night",
          modes: [
            { id: "mode:night", name: "Night" },
            { id: "mode:day", name: "Day" },
          ],
          variableIds: variables.map((variable) => variable.source.id),
          hiddenFromPublishing: true,
        },
      ],
      variables,
      diagnosticIds: resolved.diagnostics.map((diagnostic) => diagnostic.id),
    },
    diagnostics: resolved.diagnostics,
  };
}

function buildStyles(): StylesIndexIR {
  return {
    kind: "design-ir-styles",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    styles: [
      {
        styleType: "effect",
        source: {
          kind: "style",
          id: "style:effect-lift",
          key: "synthetic-effect-key",
          name: "Lift invented",
        },
        description: "Invented soft shadow.",
        variableBindings: [],
        referencedBy: [{ kind: "node", id: "node:specimens-root" }],
        diagnosticIds: [],
        effects: [
          {
            effectType: "DROP_SHADOW",
            visible: true,
            radius: 18,
            color: { r: 0, g: 0, b: 0, a: 0.24 },
            offset: { x: 0, y: 8 },
          },
        ],
      },
      {
        styleType: "grid",
        source: {
          kind: "style",
          id: "style:grid-twelve",
          name: "Twelve columns invented",
        },
        description: "Invented responsive grid.",
        variableBindings: [],
        referencedBy: [{ kind: "node", id: "node:specimens-root" }],
        diagnosticIds: [],
        grids: [
          {
            pattern: "COLUMNS",
            alignment: "STRETCH",
            count: 12,
            gutterSize: 16,
          },
        ],
      },
      {
        styleType: "paint",
        source: {
          kind: "style",
          id: "style:paint-accent",
          name: "Accent invented",
        },
        description: "Invented variable-bound paint.",
        variableBindings: [
          {
            propertyPath: "paints[0].color",
            variable: {
              kind: "variable",
              id: "variable:accent-chain",
            },
          },
        ],
        referencedBy: [{ kind: "node", id: "node:multilingual-label" }],
        diagnosticIds: [],
        assetRefs: [],
        paints: [
          {
            paintType: "SOLID",
            color: { r: 0.96, g: 0.83, b: 0.37, a: 1 },
          },
        ],
      },
      {
        styleType: "text",
        source: {
          kind: "style",
          id: "style:text-body",
          name: "Body invented",
        },
        description: "Invented multilingual body style.",
        variableBindings: [],
        referencedBy: [{ kind: "node", id: "node:multilingual-label" }],
        diagnosticIds: [],
        properties: {
          fontFamily: "Synthetic Sans",
          fontSize: 16,
          lineHeight: { unit: "PIXELS", value: 24 },
        },
      },
    ],
    diagnosticIds: [],
  };
}

function buildComponents(): ComponentsIndexIR {
  return {
    kind: "design-ir-components",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    definitions: sortUnorderedComponentDefinitions([
      {
        componentKind: "component-set",
        source: {
          kind: "component",
          id: "component:signal-card-set",
          key: "synthetic-component-set-key",
          name: "Signal card",
        },
        nodeId: "node:signal-card-set",
        defaultVariantId: "node:signal-card-quiet",
        variantAxes: [
          { name: "State", values: ["Quiet", "Bright"] },
          { name: "Size", values: ["Compact", "Wide"] },
        ],
        variantProperties: [],
        propertyDefinitions: [
          {
            id: "property:show-orbit",
            name: "Show orbit",
            propertyType: "BOOLEAN",
            defaultValue: true,
            preferredValues: [],
            variableBindings: [],
          },
        ],
        exposedInstanceIds: ["node:nested-beacon-instance"],
        documentationLinks: [],
        description: "Invented component set for deterministic contract tests.",
        diagnosticIds: [],
      },
      {
        componentKind: "component",
        source: {
          kind: "component",
          id: "component:signal-card-quiet",
          name: "Signal card / Quiet",
        },
        nodeId: "node:signal-card-quiet",
        componentSetId: "component:signal-card-set",
        variantAxes: [],
        variantProperties: [{ property: "State", value: "Quiet" }],
        propertyDefinitions: [],
        exposedInstanceIds: [],
        documentationLinks: [],
        description: "Invented quiet variant.",
        diagnosticIds: [],
      },
    ]),
    dependencies: sortUnorderedComponentDependencies([
      {
        from: { kind: "component", id: "component:signal-card-set" },
        to: { kind: "component", id: "component:signal-card-quiet" },
        relationship: "contains",
      },
      {
        from: { kind: "component", id: "component:signal-card-quiet" },
        to: { kind: "component", id: "component:beacon" },
        relationship: "instance",
      },
    ]),
    diagnosticIds: [],
  };
}

function buildInteractions(
  unknownActionDiagnosticId: string,
): readonly ReactionIR[] {
  return [
    {
      id: "reaction:open-journey",
      sourceNode: { kind: "node", id: "node:signal-card-instance" },
      order: 0,
      trigger: { triggerType: "ON_CLICK" },
      actions: [
        {
          actionType: "navigate",
          destination: {
            kind: "node",
            id: "node:journey-destination",
            name: "Journey destination",
          },
          navigation: "NAVIGATE",
          transition: {
            transitionType: "SMART_ANIMATE",
            easing: { type: "CUBIC_BEZIER", x1: 0.2, y1: 0, x2: 0, y2: 1 },
            durationSeconds: 0.32,
            matchLayers: true,
          },
          preserveScrollPosition: false,
        },
        {
          actionType: "set-variable",
          variable: {
            kind: "variable",
            id: "variable:accent-base",
            name: "Accent base",
          },
          value: "#f4d35e",
        },
      ],
      diagnosticIds: [],
    },
    {
      id: "reaction:set-accent",
      sourceNode: { kind: "node", id: "node:signal-card-instance" },
      order: 1,
      trigger: { triggerType: "MOUSE_ENTER" },
      actions: [
        {
          actionType: "set-variable",
          variable: {
            kind: "variable",
            id: "variable:accent-base",
            name: "Accent base",
          },
          value: "#f4d35e",
        },
      ],
      diagnosticIds: [],
    },
    {
      id: "reaction:future-action",
      sourceNode: { kind: "node", id: "node:future-shape" },
      order: 2,
      trigger: null,
      actions: [
        {
          actionType: "unknown",
          raw: {
            type: "SYNTHETIC_FUTURE_ACTION",
            payload: {
              invented: true,
            },
          },
          diagnosticIds: [unknownActionDiagnosticId],
        },
      ],
      diagnosticIds: [unknownActionDiagnosticId],
    },
  ];
}

function buildFixtureDiagnostics(diagnostics: DiagnosticBag): {
  readonly diagnostics: readonly Diagnostic[];
  readonly unknownActionId: string;
  readonly unknownNodeId: string;
} {
  const start = diagnostics.size();
  const unknownAction = diagnostics.add({
    code: DIAGNOSTIC_CODES.interactionUnsupportedAction,
    severity: "warning",
    message:
      "The invented future interaction remains present as raw tagged data.",
    phase: "normalization",
    source: { kind: "node", id: "node:future-shape" },
    propertyPath: "$.reactions[2].actions[0]",
    causedDataLoss: false,
  });
  const unknownNode = diagnostics.add({
    code: DIAGNOSTIC_CODES.irUnknownNodeType,
    severity: "warning",
    message: "The invented future node remains present as tagged raw data.",
    phase: "normalization",
    source: { kind: "node", id: "node:future-shape" },
    propertyPath: "$.nodeType",
    causedDataLoss: false,
  });
  return {
    diagnostics: diagnostics.listSince(start),
    unknownActionId: unknownAction.id,
    unknownNodeId: unknownNode.id,
  };
}

export interface SyntheticDesignSystemFixture {
  readonly provenance: string;
  readonly document: DesignIrDocument;
  readonly pages: readonly DesignIrPageIndex[];
  readonly roots: readonly DesignIrRootIndex[];
  readonly variables: VariablesIndexIR;
  readonly styles: StylesIndexIR;
  readonly components: ComponentsIndexIR;
  readonly interactions: readonly ReactionIR[];
  readonly assets: readonly AssetRefIR[];
  readonly previews: readonly PreviewRefIR[];
  readonly diagnostics: readonly Diagnostic[];
}

export function buildSyntheticDesignSystemFixture(): SyntheticDesignSystemFixture {
  const diagnostics = new DiagnosticBag("fixture");
  const variables = buildVariables(diagnostics);
  const fixtureDiagnostics = buildFixtureDiagnostics(diagnostics);
  const specimensRoot = buildSpecimensRoot(fixtureDiagnostics.unknownNodeId);
  const pageNote = buildPageNote();
  const journeyRoot = buildJourneyRoot();
  const interactions = buildInteractions(fixtureDiagnostics.unknownActionId);

  const document: DesignIrDocument = {
    kind: "design-ir-document",
    schemaVersion: DESIGN_IR_SCHEMA_VERSION,
    source: documentRef,
    name: "Aurora Sandbox",
    pages: [pageSpecimensRef, pageJourneyRef],
    currentPageId: pageSpecimensRef.id,
    selectedRootIds: ["node:specimens-root", "node:signal-card-set"],
    counts: {
      localVariables: {
        status: "collected",
        value: variables.index.variables.length,
        coverage: "file-local",
      },
      localStyles: {
        status: "collected",
        value: 4,
        coverage: "file-local",
      },
      localComponents: {
        status: "collected",
        value: 2,
        coverage: "selected-reachable",
      },
    },
    artifacts: {
      variables: {
        path: archivePaths.irVariables(SNAPSHOT_ID),
        mediaType: "application/json",
      },
      styles: {
        path: archivePaths.irStyles(SNAPSHOT_ID),
        mediaType: "application/json",
      },
      components: {
        path: archivePaths.irComponents(SNAPSHOT_ID),
        mediaType: "application/json",
      },
      nodeArtifacts: [
        {
          path: archivePaths.irNodePage(SNAPSHOT_ID, pageSpecimensRef.id),
          mediaType: "application/json",
        },
        {
          path: archivePaths.irNodePage(SNAPSHOT_ID, pageJourneyRef.id),
          mediaType: "application/json",
        },
      ],
    },
    capabilities: [
      "canonical-ir",
      "raw-aliases",
      "resolved-aliases",
      "synthetic-assets-metadata",
    ],
    limitations: [
      "This synthetic fixture contains contracts only; no Figma collector was invoked.",
    ],
    diagnosticIds: [
      ...variables.index.diagnosticIds,
      ...fixtureDiagnostics.diagnostics.map((diagnostic) => diagnostic.id),
    ],
  };

  const previews: readonly PreviewRefIR[] = [
    {
      sourceNode: {
        kind: "node",
        id: "node:journey-destination",
        name: "Journey destination",
      },
      archivePath: archivePaths.preview(
        SNAPSHOT_ID,
        "node:journey-destination",
      ),
      mediaType: "image/png",
      sourceBounds: { x: 0, y: 0, width: 4800, height: 900 },
      exportedBounds: { x: 0, y: 0, width: 4096, height: 768 },
      scale: 4096 / 4800,
      byteLength: 327,
      contentSha256: PREVIEW_SHA256,
      diagnosticIds: [],
    },
  ];

  const pages: readonly DesignIrPageIndex[] = [
    {
      kind: "design-ir-page-index",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      source: pageSpecimensRef,
      childNodeIds: ["node:specimens-root", "node:page-note"],
      dependencyRefs: [
        { kind: "component", id: "component:signal-card-quiet" },
        { kind: "style", id: "style:text-body" },
        { kind: "variable", id: "variable:accent-chain" },
      ],
      normalizedTrees: [specimensRoot, pageNote],
      reactions: interactions,
      assets: [rasterAsset, vectorAsset],
      previews: [],
      coverage: {
        annotationsAndAccessibility: { status: "collected" },
        dependencies: { status: "collected" },
        reactions: { status: "collected" },
        assets: { status: "collected" },
        textSegments: { status: "collected" },
      },
      rawArtifact: {
        path: archivePaths.rawRestPage(SNAPSHOT_ID, pageSpecimensRef.id),
        mediaType: "application/json",
      },
      diagnosticIds: fixtureDiagnostics.diagnostics.map(
        (diagnostic) => diagnostic.id,
      ),
    },
    {
      kind: "design-ir-page-index",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      source: pageJourneyRef,
      childNodeIds: ["node:journey-destination"],
      dependencyRefs: [],
      normalizedTrees: [journeyRoot],
      reactions: [],
      assets: [],
      previews,
      coverage: {
        annotationsAndAccessibility: { status: "collected" },
        dependencies: { status: "collected" },
        reactions: { status: "collected" },
        assets: { status: "collected" },
        textSegments: { status: "collected" },
      },
      rawArtifact: {
        path: archivePaths.rawRestPage(SNAPSHOT_ID, pageJourneyRef.id),
        mediaType: "application/json",
      },
      diagnosticIds: [],
    },
  ];

  const roots: readonly DesignIrRootIndex[] = [
    {
      kind: "design-ir-root-index",
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      source: specimensRoot.source,
      dependencyRefs: pages[0]?.dependencyRefs ?? [],
      normalizedTree: specimensRoot,
      reactions: interactions,
      assets: [rasterAsset, vectorAsset],
      previews: [],
      coverage: {
        annotationsAndAccessibility: { status: "collected" },
        dependencies: { status: "collected" },
        reactions: { status: "collected" },
        assets: { status: "collected" },
        textSegments: { status: "collected" },
      },
      rawArtifact: {
        path: archivePaths.rawRestRoot(SNAPSHOT_ID, specimensRoot.source.id),
        mediaType: "application/json",
      },
      diagnosticIds: fixtureDiagnostics.diagnostics.map(
        (diagnostic) => diagnostic.id,
      ),
    },
  ];

  return {
    provenance:
      "Entirely invented synthetic contract fixture; not derived from a real design.",
    document,
    pages,
    roots,
    variables: variables.index,
    styles: buildStyles(),
    components: buildComponents(),
    interactions,
    assets: [rasterAsset, vectorAsset],
    previews,
    diagnostics: diagnostics.list(),
  };
}

export function buildRandomizableJsonObject(): JsonObject {
  return {
    zebra: {
      two: 2,
      one: 1,
    },
    alpha: [
      { second: "b", first: "a" },
      { y: true, x: false },
    ],
    middle: SYNTHETIC_UNICODE_TEXT,
  };
}

function goldenNodeSample(node: NodeIR): unknown {
  const common = {
    family: node.family,
    source: node.source,
    nodeType: node.nodeType,
    childOrder: node.childOrder,
    visible: node.visible,
    diagnosticIds: node.diagnosticIds,
  };

  switch (node.family) {
    case "container":
      return {
        ...common,
        ...(node.geometry === undefined
          ? {}
          : {
              geometry: {
                ...(node.geometry.localBounds === undefined
                  ? {}
                  : { localBounds: node.geometry.localBounds }),
                ...(node.geometry.absoluteBounds === undefined
                  ? {}
                  : { absoluteBounds: node.geometry.absoluteBounds }),
                ...(node.geometry.rotation === undefined
                  ? {}
                  : { rotation: node.geometry.rotation }),
              },
            }),
        ...(node.layout === undefined
          ? {}
          : {
              layout: {
                mode: node.layout.mode,
                wrap: node.layout.wrap,
                itemSpacing: node.layout.itemSpacing,
                paddingTop: node.layout.paddingTop,
                paddingRight: node.layout.paddingRight,
                paddingBottom: node.layout.paddingBottom,
                paddingLeft: node.layout.paddingLeft,
                grids: node.layout.grids,
              },
            }),
        ...(node.visual === undefined
          ? {}
          : {
              visual: {
                ...(node.visual.clipsContent === undefined
                  ? {}
                  : { clipsContent: node.visual.clipsContent }),
                ...(node.visual.fills === undefined
                  ? {}
                  : { fills: node.visual.fills }),
                ...(node.visual.strokes === undefined
                  ? {}
                  : { strokes: node.visual.strokes }),
                ...(node.visual.effects === undefined
                  ? {}
                  : { effects: node.visual.effects }),
                ...(node.visual.cornerRadii === undefined
                  ? {}
                  : { cornerRadii: node.visual.cornerRadii }),
              },
            }),
        childIds: node.children.map((child) => child.source.id),
      };
    case "text":
      return {
        ...common,
        visual: node.visual,
        text: node.text,
      };
    case "vector":
      return {
        ...common,
        vector: node.vector,
        exportSettings: node.exportSettings,
        assetRefs: node.assetRefs,
        ...(node.visual === undefined ? {} : { visual: node.visual }),
        childIds: node.children.map((child) => child.source.id),
      };
    case "component":
      return {
        ...common,
        componentData: node.componentData,
        childIds: node.children.map((child) => child.source.id),
      };
    case "instance":
      return {
        ...common,
        instanceData: node.instanceData,
        visual: node.visual,
        assetRefs: node.assetRefs,
        childIds: node.children.map((child) => child.source.id),
      };
    case "leaf":
      return {
        ...common,
        ...(node.geometry === undefined ? {} : { geometry: node.geometry }),
        ...(node.layout === undefined ? {} : { layout: node.layout }),
        properties: node.properties,
      };
    case "unknown":
      return {
        ...common,
        unsupportedNodeType: node.unsupportedNodeType,
        raw: node.raw,
      };
  }
}

function flattenNodes(node: NodeIR): readonly NodeIR[] {
  switch (node.family) {
    case "container":
    case "vector":
    case "component":
    case "instance":
      return [node, ...node.children.flatMap((child) => flattenNodes(child))];
    case "text":
    case "leaf":
    case "unknown":
      return [node];
  }
}

export function buildSyntheticGoldenArtifact(): unknown {
  const fixture = buildSyntheticDesignSystemFixture();
  const goldenVariableIds = new Set([
    "variable:accent-base",
    "variable:accent-chain",
    "variable:cycle-a",
    "variable:remote-gap",
  ]);
  return {
    contract: {
      archiveVersion: ARCHIVE_FORMAT_VERSION,
      schemaVersion: DESIGN_IR_SCHEMA_VERSION,
      provenance: fixture.provenance,
    },
    document: {
      source: fixture.document.source,
      pages: fixture.document.pages,
      currentPageId: fixture.document.currentPageId,
      selectedRootIds: fixture.document.selectedRootIds,
      counts: fixture.document.counts,
      capabilities: fixture.document.capabilities,
      limitations: fixture.document.limitations,
    },
    nodes: fixture.pages.map((page) => ({
      page: page.source,
      childNodeIds: page.childNodeIds,
      treeOrder: page.normalizedTrees.flatMap((tree) =>
        flattenNodes(tree).map((node) => ({
          id: node.source.id,
          family: node.family,
          visible: node.visible,
        })),
      ),
      samples: page.normalizedTrees
        .flatMap((tree) => flattenNodes(tree))
        .filter((node) => node.source.id !== "node:signal-card-label")
        .map((node) => goldenNodeSample(node)),
      reactionIds: page.reactions.map((reaction) => reaction.id),
      assetPaths: page.assets.map((asset) => asset.archivePath ?? null),
      previewPaths: page.previews.map((preview) => preview.archivePath),
    })),
    rootArtifacts: fixture.roots.map((root) => ({
      source: root.source,
      dependencyRefs: root.dependencyRefs,
      reactionIds: root.reactions.map((reaction) => reaction.id),
      assetPaths: root.assets.map((asset) => asset.archivePath ?? null),
      previewPaths: root.previews.map((preview) => preview.archivePath),
      rawArtifact: root.rawArtifact,
      diagnosticIds: root.diagnosticIds,
    })),
    variables: {
      collections: fixture.variables.collections,
      variables: fixture.variables.variables
        .filter((variable) => goldenVariableIds.has(variable.source.id))
        .map((variable) => ({
          source: variable.source,
          values: variable.values,
          diagnosticIds: variable.diagnosticIds,
        })),
    },
    styles: fixture.styles.styles.map((style) => ({
      source: style.source,
      styleType: style.styleType,
      diagnosticIds: style.diagnosticIds,
    })),
    components: {
      definitions: fixture.components.definitions.map((definition) => ({
        componentKind: definition.componentKind,
        source: definition.source,
        ...(definition.nodeId === undefined
          ? {}
          : { nodeId: definition.nodeId }),
        ...(definition.componentSetId === undefined
          ? {}
          : { componentSetId: definition.componentSetId }),
        ...(definition.defaultVariantId === undefined
          ? {}
          : { defaultVariantId: definition.defaultVariantId }),
        variantAxes: definition.variantAxes,
        variantProperties: definition.variantProperties,
        propertyDefinitions: definition.propertyDefinitions,
      })),
      dependencies: fixture.components.dependencies,
    },
    interactions: fixture.interactions,
    assets: fixture.assets,
    previews: fixture.previews,
    diagnostics: fixture.diagnostics.map((diagnostic) => ({
      id: diagnostic.id,
      code: diagnostic.code,
      severity: diagnostic.severity,
      source: diagnostic.source,
      propertyPath: diagnostic.propertyPath,
      causedDataLoss: diagnostic.causedDataLoss,
    })),
  };
}
