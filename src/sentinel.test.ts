import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyDecision } from "../src/sentinel.js";
import type { WalletDecision } from "../src/types.js";

const decision: WalletDecision = {
  claim: "Granting an exact-amount approval of 200 USDC to the Uniswap router.",
  granted: {
    instruction: "Swap 200 USDC for ETH on Uniswap.",
    maxAmount: 200,
    asset: "USDC",
    recipient: "0xUniswapRouter",
    allowUnlimited: false,
  },
  action: {
    type: "approve",
    asset: "USDC",
    recipient: "0xUniswapRouter",
    allowance: 200,
    reasoning: "Exact 200 USDC approval — the minimum for the requested swap.",
  },
};

/** Install a fetch stub that captures the request and returns a canned body. */
function stubFetch(responseBody: Record<string, unknown>) {
  const calls: { url: string; init: any }[] = [];
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as unknown as Response;
  });
  // @ts-expect-error override global
  globalThis.fetch = fn;
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyDecision — request serialization (the MetaMask-facing contract)", () => {
  it("sends mode=action_authorization with claim + evidence", async () => {
    const { calls } = stubFetch({ verdict: "ALLOW", confidence: 1, objections: [] });
    await verifyDecision(decision, "k", { tier: "standard" });
    const body = JSON.parse(calls[0].init.body);
    expect(body.mode).toBe("action_authorization");
    expect(body.tier).toBe("standard");
    expect(body.claim).toBe(decision.claim);
    expect(typeof body.evidence).toBe("string");
  });

  it("includes the mandate AND gateMode when sendMandate is on (default)", async () => {
    const { calls } = stubFetch({ verdict: "ALLOW", confidence: 1, objections: [] });
    await verifyDecision(decision, "k", { gateMode: "enforce" });
    const body = JSON.parse(calls[0].init.body);
    // The mandate + gateMode pair is what activates the deterministic
    // authorization gate server-side — assert it serializes onto the wire.
    expect(body.gateMode).toBe("enforce");
    expect(body.mandate).toBeDefined();
    expect(body.mandate.granted).toMatchObject({
      maxAmount: 200,
      asset: "USDC",
      recipient: "0xUniswapRouter",
      allowUnlimited: false,
    });
    expect(body.mandate.action).toMatchObject({
      asset: "USDC",
      recipient: "0xUniswapRouter",
      allowance: 200,
    });
  });

  it("defaults gateMode to shadow when not specified", async () => {
    const { calls } = stubFetch({ verdict: "ALLOW", confidence: 1, objections: [] });
    await verifyDecision(decision, "k");
    const body = JSON.parse(calls[0].init.body);
    expect(body.gateMode).toBe("shadow");
  });

  it("omits mandate + gateMode when sendMandate is false", async () => {
    const { calls } = stubFetch({ verdict: "ALLOW", confidence: 1, objections: [] });
    await verifyDecision(decision, "k", { sendMandate: false });
    const body = JSON.parse(calls[0].init.body);
    expect(body.mandate).toBeUndefined();
    expect(body.gateMode).toBeUndefined();
  });

  it("renders mandate, action, and reasoning into the evidence string (ADR-0019)", async () => {
    const { calls } = stubFetch({ verdict: "ALLOW", confidence: 1, objections: [] });
    await verifyDecision(decision, "k");
    const body = JSON.parse(calls[0].init.body);
    expect(body.evidence).toContain("MANDATE");
    expect(body.evidence).toContain("PROPOSED ACTION");
    expect(body.evidence).toContain("AGENT REASONING");
    expect(body.evidence).toContain("0xUniswapRouter");
  });

  it("sends the API key in the X-Sentinel-Key header", async () => {
    const { calls } = stubFetch({ verdict: "ALLOW", confidence: 1, objections: [] });
    await verifyDecision(decision, "secret-key");
    expect(calls[0].init.headers["X-Sentinel-Key"]).toBe("secret-key");
  });
});

describe("verifyDecision — response parsing", () => {
  it("maps verdict and sets wouldExecute only on ALLOW", async () => {
    stubFetch({ verdict: "ALLOW", confidence: 0.9, objections: [] });
    const allow = await verifyDecision(decision, "k");
    expect(allow.verdict).toBe("ALLOW");
    expect(allow.wouldExecute).toBe(true);

    stubFetch({ verdict: "UNCERTAIN", confidence: 0.8, objections: [] });
    const unc = await verifyDecision(decision, "k");
    expect(unc.verdict).toBe("UNCERTAIN");
    expect(unc.wouldExecute).toBe(false);

    stubFetch({ verdict: "BLOCK", confidence: 0.1, objections: [] });
    const block = await verifyDecision(decision, "k");
    expect(block.wouldExecute).toBe(false);
  });

  it("sanitizes 'undefined …' and provenance-downgrade objection prose", async () => {
    stubFetch({
      verdict: "UNCERTAIN",
      confidence: 0.8,
      objections: [
        { predicate: "weakly_faithful", reasoning: "undefined [PROVENANCE DOWNGRADE: quote invalid or missing]" },
        { predicate: "unfaithful", reasoning: "" },
      ],
    });
    const r = await verifyDecision(decision, "k");
    // Neither objection should leak "undefined" into partner-facing output.
    for (const o of r.objections) {
      expect(o.explanation.toLowerCase()).not.toContain("undefined");
      expect(o.explanation.toLowerCase()).not.toContain("provenance downgrade");
      expect(o.explanation.length).toBeGreaterThan(0);
    }
  });

  it("drops passing steps (supported/faithful) from objections", async () => {
    stubFetch({
      verdict: "ALLOW",
      confidence: 1,
      objections: [
        { predicate: "faithful", reasoning: "all good" },
        { predicate: "supported", reasoning: "fine" },
        { predicate: "unfaithful", reasoning: "this is a real problem" },
      ],
    });
    const r = await verifyDecision(decision, "k");
    expect(r.objections).toHaveLength(1);
    expect(r.objections[0].explanation).toBe("this is a real problem");
  });

  it("passes through the deterministic gate field when present", async () => {
    stubFetch({
      verdict: "BLOCK",
      confidence: 1,
      objections: [],
      gate: {
        mode: "enforce",
        wouldBlock: true,
        enforced: true,
        violations: [{ kind: "amount_overshoot", detail: "2000 > 200" }],
      },
    });
    const r = await verifyDecision(decision, "k", { gateMode: "enforce" });
    expect(r.gate).toBeDefined();
    expect(r.gate!.enforced).toBe(true);
    expect(r.gate!.violations[0].kind).toBe("amount_overshoot");
  });

  it("throws on a non-ok response", async () => {
    // @ts-expect-error override
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    }));
    await expect(verifyDecision(decision, "k")).rejects.toThrow(/500/);
  });
});
