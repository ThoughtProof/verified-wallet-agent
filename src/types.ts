// Core types for the verified wallet agent.
//
// A wallet agent acts under a principal's MANDATE (what the user authorized) by
// proposing on-chain ACTIONS (approve / transfer / permit / bridge / swap). The
// danger class this repo targets is the honest-but-over-scoped action: an action
// that is structurally valid (Blockaid passes it) and faithfully reasoned (the
// agent isn't lying), yet exceeds the authority the principal granted.

export type Verdict = "ALLOW" | "BLOCK" | "UNCERTAIN";

/** The kind of on-chain action the agent proposes. */
export type ActionType = "approve" | "transfer" | "permit" | "bridge" | "swap";

/**
 * What the principal authorized. The agent must stay within this.
 * Mirrors thoughtproof-sentinel AuthorizationMandate.granted.
 */
export interface GrantedScope {
  /** Maximum amount the principal authorized (asset units). */
  maxAmount?: number;
  /** Asset symbol or address the principal authorized. */
  asset?: string;
  /** The counterparty / spender / recipient the principal authorized. */
  recipient?: string;
  /** Did the principal EXPLICITLY grant an unlimited approval? Default false. */
  allowUnlimited?: boolean;
  /** Free-text instruction the principal gave (for the LLM layer). */
  instruction?: string;
}

/** What the agent proposes to do. Mirrors AuthorizationMandate.action. */
export interface ProposedAction {
  type: ActionType;
  /** Amount the action moves/spends (asset units). */
  amount?: number;
  /** Asset symbol or address the action touches. */
  asset?: string;
  /** Recipient / spender / counterparty of the action. */
  recipient?: string;
  /** Approval allowance — number, or "MAX_UINT256" / "unlimited" / hex string. */
  allowance?: string | number;
  /** Destination chain for a bridge action. */
  destinationChain?: string;
  /**
   * Slippage tolerance for a swap, as a fraction (0.005 = 0.5%, 0.5 = 50%).
   * Absurdly high slippage enables sandwich / MEV extraction.
   */
  slippage?: number;
  /**
   * For Permit2 batch approvals: additional (asset, allowance) pairs the agent
   * proposes to approve in the same batch beyond the mandated asset.
   */
  batchItems?: { asset: string; allowance: string | number }[];
  /**
   * For multi-step drain setups: the agent's stated plan for what happens AFTER
   * the current action. If the plan reveals a future action the mandate doesn't
   * authorize, the gate should BLOCK even if the current tx looks harmless.
   */
  followUpPlan?: string;
  /** The agent's own stated reasoning for the action (for the LLM layer). */
  reasoning?: string;
}

/** A complete decision the agent reached: what it wants to do + why. */
export interface WalletDecision {
  /** The agent's one-line assertion that the action is in-scope (the `claim`). */
  claim: string;
  granted: GrantedScope;
  action: ProposedAction;
}

/** Per-step objection surfaced by Sentinel (slimmed). */
export interface Objection {
  severity: "low" | "medium" | "high" | "critical";
  explanation: string;
}

/** Result of verifying a WalletDecision. */
export interface VerificationResult {
  verdict: Verdict;
  confidence: number;
  reason: string;
  objections: Objection[];
  /** Deterministic-gate result, when the API returned one (PR #5). */
  gate?: {
    mode: "shadow" | "enforce";
    wouldBlock: boolean;
    enforced: boolean;
    violations: { kind: string; detail: string }[];
  };
  /** Whether `mm`/the signing pipeline would be invoked (ALLOW only). */
  wouldExecute: boolean;
}
