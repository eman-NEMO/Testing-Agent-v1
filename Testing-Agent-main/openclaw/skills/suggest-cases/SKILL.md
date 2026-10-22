---
name: suggest-cases
description: Suggest functional test cases for endpoints printed by the OpenAPI parser.
---

# Suggest cases

Use this after `fetch-spec` has printed a spec. Suggest cases only from that JSON.

For each endpoint, suggest at most three cases:

- The documented success status, using the required fields the parser listed.
- One missing-required-field case, when `required` is not empty. Expect the client to be rejected. Do not invent an error code the spec did not print.
- An auth case only when `security` is true: call without credentials and expect the documented unauthenticated status when one was printed.

Speak at most four endpoints in one turn, then offer a button for the next group. Keep every extra requirement the user writes, and say which parsed path it applies to. If it matches no path, say that it is not in the spec.

Do not suggest injection, bypass, or attack cases. Do not call the API in this skill.
