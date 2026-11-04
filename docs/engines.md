# Adding an OCR engine

Engines are pluggable through `OcrEngine` (`packages/core/src/types.ts`):

```ts
interface OcrEngine {
  readonly id: string;
  recognize(image: PageImage, options?: { charWhitelist?: string; layout?: "page" | "band" }): Promise<TextLine[]>;
  recognizeRegion?(image: PageImage, region: BBox | RotatedBox, options?): Promise<{ text: string; confidence: number }>;
  dispose?(): Promise<void>;
}
```

- `PageImage` is RGBA pixels (`width`, `height`, `data`), the same layout as `ImageData`, but without depending on the DOM.
- Return one `TextLine` per detected line or cell:
  - `bbox` in image pixels, axis-aligned
  - `rect` (optional) as a rotated box, when the engine knows the text angle
  - `confidence` in 0..1
- `charWhitelist`: restrict output to these characters. The MRZ pass uses it with `A–Z 0–9 <`.
- `recognizeRegion` (optional): read a single line inside a given box without running detection. The MRZ pass uses it to finish lines whose `<<<<` filler runs the detector missed.

Current engines:

| Engine | Package | Tier | Notes |
|---|---|---|---|
| PP-OCRv4 mobile (det + rec) on ONNX Runtime | `@pde/engines-web` `PaddleOcrEngine` | W1 (WebGPU), W2 (WASM) | Rotated-box DB post-processing, rotated crops, CTC with whitelist |
| Tesseract LSTM via tesseract.js | `@pde/engines-web` `TesseractEngine` | L (low-end) | ~5 MB download |

Wanted (good first contributions):

- **Native:** Apple Vision (`RecognizeDocumentsRequest`, iOS 26) and Google ML Kit Text Recognition v2, through a Capacitor shell (`@pde/engines-native`).
- **Models:** PP-OCRv5 mobile weights, and an MRZ-specific recogniser (~300 KB CNN) trained on synthetic OCR-B lines.

Run `pnpm bench` before and after a change to see the effect on accuracy and on **validated-but-wrong**, which must stay 0.
