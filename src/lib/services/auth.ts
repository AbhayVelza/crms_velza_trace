// Sign in / sign out / current user / change own password. Sessions live in the store.

import { z } from "zod";
import { accountStatus, checkPassword, normalizeLoginId, signInBlockedMessage } from "@/lib/core/auth";
import { VELZA_ORG_NAME } from "@/lib/core/types";
import { hashPassword, newSessionToken, sessionIdOf, verifyPassword } from "@/lib/passwords";
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
  const user = await store.users.findOne({ loginId });
  if (!(await verifyPassword(password, user?.passwordHash ?? null)) || !user) {
    const count = (f?.count ?? 0) + 1;
    failures.set(loginId, { count, lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCK_MINUTES * 60000 : 0 });
    throw badCredentials();
  }
  failures.delete(loginId);

  const status = accountStatus({ ...user, hasPassword: true });
  if (status !== "APPROVED") throw new ServiceError(403, status, signInBlockedMessage(status));

  const token = newSessionToken();
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_HOURS * 3600_000).toISOString();
  await store.transaction(async (tx) => {
    // Drop this user's expired sessions while we're here.
    for (const s of await tx.sessions.list({ userId: user.id })) if (Date.parse(s.expiresAt) <= now) await tx.sessions.delete(s.id);
    await tx.sessions.create({ id: sessionIdOf(token), userId: user.id, createdAt: nowIso(), expiresAt });
  });
  return { token, expiresAt, user: await me(user.id) };
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

export async function changePassword(userId: string | null, body: unknown) {
  const { currentPassword, newPassword } = changePasswordSchema.parse(body);
  const problem = checkPassword(newPassword);
  if (problem) throw badRequest("WEAK_PASSWORD", problem);
  const passwordHash = await hashPassword(newPassword);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    if (!(await verifyPassword(currentPassword, actor.user.passwordHash))) throw badRequest("BAD_CREDENTIALS", "Current password is wrong");
    await tx.users.update(actor.user.id, { passwordHash });
    return { ok: true, message: "Password changed" };
  });
}
