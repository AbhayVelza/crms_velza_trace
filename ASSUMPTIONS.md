# Assumptions and decisions

Choices made where the spec was silent or ambiguous. Simplest reasonable option each time.

## Setup

- Node.js 24 LTS and Git were installed with winget (machine had neither).
- Next.js 16.4 (current stable) is used with its defaults (`cacheComponents`, `partialPrefetching`).
  Screens are client components that fetch from the API routes, so no page depends on
  server-side dynamic rendering rules.
- `@types/node` pinned to v24 to match the runtime (vitest 5 requires ≥ 22).
- No Google Fonts: the system font stack is used so the app runs without internet.
