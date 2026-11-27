# Compliance and accessibility audit

Audited on 26 Nov 2026 against the code on `develop/aditya` (after PR #34). Scope: legal pages, cookies and consent,
personal data, third parties, content claims, images and licences, colour contrast, keyboard use and forms.

**This is not legal advice.** The policy pages were drafted from what the code actually does. Velza's legal adviser
must review them, and every `[to be confirmed]` value in `src/lib/legal.ts` must be filled in before go-live.

## Summary

| # | Area | Before this change | Now | Still open |
| --- | --- | --- | --- | --- |
| 1 | Privacy policy | Missing | `/privacy`: data table, purposes, retention, sharing, storage location, rights, Grievance Officer | Legal review; fill business details |
| 2 | Cookie policy | Missing | `/cookies`: lists the one cookie and four browser-storage keys | — |
| 3 | Terms and conditions | Missing | `/terms`: accounts, correct use, records, ownership, liability, law, open-source credits | Legal review; jurisdiction |
| 4 | Cookie consent | None | One-time notice (`CookieNotice`). No consent choice needed: only a strictly necessary cookie, no tracking | Add a real opt-in **before** adding any analytics or embed |
| 5 | Form consent | None on sign-up | Unticked consent box + plain-language notice on `/signup`; account can't be created without it | Backend: store consent time and policy version (see below) |
| 6 | What data we collect | Not disclosed | Disclosed in `/privacy`, taken from the schema | Keep in step with schema changes |
| 7 | Third-party embeds | None found | No change needed: no analytics, ads, iframes or external scripts; fonts self-hosted | — |
| 8 | AI-written text | No AI features or AI-generated claims in the UI | Policy texts are AI-drafted: legal review required | Legal review |
| 9 | Colour contrast | 4 text colours under 4.5:1; in dark theme, white on the danger button (3.41:1), its hover (4.44:1) and the primary hover (3.93:1) | All key pairs now 4.6:1 or more in both themes; filled danger buttons use their own deeper red (`--danger-fill`) | — |
| 10 | Keyboard and forms | Good base; no skip link; errors not announced; one tab title for every screen | Skip link, `#main` target, errors announced (`role="alert"`), per-screen titles | Full keyboard and screen-reader pass per screen |
| 11 | Fake reviews, unsupported claims | None: no reviews, ratings, testimonials or "certified" claims | — | Brand tagline "Driven by passion, defined by luxury" is puffery; OK |
| 12 | Business details | Not shown anywhere | Shown on legal pages from `src/lib/legal.ts` | Legal name, address, CIN, contact, Grievance Officer |
| 13 | Copyrighted images | Unused Next.js/Vercel template SVGs in `public/` | Removed. Velza logo from the brand book; fonts and icons under open licences, credited in `/terms` | Confirm Velza owns the brand-book artwork rights |
| 14 | Local laws | Not addressed | See the next section | Legal review |

## Applicable Indian law (for the legal adviser)

- **Digital Personal Data Protection Act, 2023** and the DPDP Rules 2025: notice before consent (s.5), clear
  affirmative consent (s.6), rights to access, correction, erasure, grievance and nomination (s.11–14), breach
  notice to the Data Protection Board. Most obligations apply after the Rules' phase-in period; the app is built to
  them now.
- **IT Act, 2000, s.43A** and the **SPDI Rules, 2011**: privacy policy on the website (rule 4), Grievance Officer
  with name and contact, response within one month (rule 5(9)), reasonable security practices (rule 8). Passwords
  count as sensitive personal data; they are stored only as scrypt hashes.
- **Consumer Protection Act, 2019**: the public QR page must not mislead; it only states registration status and
  label data from the batch.
- **Rights of Persons with Disabilities Act, 2016**: the accessibility work follows WCAG 2.1 AA, the usual
  benchmark.

## Personal data the app holds (source of the privacy table)

| Data | Where in code | Who enters it |
| --- | --- | --- |
| Business name, contact person, address, city, state, PIN, phone, email, supplier | `partners` table | Shop at `/signup`, or Admin |
| Sign-in ID, name, role, password hash, last sign-in | `users` table | Admin, or sign-up |
| Session (hash of the cookie token), 12 h | `sessions` table, `velza_session` cookie | Automatic at sign-in |
| Every movement and scan with sign-in ID, device, location, time | `code_history` (append-only) | Automatic |
| Damage photos | files in `VELZA_UPLOAD_DIR` | User upload |
| IP address | memory only (rate limits); security log lines | Automatic |
| Theme, sidebar, plant-PC ID, cookie-notice flag | browser localStorage | Automatic |

Consumer QR checks store no identity (`src/lib/core/alerts.ts`, REF-13).

## Contrast after the change (WCAG AA needs 4.5:1 for text)

| Pair | Light | Dark |
| --- | --- | --- |
| Body text on canvas | 15.46 | 18.06 |
| Secondary text on muted | 5.25 (was 4.46) | 5.42 |
| Tertiary text on canvas | 4.94 (was 4.33) | 7.02 |
| Tertiary text on muted | 4.73 (was 4.14) | 4.98 (was 3.85) |
| White on primary button | 4.72 | 4.72 |
| Danger text on surface | 5.38 | 4.99 |
| White on primary button hover | 6.11 | 6.11 (was 3.93) |
| White on danger button | 5.38 | 5.38 (was 3.41) |
| White on danger button hover | 6.89 | 6.89 (was 4.44) |

## Backend follow-ups (for the backend developer)

1. **Record consent**: add `consent_version` and `consent_at` to `partners` (schema v11) and require
   `consent: true` in `signupSchema` (`src/lib/services/signup.ts`). The UI blocks sign-up without consent today,
   but the API does not record it, and DPDP expects consent to be provable.
2. **Data requests**: an Admin action to export one partner's data and to deactivate it, for access and erasure
   requests. Movement history stays (needed for recalls); say so in the reply.
3. **Retention**: decide how long security logs and damage photos are kept, and add it to `/privacy`.
4. **Breach plan**: who tells the Data Protection Board and users, and how fast.

## Files changed

`src/lib/legal.ts`, `src/app/{privacy,cookies,terms}/page.tsx`, `src/components/{LegalPage,LegalLinks,CookieNotice,PageTitle}.tsx`,
`src/lib/pageTitle.ts` (+ test), `src/app/layout.tsx`, `src/app/(screens)/layout.tsx`, `src/app/signup/page.tsx`,
`src/app/t/[code]/page.tsx`, `src/components/AuthShell.tsx`, `src/components/ui.tsx`, `src/proxy.ts`,
`src/app/globals.css`, `playwright.config.ts`, `tests/e2e/demo.spec.ts`; deleted 5 template SVGs from `public/`.
