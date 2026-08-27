import { describe, expect, it } from "vitest";

import {
  collectStyles,
  type ReadableStyle,
  type StyleCollectorApi,
} from "../src/main/collect-styles";
import {
  collectVariables,
  type ReadableVariable,
  type ReadableVariableCollection,
  type VariableCollectorApi,
} from "../src/main/collect-variables";
import { ExportCancellationToken } from "../src/main/cancellation";
import { DIAGNOSTIC_CODES, DiagnosticBag } from "../src/shared/diagnostics";
import type { SourceRef } from "../src/shared/ir";

declare global {
  interface FigmaTestApi {
    readonly mixed: unknown;
    readonly variables: VariableCollectorApi;
    getLocalPaintStylesAsync(): ReturnType<
      StyleCollectorApi["getLocalPaintStylesAsync"]
    >;
    getLocalTextStylesAsync(): ReturnType<
      StyleCollectorApi["getLocalTextStylesAsync"]
    >;
    getLocalEffectStylesAsync(): ReturnType<
      StyleCollectorApi["getLocalEffectStylesAsync"]
    >;
    getLocalGridStylesAsync(): ReturnType<
      StyleCollectorApi["getLocalGridStylesAsync"]
    >;
    getStyleByIdAsync(
      id: string,
    ): ReturnType<StyleCollectorApi["getStyleByIdAsync"]>;
  }

  var figma: FigmaTestApi;
}

const aliases = (id: string) => ({ type: "VARIABLE_ALIAS", id });

function collection(
  id: string,
  variableIds: readonly string[],
): ReadableVariableCollection {
  return {
    id,
    name: `Invented ${id}`,
    key: `key:${id}`,
    remote: false,
    hiddenFromPublishing: false,
    isExtension: false,
    defaultModeId: "mode:day",
    modes: [
      { modeId: "mode:night", name: "Invented night" },
      { modeId: "mode:day", name: "Invented day" },
    ],
    variableIds,
    getPublishStatusAsync: () => Promise.resolve("CURRENT"),
  };
}

function variable(
  id: string,
  valuesByMode: Readonly<Record<string, unknown>>,
  remote = false,
): ReadableVariable {
  return {
    id,
    name: `Invented ${id}`,
    key: `key:${id}`,
    remote,
    variableCollectionId: "collection:invented",
    resolvedType: "COLOR",
    description: `Invented description for ${id}`,
    scopes: ["ALL_FILLS"],
    codeSyntax: { WEB: `--${id}` },
    hiddenFromPublishing: false,
    valuesByMode,
    getPublishStatusAsync: () => Promise.resolve("CURRENT"),
  };
}

function style(
  id: string,
  type: ReadableStyle["type"],
  fields: Partial<ReadableStyle>,
  includeMarkdown = true,
): ReadableStyle {
  return {
    id,
    key: `key:${id}`,
    name: `Invented ${id}`,
    remote: false,
    type,
    description: `Invented description for ${id}`,
    ...(includeMarkdown ? { descriptionMarkdown: `Invented **${id}**` } : {}),
    documentationLinks: [{ uri: `https://synthetic.invalid/${id}` }],
    ...fields,
  };
}

