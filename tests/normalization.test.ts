import { describe, expect, it } from "vitest";

import { DiagnosticBag } from "../src/shared/diagnostics";
import { FIGMA_MIXED_VALUE, type JsonObject } from "../src/shared/ir";
import { normalizeJsonSafeValue } from "../src/shared/normalization";
import { serializeCanonicalJson } from "../src/shared/serialization";

describe("JSON-safe normalization", () => {
  it("replaces every non-finite number with null and records its exact path", () => {
    const diagnostics = new DiagnosticBag("normalization-number-test");
    const result = normalizeJsonSafeValue(
      {
        nested: {
          positive: Number.POSITIVE_INFINITY,
          nan: Number.NaN,
          negative: Number.NEGATIVE_INFINITY,
        },
      },
      { diagnostics },
    );
    const value = result.value as JsonObject;

    expect(value.nested).toEqual({
      nan: null,
      negative: null,
      positive: null,
    });
    expect(result.diagnostics.map((item) => item.propertyPath)).toEqual([
      "$.nested.nan",
      "$.nested.negative",
      "$.nested.positive",
    ]);
    expect(result.diagnostics.every((item) => item.causedDataLoss)).toBe(true);

    const laterResult = normalizeJsonSafeValue(Number.NaN, { diagnostics });
    expect(laterResult.diagnostics[0]?.id).toBe(
      "normalization-number-test-000004",
    );
    expect(new Set(diagnostics.list().map((item) => item.id)).size).toBe(4);
  });

  it("classifies an injected synthetic mixed sentinel before generic symbols", () => {
    const mixedSentinel = Symbol("synthetic-figma-mixed");
    const result = normalizeJsonSafeValue(
      {
        exactText: "e\u0301",
        mixed: mixedSentinel,
      },
      {
        diagnostics: new DiagnosticBag("normalization-mixed-test"),
        classifySpecialValue: (value) =>
          value === mixedSentinel ? FIGMA_MIXED_VALUE : undefined,
      },
    );

    expect(result.value).toEqual({
      exactText: "e\u0301",
      mixed: { $type: "figma-mixed" },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("retains unsupported, cyclic, and inaccessible values as explicit tags", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const throwingObject = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(throwingObject, "futureProperty", {
      enumerable: true,
      get() {
        throw new TypeError("synthetic getter detail must not escape");
      },
    });
    const sparseArray = new Array<unknown>(2);
    sparseArray[1] = "retained item";
    const arrayWithExtraProperty = ["ordered"] as unknown[] & {
      syntheticExtra?: string;
    };
    arrayWithExtraProperty.syntheticExtra = "must be diagnosed";
    const symbolKeyedObject = { retained: true } as Record<
      string | symbol,
      unknown
    >;
    symbolKeyedObject[Symbol("synthetic-key")] = "must be diagnosed";

    const result = normalizeJsonSafeValue(
      {
        bigint: 42n,
        arrayWithExtraProperty,
        cycle,
        functionValue: () => 1,
        nonPlain: new Date(0),
        sparseArray,
        symbol: Symbol("synthetic unknown"),
        symbolKeyedObject,
        throwingObject,
        undefinedValue: undefined,
      },
      { diagnostics: new DiagnosticBag("normalization-unsupported-test") },
    );
    const serialized = serializeCanonicalJson({
      diagnostics: result.diagnostics,
      value: result.value,
    });

    expect(serialized).toContain('"reason": "bigint"');
    expect(serialized).toContain('"reason": "cyclic-reference"');
    expect(serialized).toContain('"reason": "function"');
    expect(serialized).toContain('"reason": "non-plain-object"');
    expect(serialized).toContain('"reason": "symbol"');
    expect(serialized).toContain('"reason": "undefined"');
    expect(serialized).toContain('"reason": "property-access-failed"');
    expect(serialized).toContain('"reason": "array-extra-property"');
    expect(serialized).toContain('"reason": "symbol-keyed-property"');
    expect(serialized).toContain("retained item");
    expect(serialized).not.toContain("synthetic getter detail must not escape");
    expect(result.diagnostics).toHaveLength(10);
  });
});
