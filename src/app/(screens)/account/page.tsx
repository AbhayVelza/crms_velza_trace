"use client";

import { useState, type FormEvent } from "react";
import { useSession } from "@/components/session";
import { Button, Card, Field, Input, Notice, PageTitle } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import { ROLE_LABELS } from "@/lib/core/types";

export default function AccountPage() {
  const { user, role, organisation } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== repeat) return setMsg({ tone: "error", text: "The new passwords don't match" });
    try {
      await api("/api/auth/password", { body: { currentPassword: current, newPassword: next } });
      setMsg({ tone: "ok", text: "Password changed" });
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (err) {
      setMsg({ tone: "error", text: errorText(err) });
    }
  }

  if (!user || !role) return null;
  return (
    <>
      <PageTitle title="Account" subtitle={`${user.name} · ${ROLE_LABELS[role]} · ${organisation}`} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Your sign-in">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-500">Sign-in ID</dt>
            <dd className="font-mono">{user.loginId}</dd>
            <dt className="text-slate-500">Portal</dt>
            <dd>{ROLE_LABELS[role]}</dd>
            <dt className="text-slate-500">Organisation</dt>
            <dd>{organisation}</dd>
          </dl>
          <p className="mt-3 text-xs text-slate-500">Your name, role and organisation are managed by Velza Admin.</p>
        </Card>
        <Card title="Change password">
          <form onSubmit={submit} className="space-y-3">
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            <Field label="Current password">
              <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="New password" hint="At least 8 characters, letters and digits">
              <Input type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <Field label="Repeat new password">
              <Input type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </Field>
            <Button type="submit" disabled={!current || !next || !repeat}>
              Change password
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
