import { describe, it, expect } from "vitest";
import { executeIfAuthorized } from "../src/executor.js";
import type { WalletDecision, VerificationResult } from "../src/types.js";

const decision: WalletDecision = {
  claim: "test",
  granted: { maxAmount: 200, recipient: "0xACME" },
  action: { type: "transfer", amount: 200, recipient: "0xACME" },
};

function result(verdict: VerificationResult["verdict"]): VerificationResult {
  return {
    verdict,
    confidence: 1,
    reason: "",
    objections: [],
    wouldExecute: verdict === "ALLOW",
  };
}

describe("executor signing-gate invariant", () => {
  it("suppresses the signature on BLOCK in every mode", async () => {
    for (const mode of ["off", "dryrun", "live"] as const) {
      const r = await executeIfAuthorized(decision, result("BLOCK"), mode);
      expect(r.status).toBe("suppressed");
      expect(r.payload).toBeUndefined();
    }
  });

  it("suppresses the signature on UNCERTAIN (fail-closed)", async () => {
    const r = await executeIfAuthorized(decision, result("UNCERTAIN"), "live");
    expect(r.status).toBe("suppressed");
    expect(r.payload).toBeUndefined();
  });

  it("only reaches signing on ALLOW", async () => {
    const off = await executeIfAuthorized(decision, result("ALLOW"), "off");
    expect(off.status).toBe("skipped");
    const dry = await executeIfAuthorized(decision, result("ALLOW"), "dryrun");
    expect(dry.status).toBe("previewed");
    expect(dry.payload).toBeDefined();
    const live = await executeIfAuthorized(decision, result("ALLOW"), "live");
    expect(live.status).toBe("executed");
  });
});
