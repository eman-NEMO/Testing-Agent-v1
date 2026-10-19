# QA Squad

The squad is three agents:

- `qa` — reader. See `qa-reader.md`.
- `qa-runner` — suggests scenarios and sends approved requests. See `qa-runner.md`.
- `qa-analyst` — compares results with the spec. See `qa-analyst.md`.

There is no built-in endpoint list. The reader stores a spec the user attaches, or `GET /openapi.json` on a local URL.
