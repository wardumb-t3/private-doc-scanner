import { checkStatementBalance, parseAmount, parseDate, type DateOrder } from "@pde/validators";
import { rowTexts } from "../layout.ts";
import type { CheckResult, TextLine } from "../types.ts";
import type { DocumentSchema } from "./types.ts";

interface TxRow {
  date: string;
  amounts: number[];
}

const ROW = /^\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3}\.?(?:\s+\d{2,4})?)\s+(.*)$/;
const TRAILING_AMOUNTS = /((?:[-−(]?\s*\d{1,3}(?:[,.\s']\d{3})*[.,]\d{2}\)?(?:\s?(?:CR|DR))?-?\s*){1,3})$/;

/** Transaction rows: a leading date, a description and 1–3 trailing amounts. */
export function parseTransactionRows(lines: TextLine[], dateOrder: DateOrder = "DMY"): TxRow[] {
  const rows: TxRow[] = [];
  for (const row of rowTexts(lines)) {
    const m = row.text.match(ROW);
    if (!m) continue;
    const date = parseDate(m[1]!, dateOrder) ?? m[1]!;
    const tail = m[2]!.match(TRAILING_AMOUNTS);
    if (!tail) continue;
    const amounts = tail[1]!
      .trim()
      .split(/\s{2,}|\s(?=[-−(]?\d)/)
      .map((t) => parseAmount(t)?.value)
      .filter((v): v is number => v !== undefined);
    if (amounts.length) rows.push({ date, amounts });
  }
  return rows;
}

/**
 * Running-balance chain: for rows printed as `… amount  balance`, each
 * balance must equal the previous balance ± the amount. Every row that
 * chains is a row read correctly.
 */
export function checkRunningBalance(rows: TxRow[], opening: number | null): CheckResult | null {
  const withBalance = rows.filter((r) => r.amounts.length >= 2);
  if (withBalance.length < 2) return null;
  let prev = opening ?? null;
  let broken = 0;
  for (const r of withBalance) {
    const balance = r.amounts[r.amounts.length - 1]!;
    const amount = r.amounts[r.amounts.length - 2]!;
    if (prev !== null) {
      const up = Math.round((prev + Math.abs(amount)) * 100);
      const down = Math.round((prev - Math.abs(amount)) * 100);
      const b = Math.round(balance * 100);
      if (Math.abs(up - b) > 1 && Math.abs(down - b) > 1) broken++;
    }
    prev = balance;
  }
  return {
    id: "rows.running_balance",
    ok: broken === 0,
    message:
      broken === 0
        ? `All ${withBalance.length} transaction balances chain correctly`
        : `${broken} of ${withBalance.length} transaction rows do not chain — check amounts`,
    fields: ["opening_balance", "closing_balance"],
  };
}

export const bankStatementSchema: DocumentSchema = {
  type: "bank_statement",
  label: "Bank statement",
  fields: [
    { key: "account_holder", label: "Account holder", kind: "name", anchors: [/\baccount (?:holder|name)\b/i, /\bcustomer name\b/i, /^\s*name\b/i], required: true },
    { key: "iban", label: "IBAN", kind: "iban", anchors: [/\biban\b/i] },
    { key: "account_number", label: "Account number", kind: "account_number", anchors: [/\baccount (?:no\.?|number)\b/i, /\bacct\.? (?:no\.?|number)\b/i] },
    { key: "statement_period", label: "Statement period", kind: "date_range", anchors: [/\bstatement period\b/i, /\bperiod\b/i, /\bfrom\b/i], required: true },
    { key: "opening_balance", label: "Opening balance", kind: "amount", anchors: [/\bopening balance\b/i, /\bbalance brought forward\b/i, /\bprevious balance\b/i, /\bbeginning balance\b/i, /\bstarting balance\b/i], required: true },
    { key: "total_credits", label: "Total money in", kind: "amount", anchors: [/\btotal (?:credits|deposits|money in|paid in)\b/i, /\bmoney in\b/i] },
    { key: "total_debits", label: "Total money out", kind: "amount", anchors: [/\btotal (?:debits|withdrawals|money out|paid out)\b/i, /\bmoney out\b/i] },
    { key: "closing_balance", label: "Closing balance", kind: "amount", anchors: [/\bclosing balance\b/i, /\bbalance carried forward\b/i, /\bending balance\b/i, /\bnew balance\b/i], required: true },
  ],
  checks(fields, ctx) {
    const out: CheckResult[] = [];
    const num = (k: string) => {
      const v = fields.get(k)?.value;
      return v ? Number(v) : null;
    };
    const opening = num("opening_balance");
    const closing = num("closing_balance");
    const credits = num("total_credits");
    const debits = num("total_debits");
    if (opening !== null && closing !== null && credits !== null && debits !== null) {
      const r = checkStatementBalance({ opening, closing, credits: [credits], debits: [debits] });
      out.push({
        id: "statement.opening_plus_in_minus_out_equals_closing",
        ok: r.ok,
        message: r.ok ? "Opening + money in − money out = closing" : `Balances differ by ${r.difference.toFixed(2)}`,
        fields: ["opening_balance", "total_credits", "total_debits", "closing_balance"],
      });
    }
    // Needs the raw rows, so it only runs while reading (ctx.lines is empty on re-check).
    const chain = ctx.lines.length ? checkRunningBalance(parseTransactionRows(ctx.lines), opening) : null;
    if (chain) out.push(chain);
    return out;
  },
};
