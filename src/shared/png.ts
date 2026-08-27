export interface PngDimensions {
  readonly width: number;
  readonly height: number;
}

export interface PreviewExportPlan {
  readonly constraint:
    | { readonly type: "SCALE"; readonly value: 1 }
    | { readonly type: "WIDTH" | "HEIGHT"; readonly value: 4096 };
  readonly scale: number;
}

export class PngContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngContractError";
  }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export function planPreviewExport(
  width: number,
  height: number,
): PreviewExportPlan {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new PngContractError(
      "Preview source dimensions must be finite and positive.",
    );
  }
  const longestDimension = Math.max(width, height);
  if (longestDimension <= 4096) {
    return {
      constraint: { type: "SCALE", value: 1 },
      scale: 1,
    };
  }
  return {
    constraint: {
      type: width >= height ? "WIDTH" : "HEIGHT",
      value: 4096,
    },
    scale: 4096 / longestDimension,
  };
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

export function readPngDimensions(bytes: Uint8Array): PngDimensions {
  if (
    bytes.length < 24 ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  ) {
    throw new PngContractError("Preview bytes are not a canonical PNG stream.");
  }
  const width = readUint32BigEndian(bytes, 16);
  const height = readUint32BigEndian(bytes, 20);
  if (width <= 0 || height <= 0) {
    throw new PngContractError("PNG preview dimensions must be positive.");
  }
  return { width, height };
}
