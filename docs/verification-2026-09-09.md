# Bridge and dashboard verification — 9 September 2026

Verified against the local Docker deployment and AgentsView on port 8080.

- Signed CLI import creates a daily analytics snapshot without modifying the
  original native hourly records.
- A later source-only import replaced the previous snapshot, including a lower
  cost. Native-reader cursor did not advance.
- Live comparison at verification matched in both AgentsView and Usurp
  analytics to the microdollar. Each priced model matched exactly too.
  This is an as-of-import comparison, not a guarantee that an actively updating
  source and an older snapshot remain equal.
- Final bridge transport works from inside the Docker web container. Anonymous
  POSTs to the refresh endpoint return HTTP 401. Cross-origin, wrong-owner,
  success, and source-failure paths have automated tests; persistence and
  signature/replay checks have real PostgreSQL integration tests.
- Browser: model and agent filters, attribution view switching, view refresh
  retaining filters, and Today/All-time navigation were exercised. Cursor GPT
  metadata-only selection displays unavailable cost/tokens, not fabricated zero
  usage. Fully priced model selection has no broad warning banner.
- No horizontal overflow at 390px and 1440px; browser error log empty. Restored
  normal viewport afterward. The browser was signed out, so the authenticated
  **Refresh source** click was not exercised in that session; its transport,
  handler, authorization and persistence were tested separately.
- Web production build passed; web and PostgreSQL healthy; worker running.

Regression suite: **495 tests passed** on the isolated
`usurp_archive_test_20260909` database, including signed bridge preview without uploads.
Production database was never used as a test fixture database.

Remaining data limitations are source limitations: unknown-model prices and
Cursor selected-model-only conversations cannot supply an actual bill. No
pricing table, session payload, or transcript is synthesized to fill them.
