import { LitElement, css, html } from "lit";
import { tokens } from "./styles.ts";

/**
 * Compact privacy promise shown above the capture area on every step. It
 * cannot be dismissed; "More ›" expands it inline.
 */
export class PdePrivacyLabel extends LitElement {
  static override properties = {
    open: { type: Boolean, reflect: true },
    destination: { type: String },
  };
  open = false;
  /** How the recipient is named to the user. */
  destination = "your T3 enclave";

  static override styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      .label {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 6px;
        padding: 10px 14px;
        border-radius: var(--pde-radius);
        background: var(--pde-surface);
        border: 1px solid var(--pde-border);
        font-size: 15px;
      }
      strong {
        font-weight: 600;
      }
      .more {
        margin-top: 8px;
        line-height: 1.5;
      }
      .links {
        margin-top: 6px;
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        font-size: 14px;
      }
    `,
  ];

  override render() {
    return html`<div class="label" part="label">
      <span aria-hidden="true">🔒</span>
      <strong>Your document never leaves this device.</strong>
      <button class="link" aria-expanded=${this.open} aria-controls="more" @click=${() => (this.open = !this.open)}>
        ${this.open ? "Less ‹" : "More ›"}
      </button>
      ${this.open
        ? html`<div id="more" class="more">
            It's read here, you check the details and only those are sealed directly to ${this.destination}. No AI or
            Terminal 3 can see it in plain text.
            <div class="links">
              <button class="link" @click=${() => this.dispatchEvent(new CustomEvent("show-network", { bubbles: true, composed: true }))}>
                See what left this device
              </button>
              <button class="link" @click=${() => this.dispatchEvent(new CustomEvent("show-verify", { bubbles: true, composed: true }))}>
                How to verify this
              </button>
            </div>
          </div>`
        : null}
    </div>`;
  }
}

/** "On this device" status chip, visible while anything is being processed. */
export class PdeDeviceChip extends LitElement {
  static override properties = { status: { type: String } };
  status = "Ready";
  static override styles = [
    tokens,
    css`
      :host {
        display: inline-flex;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid var(--pde-border);
        background: var(--pde-surface);
        font-size: 14px;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--pde-ok);
      }
    `,
  ];
  override render() {
    return html`<span class="chip" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span><strong>On this device</strong> · ${this.status}</span>`;
  }
}
