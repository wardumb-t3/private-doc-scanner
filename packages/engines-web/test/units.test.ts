import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import { allowedClasses, assessQuality, buildCharset, ctcDecode, dbBoxes, detectCapabilities, groupCells, loadAsset, pickTier } from "../src/index.ts";

describe("CTC decoding", () => {
  const charset = buildCharset("A\nB\n<\n");
  // classes: 0 blank, 1 A, 2 B, 3 <, 4 space
  const probs = (rows: number[][]) => new Float32Array(rows.flat());

  it("collapses repeats and drops blanks", () => {
    const p = probs([
      [0.1, 0.8, 0.05, 0.05, 0],
      [0.1, 0.8, 0.05, 0.05, 0],
      [0.9, 0.05, 0.05, 0, 0],
      [0.1, 0.8, 0.05, 0.05, 0],
      [0.1, 0.05, 0.8, 0.05, 0],
    ]);
    expect(ctcDecode(p, 5, 5, charset).text).toBe("AAB");
  });

  it("restricts output to a whitelist", () => {
    const p = probs([[0.1, 0.5, 0.0, 0.4, 0]]);
    expect(ctcDecode(p, 1, 5, charset, allowedClasses(charset, "<")).text).toBe("<");
  });
});

describe("DB post-processing", () => {
  it("finds separate text blobs and grows them", () => {
    const w = 40, h = 20;
    const prob = new Float32Array(w * h);
    for (let y = 5; y < 10; y++) for (let x = 2; x < 15; x++) prob[y * w + x] = 0.9;
    for (let y = 5; y < 10; y++) for (let x = 25; x < 38; x++) prob[y * w + x] = 0.9;
    prob[0] = 0.95; // single-pixel speck is ignored
    const boxes = dbBoxes(prob, w, h).sort((a, b) => a.cx - b.cx);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.angle).toBe(0);
    expect(boxes[0]!.cx).toBeCloseTo(8.5, 0);
    expect(boxes[0]!.len).toBeGreaterThan(13);
  });

  it("recovers the angle of a tilted text line", () => {
    const w = 200, h = 80;
    const prob = new Float32Array(w * h);
    const tilt = (5 * Math.PI) / 180;
    for (let u = 0; u < 150; u++) {
      for (let v = -4; v <= 4; v++) {
        const x = Math.round(20 + u * Math.cos(tilt) - v * Math.sin(tilt));
        const y = Math.round(30 + u * Math.sin(tilt) + v * Math.cos(tilt));
        prob[y * w + x] = 0.9;
      }
    }
    const [box] = dbBoxes(prob, w, h);
    expect(box!.angle).toBeCloseTo(tilt, 1);
    expect(box!.len).toBeGreaterThan(150);
  });
});

describe("pdf text grouping", () => {
  it("joins items on a row and splits table cells at wide gaps", () => {
    const lines = groupCells(
      [
        { str: "Net", x: 10, y: 100, w: 30, h: 12 },
        { str: "Pay", x: 44, y: 100, w: 30, h: 12 },
        { str: "4,000.00", x: 300, y: 101, w: 60, h: 12 },
        { str: "Gross", x: 10, y: 80, w: 40, h: 12 },
      ],
      1,
    );
    expect(lines.map((l) => l.text)).toEqual(["Gross", "Net Pay", "4,000.00"]);
  });
});

describe("quality gate", () => {
  const draw = (blur: number, glare = false) => {
    const c = createCanvas(900, 600);
    const g = c.getContext("2d");
    g.fillStyle = "#d9d6cc"; // photographed paper is never pure white
    g.fillRect(0, 0, 900, 600);
    if (blur) g.filter = `blur(${blur}px)`;
    g.fillStyle = "#111";
    g.font = "28px DejaVu Sans";
    for (let i = 0; i < 12; i++) g.fillText("The quick brown fox 1234567890", 30, 50 + i * 45);
    g.filter = "none";
    if (glare) {
      g.fillStyle = "#fff";
      g.fillRect(400, 100, 350, 300);
    }
    const d = g.getImageData(0, 0, 900, 600);
    return { page: 1, width: 900, height: 600, data: d.data };
  };
  it("passes a sharp image", () => {
    expect(assessQuality(draw(0))).toMatchObject({ ok: true, issues: [] });
  });
  it("flags blur", () => {
    expect(assessQuality(draw(4)).issues).toContain("blurry");
  });
  it("flags glare", () => {
    expect(assessQuality(draw(0, true)).issues).toContain("glare");
  });
  it("does not mistake a white scanned page for glare", () => {
    const c = createCanvas(900, 600);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 900, 600);
    g.fillStyle = "#111";
    g.font = "28px DejaVu Sans";
    for (let i = 0; i < 12; i++) g.fillText("The quick brown fox 1234567890", 30, 50 + i * 45);
    const d = g.getImageData(0, 0, 900, 600);
    expect(assessQuality({ page: 1, width: 900, height: 600, data: d.data }).issues).not.toContain("glare");
  });
});

describe("tiers", () => {
  const base = { webgpu: false, wasmSimd: true, threads: false, deviceMemoryGb: 8, cores: 8, offscreenCanvas: true };
  it("picks by capability", () => {
    expect(pickTier({ ...base, webgpu: true })).toBe("W1");
    expect(pickTier(base)).toBe("W2");
    expect(pickTier({ ...base, deviceMemoryGb: 2, webgpu: true })).toBe("L");
    expect(pickTier({ ...base, wasmSimd: false })).toBe("L");
    expect(pickTier({ ...base, webgpu: true, deviceMemoryGb: null })).toBe("W1");
    expect(pickTier({ ...base, webgpu: true, ios: true })).toBe("W2");
  });
});

describe("WebKit", () => {
  const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
  const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const withBrowser = async (userAgent: string) => {
    vi.stubGlobal("navigator", { userAgent, hardwareConcurrency: 8, maxTouchPoints: 0, gpu: { requestAdapter: async () => ({}) } });
    vi.stubGlobal("crossOriginIsolated", true);
    try {
      return await detectCapabilities();
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("uses single-threaded WASM on Safari and every iOS browser", async () => {
    for (const ua of [SAFARI, IPHONE_CHROME]) {
      const c = await withBrowser(ua);
      expect(c.webkit).toBe(true);
      expect(c.tier).toBe("W2");
      expect(c.threads).toBe(false);
    }
  });

  it("keeps WebGPU and threads on desktop Chrome", async () => {
    const c = await withBrowser(MAC_CHROME);
    expect(c.webkit).toBe(false);
    expect(c.tier).toBe("W1");
    expect(c.threads).toBe(true);
  });
});

describe("model download", () => {
  it("names the file and how far it got when a download stalls", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_500_000));
        // ...then nothing more arrives.
      },
    });
    // Like a real stalled fetch: the abort signal alone does not end the body.
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(body)));
    try {
      await expect(loadAsset({ url: "https://app.example/models/ppocr_rec.onnx", sha256: "00", bytes: 10_822_323 }, undefined, 50)).rejects.toThrow(
        "downloading ppocr_rec.onnx stopped at 1.5 of 10.8 MB",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
