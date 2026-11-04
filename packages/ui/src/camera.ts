import { assessQuality, type DocType, type DocumentInput } from "@pde/core";
import { LitElement, css, html } from "lit";
import { tokens } from "./styles.ts";

const HINT_MS = 600;

/**
 * Live camera capture with a document frame and real-time quality hints
 * (blur / glare / too dark), computed on-device from small preview frames.
 * Emits `captured` (DocumentInput, JPEG), `cancel`, or `unavailable` (detail: reason) when
 * the camera cannot be opened (permission denied, embedded without camera
 * permission…), so the caller can explain and offer another way in.
 */
export class PdeCamera extends LitElement {
  static override properties = { docType: { attribute: false }, hint: { state: true }, ready: { state: true } };
  docType: DocType = "generic";
  hint = "Starting camera…";
  ready = false;
  private stream: MediaStream | null = null;
  private timer = 0;

  static override styles = [
    tokens,
    css`
      :host {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: #000;
        display: flex;
        flex-direction: column;
      }
      .stage {
        position: relative;
        flex: 1;
        overflow: hidden;
      }
      video {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .frame {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        border: 3px solid rgba(255, 255, 255, 0.9);
        border-radius: 14px;
        box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
      }
      .hint {
        position: absolute;
        left: 16px;
        right: 16px;
        bottom: 16px;
        text-align: center;
        color: #fff;
        font-size: 16px;
        text-shadow: 0 1px 2px #000;
      }
      .bar {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 16px;
        background: #000;
      }
    `,
  ];

  private get frameStyle() {
    // ID-1 cards are 85.6 × 54 mm; passports' data page is close; pages are A4.
    const card = this.docType === "passport" || this.docType === "id_card";
    return card ? "width: min(90vw, 140vh); aspect-ratio: 1.42" : "height: min(80vh, 125vw); aspect-ratio: 0.707";
  }

  override async connectedCallback() {
    super.connectedCallback();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1440 } },
        audio: false,
      });
    } catch (err) {
      const name = (err as Error).name;
      const reason = name === "NotAllowedError" ? "camera permission was not given" : name === "NotFoundError" ? "no camera found" : (err as Error).message || name;
      this.dispatchEvent(new CustomEvent("unavailable", { detail: reason }));
      return;
    }
    await this.updateComplete;
    const video = this.renderRoot.querySelector("video")!;
    // iOS only plays a camera stream inline when these are set as properties.
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.stream;
    await video.play().catch(() => {});
    this.ready = true;
    this.timer = window.setInterval(() => this.updateHint(video), HINT_MS);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  override render() {
    return html`<div class="stage">
        <video playsinline muted></video>
        <div class="frame" style=${this.frameStyle} aria-hidden="true"></div>
        <div class="hint" role="status" aria-live="polite">${this.hint}</div>
      </div>
      <div class="bar">
        <button @click=${() => this.dispatchEvent(new CustomEvent("cancel"))}>Cancel</button>
        <button class="primary" ?disabled=${!this.ready} @click=${this.capture}>Capture</button>
      </div>`;
  }

  private grab(video: HTMLVideoElement, maxSide: number) {
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.max(1, Math.round(video.videoWidth * scale));
    const h = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, w, h);
    return { canvas, ctx, w, h };
  }

  private updateHint(video: HTMLVideoElement) {
    if (!video.videoWidth) return;
    const { ctx, w, h, canvas } = this.grab(video, 480);
    const q = assessQuality({ page: 1, width: w, height: h, data: ctx.getImageData(0, 0, w, h).data }, {
      minBlurScore: 40,
      maxGlareRatio: 0.05,
      minShortSide: 0,
      minMeanLuma: 50,
    });
    canvas.width = 1;
    if (q.issues.includes("too_dark")) this.hint = "Too dark — move to better light";
    else if (q.issues.includes("glare")) this.hint = "Glare — tilt the document slightly";
    else if (q.issues.includes("blurry")) this.hint = "Hold steady…";
    else this.hint = "Looks good — fit the document in the frame and capture";
  }

  private capture = async () => {
    const video = this.renderRoot.querySelector("video")!;
    const { canvas } = this.grab(video, 2400);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    canvas.width = 1;
    if (!blob) return;
    const input: DocumentInput = { name: "camera.jpg", mime: "image/jpeg", bytes: await blob.arrayBuffer() };
    this.dispatchEvent(new CustomEvent("captured", { detail: input }));
  };
}

customElements.define("pde-camera", PdeCamera);
