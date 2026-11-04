import { applyUserEdit, getSchema, type ExtractedField, type ExtractionResult, type PageImage } from "@pde/core";
import { DATE_FORMAT_LABEL, displayToIso, displayToIsoRange, isoRangeToDisplay, isoToDisplay } from "./dates.ts";
import { LitElement, css, html, nothing } from "lit";
import { checkLabel, DOC_LABELS, SOURCE_LABELS } from "./labels.ts";
import { tokens } from "./styles.ts";

/**
 * Review screen for one document. Every field is shown next to a crop of
 * where it was read, with how it was read and whether a deterministic check
 * vouches for it. Highlighted fields need a look; one "Verify all" button
 * confirms them together. Dates are shown as DD-MM-YYYY. Emits
 * `review-complete` or `retake`.
 */
export class PdeReview extends LitElement {
  static override properties = {
    result: { attribute: false },
    errors: { state: true },
  };
  result!: ExtractionResult;
  /** Per-field input errors (e.g. a date that is not DD-MM-YYYY). */
  errors: Record<string, string> = {};

  static override styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      .notice-error {
        padding: 10px 14px;
        border-radius: var(--pde-radius);
        border: 1px solid var(--pde-bad);
        color: var(--pde-bad);
        margin-bottom: 12px;
      }
      .field {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
        padding: 12px 0;
        border-bottom: 1px solid var(--pde-border);
      }
      .field.flagged {
        background: color-mix(in srgb, var(--pde-warn) 8%, transparent);
        padding: 12px;
        border-radius: 10px;
        border-bottom: none;
        margin: 6px 0;
      }
      label {
        font-weight: 600;
      }
      input[type="text"] {
        font: inherit;
        font-size: 16px; /* no iOS zoom */
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--pde-border);
        background: var(--pde-bg);
        color: var(--pde-text);
        width: 100%;
      }
      .shared {
        display: grid;
        gap: 6px;
        margin-bottom: 8px;
      }
      canvas {
        max-width: 100%;
        max-height: 120px;
        object-fit: contain;
        object-position: left;
        height: auto;
        border-radius: 6px;
        border: 1px solid var(--pde-border);
        background: #fff;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        font-size: 13px;
      }
      .ok {
        color: var(--pde-ok);
      }
      .check {
        color: var(--pde-warn);
      }
      .error {
        color: var(--pde-bad);
        font-size: 14px;
      }
      input[aria-invalid="true"] {
        border-color: var(--pde-bad);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        justify-content: space-between;
        margin-top: 16px;
      }
    `,
  ];

  /** Fields read from one region (the MRZ) share a single crop shown once at the top. */
  private get sharedEvidenceKey(): string | null {
    const mrz = this.result.fields.filter((f) => f.source === "mrz" && f.evidence);
    return mrz.length > 1 ? mrz[0]!.key : null;
  }

  private sharesEvidence(f: ExtractedField): boolean {
    const key = this.sharedEvidenceKey;
    if (!key || !f.evidence) return false;
    const shared = this.result.fields.find((x) => x.key === key)!.evidence!;
    return f.evidence.bbox === shared.bbox || (f.evidence.bbox.x === shared.bbox.x && f.evidence.bbox.y === shared.bbox.y && f.evidence.bbox.w === shared.bbox.w);
  }

  private get highlighted(): ExtractedField[] {
    return this.result.fields.filter((f) => f.needsReview);
  }

  private kind(key: string) {
    return getSchema(this.result.docType).fields.find((s) => s.key === key)?.kind;
  }

  override render() {
    const r = this.result;
    return html`
      ${r.warnings.map((w) => html`<div class="notice-error" role="alert">${w}</div>`)}
      <p class="muted">
        Check the details read from your ${DOC_LABELS[r.docType].title.toLowerCase()}.${this.highlighted.length
          ? html` <strong>${this.highlighted.length} highlighted field${this.highlighted.length > 1 ? "s" : ""}</strong> need a look — correct anything that's wrong, then verify all.`
          : ""}
      </p>
      ${this.sharedEvidenceKey
        ? html`<div class="shared"><span class="muted">Read from these lines on your document:</span><canvas aria-hidden="true" data-crop=${this.sharedEvidenceKey}></canvas></div>`
        : nothing}
      ${r.fields.map((f) => this.renderField(f))}
      <div class="actions">
        <button @click=${() => this.dispatchEvent(new CustomEvent("retake", { bubbles: true, composed: true }))}>Use a different file or photo</button>
        <button class="primary" ?disabled=${Object.keys(this.errors).length > 0} @click=${this.done} data-testid="review-continue">
          ${this.highlighted.length ? "Verify all and continue" : "These details are correct"}
        </button>
      </div>
    `;
  }

  private renderField(f: ExtractedField) {
    const id = `f-${f.key}`;
    const kind = this.kind(f.key);
    const format = kind === "date" ? ` (${DATE_FORMAT_LABEL})` : kind === "date_range" ? ` (${DATE_FORMAT_LABEL} to ${DATE_FORMAT_LABEL})` : "";
    const shown = f.value === null ? "" : kind === "date" ? isoToDisplay(f.value) : kind === "date_range" ? isoRangeToDisplay(f.value) : f.value;
    const checks = this.result.checks.filter((c) => c.ok && f.validatedBy.includes(c.id)).map((c) => checkLabel(c.id));
    const vocab = f.validatedBy.includes("mrz.vocabulary") ? [checkLabel("mrz.vocabulary")] : [];
    const iban = f.validatedBy.includes("iban.mod97") ? [checkLabel("iban.mod97")] : [];
    const verified = [...new Set([...checks, ...vocab, ...iban])];
    return html`<div class="field ${f.needsReview ? "flagged" : ""}" data-field=${f.key}>
      <label for=${id}>${f.label}${format}${f.required ? "" : html` <span class="muted">(optional)</span>`}</label>
      ${f.evidence && !this.sharesEvidence(f) ? html`<canvas aria-hidden="true" data-crop=${f.key}></canvas>` : nothing}
      <input
        id=${id}
        type="text"
        .value=${shown}
        placeholder=${f.value === null ? (kind === "date" ? DATE_FORMAT_LABEL : kind === "date_range" ? `${DATE_FORMAT_LABEL} to ${DATE_FORMAT_LABEL}` : "Not found — type it here") : ""}
        aria-invalid=${this.errors[f.key] ? "true" : "false"}
        autocomplete="off"
        spellcheck="false"
        @change=${(e: Event) => this.edit(f.key, (e.target as HTMLInputElement).value)}
      />
      <div class="meta">
        <span class="muted">${SOURCE_LABELS[f.source]}</span>
        ${verified.length ? html`<span class="ok">✓ ${verified.join(" · ")}</span>` : nothing}
        ${f.needsReview && !verified.length ? html`<span class="check">Please check</span>` : nothing}
      </div>
      ${this.errors[f.key] ? html`<div class="error" role="alert">${this.errors[f.key]}</div>` : nothing}
    </div>`;
  }

  override updated() {
    // Draw each field's crop from the on-device preview image.
    for (const canvas of this.renderRoot.querySelectorAll<HTMLCanvasElement>("canvas[data-crop]")) {
      const f = this.result.fields.find((x) => x.key === canvas.dataset.crop);
      const preview = f?.evidence ? this.result.previews[f.evidence.page - 1] : undefined;
      if (f?.evidence && preview) drawCrop(canvas, preview, f.evidence);
    }
  }

  private edit(key: string, value: string) {
    const kind = this.kind(key);
    let stored = value;
    if ((kind === "date" || kind === "date_range") && value.trim() !== "") {
      const iso = kind === "date" ? displayToIso(value) : displayToIsoRange(value);
      if (!iso) {
        const fmt = kind === "date" ? DATE_FORMAT_LABEL : `${DATE_FORMAT_LABEL} to ${DATE_FORMAT_LABEL}`;
        this.errors = { ...this.errors, [key]: `Use ${fmt}, e.g. ${kind === "date" ? "31-03-2025" : "01-03-2025 to 31-03-2025"}` };
        return;
      }
      stored = iso;
    }
    const { [key]: _gone, ...rest } = this.errors;
    this.errors = rest;
    applyUserEdit(this.result, key, stored);
    this.requestUpdate();
  }

  private done = () => {
    this.dispatchEvent(new CustomEvent("review-complete", { detail: this.result, bubbles: true, composed: true }));
  };
}

function drawCrop(canvas: HTMLCanvasElement, preview: PageImage, ev: NonNullable<ExtractedField["evidence"]>) {
  const sx = ev.space ? preview.width / ev.space.width : 1;
  const sy = ev.space ? preview.height / ev.space.height : 1;
  const pad = 6;
  const x = Math.max(0, Math.floor(ev.bbox.x * sx - pad));
  const y = Math.max(0, Math.floor(ev.bbox.y * sy - pad));
  const w = Math.min(preview.width - x, Math.ceil(ev.bbox.w * sx + 2 * pad));
  const h = Math.min(preview.height - y, Math.ceil(ev.bbox.h * sy + 2 * pad));
  if (w <= 0 || h <= 0) return;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * preview.width + x) * 4;
    img.data.set(preview.data.subarray(src, src + w * 4), row * w * 4);
  }
  ctx.putImageData(img, 0, 0);
}

customElements.define("pde-review", PdeReview);
