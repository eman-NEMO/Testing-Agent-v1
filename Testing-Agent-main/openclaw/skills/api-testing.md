# api-testing

Send a request only after the user approves that exact batch.

- Call the `http` or `https` host from the URL the user gave.
- Save the real status code and body.
- A timeout or a connection failure is blocked, not a pass.
- A second approval of the same id sends nothing.
