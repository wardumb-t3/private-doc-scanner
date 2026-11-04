/**
 * Side-effect module: import it before pdf.js (on the page and in pdf.js's
 * worker). pdf.js loops over streams with `for await (… of stream)`, which
 * Safari and every iOS browser (all WebKit) did not support until recently;
 * there it fails with "undefined is not a function (near '...e of t...')".
 */
interface StreamIterator<R> extends AsyncIterableIterator<R> {
  return(value?: unknown): Promise<IteratorResult<R>>;
}

const proto = (typeof ReadableStream !== "undefined" ? ReadableStream.prototype : null) as
  | (ReadableStream & { values?: (opts?: { preventCancel?: boolean }) => StreamIterator<unknown>; [Symbol.asyncIterator]?: unknown })
  | null;

if (proto && typeof proto[Symbol.asyncIterator] !== "function") {
  // Per the Streams spec: iterating locks the stream; leaving the loop early
  // (break / throw) cancels it unless preventCancel is set.
  const values = function (this: ReadableStream, { preventCancel = false }: { preventCancel?: boolean } = {}): StreamIterator<unknown> {
    const reader = this.getReader();
    return {
      async next() {
        const r = await reader.read();
        if (r.done) reader.releaseLock();
        return r.done ? { done: true, value: undefined } : { done: false, value: r.value };
      },
      async return(value?: unknown) {
        if (!preventCancel) await reader.cancel(value);
        reader.releaseLock();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  Object.defineProperty(proto, "values", { value: values, writable: true, configurable: true });
  Object.defineProperty(proto, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
}

export {};
