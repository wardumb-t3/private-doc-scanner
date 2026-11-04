import { LitElement, css, html } from "lit";
import type { NetworkEntry } from "./network-monitor.ts";
import { tokens } from "./styles.ts";

const KIND_LABEL: Record<NetworkEntry["kind"], string> = {
  app: "App code (this site)",
  model: "Reading model (this site, verified)",
  submission: "Encrypted submission",
  unexpected: "Unexpected destination",
  blocked: "Blocked by the browser",
};

/** "What left this device" — the exact list of requests the page made. */
export class PdeNetworkPanel extends LitElement {
  static override properties = { entries: { attribute: false }, open: { type: Boolean, reflect: true } };
  entries: NetworkEntry[] = [];
  open = false;

  static override styles = [
    tokens,
    css`
      :host {
        display: block;
      }
      details {
        border: 1px solid var(--pde-border);
        border-radius: var(--pde-radius);
        padding: 10px 14px;
      }
      summary {
        cursor: pointer;
        font-weight: 600;
      }
      ul {
        list-style: none;
        padding: 0;
        margin: 8px 0 0;
        font-size: 13px;
      }
      li {
        padding: 6px 0;
        border-top: 1px solid var(--pde-border);
        word-break: break-all;
      }
      .bad {
        color: var(--pde-bad);
        font-weight: 600;
      }
      .tag {
        font-weight: 600;
      }
    `,
  ];

  override render() {
    const outbound = this.entries.filter((e) => e.kind !== "app" && e.kind !== "model");
    return html`<details ?open=${this.open} @toggle=${(e: Event) => (this.open = (e.target as HTMLDetailsElement).open)}>
      <summary>What left this device (${outbound.length} outgoing)</summary>
      <p class="muted">
        Every network request this page made, as recorded by your browser. Downloads are the app and its reading models from this
        site; the only data sent out is the encrypted submission.
      </p>
      <ul data-testid="network-list">
        ${this.entries.map(
          (e) => html`<li class=${e.kind === "unexpected" || e.kind === "blocked" ? "bad" : ""} data-kind=${e.kind}>
            <span class="tag">${KIND_LABEL[e.kind]}</span> · ${shortUrl(e.url)}
            ${e.sha256 ? html`<br /><span class="muted">sha256 ${e.sha256.slice(0, 16)}…</span>` : null}
            ${e.transferSize === 0 && (e.kind === "model" || e.kind === "app") ? html` <span class="muted">(from cache)</span>` : null}
          </li>`,
        )}
      </ul>
    </details>`;
  }
}

function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.host}${url.pathname}`;
  } catch {
    return u;
  }
}

customElements.define("pde-network-panel", PdeNetworkPanel);
