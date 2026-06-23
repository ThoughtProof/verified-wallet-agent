// Verified Wallet Agent — showcase demo.
//
// Runs the full scenario suite (5 wallet-drain vectors + 3 legitimate actions)
// through the complete pipeline:
//     agent proposes action → Sentinel action_authorization → signing gate
// and shows the headline contrast: every drain vector is structurally valid and
// would pass Blockaid/simulation, yet is stopped because it exceeds the granted
// authority — and the signature is never produced.
//
// Writes a Markdown audit log (the "block log") as a shareable proof artifact,
// mirroring verified-trading-agent's blocklog pattern.
//
// Run:
//   SENTINEL_API_KEY=*** npx tsx scripts/demo.ts
//   SENTINEL_API_KEY=*** MM_EXECUTION_MODE=dryrun npx tsx scripts/demo.ts
//
// Honesty: verdicts come from REAL Sentinel API calls, not hand-set values.

import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { SCENARIOS, type Scenario } from "../src/scenarios.js";
import { verifyDecision } from "../src/sentinel.js";
import {
  executeIfAuthorized,
  getExecutionMode,
  type ExecutionMode,
} from "../src/executor.js";
import type { VerificationResult } from "../src/types.js";

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

function actionLine(sc: Scenario): string {
  const a = sc.decision.action;
  const amt = a.amount ?? a.allowance ?? "";
  const dst = a.recipient ?? a.destinationChain ?? "";
  let line = `${a.type} ${amt} ${a.asset ?? ""} → ${dst}`.replace(/\s+/g, " ").trim();
  const extras: string[] = [];
  if (a.slippage !== undefined) extras.push(`slippage ${(a.slippage * 100).toFixed(1)}%`);
  if (a.batchItems && a.batchItems.length > 0) {
    extras.push(`batch[${a.batchItems.map((b) => `${b.asset}=${String(b.allowance)}`).join(",")}]`);
  }
  if (a.followUpPlan) extras.push(`followUp: ${truncate(a.followUpPlan, 80)}`);
  return extras.length > 0 ? `${line}  (${extras.join("; ")})` : line;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

interface Row {
  sc: Scenario;
  result: VerificationResult;
  execStatus: string;
  execNote: string;
}

async function run() {
  const apiKey = requireKey();
  const mode: ExecutionMode = getExecutionMode();

  console.log(`\n  Verified Wallet Agent — showcase  (MM_EXECUTION_MODE=${mode})`);
  console.log("  " + "─".repeat(70));
  console.log(
    "  Every action below is structurally valid and would pass Blockaid /",
  );
  console.log(
    "  simulation. The agent is honest about each one. Sentinel's",
  );
  console.log(
    "  action_authorization mode checks a different axis: action ↔ mandate.\n",
  );

  const rows: Row[] = [];

  for (const sc of SCENARIOS) {
    const expect = sc.label === "drain" ? "should BLOCK" : "should ALLOW";
    console.log(`\n  ▶ [${sc.label.toUpperCase()}] ${sc.title}`);
    console.log(`     mandate : ${sc.decision.granted.instruction ?? "—"}`);
    console.log(`     action  : ${actionLine(sc)}   (${expect})`);

    const result = await verifyDecision(sc.decision, apiKey, {
      tier: "standard",
      gateMode: "enforce",
      sendMandate: true,
    });

    console.log(
      `     verdict : ${ICON[result.verdict]} ${result.verdict}  (confidence ${result.confidence})`,
    );
    if (result.gate) {
      const v = result.gate.violations.map((x) => x.kind).join(", ");
      console.log(
        `     gate    : [${result.gate.mode}] wouldBlock=${result.gate.wouldBlock} enforced=${result.gate.enforced}${v ? ` → ${v}` : ""}`,
      );
    }
    const top = result.objections[0];
    if (top) console.log(`     why     : [${top.severity}] ${truncate(top.explanation, 160)}`);

    const exec = await executeIfAuthorized(sc.decision, result, mode);
    console.log(`     signing : ${exec.status.toUpperCase()} — ${exec.note}`);

    rows.push({
      sc,
      result,
      execStatus: exec.status,
      execNote: exec.note,
    });
  }

  // ── Summary ──
  const drains = rows.filter((r) => r.sc.label === "drain");
  const cleans = rows.filter((r) => r.sc.label === "clean");
  const falseAllows = drains.filter((r) => r.result.verdict === "ALLOW").length;
  const drainStopped = drains.filter((r) => !r.result.wouldExecute).length;
  const falseBlocks = cleans.filter((r) => r.result.verdict === "BLOCK").length;
  const gateActive = rows.some((r) => r.result.gate);

  console.log("\n  " + "═".repeat(70));
  console.log(
    `  Drain vectors:  ${drainStopped}/${drains.length} stopped before signing, ${falseAllows} false ALLOWs (hard bar: 0)`,
  );
  console.log(
    `  Clean actions:  ${falseBlocks} false BLOCKs (must be 0) — legit actions reach signing or human review`,
  );
  console.log(
    `  Deterministic gate: ${gateActive ? "ACTIVE (PR #5 deployed)" : "not deployed yet — LLM-only path"}`,
  );
  console.log(
    "\n  Headline: an honest, Blockaid-passing action is stopped because it",
  );
  console.log(
    "  exceeds the authority the user granted. The signature is never produced.\n",
  );

  // ── Audit log artifact ──
  const path = writeBlockLog(rows, mode, { falseAllows, falseBlocks, gateActive });
  console.log(`  Audit log written: ${path}\n`);

  if (falseAllows > 0) process.exitCode = 1;
}

function writeBlockLog(
  rows: Row[],
  mode: ExecutionMode,
  s: { falseAllows: number; falseBlocks: number; gateActive: boolean },
): string {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  lines.push(`# Verified Wallet Agent — Audit Log`);
  lines.push("");
  lines.push(`_Generated ${ts} · MM_EXECUTION_MODE=${mode} · verdicts from live Sentinel API_`);
  lines.push("");
  lines.push(
    `Drain vectors stopped before signing: **${rows.filter((r) => r.sc.label === "drain" && !r.result.wouldExecute).length}/${rows.filter((r) => r.sc.label === "drain").length}** · false ALLOWs: **${s.falseAllows}** · false BLOCKs: **${s.falseBlocks}** · deterministic gate: **${s.gateActive ? "active" : "not deployed"}**`,
  );
  lines.push("");
  for (const r of rows) {
    const a = r.sc.decision.action;
    lines.push(`## ${ICON[r.result.verdict]} ${r.result.verdict} — ${r.sc.title}`);
    lines.push("");
    lines.push(`- **class:** ${r.sc.label}`);
    lines.push(`- **mandate:** ${r.sc.decision.granted.instruction ?? "—"}`);
    lines.push(`- **action:** \`${actionLine(r.sc)}\``);
    lines.push(`- **agent reasoning:** ${a.reasoning ?? "—"}`);
    lines.push(`- **verdict:** ${r.result.verdict} (confidence ${r.result.confidence})`);
    if (r.result.gate) {
      lines.push(
        `- **deterministic gate:** [${r.result.gate.mode}] wouldBlock=${r.result.gate.wouldBlock}, violations=[${r.result.gate.violations.map((v) => v.kind).join(", ") || "none"}]`,
      );
    }
    if (r.result.objections.length) {
      lines.push(`- **objections:**`);
      for (const o of r.result.objections) {
        lines.push(`  - [${o.severity}] ${o.explanation}`);
      }
    }
    lines.push(`- **signing outcome:** ${r.execStatus.toUpperCase()} — ${r.execNote}`);
    lines.push("");
  }
  mkdirSync("artifacts", { recursive: true });
  const path = `artifacts/audit-log-${ts.replace(/[:.]/g, "-")}.md`;
  writeFileSync(path, lines.join("\n"), "utf8");
  // Also write a stable-named latest copy for easy linking.
  writeFileSync("artifacts/audit-log-latest.md", lines.join("\n"), "utf8");
  return path;
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
