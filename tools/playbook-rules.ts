// tools/playbook-rules.ts — CLI operator untuk PlaybookRule (SMB T-05/T-06).
// Satu-satunya jalur untuk mengubah status aturan (GR #9: aturan baru lahir
// PROPOSED; APPROVED hanya lewat keputusan eksplisit operator di sini).
//
// Pakai:
//   npx tsx tools/playbook-rules.ts list [status]
//   npx tsx tools/playbook-rules.ts approve <ruleId>
//   npx tsx tools/playbook-rules.ts reject <ruleId>
//   npx tsx tools/playbook-rules.ts archive <ruleId>
//   npx tsx tools/playbook-rules.ts add "<ruleText>" "<triggerCondition>" "<actionStatement>"
import { db } from "../apps/server/src/core/db.js";
import { PLAYBOOK_STATUSES } from "../apps/server/src/learning/playbookRules.js";

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === "list") {
    const where = a ? { status: a.toUpperCase() } : {};
    const rules = await db.playbookRule.findMany({ where, orderBy: { createdAt: "desc" } });
    for (const r of rules) {
      console.log(`[${r.status}] ${r.id} (${r.source}) applied=${r.appliedCount} violated=${r.violatedCount}`);
      console.log(`  IF   : ${r.triggerCondition}`);
      console.log(`  THEN : ${r.actionStatement}`);
      console.log(`  TEXT : ${r.ruleText}`);
    }
    console.log(`Total: ${rules.length} aturan${a ? ` (status ${a.toUpperCase()})` : ""}`);
  } else if (cmd === "approve" || cmd === "reject" || cmd === "archive") {
    if (!a) { console.error("butuh <ruleId>"); process.exit(2); }
    const status = cmd === "approve" ? "APPROVED" : cmd === "reject" ? "REJECTED" : "ARCHIVED";
    const rule = await db.playbookRule.findUnique({ where: { id: a } });
    if (!rule) { console.error(`aturan ${a} tidak ditemukan`); process.exit(1); }
    await db.playbookRule.update({ where: { id: a }, data: { status, updatedAt: new Date() } });
    await db.eventLog.create({ data: { type: "PLAYBOOK_RULE_STATUS", severity: "info", payload: JSON.stringify({ ruleId: a, from: rule.status, to: status, via: "operator-cli" }) } });
    console.log(`OK: ${a} ${rule.status} -> ${status}`);
  } else if (cmd === "add") {
    if (!a || !b || !c) { console.error('pakai: add "<ruleText>" "<triggerCondition>" "<actionStatement>"'); process.exit(2); }
    const rule = await db.playbookRule.create({ data: { ruleText: a, triggerCondition: b, actionStatement: c, source: "MANUAL", status: "PROPOSED" } });
    console.log(`OK: aturan MANUAL dibuat sebagai PROPOSED (id ${rule.id}). Jalankan "approve ${rule.id}" untuk mengaktifkan.`);
  } else {
    console.log("Status valid: " + PLAYBOOK_STATUSES.join(", "));
    console.error("Perintah: list [status] | approve <id> | reject <id> | archive <id> | add <ruleText> <trigger> <action>");
    process.exit(2);
  }
  await db.$disconnect();
}
main().catch((e) => { console.error("ERROR:", (e as Error).message); process.exit(1); });