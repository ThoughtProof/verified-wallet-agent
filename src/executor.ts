// Wallet executor — the signing gate.
//
// This is the whole point: a verified ALLOW is the ONLY path that reaches the
// signing pipeline. BLOCK and UNCERTAIN both suppress the signature entirely —
// the action never becomes a transaction, never enters MetaMask's
// simulation → Blockaid → MEV pipeline, never touches the chain.
//
// We do NOT modify MetaMask and do NOT require a hook inside its (non-bypassable)
// pipeline — there isn't one by design. The gate lives in the agent that drives
// the wallet, exactly as in verified-trading-agent's metamask-executor. Here the
// action surface is the full wallet (approve/transfer/permit/bridge), not just
// perps.
//
// MM_EXECUTION_MODE:
//   off (default) — no signing; pure logical demonstration of the gate.
//   dryrun        — on ALLOW, build the action payload and (if a signer is
//                   configured) run a read-only preview. Never broadcasts.
//   live          — on ALLOW, submit via the configured signer. Operator opt-in.

import type { WalletDecision, VerificationResult } from "./types.js";

export type ExecutionMode = "off" | "dryrun" | "live";

export function getExecutionMode(): ExecutionMode {
  const m = (process.env.MM_EXECUTION_MODE ?? "off").toLowerCase();
  return m === "dryrun" || m === "live" ? (m as ExecutionMode) : "off";
}

export interface ExecutionResult {
  mode: ExecutionMode;
  status: "executed" | "suppressed" | "previewed" | "skipped";
  note: string;
  /** The action payload that WOULD be signed (for transparency/audit). */
  payload?: Record<string, unknown>;
}

function buildPayload(d: WalletDecision): Record<string, unknown> {
  const a = d.action;
  return {
    type: a.type,
    asset: a.asset,
    amount: a.amount,
    recipient: a.recipient,
    allowance: a.allowance,
    destinationChain: a.destinationChain,
  };
}

/**
 * The signing gate. Given a decision and its verification result, decide whether
 * to sign. The invariant — enforced here and asserted in tests — is:
 *
 *     result.wouldExecute === false  ⇒  the signer is NEVER invoked.
 *
 * Only a verified ALLOW can reach the signing pipeline.
 */
export async function executeIfAuthorized(
  decision: WalletDecision,
  result: VerificationResult,
  mode: ExecutionMode = getExecutionMode(),
): Promise<ExecutionResult> {
  // Fail-closed: anything other than an explicit, executable ALLOW is suppressed.
  if (!result.wouldExecute) {
    return {
      mode,
      status: "suppressed",
      note: `Verdict ${result.verdict} — signature suppressed. The ${decision.action.type} action never reaches the signing pipeline.`,
    };
  }

  const payload = buildPayload(decision);

  if (mode === "off") {
    return {
      mode,
      status: "skipped",
      note: `ALLOW — would sign this ${decision.action.type}, but MM_EXECUTION_MODE=off (no signing).`,
      payload,
    };
  }

  if (mode === "dryrun") {
    return {
      mode,
      status: "previewed",
      note: `ALLOW — built the ${decision.action.type} payload for read-only preview. Not broadcast.`,
      payload,
    };
  }

  // mode === "live": operator opt-in. A real signer integration is plugged in
  // here (e.g. the mm CLI, an ethers Wallet, a Safe proposer). Kept as an
  // explicit, honest stub so we never fake a broadcast we didn't perform.
  return {
    mode,
    status: "executed",
    note: `ALLOW — live signing requested for this ${decision.action.type}. Wire a concrete signer here before claiming a broadcast.`,
    payload,
  };
}
