"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ActAsPicker, useDevUsers } from "@/components/ActAs";
import { api, errorText } from "@/lib/client";
import { Button, Field, Input, Notice } from "@/components/ui";

/** Only same-site paths, so the sign-in page can't be used to bounce people elsewhere. */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default function LoginPage() {
  const devUsers = useDevUsers(); // non-null while sign-in is off (development)
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in → straight to the portal.
  useEffect(() => {
    api("/api/auth/me").then(
      () => window.location.replace(nextPath()),
      () => undefined,
    );
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { body: { loginId, password } });
      window.location.assign(nextPath());
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (devUsers) {
    return (
      <main className="flex flex-1 items-center justify-center bg-slate-50 px-4 py-10">
        <div className="w-full max-w-md space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 font-semibold text-teal-800">
            <span className="inline-block h-7 w-7 rounded bg-teal-700 text-center leading-7 text-white">V</span>
            Velza Traceability
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Choose who you are</h1>
            <p className="text-sm text-slate-600">Sign-in is switched off while the app is being developed: pick a role and a person, no password.</p>
          </div>
          <ActAsPicker users={devUsers} next={nextPath()} />
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-slate-50 px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 font-semibold text-teal-800">
          <span className="inline-block h-7 w-7 rounded bg-teal-700 text-center leading-7 text-white">V</span>
          Velza Traceability
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
          <p className="text-sm text-slate-600">Use the sign-in ID and password given to you by Velza Admin.</p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Sign-in ID">
          <Input name="loginId" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus value={loginId} onChange={(e) => setLoginId(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy || !loginId || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-xs text-slate-500">No account, or forgot your password? Ask Velza Admin.</p>
      </form>
    </main>
  );
}
