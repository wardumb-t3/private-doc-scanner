import {
  buildSubmission,
  describeSubmission,
  releaseResult,
  type Destination,
  type DocType,
  type DocumentInput,
  type ExtractionResult,
  type ProgressStage,
} from "@pde/core";
import { LitElement, css, html, nothing } from "lit";
import "./capture.ts";
import { assistantPrompt, type AssistantPromptContext } from "./assistant-prompt.ts";
import { DOC_LABELS } from "./labels.ts";
import type { NetworkEntry, NetworkMonitor } from "./network-monitor.ts";
import "./network-panel.ts";
import "./review.ts";
import "./seal.ts";
import { tokens } from "./styles.ts";

/** Runs extraction on-device (typically in a Web Worker). */
export interface Extractor {
  /** Load engines and models; resolves when reading can start. */
  prepare(onProgress?: (loaded: number, total: number) => void, onStage?: (stage: string) => void): Promise<{ tier: string; offlineReady: boolean | Promise<boolean> }>;
  extract(input: DocumentInput, docType: DocType, onStage?: (stage: ProgressStage) => void): Promise<ExtractionResult>;
}

export interface FlowConfig {
  /** Document types offered on the start page, in this order. */
  docTypes: DocType[];
  /** Types the requester's link asked for: listed first and marked "Requested". */
  requestedTypes?: DocType[];
  /** Id from the link the requester (agent/business) sent; contains no data. */
  requestId: string | null;
  destination: Destination;
  extractor: Extractor;
  monitor: NetworkMonitor;
  build: { version: string; sha: string; repoUrl: string };
  /** Where sealed data goes, in a few words for the footer (e.g. "saves to your own vault"). */
  modeLabel?: string;
  /** Where to create a Terminal 3 account, linked when sign-in finds no account. */
  signUpUrl?: string;
  /** When set, the done page offers a self-contained prompt to check the submission from any AI session. */
  assistantPrompt?: AssistantPromptContext;
  /** Link to continue on a phone (same request id). */
  handoffUrl?: string;
  /** How the recipient is named in the privacy label. */
  destinationName?: string;
}

type Slot = { id: number; docType: DocType; result: ExtractionResult | null; reviewed: boolean };
/** home: pick a type · capture: upload / photo · collected: your documents. */
type Step = "home" | "capture" | "reading" | "review" | "collected" | "seal" | "done" | "error";

const TYPE_BLURBS: Record<DocType, string> = {
  passport: "The photo page, with the lines of <<< at the bottom",
  id_card: "A card with lines of <<< (usually on the back)",
  payslip: "The PDF from your employer, or a photo",
  bank_statement: "The PDF from your bank",
  generic: "Any other document",
};

const STAGE_TEXT: Record<ProgressStage, string> = {
  text_layer: "Reading the PDF text…",
  rasterize: "Opening the page…",
  quality: "Checking the photo…",
  ocr: "Reading the text…",
  mrz: "Reading the machine-readable lines…",
  mapping: "Finding the details…",
  done: "Done",
};

/**
 * The whole capture flow: privacy promise → pick a document type →
 * upload / photo → on-device reading → review → your documents (scan more,
 * or continue) → seal confirmation → done. Drop it into any page:
 * `<pde-flow .config=${...}>`.
 */
