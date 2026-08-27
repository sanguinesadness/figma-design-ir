import { describe, expect, it } from "vitest";

import {
  AliasResolutionContractError,
  resolveVariableAliases,
} from "../src/shared/aliases";
import { DIAGNOSTIC_CODES, DiagnosticBag } from "../src/shared/diagnostics";
import { variableAlias, type JsonValue } from "../src/shared/ir";
import { serializeCanonicalJson } from "../src/shared/serialization";

function variable(
  id: string,
  valuesByMode: Readonly<Record<string, JsonValue>>,
  collectionId = "collection:primary",
) {
  return {
    source: { kind: "variable" as const, id, name: `Synthetic ${id}` },
    collectionId,
    valuesByMode,
  };
}

const missingModeValue = {
  $type: "unavailable",
  reason: "missing-mode",
} as const satisfies JsonValue;

function oneModeInput(variables: ReturnType<typeof variable>[]) {
  return {
    variables,
    collections: [
      { id: "collection:primary", modeOrder: ["mode:one"] as const },
    ],
    diagnostics: new DiagnosticBag("alias-test"),
  };
}

describe("variable alias resolution", () => {
  it("keeps raw direct and multi-hop aliases beside separately resolved values", () => {
    const result = resolveVariableAliases(
      oneModeInput([
        variable("variable:z-chain", {
          "mode:one": variableAlias("variable:y-alias"),
        }),
        variable("variable:x-base", { "mode:one": "#123456" }),
        variable("variable:y-alias", {
          "mode:one": variableAlias("variable:x-base"),
        }),
      ]),
    );

    expect(result.variables.map((item) => item.source.id)).toEqual([
      "variable:x-base",
      "variable:y-alias",
      "variable:z-chain",
    ]);
    expect(result.variables[1]?.values[0]).toEqual({
      modeId: "mode:one",
      raw: variableAlias("variable:x-base"),
      status: "resolved",
      resolved: "#123456",
      aliasChain: ["variable:y-alias", "variable:x-base"],
      resolutionContext: [
        { collectionId: "collection:primary", modeId: "mode:one" },
      ],
    });
    expect(result.variables[2]?.values[0]?.aliasChain).toEqual([
      "variable:z-chain",
      "variable:y-alias",
      "variable:x-base",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("preserves explicit collection mode order independent of object key order", () => {
    const result = resolveVariableAliases({
      collections: [
        {
          id: "collection:primary",
          modeOrder: ["mode:night", "mode:day"],
        },
      ],
      diagnostics: new DiagnosticBag("alias-mode-order-test"),
      variables: [
        variable("variable:base", {
          "mode:day": "day-value",
          "mode:night": "night-value",
        }),
      ],
    });

    expect(result.variables[0]?.values.map((value) => value.modeId)).toEqual([
      "mode:night",
      "mode:day",
    ]);
    expect(result.variables[0]?.values.map((value) => value.resolved)).toEqual([
      "night-value",
      "day-value",
    ]);

    const invalidInputs = [
      {
        collections: [
          {
            id: "collection:primary",
            modeOrder: ["mode:night", "mode:night"],
          },
        ],
        variables: [],
      },
      {
        collections: [{ id: "collection:primary", modeOrder: ["mode:night"] }],
        variables: [
          variable(
            "variable:unknown-collection",
            { "mode:night": "value" },
            "collection:missing",
          ),
        ],
      },
      {
        collections: [{ id: "collection:primary", modeOrder: ["mode:night"] }],
        variables: [
          variable("variable:unknown-mode", { "mode:future": "value" }),
        ],
      },
      {
        collections: [{ id: "collection:primary", modeOrder: ["mode:night"] }],
        variables: [],
        selectedModesByCollection: { "collection:primary": "mode:future" },
      },
      {
        collections: [
          {
            id: "collection:primary",
            modeOrder: ["mode:night", "mode:day"],
          },
        ],
        variables: [
          variable("variable:missing-declared-mode", {
            "mode:night": "value",
          }),
        ],
      },
    ];
    for (const invalidInput of invalidInputs) {
      expect(() =>
        resolveVariableAliases({
          ...invalidInput,
          diagnostics: new DiagnosticBag("alias-invalid-mode-test"),
        }),
      ).toThrow(AliasResolutionContractError);
    }
  });

  it("retains unresolved aliases and requires context across multimode collections", () => {
    const variables = [
      variable("variable:missing-mode-source", {
        "mode:night": "available",
        "mode:day": variableAlias("variable:night-only"),
      }),
      variable("variable:missing-reference-source", {
        "mode:night": variableAlias("variable:not-accessible"),
        "mode:day": "available",
      }),
      variable("variable:night-only", {
        "mode:night": "available",
        "mode:day": missingModeValue,
      }),
      variable(
        "variable:cross-source",
        {
          "mode:night": "available",
          "mode:day": variableAlias("variable:cross-target"),
        },
        "collection:primary",
      ),
      variable(
        "variable:cross-target",
        { "mode:a": "context-a", "mode:b": "context-b" },
        "collection:secondary",
      ),
    ];
    const collections = [
      {
        id: "collection:primary",
        modeOrder: ["mode:night", "mode:day"],
      },
      {
        id: "collection:secondary",
        modeOrder: ["mode:a", "mode:b"],
      },
    ];
    const result = resolveVariableAliases({
      variables,
      collections,
      diagnostics: new DiagnosticBag("alias-unresolved-test"),
    });

    expect(new Set(result.diagnostics.map((item) => item.code))).toEqual(
      new Set([
        DIAGNOSTIC_CODES.variableAliasMissingMode,
        DIAGNOSTIC_CODES.variableAliasMissingReference,
        DIAGNOSTIC_CODES.variableAliasRequiresConsumerContext,
      ]),
    );
    expect(
      result.variables
        .flatMap((item) => item.values)
        .filter((value) => value.status !== "resolved")
        .map((value) => value.status)
        .sort(),
    ).toEqual([
      "missing-mode",
      "missing-mode",
      "missing-reference",
      "requires-consumer-context",
    ]);
    expect(
      result.variables.find((item) => item.source.id === "variable:night-only")
        ?.values,
    ).toHaveLength(2);
    expect(
      result.diagnostics.every((item) => item.severity === "warning"),
    ).toBe(true);

    const contextual = resolveVariableAliases({
      variables,
      collections,
      selectedModesByCollection: { "collection:secondary": "mode:b" },
      diagnostics: new DiagnosticBag("alias-context-test"),
    });
    const crossSource = contextual.variables.find(
      (item) => item.source.id === "variable:cross-source",
    );
    expect(
      crossSource?.values.find((value) => value.modeId === "mode:day"),
    ).toMatchObject({
      status: "resolved",
      resolved: "context-b",
      aliasChain: ["variable:cross-source", "variable:cross-target"],
    });
  });

  it("terminates self and multi-node cycles with insertion-independent diagnostics", () => {
    const variables = [
      variable("variable:a", {
        "mode:one": variableAlias("variable:b"),
      }),
      variable("variable:b", {
        "mode:one": variableAlias("variable:a"),
      }),
      variable("variable:self", {
        "mode:one": variableAlias("variable:self"),
      }),
    ];
    const forward = resolveVariableAliases(oneModeInput(variables));
    const reverse = resolveVariableAliases(
      oneModeInput([...variables].reverse()),
    );

    expect(serializeCanonicalJson(forward)).toBe(
      serializeCanonicalJson(reverse),
    );
    expect(forward.diagnostics).toHaveLength(2);
    expect(
      forward.diagnostics.every(
        (item) =>
          item.code === DIAGNOSTIC_CODES.variableAliasCycle &&
          item.severity === "error",
      ),
    ).toBe(true);
    expect(
      forward.variables
        .flatMap((item) => item.values)
        .map((item) => item.status),
    ).toEqual(["cycle", "cycle", "cycle"]);

    const largeCycle = Array.from({ length: 400 }, (_, index) =>
      variable(`variable:large-${String(index).padStart(3, "0")}`, {
        "mode:one": variableAlias(
          `variable:large-${String((index + 1) % 400).padStart(3, "0")}`,
        ),
      }),
    );
    const largeResult = resolveVariableAliases(oneModeInput(largeCycle));
    expect(largeResult.variables).toHaveLength(400);
    expect(largeResult.diagnostics).toHaveLength(1);
    expect(
      largeResult.variables.every((item) => item.values[0]?.status === "cycle"),
    ).toBe(true);
  });
});
