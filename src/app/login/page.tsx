"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ActAsPicker, useDevUsers } from "@/components/ActAs";
import { AuthShell } from "@/components/AuthShell";
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
      <AuthShell>
        <div className="space-y-5">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">Choose who you are</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">Sign-in is switched off while the app is being developed: pick a role and a person, no password.</p>
          </div>
          <ActAsPicker users={devUsers} next={nextPath()} />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={submit} className="space-y-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Sign in</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Use your sign-in ID and password.</p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Sign-in ID">
          <Input name="loginId" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus value={loginId} onChange={(e) => setLoginId(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={busy || !loginId || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-sm text-muted-foreground">
          Super Stockist, Distributor or Retailer without an account?{" "}
          <a href="/signup" className="font-semibold text-foreground underline underline-offset-2">
            Create an account
          </a>
        </p>
        <p className="text-xs text-muted-foreground">Forgot your password, or at the plant? Ask Velza Admin.</p>
      </form>
    </AuthShell>
  );
}
