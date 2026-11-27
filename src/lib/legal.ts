// One source for the business details and versions shown on /privacy, /cookies, /terms, the footer and the
// sign-up consent. DRAFT: the policy texts were written from what the code does (Nov 2026) and must be reviewed by
// Velza's legal adviser before go-live. Every value marked TO_CONFIRM must be replaced with the real detail.

export const TO_CONFIRM = "[to be confirmed]";

export const LEGAL = {
  /** Bumped whenever a policy changes in substance; the sign-up form shows it next to the consent box. */
  version: "1.0",
  effectiveDate: "26 November 2026",
  business: {
    /** Registered company name, as on the certificate of incorporation. */
    legalName: TO_CONFIRM,
    tradingName: "Velza",
    registeredAddress: TO_CONFIRM,
    /** CIN of the company. */
    cin: TO_CONFIRM,
    contactEmail: TO_CONFIRM,
  },
  /** Grievance Officer: required by the IT (SPDI) Rules 2011, rule 5(9), and the contact for DPDP Act requests. */
  grievanceOfficer: {
    name: TO_CONFIRM,
    email: TO_CONFIRM,
    /** Grievances must be resolved within one month (SPDI Rules 2011). */
    responseTime: "within 30 days",
  },
  /** Courts for disputes under the Terms. */
  jurisdiction: TO_CONFIRM,
} as const;

export const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy notice" },
  { href: "/cookies", label: "Cookie notice" },
  { href: "/terms", label: "Terms of use" },
] as const;

/** Local storage key that records that this browser has seen the cookie notice. */
export const COOKIE_NOTICE_KEY = "velza-cookie-notice";
