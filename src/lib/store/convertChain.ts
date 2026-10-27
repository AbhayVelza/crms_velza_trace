// Converts data from before the chain change to the current chain. Before: Manufacturer → Super Stockist
// → Distributor → Supplier → Outlet. Now: Manufacturer → Super Stockist → Distributor → Retailer, and a few
// Retailers are served by their Super Stockist directly.
// - Outlets become Retailers (partner type, sign-in role, AT_OUTLET → AT_RETAILER), and an OT0001-style ID
//   becomes the next RT number everywhere it appears.
// - Suppliers are removed with their sign-ins and sessions; a Retailer that was assigned to a Supplier is
//   assigned to that Supplier's own Distributor. A Supplier that still holds stock, has stock on the way,
//   or appears in any history is refused: history is never dropped.
// - Partners and sign-ins entered before the registration form and sign-in existed get the fields they lack.
// Pure: returns a converted copy and what changed, in plain words. Running it again changes nothing.
// Used by `npm run db:convert-chain` and by `npm run db:import-json`.

import { formatSequenceId, PARTNER_ID_PREFIX } from "@/lib/core/ids";
import { ASSIGNED_TO } from "@/lib/core/rules";
import { PARTNER_TYPE_LABELS, type PartnerType } from "@/lib/core/types";
import type { DbSnapshot } from "./Store";

// Values of the old chain. They are no longer in the app's types, so rows are read as plain records here.
const SUPPLIER = "SUPPLIER";
const OUTLET = "OUTLET";
const RETAILER: PartnerType = "RETAILER";
const STATUS_RENAMES: Record<string, string> = { AT_OUTLET: "AT_RETAILER" };
const SUPPLIER_STATUS = "AT_SUPPLIER";
/** Old ID sequences: Supplier (SP0001) and Outlet (OT0001). */
const OLD_SEQUENCES = ["SP", "OT"];
const OUTLET_ID_RE = /^OT([0-9]{4,})$/;
const RT = PARTNER_ID_PREFIX.RETAILER;
const RT_ID_RE = new RegExp(`^${RT}([0-9]{4,})$`);

/** Text fields of the registration form, missing on partners entered before it. */
const PARTNER_TEXT_FIELDS = ["place", "address", "city", "state", "pincode", "contactPerson", "phone", "email"];
/** Sign-in fields, missing on people entered before sign-in existed. */
const USER_FIELDS = ["passwordHash", "passwordChangedAt", "createdAt", "lastLoginAt"];

export const NOTHING_TO_CONVERT = "Nothing to convert: no Suppliers, Outlets, old statuses or incomplete records found.";

/** How many codes a refusal lists by name before "… and N more". */
const LIST_MAX = 10;

type Rec = Record<string, unknown>;

