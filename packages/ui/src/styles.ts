import { css } from "lit";

/** Design tokens shared by all components. Override the custom properties to theme. */
export const tokens = css`
  :host {
    --pde-bg: #ffffff;
    --pde-surface: #f6f7f9;
    --pde-border: #dde1e7;
    --pde-text: #14171c;
    --pde-muted: #5b6573;
    --pde-accent: #1f5eff;
    --pde-accent-text: #ffffff;
    --pde-ok: #127a43;
    --pde-warn: #a35c00;
    --pde-bad: #b42318;
    --pde-radius: 12px;
    --pde-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-family: var(--pde-font);
    color: var(--pde-text);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --pde-bg: #111418;
      --pde-surface: #1a1e24;
      --pde-border: #2c323b;
      --pde-text: #e8ebef;
      --pde-muted: #9aa4b2;
      --pde-accent: #6f9bff;
      --pde-accent-text: #0b0d10;
      --pde-ok: #4cc287;
      --pde-warn: #f0a640;
      --pde-bad: #ff7b72;
    }
  }
  * {
    box-sizing: border-box;
  }
  button {
    font: inherit;
    border-radius: 10px;
    border: 1px solid var(--pde-border);
    background: var(--pde-surface);
    color: var(--pde-text);
    padding: 10px 16px;
    min-height: 44px;
    cursor: pointer;
  }
  button.primary {
    background: var(--pde-accent);
    color: var(--pde-accent-text);
    border-color: transparent;
    font-weight: 600;
  }
  button.link {
    background: none;
    border: none;
    padding: 0;
    min-height: 0;
    color: var(--pde-accent);
    text-decoration: underline;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button:focus-visible,
  input:focus-visible {
    outline: 3px solid var(--pde-accent);
    outline-offset: 2px;
  }
  .muted {
    color: var(--pde-muted);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
`;
