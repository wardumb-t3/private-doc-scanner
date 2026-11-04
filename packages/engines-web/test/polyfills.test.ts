import { describe, expect, it } from "vitest";

describe("ReadableStream async iteration polyfill (Safari / iOS)", () => {
  it("lets for-await loop over a stream where the browser cannot", async () => {
    const proto = ReadableStream.prototype as unknown as Record<PropertyKey, unknown>;
    const saved = { it: proto[Symbol.asyncIterator], values: proto.values };
    delete proto[Symbol.asyncIterator];
    delete proto.values;
    try {
      // First evaluation in this test file (each file has its own module graph).
      await import("../src/polyfills.ts");
      const stream = new ReadableStream<number>({
        start(c) {
          [1, 2, 3].forEach((n) => c.enqueue(n));
          c.close();
        },
      });
      const seen: number[] = [];
      for await (const n of stream as unknown as AsyncIterable<number>) seen.push(n);
      expect(seen).toEqual([1, 2, 3]);
      expect(stream.locked).toBe(false);

      // Leaving early cancels the stream, as the spec requires.
      let cancelled = false;
      const endless = new ReadableStream<number>({ pull: (c) => c.enqueue(0), cancel: () => void (cancelled = true) });
      for await (const _ of endless as unknown as AsyncIterable<number>) break;
      expect(cancelled).toBe(true);
    } finally {
      proto[Symbol.asyncIterator] = saved.it;
      proto.values = saved.values;
    }
  });
});
