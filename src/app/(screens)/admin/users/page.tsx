"use client";

import { useState } from "react";
import { AdminCrud } from "@/components/AdminCrud";
import { PasswordInput } from "@/components/PasswordInput";
import { useSession } from "@/components/session";
import { Button, Card, Field, fmtTime, Input, Notice, PageTitle, Select } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import { ROLE_LABELS, ROLE_PARTNER_TYPE, ROLES, type Role } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";

/** A sign-in on its own: Velza staff, or a partner sign-in that was deleted and is needed again. */
function NewSignIn() {
  const { data } = useSession();
  const [role, setRole] = useState<Role | "">("");
  const [partnerId, setPartnerId] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const partnerType = role ? ROLE_PARTNER_TYPE[role] : null;

  async function create() {
    setMsg(null);
    try {
      const u = await api<{ id: string }>("/api/admin/users", { body: { role, name, partnerId: partnerType ? partnerId || null : null, password } });
      setMsg({ tone: "ok", text: `Created sign-in ${u.id} — share with the person: ${u.id} / ${password}` });
      setName("");
      setPassword("");
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  return (
    <Card title="New sign-in">
      <p className="mb-3 text-sm text-slate-600">
        For Velza staff (Admin → AD0002 …, HQ → HQ0002 …). Partner sign-ins are made by the registration form on the Partners page; use this only to
        make one again after it was deleted.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Role / portal">
          <Select aria-label="Role" value={role} onChange={(e) => (setRole(e.target.value as Role), setPartnerId(""))}>
            <option value="">Choose…</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        {partnerType && (
          <Field label="Partner">
            <Select aria-label="Partner" value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
              <option value="">Choose…</option>
              {(data?.partners ?? [])
                .filter((p) => p.type === partnerType)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label="Name">
          <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        </Field>
        <Field label="Password">
          <PasswordInput value={password} onChange={setPassword} />
        </Field>
      </div>
      <Button className="mt-3" onClick={create} disabled={!role || !name || !password}>
        Create sign-in
      </Button>
      {msg && (
        <Notice tone={msg.tone} className="mt-3">
          {msg.text}
        </Notice>
      )}
    </Card>
  );
}

export default function UsersPage() {
  const { data } = useSession();
  const partners = data?.partners ?? [];
  const partnerName = (id: unknown) => partners.find((p) => p.id === id)?.name ?? "—";
  return (
    <>
      <PageTitle
        title="Sign-ins & passwords"
        subtitle="Each partner's sign-in ID is its partner ID (the plant has -OP and -QC). Set a new password and share it with the person; they can change it themselves after signing in."
      />
      <div className="space-y-4">
        <AdminCrud
          entity="users"
          title="Sign-ins"
          allowCreate={false}
          intro={
            <Notice tone="info">
              Passwords are stored scrambled, so nobody — not even Velza Admin — can look one up. If someone forgets theirs, set a new one here: it signs
              them out everywhere. Untick <b>Active</b> to stop a sign-in at once.
            </Notice>
          }
          sort={(a, b) => ROLES.indexOf(a.role as Role) - ROLES.indexOf(b.role as Role) || String(a.id).localeCompare(String(b.id))}
          columns={[
            { key: "id", label: "Sign-in ID", type: "display", render: (row) => <span className="font-mono text-xs">{row.id}</span> },
            { key: "name", label: "Name", type: "text" },
            { key: "role", label: "Portal", type: "display", render: (row) => ROLE_LABELS[row.role as Role] },
            { key: "partnerId", label: "Partner", type: "display", render: (row) => (row.partnerId ? partnerName(row.partnerId) : "Velza staff") },
            { key: "lastLoginAt", label: "Last sign-in", type: "display", render: (row) => <span className="whitespace-nowrap text-xs">{fmtTime(row.lastLoginAt as string | null)}</span> },
            { key: "password", label: "Password", type: "password" },
            { key: "active", label: "Active", type: "bool" },
          ]}
        />
        <NewSignIn />
      </div>
    </>
  );
}
