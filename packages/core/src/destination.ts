import type { Submission } from "./payload.ts";

/**
 * Where reviewed fields go. Implementations must encrypt end-to-end to the
 * final recipient (e.g. an attested TEE) — the hosting web server, CDN and
 * any AI assistant must never see plaintext.
 */
export interface Destination {
  /** Shown to the user on the seal-confirmation screen. */
  describe(): DestinationInfo;
  /**
   * Establish and verify the encrypted channel before anything is sent
   * (attestation, key pinning…). Must throw if verification fails — the UI
   * blocks submission and never falls back to sending anyway.
   */
  prepare(): Promise<void>;
  submit(submission: Submission): Promise<SubmitReceipt>;
  /** Origins this destination talks to; the network monitor allows only these. */
  origins(): string[];
  /**
   * After `prepare()`: true when the destination must be created first, e.g.
   * the signed-in user has no vault yet. The UI then offers `setUp()`.
   */
  needsSetup?(): Promise<boolean>;
  /** Create what `needsSetup()` reported missing; `onStep` names each step for the UI. */
  setUp?(onStep?: (step: string) => void): Promise<void>;
}

export interface DestinationInfo {
  /** e.g. "T3 node" */
  kind: string;
  /** Node id / key fingerprint shown to the user. */
  id: string;
  label: string;
  /** Who the data is saved for, once signed in: the full DID. */
  account?: string;
}

export interface SubmitReceipt {
  /** Opaque reference the requester (agent) can look up; contains no values. */
  reference: string;
}

/**
 * Thrown by `Destination.prepare()` when the recipient was verified but the
 * user could not be signed in (wrong one-time code, cancelled, rate limited).
 * The UI offers a retry; anything else is treated as a failed verification.
 */
export class NoDeveloperAccountError extends Error {
  /** "none": not a Terminal 3 developer account; otherwise the account's status (e.g. "pending"). */
  readonly status: string;
  constructor(status: string, options?: { cause?: unknown }) {
    super(status === "none" ? "this email isn't linked to a Terminal 3 developer account" : `this Terminal 3 account is ${status}`, options);
    this.name = "NoDeveloperAccountError";
    this.status = status;
  }
}

/**
 * Thrown by `Destination.prepare()` when sign-in worked but the account is
 * not a Terminal 3 developer account (or not active yet), so it can't hold
 * a vault. The UI asks the user to sign up first; nothing is sent.
 */
export class SignInError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SignInError";
  }
}
