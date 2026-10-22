---
name: write-report
description: Save the API test analysis as a markdown file after the user approves it.
---

# Write report

Use this when the user wants the analysis saved. Return an `action_proposal` first.

- `tool` is `write-report`.
- `title` is `Save API analysis`.
- `risk` is `medium`.
- `summary` names the file path under `reports/`.

After `Approved action` for that id, write one markdown file in the workspace `reports/` directory. Include only:

- the spec title, version, and endpoint count from the parser
- requirements the user wrote
- cases that were suggested
- calls whose `run-case` output included a status
- cases that were not run

Do not write a status code that `run-case` did not print. Do not write tokens or credential values. If the user denies the action, leave the disk unchanged and say so.
