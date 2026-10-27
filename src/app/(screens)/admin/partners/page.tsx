"use client";

import { useState } from "react";
import { AdminCrud, type Row } from "@/components/AdminCrud";
import { PasswordInput } from "@/components/PasswordInput";
import { useSession } from "@/components/session";
import { Button, Card, Field, Input, Notice, PageTitle, Select } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import { INDIAN_STATES, PARTNER_ID_PREFIX } from "@/lib/core/ids";
import { ASSIGNED_TO, assignedPluralOf, assignedTypesOf } from "@/lib/core/rules";
import { PARTNER_TYPE_LABELS, PARTNER_TYPES, type Partner, type PartnerType } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";

const order = (t: unknown) => PARTNER_TYPES.indexOf(t as PartnerType);
/** Tiers that have partners assigned to them: SS → distributors and retailers, DB → retailers. */
const PARENT_TYPES = PARTNER_TYPES.filter((t) => assignedTypesOf(t).length);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const stateOptions = () => INDIAN_STATES.map((s) => ({ value: s, label: s }));

/** "" = all, a tier, "unassigned" = assignable partners with no parent, "of:<id>" = partners assigned to <id>. */
function matches(view: string, row: Row): boolean {
  if (!view) return true;
  if (view === "unassigned") return !!ASSIGNED_TO[row.type as PartnerType] && !row.parentId;
  if (view.startsWith("of:")) return row.parentId === view.slice(3);
  return row.type === view;
}

const EMPTY = { type: "" as PartnerType | "", name: "", place: "", address: "", city: "", state: "", pincode: "", contactPerson: "", phone: "", email: "", parentId: "", password: "", qcPassword: "" };