const rows = (data: DbSnapshot, name: keyof DbSnapshot) => (Array.isArray(data[name]) ? data[name] : []) as unknown as Rec[];
const str = (v: unknown) => (typeof v === "string" ? v : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every string value in a row (any depth), with its field path. */
function* strings(value: unknown, path: string): Generator<[path: string, value: string]> {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* strings(value[i], `${path}[${i}]`);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}.${k}`);
}

/** Fields that hold what someone typed or scanned, or free text: never renamed, even if one equals an old ID. */
const TEXT_FIELDS = new Set(["code", "message", "result", "note", "reason", "invoice", "name", "quarantineReason", "recallReason"]);

/** Replace string values equal to a key of `map`, at any depth, in place (except in TEXT_FIELDS). */
function renameValues(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = renameValues(value[i], map);
  } else if (value && typeof value === "object") {
    const o = value as Rec;
    for (const k of Object.keys(o)) if (!TEXT_FIELDS.has(k)) o[k] = renameValues(o[k], map);
  }
  return value;
}

function listCodes(codes: string[]): string {
  const shown = codes.slice(0, LIST_MAX).join(", ");
  return codes.length > LIST_MAX ? `${shown} … and ${codes.length - LIST_MAX} more` : shown;
}

/** `now` stamps createdAt on old records that have none. */
export function convertChain(snapshot: DbSnapshot, now = new Date().toISOString()): { data: DbSnapshot; report: string[] } {
  const data = structuredClone(snapshot);
  const report: string[] = [];
  const partners = rows(data, "partners");
  const users = rows(data, "users");
  const byId = new Map(partners.map((p) => [String(p.id), p]));
  /** "panvel_db", or "Panvel DB (DB0004)" when the ID is a readable one. */
  const nameOf = (p: Rec) => {
    const id = String(p.id);
    const name = str(p.name) || id;
    return /^[A-Z]{2}[0-9]{4,}$/.test(id) && name !== id ? `${name} (${id})` : name;
  };

  // ------------------------------------------------------------ Suppliers to remove
  const suppliers = partners.filter((p) => p.type === SUPPLIER);
  const supplierIds = new Set(suppliers.map((p) => String(p.id)));
  const supplierUsers = users.filter((u) => u.role === SUPPLIER || supplierIds.has(String(u.partnerId)));
  const supplierUserIds = new Set(supplierUsers.map((u) => String(u.id)));
  /** Supplier a removed sign-in belonged to (for messages). */
  const ownerOf = (id: string) => (supplierIds.has(id) ? id : String(users.find((u) => u.id === id)?.partnerId ?? id));

  // Anything still pointing at a Supplier or its sign-ins, other than what goes with it (its sign-ins and
  // their sessions) or what is moved up (partners assigned to it).
  const problems = new Map<string, { stock: string[]; history: Record<string, number>; other: string[] }>();
  const problem = (owner: string) => {
    let p = problems.get(owner);
    if (!p) problems.set(owner, (p = { stock: [], history: {}, other: [] }));
    return p;
  };
  const flagged = new Set<Rec>();
  if (supplierIds.size || supplierUserIds.size) {
    const removed = new Set([...supplierIds, ...supplierUserIds]);
    for (const name of Object.keys(data) as (keyof DbSnapshot)[]) {
      for (const row of rows(data, name)) {
        if (name === "partners" && supplierIds.has(String(row.id))) continue;
        if (name === "users" && supplierUserIds.has(String(row.id))) continue;
        if (name === "sessions" && supplierUserIds.has(String(row.userId))) continue;
        const seen = new Set<string>();
        for (const [path, value] of strings(row, "")) {
          if (!removed.has(value) || (name === "partners" && path === ".parentId")) continue;
          const owner = ownerOf(value);
          if (seen.has(owner)) continue;
          seen.add(owner);
          const p = problem(owner);
          if (name === "lots" || name === "packs") p.stock.push(String(row.id));
          else if (name === "movements" || name === "scans" || name === "reprints") p.history[name] = (p.history[name] ?? 0) + 1;
          else p.other.push(`${name} ${String(row.id)}${path}`);
          flagged.add(row);
        }
      }
    }
  }
  // A code or movement still "at a Supplier" that names no Supplier (inconsistent data): refused too.
  const atSupplier: string[] = [];
  for (const name of ["lots", "packs", "movements"] as const) {
    for (const row of rows(data, name)) {
      if (flagged.has(row)) continue;
      const fields = ["status", "statusBeforeRecall", "fromStatus", "toStatus"].filter((f) => row[f] === SUPPLIER_STATUS);
      if (fields.length) atSupplier.push(`${name} ${String(row.id)} (${fields.join(", ")})`);
    }
  }
  if (problems.size || atSupplier.length) {
    const lines = [...problems].map(([owner, p]) => {
      const who = byId.get(owner) ? `Supplier ${nameOf(byId.get(owner)!)}` : owner;
      const parts: string[] = [];
      if (p.stock.length) parts.push(`${plural(p.stock.length, "code")} held there or on the way to or from it (${listCodes(p.stock)})`);
      const history = Object.entries(p.history).map(([n, c]) => plural(c, n.replace(/s$/, "")));
      if (history.length) parts.push(`named in history (${history.join(", ")})`);
      if (p.other.length) parts.push(`referenced by ${listCodes(p.other)}`);
      return `  - ${who}: ${parts.join("; ")}`;
    });
    if (atSupplier.length) lines.push(`  - still marked ${SUPPLIER_STATUS} without naming a Supplier: ${listCodes(atSupplier)}`);
    throw new Error(
      [
        "Cannot remove the Supplier tier: some Suppliers still have stock or history. Nothing was changed.",
        ...lines,
        "Stock must not vanish and history is never dropped. Move that stock on (or back) first, or convert these records by hand, then run the conversion again.",
      ].join("\n"),
    );
  }

  // ------------------------------------------------------------ remove Suppliers, move their Retailers up
  /** A removed Supplier's place in the chain: its own parent, going up past any Supplier. */
  const replacementFor = (supplierId: string): Rec | null => {
    let parent = byId.get(supplierId);
    const visited = new Set<string>();
    while (parent && parent.type === SUPPLIER && !visited.has(String(parent.id))) {
      visited.add(String(parent.id));
      parent = byId.get(String(parent.parentId));
    }
    return parent ?? null;
  };
  for (const s of suppliers) {
    const signIns = supplierUsers.filter((u) => u.partnerId === s.id).map((u) => str(u.name) || String(u.id));
    const parent = byId.get(String(s.parentId));
    report.push(
      `Removed Supplier ${nameOf(s)}${parent ? `, assigned to ${nameOf(parent)},` : ""}` +
        (signIns.length ? ` and its sign-in${signIns.length > 1 ? "s" : ""} ${signIns.join(", ")}` : ""),
    );
  }
  const strayUsers = supplierUsers.filter((u) => !supplierIds.has(String(u.partnerId)));
  if (strayUsers.length) report.push(`Removed Supplier sign-in(s) without a Supplier: ${strayUsers.map((u) => str(u.name) || String(u.id)).join(", ")}`);
  const sessionsBefore = data.sessions.length;
  data.partners = data.partners.filter((p) => !supplierIds.has(p.id));
  data.users = data.users.filter((u) => !supplierUserIds.has(u.id));
  data.sessions = data.sessions.filter((s) => !supplierUserIds.has(s.userId));
  if (data.sessions.length < sessionsBefore) report.push(`Signed out ${plural(sessionsBefore - data.sessions.length, "session")} of the removed Supplier sign-ins`);

  // ------------------------------------------------------------ Outlet IDs → next Retailer IDs
  const usedRt = [...partners, ...users].map((r) => RT_ID_RE.exec(String(r.id))).filter((m) => m !== null).map((m) => Number(m[1]));
  const rtSequence = data.sequences.find((s) => s.id === RT);
  let lastRt = Math.max(0, rtSequence?.value ?? 0, ...usedRt);
  const outletIds = [...new Set([...data.partners, ...data.users].map((r) => r.id).filter((id) => OUTLET_ID_RE.test(id)))];
  outletIds.sort((a, b) => Number(OUTLET_ID_RE.exec(a)![1]) - Number(OUTLET_ID_RE.exec(b)![1]));
  const renames = new Map(outletIds.map((id) => [id, formatSequenceId(RT, ++lastRt)]));

  // ------------------------------------------------------------ Outlets → Retailers
  for (const p of rows(data, "partners")) {
    const fromSupplier = supplierIds.has(String(p.parentId)) ? byId.get(String(p.parentId))! : null;
    let parent = byId.get(String(p.parentId)) ?? null;
    if (fromSupplier) {
      const up = replacementFor(String(fromSupplier.id));
      const type = (p.type === OUTLET ? RETAILER : p.type) as PartnerType;
      parent = up && (ASSIGNED_TO[type] ?? []).includes(up.type as PartnerType) ? up : null;
      p.parentId = parent ? parent.id : null;
    }
    if (p.type !== OUTLET && !fromSupplier) continue;
    const label = p.type === OUTLET ? "Outlet" : PARTNER_TYPE_LABELS[p.type as PartnerType] ?? String(p.type);
    const id = String(p.id);
    const renamed = renames.get(id);
    const was = fromSupplier ? ` (was ${nameOf(fromSupplier)}, a Supplier)` : "";
    const where = parent ? `assigned to ${nameOf(parent)}${was}` : `not assigned to anyone${was} — assign it in the Admin portal`;
    const becomes = p.type === OUTLET ? ` → Retailer${renamed ? ` ${renamed}` : ""}` : "";
    report.push(`${label} ${nameOf(p)}${becomes}, ${where}`);
    if (p.type === OUTLET) p.type = RETAILER;
  }

  const outletUsers = rows(data, "users").filter((u) => u.role === OUTLET);
  for (const u of outletUsers) u.role = RETAILER;
  if (outletUsers.length) {
    const names = outletUsers.map((u) => `${str(u.name) || String(u.id)}${renames.has(String(u.id)) ? ` (sign-in ${String(u.id)} → ${renames.get(String(u.id))})` : ""}`);
    report.push(`${plural(outletUsers.length, "Outlet sign-in")} now ${outletUsers.length === 1 ? "signs" : "sign"} in as Retailer: ${names.join(", ")}`);
  }

  // ------------------------------------------------------------ statuses
  let codesRenamed = 0;
  for (const name of ["lots", "packs"] as const) {
    for (const row of rows(data, name)) {
      let changed = false;
      for (const field of ["status", "statusBeforeRecall"]) {
        const to = STATUS_RENAMES[String(row[field])];
        if (!to) continue;
        row[field] = to;
        changed = true;
      }
      if (changed) codesRenamed++;
    }
  }
  if (codesRenamed) report.push(`${plural(codesRenamed, "code")} at a Retailer: status AT_OUTLET → AT_RETAILER`);
  let historyRenamed = 0;
  for (const row of rows(data, "movements")) {
    let changed = false;
    for (const field of ["fromStatus", "toStatus"]) {
      const to = STATUS_RENAMES[String(row[field])];
      if (!to) continue;
      row[field] = to;
      changed = true;
    }
    if (changed) historyRenamed++;
  }
  if (historyRenamed) report.push(`${plural(historyRenamed, "history row")}: status AT_OUTLET → AT_RETAILER`);

  // ------------------------------------------------------------ IDs and sequences
  if (renames.size) {
    renameValues(data, renames);
    report.push(`Outlet IDs renamed everywhere they appear: ${[...renames].map(([a, b]) => `${a} → ${b}`).join(", ")}`);
  }
  const oldSequences = data.sequences.filter((s) => OLD_SEQUENCES.includes(s.id));
  if (oldSequences.length || renames.size || (lastRt > 0 && (rtSequence?.value ?? 0) < lastRt)) {
    data.sequences = data.sequences.filter((s) => !OLD_SEQUENCES.includes(s.id) && s.id !== RT);
    if (lastRt > 0) data.sequences.push({ id: RT, value: lastRt });
    const dropped = oldSequences.map((s) => s.id).join(" and ");
    report.push(
      [dropped && `ID sequence${oldSequences.length > 1 ? "s" : ""} ${dropped} removed`, lastRt > 0 && `the next Retailer ID is ${formatSequenceId(RT, lastRt + 1)}`]
        .filter(Boolean)
        .join("; "),
    );
  }

  // ------------------------------------------------------------ records from before the registration form
  // Partners and sign-ins entered before the registration form and sign-in existed lack their fields, and the
  // app's checks read them: fill them in (blank until the Admin edits them). An old territory becomes the place.
  const filledPartners: string[] = [];
  const noState: string[] = [];
  for (const p of rows(data, "partners")) {
    const missing = PARTNER_TEXT_FIELDS.filter((f) => typeof p[f] !== "string");
    if (!missing.length && typeof p.createdAt === "string" && "createdBy" in p && "parentId" in p && !("territory" in p)) continue;
    const territory = str(p.territory)?.trim() ?? "";
    for (const f of missing) p[f] = "";
    if (territory && !p.place) p.place = territory;
    delete p.territory;
    if (!("parentId" in p)) p.parentId = null;
    if (typeof p.active !== "boolean") p.active = true;
    if (typeof p.createdAt !== "string") p.createdAt = now;
    if (!("createdBy" in p)) p.createdBy = null;
    filledPartners.push(territory ? `${nameOf(p)} (territory "${territory}" kept as its place)` : nameOf(p));
    if (p.type === "SS" && !p.state) noState.push(nameOf(p));
  }
  if (filledPartners.length) {
    report.push(
      `Added the registration form's fields to ${plural(filledPartners.length, "partner")} entered before it (blank until edited in Admin → Partners): ${filledPartners.join(", ")}`,
    );
  }
  if (noState.length) report.push(`Pick the state of ${noState.join(", ")} in Admin → Partners (one Super Stockist per state)`);
  const filledUsers: string[] = [];
  for (const u of rows(data, "users")) {
    const missing = USER_FIELDS.filter((f) => !(f in u));
    if (!missing.length) continue;
    for (const f of missing) u[f] = f === "createdAt" ? now : null;
    filledUsers.push(str(u.name) || String(u.id));
  }
  if (filledUsers.length) {
    report.push(
      `Added the sign-in fields to ${plural(filledUsers.length, "person", "people")} entered before sign-in existed; those without a password can be picked while sign-in is off: ${filledUsers.join(", ")}`,
    );
  }

  if (!report.length) return { data: structuredClone(snapshot), report: [NOTHING_TO_CONVERT] };
  return { data, report };
}

/**
 * Why this data can't be used until `npm run db:convert-chain` has run, or null when it is up to date.
 * The JSON store checks this on load, as the PostgreSQL schema does.
 */
export function conversionNeeded(snapshot: DbSnapshot): string | null {
  let report: string[];
  try {
    report = convertChain(snapshot).report;
  } catch (e) {
    return (e as Error).message;
  }
  return report.length === 1 && report[0] === NOTHING_TO_CONVERT ? null : report.join("\n");
}
