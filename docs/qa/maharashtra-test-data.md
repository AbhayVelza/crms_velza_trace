# Maharashtra QA dataset — 18 synthetic partners

Machine-readable version: [maharashtra-test-data.json](maharashtra-test-data.json) · Definition: `tests/qa/maharashtraDataset.ts`
· Data file: `data/qa-mh-2026.json` (git-ignored) · Created: 28 Oct 2026, run 1 of `tests/qa/qaRun.ts` (05:46 UTC) through
`POST /api/admin/partners`; re-verified by run 2 (found all 18, created none).

All names, contacts, phones (`+91 00000 2026NN`, not dialable) and e-mails (`@example.com`) are fictional. Passwords are
in `data/qa-mh-2026-credentials.json` (git-ignored) and are not listed here.

| Tier | Expected | Created and verified |
|---|---:|---:|
| Manufacturer | 1 | 1 |
| Super Stockist | 2 | 2 |
| Distributor | 5 | 5 |
| Retailer | 10 | 10 |
| **Total** | **18** | **18** |

"Verified" = type, parent, city, state, PIN and Active checked in the API list **and** by reading the data file; sign-ins
present; no duplicate IDs; no broken parent references.

| QA code | ID | Tier | Name | Assigned to | Place, city | State | PIN | Sign-in | Verified |
|---|---|---|---|---|---|---|---|---|:---:|
| QA-MH-2026-MFG-001 | MF0001 | Manufacturer | Sahyadri Beverages Plant | — | Chakan MIDC, Pune | Maharashtra | 410501 | MF0001-OP, MF0001-QC | ✅ |
| QA-MH-2026-SS-001 | SS0001 | Super Stockist | Deccan Super Stockist | — | Hadapsar, Pune | Maharashtra | 411028 | SS0001 | ✅ |
| QA-MH-2026-SS-002 | SS0002 | Super Stockist | Konkan Coast Super Stockist | — | Panaji, Panaji | Goa | 403001 | SS0002 | ✅ |
| QA-MH-2026-DST-001 | DB0001 | Distributor | Shivajinagar Distributors | SS0001 (SS-001) | Shivajinagar, Pune | Maharashtra | 411005 | DB0001 | ✅ |
| QA-MH-2026-DST-002 | DB0002 | Distributor | Nashik Valley Distributors | SS0001 (SS-001) | College Road, Nashik | Maharashtra | 422005 | DB0002 | ✅ |
| QA-MH-2026-DST-003 | DB0003 | Distributor | Andheri Distributors | SS0001 (SS-001) | Andheri East, Mumbai | Maharashtra | 400069 | DB0003 | ✅ |
| QA-MH-2026-DST-004 | DB0004 | Distributor | Kolhapur Distributors | SS0002 (SS-002) | Shahupuri, Kolhapur | Maharashtra | 416001 | DB0004 | ✅ |
| QA-MH-2026-DST-005 | DB0005 | Distributor | Solapur Distributors | SS0002 (SS-002) | Navi Peth, Solapur | Maharashtra | 413001 | DB0005 | ✅ |
| QA-MH-2026-RTL-001 | RT0001 | Retailer | Kothrud Fresh Mart | DB0001 (DST-001) | Kothrud, Pune | Maharashtra | 411038 | RT0001 | ✅ |
| QA-MH-2026-RTL-002 | RT0002 | Retailer | Baner Kirana | DB0001 (DST-001) | Baner, Pune | Maharashtra | 411045 | RT0002 | ✅ |
| QA-MH-2026-RTL-003 | RT0003 | Retailer | Gangapur Road Store | DB0002 (DST-002) | Gangapur Road, Nashik | Maharashtra | 422013 | RT0003 | ✅ |
| QA-MH-2026-RTL-004 | RT0004 | Retailer | Nashik Road Mart | DB0002 (DST-002) | Nashik Road, Nashik | Maharashtra | 422101 | RT0004 | ✅ |
| QA-MH-2026-RTL-005 | RT0005 | Retailer | Powai Corner Store | DB0003 (DST-003) | Powai, Mumbai | Maharashtra | 400076 | RT0005 | ✅ |
| QA-MH-2026-RTL-006 | RT0006 | Retailer | Dadar Cafe | DB0003 (DST-003) | Dadar, Mumbai | Maharashtra | 400014 | RT0006 | ✅ |
| QA-MH-2026-RTL-007 | RT0007 | Retailer | Rajarampuri Stores | DB0004 (DST-004) | Rajarampuri, Kolhapur | Maharashtra | 416008 | RT0007 | ✅ |
| QA-MH-2026-RTL-008 | RT0008 | Retailer | Ichalkaranji Mart | DB0004 (DST-004) | Ichalkaranji, Kolhapur | Maharashtra | 416115 | RT0008 | ✅ |
| QA-MH-2026-RTL-009 | RT0009 | Retailer | Hotgi Road Kirana | DB0005 (DST-005) | Hotgi Road, Solapur | Maharashtra | 413003 | RT0009 | ✅ |
| QA-MH-2026-RTL-010 | RT0010 | Retailer | Pandharpur Fresh | DB0005 (DST-005) | Pandharpur, Solapur | Maharashtra | 413304 | RT0010 | ✅ |

## Notes

- **IDs are issued by the app** (next number of the tier); the QA code is the start of the name, which is how a rerun
  finds the records.
- **SS-002 is in Goa**: the app allows one Super Stockist per state (`STATE_TAKEN`), so a second Maharashtra SS is
  refused — tested. Its distributors and retailers are in Maharashtra (Kolhapur, Solapur).
- The Manufacturer has no assigned Super Stockists: the app has no plant → SS link (any plant supplies any SS).
- Activity in the QA file from run 1: one print order (1 case Original + 1 tray Green Apple, 12 stickers), QC, the case
  taken SS0001 → DB0001 → RT0001 and opened, the Green Apple batch recalled, and the scans of every check (including the
  refused ones).
- Disposable test partners RT0011–RT0014 were created and deleted again during the lifecycle tests (IDs are never
  reused, so the retailer counter is at 14).
- **Cleanup** (only when asked): delete `data/qa-mh-2026.json` and `data/qa-mh-2026-credentials.json`; nothing else
  holds QA data. The partners can't be deleted one by one once they have history (by design).
