export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled.");
    this.name = "ExportCancelledError";
  }
}

export class ExportCancellationToken {
  #cancelled = false;

  get cancelled(): boolean {
    return this.#cancelled;
  }

  cancel(): void {
    this.#cancelled = true;
  }

  throwIfCancelled(): void {
    if (this.#cancelled) {
      throw new ExportCancelledError();
    }
  }
}

export function yieldToFigma(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
