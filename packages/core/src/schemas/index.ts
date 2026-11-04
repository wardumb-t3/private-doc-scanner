import type { DocType } from "../types.ts";
import { bankStatementSchema } from "./bank-statement.ts";
import { genericSchema } from "./generic.ts";
import { idCardSchema, passportSchema } from "./identity.ts";
import { payslipSchema } from "./payslip.ts";
import type { DocumentSchema } from "./types.ts";

export const SCHEMAS: Record<DocType, DocumentSchema> = {
  passport: passportSchema,
  id_card: idCardSchema,
  payslip: payslipSchema,
  bank_statement: bankStatementSchema,
  generic: genericSchema,
};

export function getSchema(type: DocType): DocumentSchema {
  return SCHEMAS[type];
}

export type { DocumentSchema, FieldSpec, SchemaContext } from "./types.ts";
export { parseTransactionRows, checkRunningBalance } from "./bank-statement.ts";
