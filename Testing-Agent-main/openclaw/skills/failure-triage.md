# failure-triage

After the runner saves results, compare each case with its expected status.

- Matched means the status is the one in the spec.
- Did not match means the server returned a different status. Quote the method, URL, request body, both status numbers, and the response body.
- Answer a question from the saved runs: how many passed, how many failed, the passed list, the failed list, or the runs in one category such as users.
- Do not name a root cause that the response did not show.
