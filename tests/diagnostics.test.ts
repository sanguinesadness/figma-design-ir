import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_CODES,
  DiagnosticBag,
  normalizeSafeTechnicalCause,
  summarizeDiagnostics,
  type DiagnosticSeverity,
} from "../src/shared/diagnostics";
import { serializeCanonicalJson } from "../src/shared/serialization";

function diagnosticsWith(
  severities: readonly DiagnosticSeverity[],
): ReturnType<DiagnosticBag["list"]> {
  const bag = new DiagnosticBag();
  for (const severity of severities) {
    bag.add({
      code: DIAGNOSTIC_CODES.normalizationUnsupportedValue,
      severity,
      message: "Synthetic diagnostic.",
      phase: "normalization",
      causedDataLoss: severity === "error" || severity === "fatal",
    });
  }
  return bag.list();
}

describe("diagnostic truthfulness", () => {
  it("calculates counts and completeness from severity semantics", () => {
    expect(summarizeDiagnostics(diagnosticsWith([]))).toEqual({
      counts: { info: 0, warning: 0, error: 0, fatal: 0 },
      completeness: "complete",
    });
    expect(summarizeDiagnostics(diagnosticsWith(["info"])).completeness).toBe(
      "complete",
    );
    expect(summarizeDiagnostics(diagnosticsWith(["info", "warning"]))).toEqual({
      counts: { info: 1, warning: 1, error: 0, fatal: 0 },
      completeness: "complete-with-warnings",
    });
    expect(summarizeDiagnostics(diagnosticsWith(["error"])).completeness).toBe(
      "incomplete",
    );
    expect(summarizeDiagnostics(diagnosticsWith(["fatal"])).completeness).toBe(
      "incomplete",
    );
  });

  it("normalizes thrown values without retaining messages, stacks, paths, or tokens", () => {
    const error = new TypeError(
      "synthetic-token=do-not-retain at /synthetic/private/path",
    );
    const normalizedError = normalizeSafeTechnicalCause(
      error,
      "property-access",
    );
    const normalizedUnknown = normalizeSafeTechnicalCause(
      { arbitrary: "synthetic secret" },
      "unknown",
    );
    const hostileThrownValue = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("synthetic hostile trap detail");
        },
      },
    );
    const normalizedHostile = normalizeSafeTechnicalCause(
      hostileThrownValue,
      "unknown",
    );
    const serialized = serializeCanonicalJson({
      normalizedError,
      normalizedHostile,
      normalizedUnknown,
    });

    expect(normalizedError).toEqual({
      category: "type-error",
      context: "property-access",
    });
    expect(normalizedUnknown.category).toBe("unknown-thrown-value");
    expect(normalizedHostile.category).toBe("unknown-thrown-value");
    expect(serialized).not.toMatch(
      /do-not-retain|private\/path|synthetic secret/,
    );
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("synthetic hostile trap detail");
  });
});
