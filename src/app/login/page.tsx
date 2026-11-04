"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ActAsPicker, useDevUsers } from "@/components/ActAs";
import { VelzaLogo, VelzaSymbol } from "@/components/brand";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
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
          <p className="mt-1.5 text-sm text-muted-foreground">Use the sign-in ID and password given to you by Velza Admin.</p>
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
        <p className="text-xs text-muted-foreground">No account, or forgot your password? Ask Velza Admin.</p>
      </form>
    </AuthShell>
  );
}

/** Sign-in layout: black brand panel (wide screens) beside the form; the logo sits above the form on phones. */
function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-1">
      <aside className="theme-dark brand-bar relative hidden w-[42%] max-w-xl flex-col justify-between overflow-hidden bg-surface p-12 text-foreground lg:flex">
        {/* Watermark device: the V as a tonal, cropped form (brand book p. 7 and 19). */}
        <VelzaSymbol height={520} tone="on-dark" className="pointer-events-none absolute -bottom-24 -right-40 h-[520px] w-auto max-w-none opacity-[0.07]" />
        <VelzaLogo height={128} tone="on-dark" className="relative h-32 w-auto self-start" />
        <div className="relative space-y-3">
          <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Velza Traceability</p>
          <p className="max-w-sm text-2xl font-bold leading-snug tracking-tight">Every case, tray and pack — from plant to retailer.</p>
          <p className="text-xs uppercase tracking-[0.16em] text-subtle-foreground">Driven by passion, defined by luxury</p>
        </div>
      </aside>
      <div className="relative flex flex-1 flex-col items-center justify-center bg-background px-4 py-10">
        <ThemeSwitcher className="absolute right-4 top-4" />
        <div className="w-full max-w-sm animate-rise-in">
          <div className="mb-8 flex justify-center lg:hidden">
            <VelzaLogo height={88} className="h-[88px] w-auto" />
          </div>
          <div className="rounded-card border border-line bg-surface p-6 shadow-card sm:p-7">{children}</div>
        </div>
      </div>
    </main>
  );
}
