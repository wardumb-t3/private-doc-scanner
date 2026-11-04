// pdf.js's worker, with the stream polyfill it needs on Safari / iOS loaded
// first (modules evaluate in import order).
import "@pde/engines-web/polyfills";
import "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
