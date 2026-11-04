import { toCents } from "./amount.ts";

/**
 * Cross-field arithmetic checks. When the numbers on a statement or payslip
 * reconcile, every amount that took part is very likely read correctly —
 * this is the strongest accuracy signal available without seeing the
 * document ourselves.
 */

export interface ReconcileResult {
  ok: boolean;
  /** expected − actual, in currency units (0 when ok). */
  difference: number;
}

const TOLERANCE_CENTS = 1;

function reconcile(expectedCents: number, actualCents: number): ReconcileResult {
  const diff = expectedCents - actualCents;
  return { ok: Math.abs(diff) <= TOLERANCE_CENTS, difference: diff / 100 };
}

/** opening + credits − debits = closing */
export function checkStatementBalance(input: {
  opening: number;
  closing: number;
  credits?: number[];
  debits?: number[];
  /** Signed transaction amounts, as an alternative to credits/debits. */
  transactions?: number[];
}): ReconcileResult {
  const credits = (input.credits ?? []).reduce((s, v) => s + toCents(Math.abs(v)), 0);
  const debits = (input.debits ?? []).reduce((s, v) => s + toCents(Math.abs(v)), 0);
  const signed = (input.transactions ?? []).reduce((s, v) => s + toCents(v), 0);
  const expected = toCents(input.opening) + credits - debits + signed;
  return reconcile(expected, toCents(input.closing));
}

/** gross − Σ deductions = net */
export function checkPayslip(input: { gross: number; net: number; deductions: number[] }): ReconcileResult {
  const deductions = input.deductions.reduce((s, v) => s + toCents(Math.abs(v)), 0);
  return reconcile(toCents(input.gross) - deductions, toCents(input.net));
}

/** Σ parts = total */
export function checkSum(parts: number[], total: number): ReconcileResult {
  return reconcile(parts.reduce((s, v) => s + toCents(v), 0), toCents(total));
}
