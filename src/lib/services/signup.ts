// Self sign-up (design: docs/superpowers/specs/2026-11-14-self-signup-design.md). Super Stockist, Distributor and
// Retailer shops create their own account; Velza Admin creates only the plant's sign-ins (-OP, -QC) and Velza's own.
// A Retailer works at once. A Super Stockist or Distributor is saved PENDING (partner and sign-in inactive) until
// Velza Admin approves or rejects it (admin.ts decideApproval). Everything is stored like an Admin registration.

import { z } from "zod";
import { formatSequenceId, PARTNER_ID_PREFIX, partnerLoginId } from "@/lib/core/ids";
import { PARTNER_TYPE_LABELS, type Partner } from "@/lib/core/types";
import { hashPassword } from "@/lib/passwords";
import { getStore } from "@/lib/store";
import { newUser, partnerFields, requirePassword, validatePartner } from "./admin";
import { badRequest, nowIso } from "./common";

/** The tiers a shop can sign itself up as. */
export const SIGNUP_TYPES = ["SS", "DB", "RETAILER"] as const;

export const signupSchema = z.object({
  ...partnerFields,
  type: z.enum(SIGNUP_TYPES),
  password: z.string().max(200),
});

/** Approved (no approval mark) and active: the only partners a sign-up may pick, and the only ones it sees. */
const usable = (p: Partner) => p.active && !p.approval;

/**
 * What the sign-up form needs, and nothing more (the page is public): the states that already have a
 * Super Stockist (pending ones included, rejected ones not), and the approved Super Stockists and
 * Distributors to pick as supplier — ID, name, city (and state / parent to filter by).
 */
export async function signupOptions() {
  const partners = await getStore().partners.list();
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    statesTaken: [...new Set(partners.filter((p) => p.type === "SS" && p.approval !== "REJECTED").map((p) => p.state))].sort(),
    superStockists: partners
      .filter((p) => p.type === "SS" && usable(p))
      .map(({ id, name, city, state }) => ({ id, name, city, state }))
      .sort(byName),
    distributors: partners
      .filter((p) => p.type === "DB" && usable(p))
      .map(({ id, name, city, parentId }) => ({ id, name, city, parentId }))
      .sort(byName),
  };
}

/**
 * Create the shop's partner record and its sign-in (ID = partner ID, e.g. RT0007) with the password it chose.
 * A Distributor must pick its Super Stockist; a Retailer its Distributor (or, for a few, its Super Stockist);
 * the picked partner must be approved and active. The Admin form's other checks apply (state, one SS per state,
 * PIN, phone, email, duplicates, password rules).
 */
export async function signup(body: unknown): Promise<{ partner: Partner; loginId: string; pending: boolean; message: string }> {
  const { password, ...data } = signupSchema.parse(body);
  const hash = await hashPassword(requirePassword(password, "Password"));
  const label = PARTNER_TYPE_LABELS[data.type];
  return getStore().transaction(async (tx) => {
    const parentId = data.type === "SS" ? null : (data.parentId ?? null);
    if (data.type !== "SS") {
      const parent = parentId ? await tx.partners.get(parentId) : null;
      if (!parent || !usable(parent)) {
        const whom = data.type === "DB" ? "Super Stockist" : "Distributor or Super Stockist";
        throw badRequest("BAD_PARENT", `Pick the ${whom} that supplies this ${label}`);
      }
    }
    const pending = data.type !== "RETAILER";
    const fields = { state: "", pincode: "", email: "", ...data, parentId, active: !pending, approval: pending ? ("PENDING" as const) : null };
    await validatePartner(tx, fields);
    const prefix = PARTNER_ID_PREFIX[data.type];
    const id = formatSequenceId(prefix, await tx.nextSequence(prefix));
    // createdBy null = the shop signed itself up (an Admin registration records the Admin's ID).
    const partner = await tx.partners.create({ ...fields, id, createdAt: nowIso(), createdBy: null });
    const loginId = partnerLoginId(data.type, id);
    const user = await newUser(tx, loginId, data.contactPerson, data.type, id, hash);
    if (pending) await tx.users.update(user.id, { active: false });
    return {
      partner,
      loginId,
      pending,
      message: pending
        ? `Account created: your sign-in ID is ${loginId}. Your account is waiting for Velza approval — you can sign in once Velza approves it.`
        : `Account created: your sign-in ID is ${loginId}. You can sign in now.`,
    };
  });
}
