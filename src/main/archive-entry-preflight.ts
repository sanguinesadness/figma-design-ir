import {
  ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT,
  ArchiveProducerSafetyError,
} from "../shared/archive";
import { CanonicalSerializationError } from "../shared/serialization";
import { yieldToFigma } from "./cancellation";

const DEFAULT_TEXT_YIELD_INTERVAL = 256 * 1024;

export interface ArchiveEntryPreflightOptions {
  readonly byteLimit?: number | undefined;
  readonly checkpoint: () => void;
  readonly textYieldInterval?: number | undefined;
  readonly yieldControl?: () => Promise<void>;
}

type CanonicalMeasureFrame =
  | {
      readonly kind: "value";
      readonly value: unknown;
      readonly depth: number;
    }
  | {
      readonly kind: "array-item";
      readonly value: readonly unknown[];
      readonly depth: number;
      readonly index: number;
      readonly length: number;
    }
  | {
      readonly kind: "array-after-item";
      readonly value: readonly unknown[];
      readonly depth: number;
      readonly index: number;
      readonly length: number;
    }
  | {
      readonly kind: "object-item";
      readonly value: Record<string, unknown>;
      readonly depth: number;
      readonly keys: readonly string[];
      readonly index: number;
    }
  | {
      readonly kind: "object-after-key";
      readonly value: Record<string, unknown>;
      readonly depth: number;
      readonly keys: readonly string[];
      readonly index: number;
      readonly key: string;
    }
  | {
      readonly kind: "object-after-item";
      readonly value: Record<string, unknown>;
      readonly depth: number;
      readonly keys: readonly string[];
      readonly index: number;
    }
  | {
      readonly kind: "json-string";
      readonly value: string;
      readonly index: number;
    };

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function canonicalSerializationError(message: string): never {
  throw new CanonicalSerializationError(message);
}

function requireCanonicalObjectKeys(value: object): string[] {
  let keys: string[];
  let symbols: symbol[];
  try {
    keys = Object.keys(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return canonicalSerializationError(
      "Canonical JSON could not inspect object keys; normalize it first.",
    );
  }
  if (symbols.length > 0) {
    return canonicalSerializationError(
      "Canonical JSON cannot omit symbol-keyed properties; normalize them first.",
    );
  }
  return keys;
}

function requirePlainCanonicalObject(value: object): Record<string, unknown> {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return canonicalSerializationError(
      "Canonical JSON could not inspect an object prototype; normalize it first.",
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return canonicalSerializationError(
      "Canonical JSON accepts only arrays and plain objects.",
    );
  }
  return value as Record<string, unknown>;
}

function isArrayIndexKey(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function requireArrayLength(value: readonly unknown[]): number {
  let length: number;
  try {
    length = value.length;
  } catch {
    return canonicalSerializationError(
      "Canonical JSON could not inspect an array length; normalize it first.",
    );
  }
  if (
    requireCanonicalObjectKeys(value).some(
      (key) => !isArrayIndexKey(key, length),
    )
  ) {
    return canonicalSerializationError(
      "Canonical JSON cannot omit non-index array properties; normalize them first.",
    );
  }
  return length;
}

function readCanonicalArrayItem(
  value: readonly unknown[],
  index: number,
): unknown {
  try {
    return value[index];
  } catch {
    return canonicalSerializationError(
      "Canonical JSON could not read an array item; normalize it first.",
    );
  }
}

function readCanonicalObjectProperty(
  value: Record<string, unknown>,
  key: string,
): unknown {
  try {
    return value[key];
  } catch {
    return canonicalSerializationError(
      "Canonical JSON could not read an object property; normalize it first.",
    );
  }
}

/**
 * Rejects an entry before structured clone or UTF-8 allocation. Text is counted
 * exactly like TextEncoder and yields cooperatively during substantial scans.
 */
export async function assertArchiveEntryFits(
  data: string | Uint8Array,
  options: ArchiveEntryPreflightOptions,
): Promise<void> {
  const byteLimit = requirePositiveSafeInteger(
    options.byteLimit ?? ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT,
    "Archive entry byte limit",
  );
  const textYieldInterval = requirePositiveSafeInteger(
    options.textYieldInterval ?? DEFAULT_TEXT_YIELD_INTERVAL,
    "Archive text preflight yield interval",
  );
  const yieldControl = options.yieldControl ?? yieldToFigma;

  options.checkpoint();
  if (typeof data !== "string") {
    if (data.byteLength > byteLimit) {
      throw new ArchiveProducerSafetyError("archive-capacity-exceeded");
    }
    options.checkpoint();
    return;
  }

  let byteLength = 0;
  let index = 0;
  let nextYieldIndex = textYieldInterval;
  while (index < data.length) {
    const codeUnit = data.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
      index += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
      index += 1;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < data.length
    ) {
      const nextCodeUnit = data.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        byteLength += 4;
        index += 2;
      } else {
        byteLength += 3;
        index += 1;
      }
    } else {
      byteLength += 3;
      index += 1;
    }

    if (byteLength > byteLimit) {
      throw new ArchiveProducerSafetyError("archive-capacity-exceeded");
    }
    if (index >= nextYieldIndex) {
      await yieldControl();
      options.checkpoint();
      nextYieldIndex = index + textYieldInterval;
    }
  }
  options.checkpoint();
}

