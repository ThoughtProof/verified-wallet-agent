// Standalone demo: feed one drain vector + one clean action through the full
// pipeline (Sentinel action_authorization → signing gate) and show the headline:
// BLOCK suppresses the signature entirely; ALLOW reaches the signing gate.
//
// Run:
//   SENTINEL_API_KEY=*** npx tsx scripts/demo.ts
//   SENTINEL_API_KEY=*** MM_EXECUTION_MODE=dryrun npx tsx scripts/demo.ts
//
// Honesty: verdicts come from REAL Sentinel API calls, not hand-set values.

import "dotenv/config";
import { SCENARIOS } from "../src/scenarios.js";
import { verifyDecision } from "../src/sentinel.js";
import { executeIfAuthorized, getExecutionMode } from "../src/executor.js";

function requireKey(): string {
  const k = process.env.SENTINEL_API_KEY ?? process.env.SENTINEL_KEY;
  if (!k) {
    console.error(
      "Missing SENTINEL_API_KEY. Set it in the environment or a .env file.",
    );
    process.exit(1);
  }
  return k;
}

const ICON = { ALLOW: "✅", BLOCK: "🛑", UNCERTAIN: "⚠️" } as const;

async function run() {
  const apiKey = requireKey();
  const mode = getExecutionMode();
  const picks = ["drain-01-unlimited-approval", "ok-01-exact-swap-approval"];
  const scenarios = picks
    .map((id) => SCENARIOS.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  console.log(`\nVerified Wallet Agent — demo (MM_EXECUTION_MODE=${mode})`);
  console.log("=".repeat(64));

  for (const sc of scenarios) {
    const a = sc.decision.action;
    console.log(`\n▶ ${sc.title}`);
    console.log(
      `  action: ${a.type} ${a.amount ?? a.allowance ?? ""} ${a.asset ?? ""} → ${a.recipient ?? a.destinationChain ?? ""}`.replace(/\s+/g, " ").trim(),
    );
    const result = await verifyDecision(sc.decision, apiKey, {
      tier: "standard",
      gateMode: "enforce",
      sendMandate: true,
    });
    console.log(
      `  ${ICON[result.verdict]} ${result.verdict} (confidence ${result.confidence})`,
    );
    if (result.gate) {
      console.log(
        `  gate[${result.gate.mode}]: wouldBlock=${result.gate.wouldBlock} enforced=${result.gate.enforced}` +
          (result.gate.violations.length
            ? ` violations=[${result.gate.violations.map((v) => v.kind).join(", ")}]`
            : ""),
      );
    }
    for (const o of result.objections.slice(0, 2)) {
      console.log(`    └ [${o.severity}] ${o.explanation}`);
    }
    const exec = await executeIfAuthorized(sc.decision, result, mode);
    console.log(`  → ${exec.status.toUpperCase()}: ${exec.note}`);
  }

  console.log(
    "\nHeadline: an honest, structurally-valid, Blockaid-passing action is",
  );
  console.log(
    "stopped because it exceeds the authority the user granted — and the",
  );
  console.log("signature is never produced.\n");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