export class PdeFlow extends LitElement {
  static override properties = {
    config: { attribute: false },
    step: { state: true },
    slots: { state: true },
    active: { state: true },
    status: { state: true },
    entries: { state: true },
    offlineReady: { state: true },
    modelProgress: { state: true },
    prepStage: { state: true },
    blockedReason: { state: true },
    retryable: { state: true },
    sealReady: { state: true },
    needsAccount: { state: true },
    promptCopied: { state: true },
    setupNeeded: { state: true },
    settingUp: { state: true },
    setupStep: { state: true },
    sending: { state: true },
    reference: { state: true },
    error: { state: true },
    showVerify: { state: true },
    networkOpen: { state: true },
  };
  config!: FlowConfig;
  step: Step = "home";
  /** Documents scanned so far, plus the one in progress (not yet reviewed). */
  slots: Slot[] = [];
  /** Slot id being captured / reviewed. */
  active = 0;
  private nextSlot = 1;
  status = "Ready";
  entries: NetworkEntry[] = [];
  offlineReady = false;
  modelProgress = 0;
  /** What reader start-up is doing now (shown so a stall can be reported). */
  prepStage = "";
  blockedReason = "";
  retryable = false;
  sealReady = false;
  /** Signed in, but not with a Terminal 3 developer account. */
  needsAccount = false;
  /** Document types in the sealed submission (kept after the results are wiped). */
  private sealedTypes: DocType[] = [];
  promptCopied = false;
  /** Signed in, but the destination (the user's own vault) must be set up first. */
  setupNeeded = false;
  settingUp = false;
  setupStep = "";
  sending = false;
  reference = "";
  error = "";
  showVerify = false;
  networkOpen = false;
  /**
   * The request id the submission is stored under: the link's, or (opened
   * without one) a random reference the user passes on in their chat.
   */
  private requestId = "";
  private unsubscribe: (() => void) | null = null;
  private prepared: Promise<unknown> | null = null;

  static override styles = [
    tokens,
    css`
      :host {
        display: block;
        max-width: 640px;
        margin: 0 auto;
        padding: 16px;
        background: var(--pde-bg);
      }
      header {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 16px;
      }
      h2 {
        font-size: 20px;
        margin: 8px 0;
      }
      .slot {
        border: 1px solid var(--pde-border);
        border-radius: var(--pde-radius);
        padding: 14px;
        margin-bottom: 14px;
      }
      .slot.done {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .slot.done .actions {
        display: flex;
        gap: 14px;
      }
      .types {
        display: grid;
        gap: 10px;
        margin-bottom: 14px;
      }
      .type {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        width: 100%;
        text-align: left;
        padding: 14px 16px;
        font-size: 17px;
        font-weight: 600;
      }
      .type .muted {
        font-size: 14px;
        font-weight: 400;
      }
      .tag {
        font-size: 12px;
        font-weight: 600;
        color: var(--pde-accent);
        margin-left: 6px;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        justify-content: space-between;
        margin-top: 8px;
      }
      .notice {
        padding: 10px 14px;
        border-radius: var(--pde-radius);
        background: var(--pde-surface);
        border: 1px solid var(--pde-border);
        margin-bottom: 14px;
        font-size: 15px;
      }
      .progress {
        height: 6px;
        background: var(--pde-surface);
        border-radius: 3px;
        overflow: hidden;
      }
      .progress > div {
        height: 100%;
        background: var(--pde-accent);
      }
      .done-card {
        text-align: center;
        padding: 24px 8px;
      }
      .ai-prompt {
        text-align: left;
        margin-top: 24px;
        padding: 16px;
        border: 1px solid var(--pde-border);
        border-radius: var(--pde-radius);
        background: var(--pde-surface);
      }
      .ai-prompt h3 {
        margin: 0 0 6px;
      }
      .ai-prompt pre {
        margin: 12px 0 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font-size: 12px;
        line-height: 1.5;
        max-height: 320px;
        overflow: auto;
      }
      .ref {
        font-size: 15px;
        line-height: 1.5;
      }
      .ref code {
        font-size: 18px;
        user-select: all;
      }
      footer {
        margin-top: 24px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        font-size: 13px;
      }
      .verify {
        border: 1px solid var(--pde-border);
        border-radius: var(--pde-radius);
        padding: 10px 14px;
        line-height: 1.5;
      }
      .error {
        color: var(--pde-bad);
      }
    `,
  ];

