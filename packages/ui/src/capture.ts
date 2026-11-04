import type { DocType, DocumentInput } from "@pde/core";
import { LitElement, css, html } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { renderSVG } from "uqr";
import { DOC_LABELS } from "./labels.ts";
import { tokens } from "./styles.ts";
import "./camera.ts";

const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif";
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * One document slot. Primary: "Upload a file" (PDF, scan, screenshot or a
 * photo already on the device — works everywhere, no camera permission).
 * Secondary: "Take a photo" — live camera, the OS camera via file input, or
 * a QR code to continue on a phone when this device has no camera.
 *
 * Emits `document-selected` with `{ input, via }`. Nothing is uploaded: the
 * file is read into memory and handed to the on-device pipeline.
 */
export class PdeCapture extends LitElement {
  static override properties = {
    docType: { type: String, attribute: "doc-type" },
    handoffUrl: { type: String, attribute: "handoff-url" },
    dragging: { state: true },
    mode: { state: true },
    error: { state: true },
  };
  docType: DocType = "generic";
  /** URL to open on a phone (same request id); enables the QR handoff. */
  handoffUrl = "";
  dragging = false;
  mode: "idle" | "camera" | "qr" = "idle";
  error = "";

  static override styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      .drop {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 150px;
        padding: 20px;
        border: 2px dashed var(--pde-border);
        border-radius: var(--pde-radius);
        background: var(--pde-surface);
        text-align: center;
        cursor: pointer;
      }
      .drop.dragging {
        border-color: var(--pde-accent);
      }
      .drop .big {
        font-size: 18px;
        font-weight: 600;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        margin-top: 12px;
      }
      .qr {
        margin-top: 12px;
        padding: 16px;
        border: 1px solid var(--pde-border);
        border-radius: var(--pde-radius);
        text-align: center;
      }
      .qr svg {
        width: 200px;
        height: 200px;
        background: #fff;
        padding: 8px;
        border-radius: 8px;
      }
      .error {
        color: var(--pde-bad);
        margin-top: 8px;
      }
      .drop {
        position: relative;
      }
      .drop:focus-within {
        outline: 3px solid var(--pde-accent);
        outline-offset: 2px;
      }
      input.cover {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
        font-size: 0;
      }
      .photo {
        position: relative;
        display: inline-block;
      }
      .photo:focus-within {
        outline: 3px solid var(--pde-accent);
        outline-offset: 2px;
        border-radius: var(--pde-radius);
      }
    `,
  ];

  private get label() {
    return DOC_LABELS[this.docType];
  }

  override render() {
    const photoClass = this.label.photoFirst ? "primary" : "";
    return html`
      <div
        class="drop ${this.dragging ? "dragging" : ""}"
        data-testid="drop-zone"
        @dragover=${(e: DragEvent) => {
          e.preventDefault();
          this.dragging = true;
        }}
        @dragleave=${() => (this.dragging = false)}
        @drop=${this.onDrop}
      >
        <span class="big">Upload a file</span>
        <span class="muted">PDF, scan or photo · click or drag it here</span>
        <!-- The real file input covers the whole box: a click lands on the
             browser's own control, which opens the picker in every browser. -->
        <input
          type="file"
          class="cover"
          accept=${ACCEPT}
          @change=${this.onPick}
          data-testid="file-input"
          aria-label="Upload a file: PDF, scan or photo"
          title="Upload a file"
        />
      </div>
      <div class="row">
        <span class="muted">or</span>
        ${isPhone()
          ? // Phones: the OS camera input itself sits over the button, so the
            // tap opens the camera directly (iOS ignores camera inputs opened
            // from script after an await, and its live camera is unreliable
            // in a page). The photo still goes through the quality check.
            html`<span class="photo">
              <button class=${photoClass} tabindex="-1" aria-hidden="true">Take a photo</button>
              <input
                type="file"
                class="cover"
                accept="image/*"
                capture="environment"
                @change=${this.onPick}
                id="native-camera"
                data-testid="camera-input"
                aria-label="Take a photo"
              />
            </span>`
          : html`<button class=${photoClass} @click=${this.onTakePhoto}>Take a photo</button>`}
      </div>
      ${this.mode === "qr" ? this.renderQr() : null}
      ${this.mode === "camera"
        ? html`<pde-camera
            .docType=${this.docType}
            @captured=${(e: CustomEvent<DocumentInput>) => {
              this.mode = "idle";
              this.emit(e.detail, "camera");
            }}
            @cancel=${() => (this.mode = "idle")}
            @unavailable=${(e: CustomEvent<string>) => {
              this.mode = this.handoffUrl ? "qr" : "idle";
              this.error = `The camera could not be opened (${e.detail}). Upload a file instead${this.handoffUrl ? ", or continue on your phone" : ""}.`;
            }}
          ></pde-camera>`
        : null}
      ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : null}
    `;
  }

  private renderQr() {
    return html`<div class="qr">
      <div>${unsafeSVG(renderSVG(this.handoffUrl, { border: 1 }))}</div>
      <p><strong>No camera here? Continue on your phone.</strong></p>
      <p class="muted">Scan this code. Your phone reads the document itself — nothing passes through this computer.</p>
      <button class="link" @click=${() => (this.mode = "idle")}>Close</button>
    </div>`;
  }

  /** Desktop only (phones use the OS camera input): live camera, else the QR hand-off. */
  private async onTakePhoto() {
    this.error = "";
    const hasLiveCamera = !!navigator.mediaDevices?.getUserMedia && (await hasVideoInput());
    if (hasLiveCamera) this.mode = "camera";
    else if (this.handoffUrl) this.mode = "qr";
    else this.error = "This device has no camera. Upload a file instead.";
  }

  private onDrop = (e: DragEvent) => {
    e.preventDefault();
    this.dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) void this.readFile(file, "upload");
  };

  private onPick = (e: Event) => {
    const el = e.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = "";
    if (file) void this.readFile(file, el.id === "native-camera" ? "camera" : "upload");
  };

  private async readFile(file: File, via: "upload" | "camera") {
    this.error = "";
    if (file.size > MAX_BYTES) {
      this.error = "That file is larger than 25 MB. Try a smaller PDF or a photo.";
      return;
    }
    const looksOk = file.type === "application/pdf" || file.type.startsWith("image/") || /\.pdf$/i.test(file.name);
    if (!looksOk) {
      this.error = "Please choose a PDF or an image.";
      return;
    }
    this.emit({ name: file.name, mime: file.type || "application/octet-stream", bytes: await file.arrayBuffer() }, via);
  }

  private emit(input: DocumentInput, via: "upload" | "camera") {
    this.dispatchEvent(new CustomEvent("document-selected", { detail: { input, via }, bubbles: true, composed: true }));
  }
}

/** Touch-first devices (phones, tablets), where the OS camera app is the better camera. */
function isPhone(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
}

async function hasVideoInput(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === "videoinput");
  } catch {
    return false;
  }
}

customElements.define("pde-capture", PdeCapture);
