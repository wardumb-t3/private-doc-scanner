import { describe, expect, it } from "vitest";
import { NetworkMonitor } from "../src/network-monitor.ts";

describe("network monitor", () => {
  const self = "https://capture.example";
  (globalThis as { location?: unknown }).location = { origin: self, href: `${self}/` };

  it("classifies a same-origin relay path as the submission", () => {
    const m = new NetworkMonitor({ destinationOrigins: [`${self}/t3`] });
    m.record(`${self}/t3/api/rpc`);
    m.record(`${self}/t3`);
    m.record(`${self}/assets/index.js`);
    m.record(`${self}/models/ppocr_det.onnx`);
    m.record(`${self}/t3x/evil`);
    expect(m.entries.map((e) => e.kind)).toEqual(["submission", "submission", "app", "model", "app"]);
    expect(m.trusted).toBe(true);
  });

  it("classifies a bare destination origin and flags anything else", () => {
    const m = new NetworkMonitor({ destinationOrigins: ["https://node.example"] });
    m.record("https://node.example/api/rpc");
    m.record("https://cdn.evil.example/x.js");
    expect(m.entries.map((e) => e.kind)).toEqual(["submission", "unexpected"]);
    expect(m.trusted).toBe(false);
  });
});
