// Whether people must sign in with a password. While the app is being developed it is off: anyone
// opening the app picks who to act as (header / start page). Set SIGN_IN=on or off to choose; by default
// it is off under `npm run dev` and on in a production build (`npm start`), so a deployed app is never open
// by accident. Own module so proxy.ts can import it without pulling in the store.

export function signInRequired(): boolean {
  const v = process.env.SIGN_IN?.trim().toLowerCase();
  if (v === "on") return true;
  if (v === "off") return false;
  return process.env.NODE_ENV === "production";
}
