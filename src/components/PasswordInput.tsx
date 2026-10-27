"use client";

// Password box for Velza Admin: type one, or press Generate for a random one to share with the person.
// Shown in clear text while the Admin is setting it, so it can be read out or copied.

import { useState } from "react";
import { Button, Input } from "./ui";

const LETTERS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";

/** Uniform random integer in [0, n), from the browser's secure generator (rejection sampling: no bias). */
function randomInt(n: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

/** 12 letters and digits, easy to read aloud (no 0/O, 1/l/I) — same rules as the server's generator. */
export function generatePassword(): string {
  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(LETTERS), pick(DIGITS), ...Array.from({ length: 10 }, () => pick(LETTERS + DIGITS))];
  // Shuffle so the guaranteed letter and digit aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function PasswordInput({ value, onChange, label = "Password", id }: { value: string; onChange: (v: string) => void; label?: string; id?: string }) {
  const [shown, setShown] = useState(true);
  return (
    <div className="flex gap-1">
      <Input
        id={id}
        aria-label={label}
        type={shown ? "text" : "password"}
        autoComplete="new-password"
        spellCheck={false}
        className="font-mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="8+ letters and digits"
      />
      <Button variant="secondary" className="px-2 text-xs" onClick={() => setShown(!shown)}>
        {shown ? "Hide" : "Show"}
      </Button>
      <Button variant="secondary" className="px-2 text-xs" onClick={() => (onChange(generatePassword()), setShown(true))}>
        Generate
      </Button>
    </div>
  );
}
