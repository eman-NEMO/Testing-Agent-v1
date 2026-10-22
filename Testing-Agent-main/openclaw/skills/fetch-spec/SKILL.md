---
name: fetch-spec
description: Download a Swagger or OpenAPI JSON document from a URL the user named and list its real endpoints.
---

# Fetch spec

Use this when the user gives a Swagger or OpenAPI URL, or asks you to scan an API document.

1. The URL must be one the user typed in this conversation. It must be `http` or `https`.
2. Run the parser and use its stdout as the only endpoint list:

```bash
node {baseDir}/../suggest-cases/scripts/parse-openapi.mjs --url "<the user URL>"
```

3. Speak the document title and `endpointCount`. Offer the next step as buttons: suggest cases, add a requirement, or final analysis.
4. If the command fails, speak the real error. Do not invent endpoints, paths, or status codes.
5. A YAML URL is not accepted. Ask the user for the JSON URL of the same document.
