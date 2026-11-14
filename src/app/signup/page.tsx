"use client";

// Self sign-up for Super Stockist, Distributor and Retailer shops (design: docs/superpowers/specs/2026-11-14-self-signup-design.md).
// A Retailer can sign in at once; a Super Stockist or Distributor waits for Velza approval.

import { useEffect, useState, type FormEvent } from "react";
import { AuthShell } from "@/components/AuthShell";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { INDIAN_STATES } from "@/lib/core/ids";
import { api, errorText } from "@/lib/client";

type ShopType = "SS" | "DB" | "RETAILER";
interface Options {
  statesTaken: string[];
  superStockists: { id: string; name: string; city: string; state: string }[];
  distributors: { id: string; name: string; city: string; parentId: string | null }[];
}
interface Result {
  loginId: string;
  pending: boolean;
  message: string;
}

const TYPES: { value: ShopType; label: string; hint: string }[] = [
  { value: "RETAILER", label: "Retailer", hint: "Can sign in as soon as the account is created" },
  { value: "DB", label: "Distributor", hint: "Velza approves the account before it can be used" },
  { value: "SS", label: "Super Stockist", hint: "One per state; Velza approves the account before it can be used" },
];

const EMPTY = { name: "", contactPerson: "", place: "", address: "", city: "", state: "", pincode: "", phone: "", email: "", parentId: "", password: "", confirm: "" };
type Key = keyof typeof EMPTY;