/** The registration form: one partner and its sign-in(s), with the passwords to share. */
function RegisterForm({ partners }: { partners: Partner[] }) {
  const { refresh } = useSession();
  const [f, setF] = useState(EMPTY);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string; share?: { id: string; password: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  // A Retailer is assigned to a Distributor or, for a few, straight to a Super Stockist: pick the tier first.
  const [parentTier, setParentTier] = useState<PartnerType | "">("");
  const set = (k: keyof typeof EMPTY) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const type = f.type || null;
  const parentTypes = (type && ASSIGNED_TO[type]) || [];
  const parentType = parentTier && parentTypes.includes(parentTier) ? parentTier : parentTypes[0];
  const plant = type === "MANUFACTURER";
  const ssStates = new Map(partners.filter((p) => p.type === "SS").map((p) => [p.state, p]));

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const body = { ...f, parentId: f.parentId || null, qcPassword: plant ? f.qcPassword : undefined };
      const r = await api<{ partner: Partner; logins: { id: string; role: string }[]; message: string }>("/api/admin/partners", { body });
      setMsg({
        tone: "ok",
        text: r.message,
        share: r.logins.map((u) => ({ id: u.id, password: u.role === "QC" ? f.qcPassword : f.password })),
      });
      setF({ ...EMPTY, type: f.type });
      notifyDataChanged();
      await refresh();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Register a partner">
      <p className="mb-3 text-sm text-slate-600">
        The partner gets the next ID of its tier — {PARTNER_TYPES.map((t) => `${PARTNER_ID_PREFIX[t]}0001`).join(", ")} … — and a sign-in with that ID
        (the plant gets two: -OP for the Operator and -QC for QC). Share the password with the person; they can change it after signing in.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Tier">
          <Select
            aria-label="Tier"
            value={f.type}
            onChange={(e) => (setF({ ...f, type: e.target.value as PartnerType, parentId: "", state: "" }), setParentTier(""))}
          >
            <option value="">Choose…</option>
            {PARTNER_TYPES.map((t) => (
              <option key={t} value={t}>
                {PARTNER_TYPE_LABELS[t]} ({PARTNER_ID_PREFIX[t]}…)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Site name">
          <Input aria-label="Site name" value={f.name} onChange={(e) => set("name")(e.target.value)} placeholder="e.g. FC Road Distributors" />
        </Field>
        <Field label="Contact person">
          <Input aria-label="Contact person" value={f.contactPerson} onChange={(e) => set("contactPerson")(e.target.value)} placeholder="Full name" />
        </Field>
        <Field label="Place (locality)">
          <Input aria-label="Place" value={f.place} onChange={(e) => set("place")(e.target.value)} placeholder="e.g. FC Road" />
        </Field>
        <Field label="Address">
          <Input aria-label="Address" value={f.address} onChange={(e) => set("address")(e.target.value)} placeholder="Shop / building, street" />
        </Field>
        <Field label="City">
          <Input aria-label="City" value={f.city} onChange={(e) => set("city")(e.target.value)} placeholder="e.g. Pune" />
        </Field>
        <Field label="State" hint={type === "SS" ? "One Super Stockist per state — states that have one are greyed out" : undefined}>
          {plant ? (
            <Input aria-label="State" value={f.state} onChange={(e) => set("state")(e.target.value)} placeholder="State / province (optional)" />
          ) : (
            <Select aria-label="State" value={f.state} onChange={(e) => set("state")(e.target.value)}>
              <option value="">Choose…</option>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s} disabled={type === "SS" && ssStates.has(s)}>
                  {s}
                  {type === "SS" && ssStates.has(s) ? ` — ${ssStates.get(s)!.id}` : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="PIN code">
          <Input aria-label="PIN code" inputMode="numeric" value={f.pincode} onChange={(e) => set("pincode")(e.target.value)} placeholder="6 digits (optional)" />
        </Field>
        <Field label="Phone">
          <Input aria-label="Phone" type="tel" value={f.phone} onChange={(e) => set("phone")(e.target.value)} placeholder="+91 98765 43210" />
        </Field>
        <Field label="Email">
          <Input aria-label="Email" type="email" value={f.email} onChange={(e) => set("email")(e.target.value)} placeholder="optional" />
        </Field>
        {parentTypes.length > 1 && (
          <Field label="Assigned to tier">
            <Select aria-label="Assigned to tier" value={parentType} onChange={(e) => (setParentTier(e.target.value as PartnerType), set("parentId")(""))}>
              {parentTypes.map((t) => (
                <option key={t} value={t}>
                  {PARTNER_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {parentType && (
          <Field label={`Assigned to (${PARTNER_TYPE_LABELS[parentType]})`}>
            <Select aria-label="Assigned to" value={f.parentId} onChange={(e) => set("parentId")(e.target.value)}>
              <option value="">Not yet</option>
              {partners
                .filter((p) => p.type === parentType && p.active)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label={plant ? "Operator password (-OP)" : "Sign-in password"}>
          <PasswordInput label={plant ? "Operator password" : "Sign-in password"} value={f.password} onChange={set("password")} />
        </Field>
        {plant && (
          <Field label="QC password (-QC)">
            <PasswordInput label="QC password" value={f.qcPassword} onChange={set("qcPassword")} />
          </Field>
        )}
      </div>
      <Button className="mt-4" onClick={submit} disabled={busy || !type}>
        {busy ? "Registering…" : "Register"}
      </Button>
      {msg && (
        <Notice tone={msg.tone} className="mt-3">
          <div data-testid="register-result">{msg.text}</div>
          {msg.share && (
            <div className="mt-1">
              Share with the person:{" "}
              {msg.share.map((s) => (
                <span key={s.id} className="mr-3 inline-block font-mono">
                  {s.id} / {s.password}
                </span>
              ))}
            </div>
          )}
        </Notice>
      )}
    </Card>
  );
}

export default function PartnersPage() {
  const { data } = useSession();
  const partners = data?.partners ?? [];
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const assignedTo = (id: string) => partners.filter((p) => p.parentId === id).length;
  const childPlural = (type: unknown) => assignedPluralOf(type as PartnerType);
  const [view, setView] = useState("");

  return (
    <>
      <PageTitle title="Partners" subtitle="Every tier of the chain: Manufacturer → Super Stockist → Distributor → Retailer (a few retailers directly under their Super Stockist)" />
      <div className="space-y-4">
        <RegisterForm partners={partners} />
        <AdminCrud
          entity="partners"
          title="Partners"
          allowCreate={false}
          intro={
            <Notice tone="info">
              Assign each <b>Distributor</b> to a Super Stockist and each <b>Retailer</b> to a Distributor (or, for a few, directly to a Super Stockist).
              A partner sees and can dispatch to only the partners assigned to it. IDs never change and are never reused. Partners with history can&apos;t be deleted —
              untick <b>Active</b> instead (their sign-ins stop working at once).
            </Notice>
          }
          toolbar={
            <Select aria-label="Show" value={view} onChange={(e) => setView(e.target.value)} className="w-auto min-w-[16rem]">
              <option value="">All partners</option>
              {PARTNER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PARTNER_TYPE_LABELS[t]}s
                </option>
              ))}
              <option value="unassigned">Not assigned yet</option>
              {PARENT_TYPES.map((t) => (
                <optgroup key={t} label={`${capitalize(childPlural(t))} of…`}>
                  {partners
                    .filter((p) => p.type === t)
                    .sort(byName)
                    .map((p) => (
                      <option key={p.id} value={`of:${p.id}`}>
                        {capitalize(childPlural(t))} of {p.name} ({assignedTo(p.id)})
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          }
          filter={(row) => matches(view, row)}
          sort={(a, b) => order(a.type) - order(b.type) || String(a.id).localeCompare(String(b.id))}
          columns={[
            { key: "id", label: "ID", type: "display", render: (row) => <span className="font-mono text-xs">{row.id}</span> },
            { key: "type", label: "Tier", type: "select", createOnly: true, options: () => PARTNER_TYPES.map((t) => ({ value: t, label: PARTNER_TYPE_LABELS[t] })) },
            { key: "name", label: "Name", type: "text" },
            { key: "contactPerson", label: "Contact person", type: "text" },
            { key: "phone", label: "Phone", type: "text" },
            { key: "email", label: "Email", type: "text" },
            { key: "place", label: "Place", type: "text" },
            { key: "address", label: "Address", type: "text" },
            { key: "city", label: "City", type: "text" },
            { key: "state", label: "State", type: "select", visible: (row) => row.type !== "MANUFACTURER", options: stateOptions },
            { key: "pincode", label: "PIN", type: "text" },
            {
              key: "parentId",
              label: "Assigned to",
              type: "select",
              nullable: true,
              visible: (row) => !!ASSIGNED_TO[row.type as PartnerType],
              options: (row) => {
                // A Retailer's options span two tiers (Distributors, then Super Stockists): name the tier on each.
                const tiers = ASSIGNED_TO[row.type as PartnerType] ?? [];
                return tiers.flatMap((t) =>
                  partners
                    .filter((p) => p.type === t)
                    .sort(byName)
                    .map((p) => ({ value: p.id, label: `${p.id} · ${p.name}${tiers.length > 1 ? ` (${PARTNER_TYPE_LABELS[t]})` : ""}` })),
                );
              },
            },
            {
              key: "assigned",
              label: "Assigned to it",
              type: "display",
              visible: (row) => PARENT_TYPES.includes(row.type as PartnerType),
              render: (row) => (
                <button type="button" className="whitespace-nowrap text-teal-800 underline" onClick={() => setView(`of:${row.id}`)}>
                  {assignedTo(row.id)} {childPlural(row.type)}
                </button>
              ),
            },
            { key: "active", label: "Active", type: "bool" },
          ]}
        />
      </div>
    </>
  );
}
