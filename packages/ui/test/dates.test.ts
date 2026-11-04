import { describe, expect, it } from "vitest";
import { displayToIso, displayToIsoRange, isoRangeToDisplay, isoToDisplay } from "../src/dates.ts";

describe("DD-MM-YYYY dates", () => {
  it("shows ISO dates as DD-MM-YYYY", () => {
    expect(isoToDisplay("1965-12-15")).toBe("15-12-1965");
    expect(isoRangeToDisplay("2025-07-01/2025-07-31")).toBe("01-07-2025 to 31-07-2025");
  });
  it("parses what people type back to ISO", () => {
    expect(displayToIso("15-12-1965")).toBe("1965-12-15");
    expect(displayToIso("1/3/2025")).toBe("2025-03-01");
    expect(displayToIso("01.03.2025")).toBe("2025-03-01");
    expect(displayToIso("2025-03-01")).toBe("2025-03-01");
    expect(displayToIsoRange("01-07-2025 to 31-07-2025")).toBe("2025-07-01/2025-07-31");
  });
  it("rejects impossible or ambiguous input", () => {
    expect(displayToIso("31-02-2025")).toBeNull();
    expect(displayToIso("12-1965")).toBeNull();
    expect(displayToIso("1965-15-12")).toBeNull();
    expect(displayToIsoRange("31-07-2025 to 01-07-2025")).toBeNull();
  });
});