/**
 * Measures the exact UTF-8 length produced by serializeCanonicalJson without
 * cloning the canonical value or constructing its output string. Traversal is
 * iterative, stops as soon as the limit is crossed, and yields cooperatively.
 */
export async function assertCanonicalJsonFits(
  value: unknown,
  options: ArchiveEntryPreflightOptions,
): Promise<void> {
  const byteLimit = requirePositiveSafeInteger(
    options.byteLimit ?? ARCHIVE_SINGLE_ENTRY_BYTE_LIMIT,
    "Archive entry byte limit",
  );
  const workYieldInterval = requirePositiveSafeInteger(
    options.textYieldInterval ?? DEFAULT_TEXT_YIELD_INTERVAL,
    "Archive canonical preflight yield interval",
  );
  const yieldControl = options.yieldControl ?? yieldToFigma;
  const activeObjects = new WeakSet<object>();
  const frames: CanonicalMeasureFrame[] = [{ kind: "value", value, depth: 0 }];
  let byteLength = 0;
  let workSinceYield = 0;

  const addBytes = (count: number): void => {
    byteLength += count;
    if (byteLength > byteLimit) {
      throw new ArchiveProducerSafetyError("archive-capacity-exceeded");
    }
  };

  const yieldNow = async (): Promise<void> => {
    workSinceYield = 0;
    await yieldControl();
    options.checkpoint();
  };

  options.checkpoint();
  addBytes(1); // serializeCanonicalJson always appends one final newline.

  while (frames.length > 0) {
    const frame = frames.pop();
    if (frame === undefined) {
      break;
    }
    workSinceYield += 1;

    if (frame.kind === "json-string") {
      let stringIndex = frame.index;
      while (
        stringIndex < frame.value.length &&
        workSinceYield < workYieldInterval
      ) {
        const codeUnit = frame.value.charCodeAt(stringIndex);
        if (
          codeUnit === 0x22 ||
          codeUnit === 0x5c ||
          codeUnit === 0x08 ||
          codeUnit === 0x09 ||
          codeUnit === 0x0a ||
          codeUnit === 0x0c ||
          codeUnit === 0x0d
        ) {
          addBytes(2);
          stringIndex += 1;
        } else if (codeUnit <= 0x1f) {
          addBytes(6);
          stringIndex += 1;
        } else if (
          codeUnit >= 0xd800 &&
          codeUnit <= 0xdbff &&
          stringIndex + 1 < frame.value.length
        ) {
          const nextCodeUnit = frame.value.charCodeAt(stringIndex + 1);
          if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
            addBytes(4);
            stringIndex += 2;
          } else {
            addBytes(6);
            stringIndex += 1;
          }
        } else if (codeUnit >= 0xd800 && codeUnit <= 0xdfff) {
          addBytes(6);
          stringIndex += 1;
        } else if (codeUnit <= 0x7f) {
          addBytes(1);
          stringIndex += 1;
        } else if (codeUnit <= 0x7ff) {
          addBytes(2);
          stringIndex += 1;
        } else {
          addBytes(3);
          stringIndex += 1;
        }
        workSinceYield += 1;
      }
      if (stringIndex < frame.value.length) {
        frames.push({
          kind: "json-string",
          value: frame.value,
          index: stringIndex,
        });
      }
      if (workSinceYield >= workYieldInterval) {
        await yieldNow();
      }
      continue;
    }

    if (frame.kind === "array-item") {
      if (frame.index >= frame.length) {
        addBytes(frame.depth * 2 + 1);
        activeObjects.delete(frame.value);
      } else {
        addBytes((frame.depth + 1) * 2);
        frames.push({
          kind: "array-after-item",
          value: frame.value,
          depth: frame.depth,
          index: frame.index,
          length: frame.length,
        });
        frames.push({
          kind: "value",
          value: readCanonicalArrayItem(frame.value, frame.index),
          depth: frame.depth + 1,
        });
      }
      if (workSinceYield >= workYieldInterval) {
        await yieldNow();
      }
      continue;
    }

    if (frame.kind === "array-after-item") {
      addBytes(frame.index + 1 < frame.length ? 2 : 1);
      frames.push({
        kind: "array-item",
        value: frame.value,
        depth: frame.depth,
        index: frame.index + 1,
        length: frame.length,
      });
      if (workSinceYield >= workYieldInterval) {
        await yieldNow();
      }
      continue;
    }

    if (frame.kind === "object-item") {
      if (frame.index >= frame.keys.length) {
        addBytes(frame.depth * 2 + 1);
        activeObjects.delete(frame.value);
      } else {
        const key = frame.keys[frame.index];
        if (key === undefined) {
          return canonicalSerializationError(
            "Canonical JSON could not read a sorted object key.",
          );
        }
        addBytes((frame.depth + 1) * 2);
        frames.push({
          kind: "object-after-key",
          value: frame.value,
          depth: frame.depth,
          keys: frame.keys,
          index: frame.index,
          key,
        });
        addBytes(2);
        frames.push({
          kind: "json-string",
          value: key,
          index: 0,
        });
      }
      if (workSinceYield >= workYieldInterval) {
        await yieldNow();
      }
      continue;
    }

    if (frame.kind === "object-after-key") {
      addBytes(2);
      frames.push({
        kind: "object-after-item",
        value: frame.value,
        depth: frame.depth,
        keys: frame.keys,
        index: frame.index,
      });
      frames.push({
        kind: "value",
        value: readCanonicalObjectProperty(frame.value, frame.key),
        depth: frame.depth + 1,
      });
      if (workSinceYield >= workYieldInterval) {
        await yieldNow();
      }
      continue;
    }

    if (frame.kind === "object-after-item") {
      addBytes(frame.index + 1 < frame.keys.length ? 2 : 1);
      frames.push({
        kind: "object-item",
        value: frame.value,
        depth: frame.depth,
        keys: frame.keys,
        index: frame.index + 1,
      });
      if (workSinceYield >= workYieldInterval) {
        await yieldNow();
      }
      continue;
    }

    const current = frame.value;
    if (current === null) {
      addBytes(4);
    } else if (typeof current === "string") {
      addBytes(2);
      frames.push({ kind: "json-string", value: current, index: 0 });
    } else if (typeof current === "boolean") {
      addBytes(current ? 4 : 5);
    } else if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return canonicalSerializationError(
          "Canonical JSON cannot contain a non-finite number; normalize it first.",
        );
      }
      addBytes(Object.is(current, -0) ? 2 : String(current).length);
    } else if (typeof current !== "object") {
      return canonicalSerializationError(
        "Canonical JSON encountered a non-JSON runtime value; normalize it first.",
      );
    } else {
      if (activeObjects.has(current)) {
        return canonicalSerializationError(
          "Canonical JSON encountered a cyclic value; normalize it first.",
        );
      }
      activeObjects.add(current);
      let isArray: boolean;
      try {
        isArray = Array.isArray(current);
      } catch {
        return canonicalSerializationError(
          "Canonical JSON could not inspect a runtime value kind; normalize it first.",
        );
      }
      if (isArray) {
        const array = current as readonly unknown[];
        const length = requireArrayLength(array);
        if (length === 0) {
          addBytes(2);
          activeObjects.delete(current);
        } else {
          addBytes(2);
          frames.push({
            kind: "array-item",
            value: array,
            depth: frame.depth,
            index: 0,
            length,
          });
        }
      } else {
        const object = requirePlainCanonicalObject(current);
        const keys = requireCanonicalObjectKeys(object).sort();
        if (keys.length === 0) {
          addBytes(2);
          activeObjects.delete(current);
        } else {
          addBytes(2);
          frames.push({
            kind: "object-item",
            value: object,
            depth: frame.depth,
            keys,
            index: 0,
          });
        }
      }
    }
    if (workSinceYield >= workYieldInterval) {
      await yieldNow();
    }
  }

  options.checkpoint();
}
