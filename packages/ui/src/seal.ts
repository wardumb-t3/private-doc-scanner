import type { DestinationInfo, DocType } from "@pde/core";
import { LitElement, css, html } from "lit";
import { DOC_LABELS } from "./labels.ts";
import { tokens } from "./styles.ts";

/**
 * Final confirmation before anything leaves the device: who it is sealed
 * to, the exact list of fields (names only), and what is NOT sent.
 * Emits `seal` or `back`.
 */
export class PdeSealConfirm extends LitElement {
  static override properties = {
    destination: { attribute: false },
    summary: { attribute: false },
    busy: { type: Boolean },
    ready: { type: Boolean },
    blockedReason: { type: String, attribute: "blocked-reason" },
    retryable: { type: Boolean },
    setupNeeded: { type: Boolean },
    settingUp: { type: Boolean },
    setupStep: { type: String },
  };
  destination!: DestinationInfo;
  summary: { doc_type: DocType; fields: string[] }[] = [];
  busy = false;
  /** The destination is verified and the user signed in; only then may they send. */
  ready = false;
  /** When set, submission is refused and the reason is shown. */
  blockedReason = "";
  /** Show "Try again" next to the blocked reason (sign-in or network problems). */
  retryable = false;
  /** Signed in, but the user's vault doesn't exist yet: offer to set it up. */
  setupNeeded = false;
  settingUp = false;
  /** What vault setup is doing now. */
  setupStep = "";

  static override styles = [
    tokens,
    css`
      .setup {
        border: 1px solid var(--pde-border);
        border-radius: var(--pde-radius);
        padding: 12px 14px;
        margin: 12px 0;
        background: var(--pde-surface);
      }
      .setup p {
        margin: 6px 0 10px;
      }
      :host {
        display: block;
      }
      .card {
        padding: 16px;
        border: 1px solid var(--pde-border);
        border-radius: var(--pde-radius);
        background: var(--pde-surface);
      }
      h3 {
        margin: 0 0 8px;
        font-size: 17px;
      }
      ul {
        margin: 6px 0 12px;
        padding-left: 20px;
      }
      code {
        font-size: 13px;
        word-break: break-all;
      }
      .not {
        margin-top: 12px;
        font-weight: 600;
      }
      .blocked {
        margin-top: 12px;
        color: var(--pde-bad);
        font-weight: 600;
      }
      .actions {
        display: flex;
        gap: 10px;
        justify-content: space-between;
        margin-top: 16px;
        flex-wrap: wrap;
      }
    `,
  ];

  override render() {
    return html`<div class="card">
        <h3>Encrypting to ${this.destination.kind}${this.destination.id ? html` <code>${this.destination.id}</code>` : null}</h3>
        <p class="muted">${this.destination.label}</p>
        ${this.destination.account
          ? html`<p data-testid="seal-account">Saving to the vault of <code>${this.destination.account}</code></p>`
          : null}
        ${this.setupNeeded
          ? html`<div class="setup" data-testid="vault-setup">
              <strong>This account doesn't have a private data vault yet.</strong>
              <p>Complete a one-time setup (uses about 1,100 credits) here.</p>
              <button
                class="primary"
                ?disabled=${this.settingUp}
                @click=${() => this.dispatchEvent(new CustomEvent("setup"))}
                data-testid="setup-vault"
              >
                ${this.settingUp ? `Setting up… (${this.setupStep || "starting"})` : "Set up my vault"}
              </button>
            </div>`
          : null}
        ${this.summary.map(
          (d) => html`<div>
            <strong>${DOC_LABELS[d.doc_type].title}</strong>
            <ul>
              ${d.fields.map((f) => html`<li>${f.replace(/_/g, " ")}</li>`)}
            </ul>
          </div>`,
        )}
        <p class="muted">Only the details above are sent. Your images and the full text of your documents are not sent and are erased from memory.</p>
        <p class="not">Not shared with AI or Terminal 3 in plain-text.</p>
        ${this.blockedReason ? html`<p class="blocked" role="alert">${this.blockedReason}</p>` : null}
        ${this.blockedReason && this.retryable
          ? html`<button @click=${() => this.dispatchEvent(new CustomEvent("retry"))} data-testid="retry">Try again</button>`
          : null}
      </div>
      <div class="actions">
        <button ?disabled=${this.busy} @click=${() => this.dispatchEvent(new CustomEvent("back"))}>Back</button>
        <button
          class="primary"
          ?disabled=${this.busy || !this.ready || !!this.blockedReason}
          @click=${() => this.dispatchEvent(new CustomEvent("seal"))}
          data-testid="seal"
        >
          ${this.busy ? "Sealing…" : this.ready || this.blockedReason ? "Seal and send" : "Verifying and signing in…"}
        </button>
      </div>`;
  }
}

customElements.define("pde-seal-confirm", PdeSealConfirm);
