import { checkPayslip } from "@pde/validators";
import type { DocumentSchema } from "./types.ts";

export const payslipSchema: DocumentSchema = {
  type: "payslip",
  label: "Payslip",
  fields: [
    { key: "employer_name", label: "Employer", kind: "text", anchors: [/\b(?:employer|company(?: name)?)\b/i], required: true },
    { key: "employee_name", label: "Employee name", kind: "name", anchors: [/\bemployee name\b/i, /\bemployee\b(?! (?:id|no|number))/i, /^\s*name\b/i], required: true },
    { key: "employee_id", label: "Employee ID", kind: "id", anchors: [/\bemployee (?:id|no\.?|number)\b/i, /\bstaff (?:id|no\.?)\b/i] },
    { key: "pay_period", label: "Pay period", kind: "date_range", anchors: [/\bpay period\b/i, /\bperiod\b/i] },
    { key: "pay_date", label: "Pay date", kind: "date", anchors: [/\bpay(?:ment)? date\b/i, /\bdate paid\b/i, /\bpaid on\b/i], required: true },
    { key: "gross_pay", label: "Gross pay", kind: "amount", anchors: [/\bgross (?:pay|earnings|salary|income)\b/i, /\btotal (?:earnings|gross)\b/i, /\bgross\b/i], required: true },
    { key: "total_deductions", label: "Total deductions", kind: "amount", anchors: [/\btotal deductions\b/i, /\bdeductions total\b/i] },
    { key: "net_pay", label: "Net pay", kind: "amount", anchors: [/\bnet (?:pay|salary|amount|income)\b/i, /\btake[- ]home(?: pay)?\b/i, /\bamount paid\b/i], required: true },
  ],
  checks(fields) {
    const gross = Number(fields.get("gross_pay")?.value);
    const net = Number(fields.get("net_pay")?.value);
    const deductions = Number(fields.get("total_deductions")?.value);
    if (![gross, net, deductions].every((n) => Number.isFinite(n)) || !fields.get("total_deductions")?.value) return [];
    const r = checkPayslip({ gross, net, deductions: [deductions] });
    return [
      {
        id: "payslip.gross_minus_deductions_equals_net",
        ok: r.ok,
        message: r.ok ? "Gross − deductions = net" : `Gross − deductions differs from net by ${r.difference.toFixed(2)}`,
        fields: ["gross_pay", "total_deductions", "net_pay"],
      },
    ];
  },
};
