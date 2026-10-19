# Decisions

One line per decision: date, decision, reason. Newest at the bottom.

- 2026-10-19 · Work in the owner's own repository (sudhakargummepalli/equidron) instead of a fork · the owner is the original author; the PDF's "fork it" step is for students.
- 2026-10-19 · The test count is 59, not the PDF's 51 · commit 8471570 (bank-statement payments) came after the PDF's commit 7639c8c and added 8 tests. "All original tests pass" means all 59.
- 2026-10-19 · Keep the bank-transfer check against a Google Sheet statement (src/statement.js) alongside SimulatedProvider · it postdates the PDF; Phase 8 replaces both with a real gateway in test mode, and the check stays for tests and demos.
- 2026-10-19 · The deploy previews and branch protection in Phase 0 are left to the owner · they change Netlify and GitHub settings, which the working rules reserve for the owner.
- 2026-10-19 · Add `.env` to .gitignore · local secrets must never be committed.
