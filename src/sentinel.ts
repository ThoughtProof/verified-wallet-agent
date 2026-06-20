// Sentinel client — routes a WalletDecision through ThoughtProof's
// action_authorization mode before the agent signs anything.
//
// Verified against the deployed API (sentinel.thoughtproof.ai) 2026-06-20:
//  - mode "action_authorization" IS deployed: the four gold steps (scope
//    containment, recipient integrity, mandate alignment, least-privilege) run
//    live and BLOCK the categorical drain vectors.
//  - the deterministic gate (mandate + gateMode → `gate` response field) is
//    NOT yet deployed (thoughtproof-sentinel PR #5, ADR-0019). When it lands,
//    this client already sends both fields, so the gate activates automatically
//    and the `gate` field appears in the response. Until then the call degrades
//    gracefully to the LLM-only path (the extra fields are ignored server-side).
//
// Call shape (matches verified-trading-agent/src/verification.ts):
//   POST sentinel.thoughtproof.ai/sentinel/verify
//   headers: X-Sentinel-Key, Content-Type: application/json
//   body: { claim, evidence, mode, tier, mandate?, gateMode? }
//   => { verdict, confidence, reasoning, objections[], gate?, ... }

import type {
  WalletDecision,
  VerificationResult,
  Verdict,
  Objection,
} from "./types.js";

const SENTINEL_URL =
  process.env.SENTINEL_URL ?? "https://sentinel.thoughtproof.ai/sentinel/verify";

function normalizeVerdict(v: unknown): Verdict {
  const s = String(v ?? "").toUpperCase();
  if (s === "BLOCK" || s === "FAIL") return "BLOCK";
  if (s === "ALLOW" || s === "PASS") return "ALLOW";
  return "UNCERTAIN";
}

const SEVERITY: Record<string, Objection["severity"]> = {
  unsupported: "critical",
  unfaithful: "critical",
  unauthorized: "critical", // deterministic-gate objections
  partial: "medium",
  weakly_faithful: "medium",
  partially_faithful: "medium",
  skipped: "low",
};

function mapObjections(raw: unknown): Objection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o) => {
      const p = String((o as any)?.predicate ?? "");
      return p !== "supported" && p !== "faithful";
    })
    .map((o) => {
      const predicate = String((o as any)?.predicate ?? "");
      const reasoning = String((o as any)?.reasoning ?? "").trim();
      const criterion = String((o as any)?.criterion ?? "").trim();
      return {
        severity: SEVERITY[predicate] ?? "medium",
        explanation: cleanExplanation(reasoning, criterion, predicate),
      };
    })
    .filter((o) => o.explanation.length > 0);
}

/**
 * Produce a clean, human-readable objection sentence.
 *
 * The deployed API sometimes returns a synthesized `reasoning` that (a) begins
 * with the literal token "undefined" when the model omitted prose, and/or (b)
 * is a provenance-downgrade marker with no real content. In those cases fall
 * back to a concise statement derived from the predicate rather than leaking
 * "undefined …" into a partner-facing demo. We deliberately do NOT echo the
 * full gold-step criterion (it's a paragraph); the predicate carries the signal.
 */
function cleanExplanation(reasoning: string, criterion: string, predicate: string): string {
  const looksBroken =
    reasoning.length === 0 ||
    /^undefined\b/i.test(reasoning) ||
    /provenance downgrade/i.test(reasoning);
  if (!looksBroken) return reasoning;

  const phrase: Record<string, string> = {
    unsupported: "the action is not supported by the granted authority",
    unfaithful: "the action is not authorized by the mandate",
    unauthorized: "the action exceeds the granted authority",
    partial: "the action only partially matches the granted authority",
    weakly_faithful: "the action is only weakly supported by the mandate",
    partially_faithful: "the action is only partially authorized by the mandate",
    skipped: "this authority check was not evaluated",
  };
  return phrase[predicate] ?? `authority check failed (${predicate || "unknown"})`;
}

