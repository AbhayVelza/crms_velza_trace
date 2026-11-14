// The public QR base URL (Admin → Settings) goes into every printed sticker. Pure check, shared by the
// settings service (authoritative) and the settings screen (inline message before saving).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Private LAN addresses (10.x, 172.16–31.x, 192.168.x): phones on the same Wi-Fi scanning a local server. */
const isPrivateLan = (host: string) => /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(host);

export const PUBLIC_URL_RULE = "Public URL must start with https:// (http:// only for localhost or a local network address), with no sign-in, ? or #";

/** https only (http for a localhost/LAN server), no user:password, no query, no fragment. */
export function isSafePublicUrl(u: string): boolean {
  let x: URL;
  try {
    x = new URL(u);
  } catch {
    return false;
  }
  if (x.username || x.password || u.includes("?") || u.includes("#")) return false;
  return x.protocol === "https:" || (x.protocol === "http:" && (LOCAL_HOSTS.has(x.hostname) || isPrivateLan(x.hostname)));
}
