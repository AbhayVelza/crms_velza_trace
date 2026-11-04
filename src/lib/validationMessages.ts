// Turns request-validation issues (zod) into messages people can act on: field labels instead of internal
// key names, "X is required" / "Choose a …" instead of library wording. Messages written in a schema
// ("Name is required", "Batch code must be 6 characters …") are kept as they are.

import type { ZodError } from "zod";

type Issue = ZodError["issues"][number];

/** Fields named after what the person sees. */
const LABELS: Record<string, string> = {
  manufacturerId: "Manufacturer",
  partnerId: "Partner",
  parentId: "Assigned to",
  toPartnerId: "Receiver",
  contactPerson: "Contact person",
  pincode: "PIN code",
  type: "Tier",
  role: "Role",
  flavour: "Flavour",
  batchCode: "Batch code",
  lotCode: "Lot code",
  packCodes: "Pack codes",
  idempotencyKey: "Request key",
  deviceId: "Device",
  cases: "Cases",
  trays: "Trays",
  mfgDate: "Manufacture date",
  expiryDate: "Expiry date",
  qcPassword: "QC password",
  widthMm: "width (mm)",
  heightMm: "height (mm)",
  lotSticker: "Lot sticker",
  packSticker: "Pack sticker",
  notReceivedThresholdDays: "Not-received alert (days)",
  demoThresholdMinutes: "Demo alert (minutes)",
  poolIssueSize: "Codes issued per pool refill",
  poolRefillBelow: "Refill pool below",
  publicBaseUrl: "Public URL",
  defaultCountry: "Default country",
};

/** Picked from a list, so "Choose a …" reads better than "… is required". */
const CHOSEN = new Set(["manufacturerId", "partnerId", "parentId", "toPartnerId", "type", "role", "flavour", "deviceId", "defaultCountry"]);

const humanize = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** "Lot sticker width (mm)", "Contact person", "Batches 2 flavour" … from the issue's path. */
export function fieldLabel(path: readonly PropertyKey[]): string {
  const parts = path.filter((p) => typeof p === "string") as string[];
  if (!parts.length) return "Request";
  const label = parts.map((p) => LABELS[p] ?? humanize(p)).join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// zod's own wording, which is replaced; anything else was written in a schema and is kept.
const LIBRARY_WORDING = /^(Too small|Too big|Invalid input|Invalid option|Invalid string|Invalid UUID|Invalid uuid|Invalid email|Invalid url|Invalid|Unrecognized key)/;

export function friendlyIssue(issue: Issue): string {
  if (!LIBRARY_WORDING.test(issue.message)) return issue.message;
  const key = [...issue.path].reverse().find((p) => typeof p === "string") as string | undefined;
  const label = fieldLabel(issue.path);
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  const required = () => (key && CHOSEN.has(key) ? `Choose ${article} ${label.toLowerCase()}` : `${label} is required`);
  // zod 4 does not include the rejected value, so "missing" is read from its wording ("received undefined").
  const i = issue as Issue & { origin?: string; minimum?: number | bigint; maximum?: number | bigint; expected?: string };
  switch (issue.code) {
    case "invalid_type":
      if (/received (undefined|null)$/.test(issue.message)) return required();
      if (i.expected === "int") return `${label} must be a whole number`;
      return `${label} is not valid`;
    case "too_small":
      if (i.origin === "string" && Number(i.minimum) <= 1) return required();
      if (i.origin === "array") return `${label}: add at least ${i.minimum}`;
      return `${label} must be at least ${i.minimum}`;
    case "too_big":
      if (i.origin === "string") return `${label} must be at most ${i.maximum} characters`;
      if (i.origin === "array") return `${label}: at most ${i.maximum}`;
      return `${label} must be at most ${i.maximum}`;
    case "invalid_value":
      return `Choose ${article} valid ${label.toLowerCase()}`;
    default:
      return `${label} is not valid`;
  }
}

/** One message for the whole request and one per field; no internal schema details. */
export function friendlyValidation(error: ZodError): { message: string; fields: { field: string; message: string }[] } {
  const fields = error.issues.map((issue) => ({ field: issue.path.map(String).join("."), message: friendlyIssue(issue) }));
  return { message: [...new Set(fields.map((f) => f.message))].join("; "), fields };
}