/**
 * Render a WalletDecision into the claim + evidence the action_authorization
 * mode expects. The evidence MUST carry the mandate, the action, and the
 * reasoning (ADR-0019) — the gold steps grade against exactly these.
 */
function renderEvidence(d: WalletDecision): string {
  const g = d.granted;
  const a = d.action;
  const parts: string[] = [];
  parts.push(
    `MANDATE (what the principal authorized): ${
      g.instruction ?? "(no free-text instruction supplied)"
    }`,
  );
  const grantedBits: string[] = [];
  if (g.maxAmount !== undefined) grantedBits.push(`max amount ${g.maxAmount}`);
  if (g.asset) grantedBits.push(`asset ${g.asset}`);
  if (g.recipient) grantedBits.push(`authorized recipient/spender ${g.recipient}`);
  grantedBits.push(`unlimited approval ${g.allowUnlimited ? "GRANTED" : "NOT granted"}`);
  parts.push(`GRANTED SCOPE: ${grantedBits.join("; ")}.`);

  const actionBits: string[] = [`type ${a.type}`];
  if (a.amount !== undefined) actionBits.push(`amount ${a.amount}`);
  if (a.asset) actionBits.push(`asset ${a.asset}`);
  if (a.recipient) actionBits.push(`recipient/spender ${a.recipient}`);
  if (a.allowance !== undefined) actionBits.push(`allowance ${String(a.allowance)}`);
  if (a.destinationChain) actionBits.push(`destination chain ${a.destinationChain}`);
  parts.push(`PROPOSED ACTION: ${actionBits.join("; ")}.`);

  if (a.reasoning) parts.push(`AGENT REASONING: ${a.reasoning}`);
  return parts.join("\n\n");
}

export interface VerifyOptions {
  tier?: "checkpoint" | "standard" | "swift";
  /** 'shadow' (default) logs the deterministic gate; 'enforce' lets it BLOCK. */
  gateMode?: "shadow" | "enforce";
  /** Send the machine-readable mandate so the deterministic gate can run. */
  sendMandate?: boolean;
}

export async function verifyDecision(
  decision: WalletDecision,
  apiKey: string,
  opts: VerifyOptions = {},
): Promise<VerificationResult> {
  const tier = opts.tier ?? "standard";
  const gateMode = opts.gateMode ?? "shadow";
  const sendMandate = opts.sendMandate ?? true;

  const body: Record<string, unknown> = {
    claim: decision.claim,
    evidence: renderEvidence(decision),
    mode: "action_authorization",
    tier,
  };
  if (sendMandate) {
    body.mandate = {
      granted: {
        maxAmount: decision.granted.maxAmount,
        asset: decision.granted.asset,
        recipient: decision.granted.recipient,
        allowUnlimited: decision.granted.allowUnlimited ?? false,
      },
      action: {
        amount: decision.action.amount,
        asset: decision.action.asset,
        recipient: decision.action.recipient,
        allowance: decision.action.allowance,
      },
    };
    body.gateMode = gateMode;
  }

  const res = await fetch(SENTINEL_URL, {
    method: "POST",
    headers: { "X-Sentinel-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Sentinel failed (${res.status}): ${await res.text()}`);
  }
  const d = (await res.json()) as Record<string, any>;
  const verdict = normalizeVerdict(d.verdict);
  return {
    verdict,
    confidence: Number(d.confidence ?? 0),
    reason: String(d.reasoning ?? ""),
    objections: mapObjections(d.objections),
    gate: d.gate
      ? {
          mode: d.gate.mode,
          wouldBlock: Boolean(d.gate.wouldBlock),
          enforced: Boolean(d.gate.enforced),
          violations: Array.isArray(d.gate.violations) ? d.gate.violations : [],
        }
      : undefined,
    // Fail-closed: only an explicit ALLOW lets the action through to signing.
    // BLOCK and UNCERTAIN both stop it.
    wouldExecute: verdict === "ALLOW",
  };
}