  private started = false;

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("config") && this.config && !this.started) this.start();
  }

  private start() {
    this.started = true;
    this.requestId = this.config.requestId ?? newReference();
    this.config.monitor.start();
    this.unsubscribe = this.config.monitor.subscribe((e) => (this.entries = [...e]));
    // Warm up engines while the user picks a file.
    this.prepared = this.config.extractor
      .prepare(
        // Downloads fill most of the bar; each later start-up step (runtime,
        // detection, recognition) moves it on so it never sits at "almost done".
        (loaded, total) => (this.modelProgress = Math.max(this.modelProgress, total ? 0.8 * Math.min(1, loaded / total) : 0)),
        (stage) => {
          if (this.prepStage) this.modelProgress = Math.min(0.97, Math.max(this.modelProgress, 0.8) + 0.05);
          this.prepStage = stage;
        },
      )
      .then((r) => {
        // May still be caching: reading must not wait for offline support.
        void Promise.resolve(r.offlineReady).then((ready) => (this.offlineReady = ready));
        this.modelProgress = 1;
      })
      .catch((err: unknown) => {
        this.error = `Could not load the reading engine: ${(err as Error).message} · build ${this.config.build.sha.slice(0, 7)}`;
        this.step = "error";
      });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.wipe();
  }

  override render() {
    if (!this.config) return nothing;
    return html`
      <header>
        <pde-privacy-label
          .destination=${this.config.destinationName ?? "your T3 enclave"}
          @show-network=${() => (this.networkOpen = true)}
          @show-verify=${() => (this.showVerify = true)}
        ></pde-privacy-label>
        <pde-device-chip .status=${this.status}></pde-device-chip>
      </header>
      ${this.renderStep()}
      <footer>
        <pde-network-panel .entries=${this.entries} .open=${this.networkOpen}></pde-network-panel>
        ${this.showVerify ? this.renderVerify() : nothing}
        <div class="muted">
          Open source · build <code>${this.config.build.sha.slice(0, 12)}</code>${this.config.modeLabel
            ? html` · <span data-testid="mode">${this.config.modeLabel}</span>`
            : nothing} ·
          <button class="link" @click=${() => (this.showVerify = !this.showVerify)}>verify</button>
        </div>
      </footer>
    `;
  }

  private renderStep() {
    switch (this.step) {
      case "home":
        return this.renderHome();
      case "capture":
        return this.renderCapture();
      case "collected":
        return this.renderCollected();
      case "reading":
        return html`<div class="notice" role="status">${this.status}</div>`;
      case "review": {
        const slot = this.slotById(this.active)!;
        return html`<h2>${DOC_LABELS[slot.docType].title}</h2>
          <pde-review .result=${slot.result!} @review-complete=${this.onReviewed} @retake=${this.onRetake}></pde-review>`;
      }
      case "seal":
        return html`<h2>Seal and send</h2>
          <pde-seal-confirm
            .destination=${this.config.destination.describe()}
            .summary=${describeSubmission(this.submission())}
            .busy=${this.sending}
            .ready=${this.sealReady}
            blocked-reason=${this.blockedReason}
            .retryable=${this.retryable}
            sign-up-url=${this.config.signUpUrl ?? ""}
            .needsAccount=${this.needsAccount}
            .setupNeeded=${this.setupNeeded}
            .settingUp=${this.settingUp}
            .setupStep=${this.setupStep}
            @setup=${this.onSetUp}
            @retry=${this.onRetry}
            @seal=${this.onSeal}
            @back=${() => (this.step = "collected")}
          ></pde-seal-confirm>`;
      case "done":
        return html`<div class="done-card" data-testid="done">
          <h2>Done.</h2>
          <p>Your image has been erased from this device's memory.</p>
          <p><strong>You can go back to your chat now.</strong></p>
          ${this.config.requestId
            ? nothing
            : html`<p class="ref" data-testid="reference">
                Your reference: <code>${this.requestId}</code><br />
                <span class="muted">Reference this in your chat so the AI can reference your documents. They would not be able to see it.</span>
              </p>`}
          ${this.config.assistantPrompt ? this.renderAssistantPrompt(this.config.assistantPrompt) : nothing}
        </div>`;
      case "error":
        return html`<div class="notice error" role="alert">${this.error}</div>
          <button @click=${() => location.reload()}>Start again</button>`;
    }
  }

  private slotById(id: number): Slot | undefined {
    return this.slots.find((s) => s.id === id);
  }

  private get collected(): Slot[] {
    return this.slots.filter((s) => s.reviewed && s.result);
  }

  private renderReaderStatus() {
    return this.modelProgress < 1
      ? html`<div class="notice">
          Getting the reader ready on this device…
          ${this.prepStage ? html`<span class="muted" data-testid="prep-stage">(${this.prepStage})</span>` : nothing}
          <div class="progress" aria-hidden="true"><div style="width:${Math.round(this.modelProgress * 100)}%"></div></div>
        </div>`
      : this.offlineReady
        ? html`<div class="notice" data-testid="offline-ready">You can turn on airplane mode now. Reading works offline.</div>`
        : nothing;
  }

  /** Start page: choose which kind of document to scan. */
  private renderHome() {
    const requested = this.config.requestedTypes ?? [];
    const types = [...requested, ...this.config.docTypes.filter((t) => !requested.includes(t))];
    return html`
      ${this.renderReaderStatus()}
      <h2>${this.collected.length ? "Scan another document" : "Which document would you like to scan?"}</h2>
      <div class="types">
        ${types.map(
          (t) => html`<button class="type" data-testid="choose-${t}" @click=${() => this.choose(t)}>
            <span>${DOC_LABELS[t].title}${requested.includes(t) ? html`<span class="tag">Requested</span>` : nothing}</span>
            <span class="muted">${TYPE_BLURBS[t]}</span>
          </button>`,
        )}
      </div>
      ${this.collected.length
        ? html`<button class="link" data-testid="to-collected" @click=${() => (this.step = "collected")}>
            Back to your documents (${this.collected.length})
          </button>`
        : nothing}
    `;
  }

  /** Upload / photo for the chosen type. */
  private renderCapture() {
    const s = this.slotById(this.active)!;
    return html`
      ${this.error ? html`<div class="notice error" role="alert">${this.error}</div>` : nothing}
      ${this.renderReaderStatus()}
      <div class="slot">
        <h2>${DOC_LABELS[s.docType].title}</h2>
        <p class="muted">${DOC_LABELS[s.docType].hint}</p>
        <pde-capture
          doc-type=${s.docType}
          handoff-url=${this.config.handoffUrl ?? ""}
          @document-selected=${(e: CustomEvent<{ input: DocumentInput }>) => this.read(s.id, e.detail.input)}
        ></pde-capture>
      </div>
      <button class="link" data-testid="back-home" @click=${this.cancelCapture}>← Choose a different document</button>
    `;
  }

  /** Your documents: scan more, change, remove, or continue to seal. */
  private renderCollected() {
    const docs = this.collected;
    return html`
      <h2>Your documents</h2>
      ${docs.map(
        (s) => html`<div class="slot done" data-testid="collected-${s.docType}">
          <span>✓ ${DOC_LABELS[s.docType].title}</span>
          <span class="actions">
            <button class="link" @click=${() => this.reopen(s.id)}>Change</button>
            <button class="link" @click=${() => this.removeDoc(s.id)}>Remove</button>
          </span>
        </div>`,
      )}
      ${docs.length ? nothing : html`<p class="muted">No documents yet.</p>`}
      <div class="row">
        <button data-testid="scan-more" @click=${() => (this.step = "home")}>Scan more documents</button>
        ${docs.length ? html`<button class="primary" @click=${this.toSeal} data-testid="to-seal">Continue</button>` : nothing}
      </div>
    `;
  }

  private choose(docType: DocType) {
    this.error = "";
    // Drop a capture that was started but never read.
    this.slots = this.slots.filter((s) => s.reviewed || s.result);
    const id = this.nextSlot++;
    this.slots = [...this.slots, { id, docType, result: null, reviewed: false }];
    this.active = id;
    this.step = "capture";
  }

  private cancelCapture = () => {
    this.error = "";
    this.slots = this.slots.filter((s) => s.id !== this.active || s.reviewed);
    this.step = this.collected.length ? "collected" : "home";
  };

  private removeDoc(id: number) {
    const s = this.slotById(id);
    if (s?.result) releaseResult(s.result);
    this.slots = this.slots.filter((x) => x.id !== id);
    if (!this.collected.length) this.step = "home";
  }

  private renderAssistantPrompt(ctx: AssistantPromptContext) {
    const text = assistantPrompt(this.requestId, this.sealedTypes, ctx);
    const copy = async (e: Event) => {
      const pre = (e.currentTarget as HTMLElement).closest(".ai-prompt")?.querySelector("pre");
      try {
        await navigator.clipboard.writeText(text);
        this.promptCopied = true;
      } catch {
        // Clipboard refused: select the text so the user can copy it.
        if (pre) getSelection()?.selectAllChildren(pre);
      }
    };
    return html`<div class="ai-prompt" data-testid="ai-prompt">
      <h3>Check it with your AI</h3>
      <p class="muted">
        Paste this into a new chat in Claude Code or Codex. It has everything a fresh session needs, and none of your details.
      </p>
      <button class="primary" @click=${copy} data-testid="copy-ai-prompt">${this.promptCopied ? "Copied" : "Copy prompt"}</button>
      <pre>${text}</pre>
    </div>`;
  }

  private renderVerify() {
    const b = this.config.build;
    return html`<div class="verify">
      <strong>How to verify this page</strong>
      <ol>
        <li>The code is open source: <a href=${b.repoUrl} target="_blank" rel="noopener">${b.repoUrl}</a>. This page was built from commit <code>${b.sha}</code> (v${b.version}).</li>
        <li>Open "What left this device" above: it lists every request your browser made. The document never appears there.</li>
        <li>Turn on airplane mode after the reader is ready — reading and review still work. Only the final "Seal and send" needs a connection.</li>
        <li>The submission is encrypted on this device to a T3 node whose secure-hardware attestation is checked first. If that check fails, nothing is sent.</li>
      </ol>
    </div>`;
  }

  private async read(id: number, input: DocumentInput) {
    this.error = "";
    this.active = id;
    this.step = "reading";
    this.status = "Reading on your device…";
    try {
      await this.prepared;
      const result = await this.config.extractor.extract(input, this.slotById(id)!.docType, (stage) => {
        this.status = STAGE_TEXT[stage] ?? "Reading on your device…";
      });
      // Drop our reference to the original file bytes right away.
      (input as { bytes: ArrayBuffer | null }).bytes = null;
      this.slots = this.slots.map((s) => (s.id === id ? { ...s, result, reviewed: false } : s));
      this.status = "Read on your device";
      this.step = "review";
    } catch (err) {
      this.status = "Ready";
      this.error = `We couldn't read that file on this device (${(err as Error).message}). Try another file or a photo. · build ${this.config.build.sha.slice(0, 7)}`;
      this.step = "capture";
    }
  }

  private onReviewed = () => {
    this.slots = this.slots.map((s) => (s.id === this.active ? { ...s, reviewed: true } : s));
    this.status = "Ready";
    this.step = "collected";
  };

  private onRetake = () => {
    const slot = this.slotById(this.active);
    if (slot?.result) releaseResult(slot.result);
    this.slots = this.slots.map((s) => (s.id === this.active ? { ...s, result: null, reviewed: false } : s));
    this.step = "capture";
  };

  private reopen(id: number) {
    this.active = id;
    this.step = this.slotById(id)?.result ? "review" : "capture";
  }

  private toSeal = () => {
    this.step = "seal";
    void this.prepareSeal();
  };

  private submission() {
    return buildSubmission({
      requestId: this.requestId,
      results: this.collected.map((s) => s.result!),
      client: { name: "private-doc-scanner", version: this.config.build.version, engine: "web" },
    });
  }

  private preparing: Promise<void> | null = null;
  /** The last "Seal and send" failed after sign-in succeeded. */
  private sendFailed = false;

  private onRetry = () => {
    if (this.sendFailed && this.sealReady) {
      this.sendFailed = false;
      this.blockedReason = "";
      this.retryable = false;
      if (this.checkTraffic()) void this.onSeal();
      return;
    }
    void this.prepareSeal();
  };

  /** Verify the destination (attestation) and sign in; at most one attempt at a time. */
  private prepareSeal(): Promise<void> {
    // Already verified and signed in (e.g. after Back → Continue): no new code email.
    if ((this.sealReady || this.setupNeeded) && !this.blockedReason) return Promise.resolve();
    this.preparing ??= this.runPrepare().finally(() => (this.preparing = null));
    return this.preparing;
  }

  private async runPrepare() {
    this.blockedReason = "";
    this.retryable = false;
    this.sealReady = false;
    this.needsAccount = false;
    this.status = "Checking the secure enclave…";
    try {
      await this.config.destination.prepare();
      // Signed in; a vault that doesn't exist yet is offered for setup, not an error.
      if (await this.config.destination.needsSetup?.().catch(() => false)) {
        this.setupNeeded = true;
        this.status = "Vault setup needed";
      } else {
        this.sealReady = true;
        this.status = "Ready to seal";
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.retryable = true;
      if ((err as Error).name === "NoDeveloperAccountError") {
        const status = (err as { status?: string }).status ?? "none";
        this.needsAccount = true;
        this.blockedReason =
          status === "none"
            ? "This email isn't linked to a Terminal 3 account yet, so there's nowhere to seal your documents. Sign up first with this email, then tap Try again. Nothing was sent."
            : `Your Terminal 3 account is ${status}, so it can't hold a vault yet. Nothing was sent.`;
        this.status = "Terminal 3 account needed";
      } else if ((err as Error).name === "SignInError") {
        this.blockedReason = /code does not match|invalid code|otp/i.test(msg)
          ? "That code didn't match. Each attempt emails a new code — use the one from the newest email. Nothing was sent."
          : /rate.?limit|cooldown|too many/i.test(msg)
            ? "Too many codes were requested. Wait a few minutes, then try again. Nothing was sent."
            : `Sign-in didn't work (${msg}). Nothing was sent.`;
        this.status = "Sign-in needed";
      } else {
        this.blockedReason = `We couldn't verify the T3 node, so nothing will be sent. (${msg})`;
        this.status = "Not sent";
      }
    }
    this.checkTraffic();
  }

  private onSetUp = async () => {
    const dest = this.config.destination;
    if (!dest.setUp || this.settingUp) return;
    this.settingUp = true;
    this.blockedReason = "";
    this.status = "Setting up your vault…";
    try {
      await dest.setUp((step) => (this.setupStep = step));
      this.setupNeeded = false;
      this.sealReady = true;
      this.status = "Ready to seal";
    } catch (err) {
      // The button stays, so the user can try again.
      this.blockedReason = `We couldn't set up your vault (${(err as Error).message ?? String(err)}). Nothing was sent.`;
      this.status = "Vault setup failed";
    } finally {
      this.settingUp = false;
      this.setupStep = "";
    }
    this.checkTraffic();
  };

  private checkTraffic(): boolean {
    if (this.config.monitor.trusted) return true;
    const bad = this.entries.find((e) => e.kind === "unexpected" || e.kind === "blocked");
    this.retryable = false;
    this.blockedReason = `This page contacted an unexpected address (${bad?.origin ?? "unknown"}). For your safety, nothing will be sent.`;
    return false;
  }

  private onSeal = async () => {
    if (!this.sealReady || this.blockedReason || !this.checkTraffic()) return;
    this.sending = true;
    this.status = "Sealing on your device…";
    try {
      const submission = this.submission();
      const receipt = await this.config.destination.submit(submission);
      this.reference = receipt.reference;
      this.sealedTypes = submission.documents.map((d) => d.doc_type);
      this.wipe();
      this.status = "Sent";
      this.step = "done";
    } catch (err) {
      if ((err as Error).name === "VaultNotSetUpError") {
        // No vault under this account after all: offer the setup step. Nothing was sent.
        this.sealReady = false;
        this.setupNeeded = true;
        this.status = "Vault setup needed";
        return;
      }
      this.blockedReason = `Sending failed: ${(err as Error).message}. Nothing was stored; you can try again.`;
      // Still verified and signed in: "Try again" re-sends without a new code.
      this.sendFailed = true;
      this.retryable = true;
      this.status = "Not sent";
    } finally {
      this.sending = false;
    }
  };

  private wipe() {
    for (const s of this.slots) if (s.result) releaseResult(s.result);
    this.slots = this.slots.map((s) => ({ ...s, result: null }));
  }
}

/** A short reference with no ambiguous characters (0/O, 1/I/L), e.g. "pde-7F2K-Q9X3". */
function newReference(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `pde-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

customElements.define("pde-flow", PdeFlow);
