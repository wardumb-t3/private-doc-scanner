export { PaddleOcrEngine, type PaddleModels, type PaddleOcrOptions } from "./paddle/engine.ts";
export { dbBoxes, type DetBox } from "./paddle/db-postprocess.ts";
export { ctcDecode, buildCharset, allowedClasses } from "./paddle/ctc.ts";
export { TesseractEngine, type TesseractEngineOptions } from "./tesseract.ts";
export { PdfReader, groupCells, type PdfReaderOptions, type CanvasLike } from "./pdf.ts";
export { assessQuality, DEFAULT_QUALITY, type QualityThresholds } from "@pde/core";
export { detectCapabilities, pickTier, type Capabilities, type Tier } from "./capabilities.ts";
export { loadAsset, assetsCached, AssetIntegrityError, type AssetRef, type ModelManifest } from "./assets.ts";
export { decodeImageBrowser, createBrowserCanvas } from "./image.ts";
export {
  createWebEngines,
  createOcrEngine,
  serveOcrWorker,
  WorkerOcrEngine,
  assetsForTier,
  type WebEngines,
  type WebEnginesConfig,
  type OcrEngineConfig,
} from "./platform.ts";