describe("Variable and style resource collection", () => {
  it("retains deterministic local/reference closure, raw aliases, four style families, bindings, and inaccessible diagnostics", async () => {
    const primitive = variable("variable:a-primitive", {
      "mode:night": { r: 0.1, g: 0.2, b: 0.3 },
      "mode:day": { r: 0.8, g: 0.9, b: 1 },
    });
    const semantic = variable("variable:z-semantic", {
      "mode:night": aliases(primitive.id),
      "mode:day": aliases(primitive.id),
    });
    let extendedValueReads = 0;
    const remote = {
      ...variable(
        "variable:remote",
        { "mode:night": "unresolved", "mode:day": "unresolved" },
        true,
      ),
      valuesByModeForCollectionAsync: () => {
        extendedValueReads += 1;
        return Promise.resolve({
          "mode:night": "remote-night",
          "mode:day": "remote-day",
        });
      },
    } satisfies ReadableVariable;
    const extendedCollection = {
      ...collection("collection:extended", [remote.id]),
      remote: false,
      isExtension: true,
      parentVariableCollectionId: "collection:invented",
      rootVariableCollectionId: "collection:invented",
      modes: [
        {
          modeId: "mode:night",
          name: "Invented inherited night",
          parentModeId: "mode:night",
        },
        {
          modeId: "mode:day",
          name: "Invented inherited day",
          parentModeId: "mode:day",
        },
      ],
      variableOverrides: {
        [remote.id]: { "mode:night": aliases(primitive.id) },
      },
    } satisfies ReadableVariableCollection;
    const variables = [semantic, primitive];
    const variableApi: VariableCollectorApi = {
      getLocalVariableCollectionsAsync: () =>
        Promise.resolve([
          collection(
            "collection:invented",
            variables.map((item) => item.id),
          ),
          extendedCollection,
        ]),
      getLocalVariablesAsync: () => Promise.resolve([...variables].reverse()),
      getVariableByIdAsync: (id) =>
        Promise.resolve(
          id === remote.id
            ? remote
            : (variables.find((item) => item.id === id) ?? null),
        ),
      getVariableCollectionByIdAsync: (id) =>
        Promise.resolve(
          id === "collection:invented"
            ? collection(
                "collection:invented",
                variables.map((item) => item.id),
              )
            : id === extendedCollection.id
              ? extendedCollection
              : null,
        ),
    };

    const paint = style("style:z-paint", "PAINT", {
      boundVariables: { paints: [aliases(semantic.id)] },
      paints: [
        {
          type: "SOLID",
          color: { r: 0.2, g: 0.3, b: 0.4 },
          visible: true,
          opacity: 1,
          boundVariables: { color: aliases(semantic.id) },
        },
      ],
    });
    const text = style("style:a-text", "TEXT", {
      fontSize: 18,
      fontName: { family: "Invented Sans", style: "Regular" },
      textDecoration: "NONE",
      letterSpacing: { unit: "PIXELS", value: 0 },
      lineHeight: { unit: "PIXELS", value: 24 },
      leadingTrim: "NONE",
      paragraphIndent: 0,
      paragraphSpacing: 4,
      listSpacing: 2,
      hangingPunctuation: false,
      hangingList: false,
      textCase: "ORIGINAL",
    });
    const effect = style("style:m-effect", "EFFECT", {
      effects: [
        {
          type: "DROP_SHADOW",
          visible: true,
          radius: 6,
          color: { r: 0, g: 0, b: 0, a: 0.2 },
          offset: { x: 0, y: 2 },
        },
      ],
    });
    const grid = style(
      "style:n-grid",
      "GRID",
      {
        layoutGrids: [
          {
            pattern: "COLUMNS",
            alignment: "STRETCH",
            gutterSize: 8,
            count: 4,
            sectionSize: 16,
            offset: 0,
            visible: true,
            color: { r: 1, g: 0, b: 0, a: 0.1 },
          },
        ],
      },
      false,
    );
    const remoteStyle = {
      ...style("style:remote", "PAINT", {
        paints: [{ type: "SOLID", color: { r: 1, g: 0, b: 1 } }],
      }),
      remote: true,
    };
    const styleApi: StyleCollectorApi = {
      getLocalPaintStylesAsync: () => Promise.resolve([paint]),
      getLocalTextStylesAsync: () => Promise.resolve([text]),
      getLocalEffectStylesAsync: () => Promise.resolve([effect]),
      getLocalGridStylesAsync: () => Promise.resolve([grid]),
      getStyleByIdAsync: (id) =>
        Promise.resolve(id === remoteStyle.id ? remoteStyle : null),
    };

    const diagnostics = new DiagnosticBag("resource-test");
    const cancellation = new ExportCancellationToken();
    const consumer: SourceRef = { kind: "node", id: "node:consumer" };
    const styles = await collectStyles({
      referencedStyleIds: ["style:missing", remoteStyle.id],
      referencedByByStyleId: new Map([[paint.id, [consumer]]]),
      diagnostics,
      cancellation,
      api: styleApi,
    });
    const collectedVariables = await collectVariables({
      referencedVariableIds: [
        "variable:missing",
        remote.id,
        ...styles.referencedVariableIds,
      ],
      diagnostics,
      cancellation,
      api: variableApi,
    });

    expect(styles.localEnumerationComplete).toBe(true);
    expect(collectedVariables.localEnumerationComplete).toBe(true);
    expect(styles.localCount).toBe(4);
    expect(collectedVariables.localCount).toBe(2);
    expect(extendedValueReads).toBe(1);
    expect(styles.artifact.styles.map((item) => item.source.id)).toEqual([
      "style:a-text",
      "style:m-effect",
      "style:n-grid",
      "style:remote",
      "style:z-paint",
    ]);
    expect(
      new Set(styles.artifact.styles.map((item) => item.styleType)),
    ).toEqual(new Set(["paint", "text", "effect", "grid"]));
    expect(
      styles.artifact.styles.find((item) => item.source.id === paint.id)
        ?.referencedBy,
    ).toEqual([consumer]);
    expect(styles.referencedVariableIds).toContain(semantic.id);
    expect(
      collectedVariables.artifact.variables.map((item) => item.source.id),
    ).toEqual([primitive.id, remote.id, semantic.id]);
    expect(
      collectedVariables.artifact.variables.every(
        (item) => item.publishStatus === "CURRENT",
      ),
    ).toBe(true);
    expect(
      collectedVariables.artifact.collections.every(
        (item) => item.publishStatus === "CURRENT",
      ),
    ).toBe(true);
    expect(
      collectedVariables.artifact.variables.find(
        (item) => item.source.id === semantic.id,
      )?.values,
    ).toEqual([
      expect.objectContaining({
        modeId: "mode:night",
        raw: { $type: "variable-alias", variableId: primitive.id },
        status: "resolved",
        resolved: { r: 0.1, g: 0.2, b: 0.3 },
      }),
      expect.objectContaining({
        modeId: "mode:day",
        raw: { $type: "variable-alias", variableId: primitive.id },
        status: "resolved",
        resolved: { r: 0.8, g: 0.9, b: 1 },
      }),
    ]);
    expect(
      collectedVariables.artifact.variables.find(
        (item) => item.source.id === remote.id,
      )?.extendedCollectionValues,
    ).toEqual([
      {
        collectionId: "collection:extended",
        values: [
          expect.objectContaining({
            modeId: "mode:night",
            raw: "remote-night",
            status: "resolved",
          }),
          expect.objectContaining({
            modeId: "mode:day",
            raw: "remote-day",
            status: "resolved",
          }),
        ],
      },
    ]);
    expect(
      collectedVariables.artifact.collections.find(
        (item) => item.source.id === extendedCollection.id,
      ),
    ).toMatchObject({
      isExtension: true,
      parentVariableCollectionId: "collection:invented",
      rootVariableCollectionId: "collection:invented",
      modes: [
        { id: "mode:night", parentModeId: "mode:night" },
        { id: "mode:day", parentModeId: "mode:day" },
      ],
      variableOverrides: {
        "variable:remote": {
          "mode:night": {
            $type: "variable-alias",
            variableId: "variable:a-primitive",
          },
        },
      },
    });
    expect(new Set(diagnostics.list().map((item) => item.code))).toEqual(
      new Set([
        DIAGNOSTIC_CODES.styleReferenceUnavailable,
        DIAGNOSTIC_CODES.variableReferenceUnavailable,
      ]),
    );

    const hostileEnumerationText =
      "INVENTED_LOCAL_ENUMERATION_FAILURE_MUST_NOT_ESCAPE";
    const partialStyleDiagnostics = new DiagnosticBag("partial-style-test");
    const partialStyles = await collectStyles({
      referencedStyleIds: [],
      referencedByByStyleId: new Map(),
      diagnostics: partialStyleDiagnostics,
      cancellation: new ExportCancellationToken(),
      api: {
        getLocalPaintStylesAsync: () => Promise.resolve([paint]),
        getLocalTextStylesAsync: () =>
          Promise.reject(new Error(hostileEnumerationText)),
        getLocalEffectStylesAsync: () => Promise.resolve([]),
        getLocalGridStylesAsync: () => Promise.resolve([]),
        getStyleByIdAsync: () => Promise.resolve(null),
      },
    });
    expect(partialStyles.localEnumerationComplete).toBe(false);
    expect(partialStyles.localCount).toBe(1);
    expect(partialStyles.artifact.styles.map((item) => item.source.id)).toEqual(
      [paint.id],
    );
    expect(partialStyleDiagnostics.list()).toEqual([
      expect.objectContaining({
        code: DIAGNOSTIC_CODES.styleCollectionFailed,
        severity: "error",
        causedDataLoss: true,
      }),
    ]);

    const partialVariableDiagnostics = new DiagnosticBag(
      "partial-variable-test",
    );
    const partialVariables = await collectVariables({
      referencedVariableIds: [],
      diagnostics: partialVariableDiagnostics,
      cancellation: new ExportCancellationToken(),
      api: {
        getLocalVariableCollectionsAsync: () =>
          Promise.reject(new Error(hostileEnumerationText)),
        getLocalVariablesAsync: () => Promise.resolve([primitive]),
        getVariableByIdAsync: (id) =>
          Promise.resolve(id === primitive.id ? primitive : null),
        getVariableCollectionByIdAsync: (id) =>
          Promise.resolve(
            id === "collection:invented"
              ? collection("collection:invented", [primitive.id])
              : null,
          ),
      },
    });
    expect(partialVariables.localEnumerationComplete).toBe(false);
    expect(partialVariables.localCount).toBe(1);
    expect(
      partialVariables.artifact.variables.map((item) => item.source.id),
    ).toEqual([primitive.id]);
    expect(partialVariableDiagnostics.list()).toEqual([
      expect.objectContaining({
        code: DIAGNOSTIC_CODES.variableCollectionFailed,
        severity: "error",
        causedDataLoss: true,
      }),
    ]);
    expect(
      JSON.stringify([
        ...partialStyleDiagnostics.list(),
        ...partialVariableDiagnostics.list(),
      ]),
    ).not.toContain(hostileEnumerationText);
  });
});
