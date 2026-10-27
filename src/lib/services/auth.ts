// Sign in / sign out / current user / change own password. Sessions live in the store.
// While sign-in is off (development, see signInMode.ts) devLogin starts a session for anyone, no password.
// Velza Admin sets each person's first password and shares it; the person can then change it here,
// and that is the only change a person can make to their own account.

import { z } from "zod";
import { checkPassword, normalizeLoginId } from "@/lib/core/ids";
import { VELZA_ORG_NAME } from "@/lib/core/types";
import { hashPassword, newSessionToken, sessionIdOf, verifyPassword } from "@/lib/passwords";
import { signInRequired } from "@/lib/signInMode";
import { getStore } from "@/lib/store";
import { badRequest, loadActor, nowIso, publicUser, ServiceError } from "./common";

export const SESSION_HOURS = 12;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 5;

export const loginSchema = z.object({ loginId: z.string().min(1).max(100), password: z.string().min(1).max(200) });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) });

// Failed attempts per sign-in ID, kept in memory (resets when the server restarts).
const g = globalThis as unknown as { __velzaLoginFailures?: Map<string, { count: number; lockedUntil: number }> };
const failures = (g.__velzaLoginFailures ??= new Map());

const badCredentials = () => new ServiceError(401, "BAD_CREDENTIALS", "Wrong sign-in ID or password");

export async function login(body: unknown): Promise<{ token: string; expiresAt: string; user: Awaited<ReturnType<typeof me>> }> {
  const { loginId: raw, password } = loginSchema.parse(body);
  const loginId = normalizeLoginId(raw);
  const f = failures.get(loginId);
  if (f && f.lockedUntil > Date.now()) {
    throw new ServiceError(429, "LOCKED", `Too many wrong passwords — try again in ${Math.ceil((f.lockedUntil - Date.now()) / 60000)} minute(s)`);
  }

  const store = getStore();
  const user = await store.users.get(loginId);
  if (!(await verifyPassword(password, user?.passwordHash ?? null)) || !user) {
    const count = (f?.count ?? 0) + 1;
    failures.set(loginId, { count, lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCK_MINUTES * 60000 : 0 });
    throw badCredentials();
  }
  failures.delete(loginId);

  const partner = user.partnerId ? await store.partners.get(user.partnerId) : null;
  if (!user.active || (partner && !partner.active)) {
    throw new ServiceError(403, "DISABLED", "This sign-in is disabled. Contact Velza Admin.");
  }

  return startSession(user.id);
}

async function startSession(userId: string) {
  const token = newSessionToken();
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_HOURS * 3600_000).toISOString();
  await getStore().transaction(async (tx) => {
    // Drop this user's expired sessions while we're here.
    for (const s of await tx.sessions.list({ userId })) if (Date.parse(s.expiresAt) <= now) await tx.sessions.delete(s.id);
    await tx.sessions.create({ id: sessionIdOf(token), userId, createdAt: nowIso(), expiresAt });
    await tx.users.update(userId, { lastLoginAt: nowIso() });
  });
  return { token, expiresAt, user: await me(userId) };
}

// ---------------------------------------------------------------- development: no sign-in

const signInIsOn = () => new ServiceError(404, "NOT_FOUND", "Sign-in is on: use your sign-in ID and password");

/** While sign-in is off: everyone who can be acted as, for the pickers in the header and on the start page. */
export async function devUsers() {
  if (signInRequired()) throw signInIsOn();
  const store = getStore();
  const [users, partners] = await Promise.all([store.users.list({ active: true }), store.partners.list()]);
  const partnerOf = new Map(partners.map((p) => [p.id, p]));
  return users
    .filter((u) => !u.partnerId || partnerOf.get(u.partnerId)?.active !== false)
    .map((u) => ({ id: u.id, name: u.name, role: u.role, partnerId: u.partnerId, partnerName: u.partnerId ? (partnerOf.get(u.partnerId)?.name ?? null) : null }));
}

export const devLoginSchema = z.object({ userId: z.string().min(1).max(100) });

/** While sign-in is off: act as anyone, no password. Refused (404) as soon as sign-in is on. */
export async function devLogin(body: unknown) {
  if (signInRequired()) throw signInIsOn();
  const { userId } = devLoginSchema.parse(body);
  await loadActor(getStore(), userId); // must exist and be active, with an active partner
  return startSession(userId);
}

/** Resolve a session cookie to a user id (null if missing, unknown or expired). */
export async function sessionUserId(token: string | null | undefined): Promise<string | null> {
  if (!token) return null;
  const session = await getStore().sessions.get(sessionIdOf(token));
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
  return session.userId;
}

export async function logout(token: string | null | undefined) {
  if (token) {
    const store = getStore();
    const id = sessionIdOf(token);
    if (await store.sessions.get(id)) await store.sessions.delete(id);
  }
  return { ok: true };
}

/** The signed-in user, their partner and their organisation. */
export async function me(userId: string | null) {
  const actor = await loadActor(getStore(), userId);
  return {
    user: publicUser(actor.user),
    partner: actor.partner,
    organisation: actor.partner?.name ?? VELZA_ORG_NAME,
  };
}

/** Change your own password. Your other sessions are signed out; this one stays. */
export async function changePassword(userId: string | null, currentToken: string | null, body: unknown) {
  const { currentPassword, newPassword } = changePasswordSchema.parse(body);
  const problem = checkPassword(newPassword);
  if (problem) throw badRequest("WEAK_PASSWORD", problem);
  const passwordHash = await hashPassword(newPassword);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    if (!(await verifyPassword(currentPassword, actor.user.passwordHash))) throw badRequest("BAD_CREDENTIALS", "Current password is wrong");
    await tx.users.update(actor.user.id, { passwordHash, passwordChangedAt: nowIso() });
    const keep = currentToken ? sessionIdOf(currentToken) : null;
    for (const s of await tx.sessions.list({ userId: actor.user.id })) if (s.id !== keep) await tx.sessions.delete(s.id);
    return { ok: true, message: "Password changed" };
  });
}
