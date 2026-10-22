---
name: run-case
description: Call one API endpoint and return the real HTTP status. Requires approval first.
---

# Run one case

This skill changes nothing in the repo, but it sends a request to a host outside the workspace. Always return an `action_proposal` before running it.

- `tool` is `run-case`.
- `summary` names the method, the full URL, and what the case checks.
- Use `risk` `low` for GET, HEAD, and OPTIONS. Use `medium` for POST and PUT. Use `high` for PATCH and DELETE.

Run the command only after the user message starts with `Approved action` and the same action id:

```bash
node {baseDir}/scripts/run-case.mjs --method GET --url "https://host/path"
```

The host must be the host of the spec URL the user gave. Add `--body` only for a JSON body the user already agreed to in the proposal. Do not add a different host, a second request, or a request the proposal did not name.

Speak the `status` from stdout. If the command fails, speak that error. A denied action means the call was not made.