export default function SignupPage() {
  const [type, setType] = useState<ShopType | "">("");
  const [f, setF] = useState(EMPTY);
  const [opts, setOpts] = useState<Options | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Result | null>(null);

  useEffect(() => {
    api<Options>("/api/signup").then(setOpts, (e) => setError(errorText(e)));
  }, []);

  const set = (k: Key) => (v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setErrors((m) => (m[k] ? { ...m, [k]: undefined } : m));
  };
  const err = (k: Key) => errors[k] ?? null;

  // Who can supply this shop: a Distributor → a Super Stockist; a Retailer → a Distributor (or, for a few, a Super Stockist).
  const suppliers =
    type === "DB"
      ? (opts?.superStockists ?? []).map((s) => ({ id: s.id, label: `${s.name} — ${s.city} (Super Stockist)` }))
      : type === "RETAILER"
        ? [
            ...(opts?.distributors ?? []).map((d) => ({ id: d.id, label: `${d.name} — ${d.city} (Distributor)` })),
            ...(opts?.superStockists ?? []).map((s) => ({ id: s.id, label: `${s.name} — ${s.city} (Super Stockist)` })),
          ]
        : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const required: [Key, string][] = [
      ["name", "Shop / business name"],
      ["contactPerson", "Your name"],
      ["place", "Place (locality)"],
      ["address", "Address"],
      ["city", "City"],
      ["state", "State"],
      ["phone", "Phone"],
      ...(type === "SS" ? [] : ([["parentId", "Supplied by"]] as [Key, string][])),
      ["password", "Password"],
    ];
    const missing: Partial<Record<Key, string>> = {};
    for (const [k, label] of required) if (!f[k].trim()) missing[k] = `${label} is required`;
    if (f.password && f.confirm !== f.password) missing.confirm = "The two passwords are different";
    if (Object.keys(missing).length) {
      setErrors(missing);
      setError("Please complete the fields marked in red.");
      const first = document.querySelector<HTMLElement>(`[data-field="${Object.keys(missing)[0]}"]`);
      first?.scrollIntoView({ block: "center" });
      first?.focus({ preventScroll: true });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { confirm: _confirm, parentId, ...rest } = f;
      void _confirm;
      setDone(await api<Result>("/api/signup", { body: { ...rest, type, parentId: type === "SS" ? null : parentId } }));
    } catch (e2) {
      setError(errorText(e2));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthShell>
        <div className="space-y-5" data-testid="signup-done">
          <h1 className="text-xl font-bold tracking-tight text-foreground">{done.pending ? "Account created — waiting for approval" : "Account created"}</h1>
          <Notice tone={done.pending ? "warn" : "ok"}>{done.message}</Notice>
          <div className="rounded-control border border-line p-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your sign-in ID</div>
            <div className="mt-1 font-mono text-2xl font-bold text-foreground" data-testid="signup-login-id">
              {done.loginId}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Write it down: you sign in with this ID and the password you chose.</p>
          </div>
          <a href="/login" className="block">
            <Button className="w-full">Go to sign in</Button>
          </a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell wide>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Create an account</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">For Super Stockists, Distributors and Retailers. Fields marked * are required.</p>
        </div>

        {/* Not a <Field>: a <label> around buttons would name the first button after the label. */}
        <div>
          <div id="signup-type" className="mb-1.5 block text-sm font-semibold text-foreground-2">
            I am a *
          </div>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-labelledby="signup-type">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={type === t.value}
                onClick={() => (setType(t.value), set("parentId")(""), set("state")(""))}
                className={`rounded-control border p-3 text-left transition-colors ${type === t.value ? "border-foreground bg-muted" : "border-line hover:border-muted-foreground"}`}
              >
                <div className="text-sm font-semibold text-foreground">{t.label}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{t.hint}</div>
              </button>
            ))}
          </div>
        </div>

        {type && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Shop / business name *" error={err("name")}>
                <Input aria-label="Shop / business name" data-field="name" value={f.name} onChange={(e) => set("name")(e.target.value)} />
              </Field>
              <Field label="Your name *" error={err("contactPerson")}>
                <Input aria-label="Your name" data-field="contactPerson" autoComplete="name" value={f.contactPerson} onChange={(e) => set("contactPerson")(e.target.value)} />
              </Field>
              <Field label="Place (locality) *" error={err("place")}>
                <Input aria-label="Place" data-field="place" value={f.place} onChange={(e) => set("place")(e.target.value)} placeholder="e.g. FC Road" />
              </Field>
              <Field label="Address *" error={err("address")}>
                <Input aria-label="Address" data-field="address" autoComplete="street-address" value={f.address} onChange={(e) => set("address")(e.target.value)} placeholder="Shop / building, street" />
              </Field>
              <Field label="City *" error={err("city")}>
                <Input aria-label="City" data-field="city" value={f.city} onChange={(e) => set("city")(e.target.value)} />
              </Field>
              <Field label="State *" error={err("state")} hint={type === "SS" ? "One Super Stockist per state — states that already have one can't be picked" : undefined}>
                <Select aria-label="State" data-field="state" value={f.state} onChange={(e) => set("state")(e.target.value)}>
                  <option value="">Choose…</option>
                  {INDIAN_STATES.map((s) => {
                    const taken = type === "SS" && !!opts?.statesTaken.includes(s);
                    return (
                      <option key={s} value={s} disabled={taken}>
                        {s}
                        {taken ? " — has a Super Stockist" : ""}
                      </option>
                    );
                  })}
                </Select>
              </Field>
              <Field label="PIN code">
                <Input aria-label="PIN code" inputMode="numeric" value={f.pincode} onChange={(e) => set("pincode")(e.target.value)} placeholder="6 digits (optional)" />
              </Field>
              <Field label="Phone *" error={err("phone")}>
                <Input aria-label="Phone" data-field="phone" type="tel" autoComplete="tel" value={f.phone} onChange={(e) => set("phone")(e.target.value)} placeholder="+91 98765 43210" />
              </Field>
              <Field label="Email">
                <Input aria-label="Email" type="email" autoComplete="email" value={f.email} onChange={(e) => set("email")(e.target.value)} placeholder="optional" />
              </Field>
              {type !== "SS" && (
                <Field label="Supplied by *" error={err("parentId")} hint={type === "DB" ? "Your Super Stockist" : "Your Distributor (or your Super Stockist, if it supplies you directly)"}>
                  <Select aria-label="Supplied by" data-field="parentId" value={f.parentId} onChange={(e) => set("parentId")(e.target.value)}>
                    <option value="">Choose…</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Password *" error={err("password")} hint="At least 8 characters, letters and digits">
                <Input aria-label="Password" data-field="password" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set("password")(e.target.value)} />
              </Field>
              <Field label="Repeat password *" error={err("confirm")}>
                <Input aria-label="Repeat password" data-field="confirm" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => set("confirm")(e.target.value)} />
              </Field>
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" className="w-full" loading={busy} disabled={busy}>
              {busy ? "Creating account…" : "Create account"}
            </Button>
          </>
        )}
        {!type && error && <Notice tone="error">{error}</Notice>}
        <p className="text-sm text-muted-foreground">
          Already have an account?{" "}
          <a href="/login" className="font-semibold text-foreground underline underline-offset-2">
            Sign in
          </a>
        </p>
      </form>
    </AuthShell>
  );
}
