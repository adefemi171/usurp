# Interface verification — 9 September 2026

## Changes

- Shared navigation, active-page indicators, keyboard focus, and skip link.
- New homepage with a clear usage entry point, league explanation, arena controls,
  and setup links. Metric switches preserve the arena scroll destination.
- Settings grouped into profile, devices, arenas, clubs, notifications, and
  security. Device tables scroll inside their cards on narrow screens.
- Sign-in shows working, configured providers, with unavailable options explained
  in a disclosure instead of disabled forms.
- Consistent styling on usage profiles, arenas, hall of fame, and error pages.
- Unpriced usage no longer produces a misleading zero-cost daily average.

## Verification

- Production build and Docker rebuild passed. Web and PostgreSQL are healthy;
  the worker is running.
- Full regression suite: **504 tests passed in 32 files**, against an isolated
  test database, never the live usage database.
- Browser checks at 390px and 1440px: homepage, usage, settings, and sign-in.
  No page-level horizontal overflow. Arena checked on mobile; hall of fame on
  desktop. The settings overflow found in the first pass was fixed and retested.
- Exercised homepage arena navigation, Rating/Burn switching, social-menu
  expansion (without posting), settings section links, sync-help disclosure,
  empty club-form validation, Cursor filtering, Tokens/Cost switching, and the
  authenticated source-refresh button. Refresh succeeded and kept the filter.
- Viewed sign-in as an anonymous visitor using the loopback IP, preserving the
  existing localhost session. Configured OAuth URLs, error handling, return
  destinations, and signed-in redirects are covered by tests. A new third-party
  OAuth consent round trip was not performed.
- No real club, visibility, account, notification, or device changes were made
  during browser testing. Those mutations remain covered by integration tests.

The source-refresh test intentionally imported a newer analytics snapshot.
Native usage records and device enrollment were not modified.
