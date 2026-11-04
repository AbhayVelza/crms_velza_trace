// Whether people must sign in with a password. While the app is being developed it is off: anyone
// opening the app picks who to act as (header / start page). Outside production it is off unless SIGN_IN=on.
// A production build (`npm start`) always requires sign-in and ignores SIGN_IN=off, so a deployed app can
// never be opened by accident.
// Own module so proxy.ts can import it without pulling in the store.

let warnedIgnoredOff = false;

export function signInRequired(): boolean {
  const v = process.env.SIGN_IN?.trim().toLowerCase();
  if (process.env.NODE_ENV === "production") {
    if (v === "off" && !warnedIgnoredOff) {
      warnedIgnoredOff = true;
      console.warn("[velza] SIGN_IN=off is ignored in a production build: sign-in is required. Use `npm run dev` to work without sign-in.");
    }
    return true;
  }
  return v === "on";
}
