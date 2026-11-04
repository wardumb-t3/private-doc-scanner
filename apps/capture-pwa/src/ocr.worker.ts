import { serveOcrWorker } from "@pde/engines-web";

// OCR runs here, off the main thread, so the page stays responsive on slow phones.
serveOcrWorker(self as unknown as Parameters<typeof serveOcrWorker>[0]);
