import { expect, it } from "vitest";

import { measureFsIo } from "./ioBudget";

// No vi.mock lines here on purpose: a file that forgot them must not
// read an unmeasured zero as a passing budget.
it("refuses to measure when node:fs is not instrumented", async () => {
  await expect(measureFsIo(() => undefined)).rejects.toThrow(/not live in this test file/);
});
