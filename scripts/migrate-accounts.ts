// npm run migrate-accounts → upgrade a data file created before sign-in existed. Safe to run again.
// Users without a sign-in ID get the seeded one (admin, hq, operator, qc, ss1, …) and the default
// password, already approved; partners get an empty territory; DB-n is assigned to SS-n when both exist.

import { hashPassword } from "@/lib/passwords";
import { dbFilePath, getStore } from "@/lib/store";
import { DEFAULT_SEED_PASSWORD, partnerTag, seedLoginId } from "@/lib/store/seedData";

async function main() {
  const password = process.env.SEED_PASSWORD || DEFAULT_SEED_PASSWORD;
  const passwordHash = await hashPassword(password);
  const report = await getStore().transaction(async (tx) => {
    const [users, partners] = await Promise.all([tx.users.list(), tx.partners.list()]);
    const at = new Date().toISOString();
    const lines: string[] = [];

    for (const p of partners) {
      const patch: Record<string, unknown> = {};
      if (p.territory === undefined) patch.territory = "";
      if (p.parentId === undefined) {
        const ss = p.type === "DB" ? partners.find((x) => x.type === "SS" && partnerTag(x) === partnerTag(p).replace("DB", "SS")) : undefined;
        patch.parentId = ss?.id ?? null;
        if (ss) lines.push(`${p.name} assigned to ${ss.name}`);
      }
      if (Object.keys(patch).length) await tx.partners.update(p.id, patch);
    }

    const admin = users.find((u) => u.role === "ADMIN");
    const hq = users.find((u) => u.role === "TRACE_OWNER");
    const taken = new Set(users.map((u) => u.loginId).filter(Boolean));
    for (const u of users) {
      if (u.loginId) continue;
      const base = seedLoginId(u.role, partners.find((p) => p.id === u.partnerId) ?? null);
      let loginId = base;
      for (let i = 2; taken.has(loginId); i++) loginId = `${base}${i}`;
      taken.add(loginId);
      const partnerRole = u.partnerId !== null;
      await tx.users.update(u.id, {
        loginId,
        passwordHash,
        createdAt: at,
        adminApprovedBy: partnerRole ? (admin?.id ?? null) : null,
        adminApprovedAt: partnerRole ? at : null,
        hqApprovedBy: partnerRole ? (hq?.id ?? null) : null,
        hqApprovedAt: partnerRole ? at : null,
        rejectedBy: null,
        rejectedAt: null,
        rejectReason: null,
      });
      lines.push(`${u.name}: sign-in ID ${loginId}`);
    }
    return lines;
  });
  console.log(`Upgraded ${dbFilePath()}`);
  for (const l of report) console.log(`  - ${l}`);
  if (report.some((l) => l.includes("sign-in ID"))) console.log(`New accounts use the password ${password} — change it after signing in (Account page).`);
  if (!report.length) console.log("  nothing to do");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
