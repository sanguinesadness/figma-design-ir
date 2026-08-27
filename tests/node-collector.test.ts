import { describe, expect, it, vi } from "vitest";

import { ExportCancellationToken } from "../src/main/cancellation";
import { collectNodeTree } from "../src/main/collect-node";
import { DIAGNOSTIC_CODES, DiagnosticBag } from "../src/shared/diagnostics";
import type { NodeIR, NodeVisualIR, PaintIR } from "../src/shared/ir";

declare global {
  interface SceneNode {
    readonly id: string;
    readonly name: string;
  }

  var figma: FigmaTestApi;
}

interface InventedNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly children?: readonly InventedNode[];
  readonly [property: string]: unknown;
}

function requireFamily<TFamily extends NodeIR["family"]>(
  node: NodeIR | undefined,
  family: TFamily,
): Extract<NodeIR, { readonly family: TFamily }> {
  if (node === undefined || node.family !== family) {
    throw new Error(`Expected an invented ${family} node.`);
  }
  return node as Extract<NodeIR, { readonly family: TFamily }>;
}

function isPaintArray(
  value: NodeVisualIR["fills"],
): value is readonly PaintIR[] {
  return Array.isArray(value);
}

describe("Node collection", () => {
  it("preserves a complete invented subtree while normalizing risky values and dependencies safely", async () => {
    const arbitraryThrownMessage =
      "INVENTED_INTERNAL_THROW_TEXT_THAT_MUST_NOT_ESCAPE";
    const unicodeText = "Пример 中文 e\u0301 🚀 “quoted” — كاملة";
    const unicodePathText = "Текст по пути 路径 🧭 naïve";
    const mixed = Symbol("invented-mixed");
    const uniformFontName = {
      family: "Invented Sans",
      style: "Regular",
    };
    const uniformTextValues = {
      fontName: uniformFontName,
      fontSize: 17,
      fontWeight: 400,
      textCase: "ORIGINAL",
      textDecoration: "NONE",
      letterSpacing: { unit: "PIXELS", value: 0.5 },
      lineHeight: { unit: "PIXELS", value: 22 },
      paragraphIndent: 0,
    };
    const textNode = {
      id: "node:text",
      name: "Invented Unicode Text",
      type: "TEXT",
      visible: true,
      locked: false,
      characters: unicodeText,
      ...uniformTextValues,
    } satisfies InventedNode;
    const textPathNode = {
      id: "node:text-path",
      name: "Invented Unicode Text Path",
      type: "TEXT_PATH",
      visible: true,
      locked: false,
      characters: unicodePathText,
      ...uniformTextValues,
    } satisfies InventedNode;
    const vectorNode = {
      id: "node:vector",
      name: "Invented Vector",
      type: "VECTOR",
      visible: true,
      locked: false,
      vectorNetwork: {
        vertices: [{ x: 0, y: 1 }],
        segments: [{ start: 0, end: 0 }],
        regions: [],
      },
      vectorPaths: [{ data: "M0 0 L2 2 Z", windingRule: "NONZERO" }],
      fillGeometry: [{ data: "M0 0 L2 2 Z", windingRule: "NONZERO" }],
      handleMirroring: "ANGLE_AND_LENGTH",
      windingRule: "NONZERO",
    } satisfies InventedNode;
    Object.defineProperty(vectorNode, "opacity", {
      configurable: true,
      enumerable: false,
      get: () => {
        throw new Error(arbitraryThrownMessage);
      },
    });
    const nestedVectorNode = {
      id: "node:nested-vector",
      name: "Retained Nested Shape",
      type: "ELLIPSE",
      visible: true,
      locked: false,
      fillGeometry: [{ data: "M1 1 Z", windingRule: "EVENODD" }],
    } satisfies InventedNode;
    const unknownNode = {
      id: "node:unknown",
      name: "Invented Future Node",
      type: "INVENTED_FUTURE_NODE",
      visible: true,
      locked: false,
      children: [nestedVectorNode],
    } satisfies InventedNode;
    const root = {
      id: "node:root",
      name: "Invented Container",
      type: "FRAME",
      visible: true,
      locked: false,
      x: 0,
      y: 0,
      width: 640,
      height: 480,
      boundVariables: {
        width: { type: "VARIABLE_ALIAS", id: "variable:alpha" },
        height: { type: "VARIABLE_ALIAS", id: "variable:middle" },
      },
      fills: [
        {
          type: "SOLID",
          visible: true,
          opacity: Number.POSITIVE_INFINITY,
          color: { r: 0.1, g: 0.2, b: 0.3 },
          boundVariables: {
            color: { type: "VARIABLE_ALIAS", id: "variable:zeta" },
            nested: {
              first: { type: "VARIABLE_ALIAS", id: "variable:alpha" },
              second: [{ type: "VARIABLE_ALIAS", id: "variable:zeta" }],
            },
          },
        },
        {
          type: "GRADIENT_LINEAR",
          visible: true,
          opacity: 1,
          gradientTransform: [
            [1, 0, 0],
            [0, 1, 0],
          ],
          gradientStops: [
            {
              position: 0,
              color: { r: 0.4, g: 0.5, b: 0.6, a: 1 },
              boundVariables: {
                color: {
                  type: "VARIABLE_ALIAS",
                  id: "variable:gradient-stop",
                },
              },
            },
            {
              position: 1,
              color: { r: 0.8, g: 0.9, b: 1, a: 1 },
            },
          ],
        },
      ],
      children: [textNode, textPathNode, vectorNode, unknownNode],
    } satisfies InventedNode;
    const inputSnapshot = structuredClone(root);
    const opacityDescriptor = Object.getOwnPropertyDescriptor(
      vectorNode,
      "opacity",
    );
    const diagnostics = new DiagnosticBag("node-collector");
    vi.stubGlobal("figma", { mixed });
    Object.defineProperties(textNode, {
      paragraphSpacing: { enumerable: true, value: mixed },
      listSpacing: { enumerable: true, value: mixed },
      getStyledTextSegments: {
        enumerable: false,
        value: () => [
          {
            start: 0,
            end: 6,
            characters: unicodeText.slice(0, 6),
            ...uniformTextValues,
            fills: [],
            boundVariables: {},
            textStyleOverrides: [],
            openTypeFeatures: {},
          },
        ],
      },
    });
    Object.defineProperty(textPathNode, "getStyledTextSegments", {
      enumerable: false,
      value: () => [
        {
          start: 0,
          end: unicodePathText.length,
          characters: unicodePathText,
          ...uniformTextValues,
          fills: [],
          boundVariables: {},
          textStyleOverrides: [],
          openTypeFeatures: {},
        },
      ],
    });
    Object.defineProperty(root, "strokeJoin", {
      enumerable: true,
      value: mixed,
    });
    Object.defineProperty(vectorNode, "handleMirroring", {
      enumerable: true,
      value: mixed,
    });

    try {
      const collected = await collectNodeTree(
        root,
        { kind: "page", id: "page:invented", name: "Invented Page" },
        diagnostics,
        new ExportCancellationToken(),
      );
      const tree = requireFamily(collected.tree, "container");
      const text = requireFamily(tree.children[0], "text");
      const textPath = requireFamily(tree.children[1], "text");
      const vector = requireFamily(tree.children[2], "vector");
      const unknown = requireFamily(tree.children[3], "unknown");
      const nestedVector = requireFamily(unknown.children[0], "vector");

      expect(collected.nodeCount).toBe(6);
      expect(tree.children.map((child) => child.source.id)).toEqual([
        "node:text",
        "node:text-path",
        "node:vector",
        "node:unknown",
      ]);
      expect(tree.children.map((child) => child.childOrder)).toEqual([
        0, 1, 2, 3,
      ]);
      expect(unknown.children.map((child) => child.source.id)).toEqual([
        "node:nested-vector",
      ]);
      expect(nestedVector.childOrder).toBe(0);
      expect(nestedVector.vector.fillGeometry).toEqual([
        { data: "M1 1 Z", windingRule: "EVENODD" },
      ]);

      expect(text.text.characters).toBe(unicodeText);
      expect(textPath.text.characters).toBe(unicodePathText);
      expect(text.text.segments).toEqual([
        expect.objectContaining({
          start: 0,
          end: 6,
          characters: unicodeText.slice(0, 6),
        }),
      ]);
      expect(textPath.text.segments).toEqual([
        expect.objectContaining({
          start: 0,
          end: unicodePathText.length,
          characters: unicodePathText,
        }),
      ]);
      for (const textData of [text.text, textPath.text]) {
        expect(textData.fontName).toEqual(uniformFontName);
        expect(textData.fontSize).toBe(17);
        expect(textData.fontWeight).toBe(400);
        expect(textData.textCase).toBe("ORIGINAL");
        expect(textData.letterSpacing).toEqual({
          unit: "PIXELS",
          value: 0.5,
        });
        expect(textData.lineHeight).toEqual({ unit: "PIXELS", value: 22 });
      }
      expect(text.text.paragraphIndent).toBe(0);
      expect(text.text.paragraphSpacing).toEqual({ $type: "figma-mixed" });
      expect(text.text.listSpacing).toEqual({ $type: "figma-mixed" });
      expect(tree.visual?.strokeGeometry?.join).toEqual({
        $type: "figma-mixed",
      });

      expect(vector.vector).toMatchObject({
        handleMirroring: { $type: "figma-mixed" },
        windingRule: "NONZERO",
        fillGeometry: [{ data: "M0 0 L2 2 Z", windingRule: "NONZERO" }],
        vectorNetwork: {
          vertices: [{ x: 0, y: 1 }],
          segments: [{ start: 0, end: 0 }],
          regions: [],
        },
        vectorPaths: [{ data: "M0 0 L2 2 Z", windingRule: "NONZERO" }],
      });

      expect(unknown.unsupportedNodeType).toBe("INVENTED_FUTURE_NODE");
      expect(unknown.raw).toEqual({
        $type: "unsupported",
        reason: "unknown",
        runtimeType: "figma-node",
      });
      const unknownDiagnostic = diagnostics
        .list()
        .find(
          (diagnostic) =>
            diagnostic.code === DIAGNOSTIC_CODES.irUnknownNodeType,
        );
      expect(unknownDiagnostic).toMatchObject({
        severity: "warning",
        source: {
          kind: "node",
          id: "node:unknown",
          name: "Invented Future Node",
        },
        propertyPath: "$.type",
        causedDataLoss: false,
      });
      expect(unknown.diagnosticIds).toContain(unknownDiagnostic?.id);

      const fills = tree.visual?.fills;
      expect(isPaintArray(fills)).toBe(true);
      if (!isPaintArray(fills)) {
        throw new Error("Expected the invented root paint to be collected.");
      }
      expect(fills[0]?.opacity).toBeNull();
      expect(
        fills[0]?.boundVariables?.map((binding) => binding.variable.id),
      ).toEqual(["variable:zeta", "variable:alpha", "variable:zeta"]);
      expect(
        fills[1]?.gradientStops?.[0]?.boundVariables?.map(
          (binding) => binding.variable.id,
        ),
      ).toEqual(["variable:gradient-stop"]);
      expect(
        diagnostics
          .list()
          .find(
            (diagnostic) =>
              diagnostic.code ===
                DIAGNOSTIC_CODES.normalizationNonFiniteNumber &&
              diagnostic.source?.id === "node:root",
          ),
      ).toMatchObject({
        propertyPath: "$.fills[0].opacity",
        causedDataLoss: true,
      });

      expect(collected.dependencyRefs).toEqual([
        { kind: "variable", id: "variable:alpha" },
        { kind: "variable", id: "variable:gradient-stop" },
        { kind: "variable", id: "variable:middle" },
        { kind: "variable", id: "variable:zeta" },
      ]);
      expect(collected.coverage.textSegmentsComplete).toBe(false);
      expect(
        diagnostics
          .list()
          .find(
            (diagnostic) =>
              diagnostic.code ===
                DIAGNOSTIC_CODES.textSegmentsCollectionFailed &&
              diagnostic.source?.id === textNode.id,
          ),
      ).toMatchObject({
        severity: "warning",
        propertyPath: "$.getStyledTextSegments",
        causedDataLoss: true,
      });
      const propertyAccessDiagnostic = diagnostics
        .list()
        .find(
          (diagnostic) =>
            diagnostic.code ===
              DIAGNOSTIC_CODES.collectionPropertyAccessFailed &&
            diagnostic.source?.id === "node:vector",
        );
      expect(propertyAccessDiagnostic).toMatchObject({
        severity: "warning",
        propertyPath: "$.opacity",
        causedDataLoss: true,
        technicalCause: {
          category: "error",
          context: "property-access",
        },
      });
      expect(JSON.stringify(diagnostics.list())).not.toContain(
        arbitraryThrownMessage,
      );

      const rootWithoutMixed = Object.fromEntries(
        Object.entries(root).filter(([key]) => key !== "strokeJoin"),
      );
      const textWithoutMixed = Object.fromEntries(
        Object.entries(textNode).filter(
          ([key]) => key !== "paragraphSpacing" && key !== "listSpacing",
        ),
      );
      const vectorWithoutMixed = {
        ...vectorNode,
        handleMirroring: "ANGLE_AND_LENGTH",
      };
      expect(
        structuredClone({
          ...rootWithoutMixed,
          children: [
            textWithoutMixed,
            textPathNode,
            vectorWithoutMixed,
            unknownNode,
          ],
        }),
      ).toEqual({
        ...inputSnapshot,
      });
      expect(root.fills[0]?.opacity).toBe(Number.POSITIVE_INFINITY);
      expect(Object.getOwnPropertyDescriptor(vectorNode, "opacity")).toEqual(
        opacityDescriptor,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
