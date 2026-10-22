# API tester

The voice console can scan a Swagger or OpenAPI JSON document, suggest functional cases from that document, keep extra requirements you type, and speak an analysis of what was actually run.

Read-only skills are `fetch-spec` and `suggest-cases`. `run-case` and `write-report` wait for Approve in the console.

## What talks to what

The console does not load this folder. `src/routes/api/agent.ts` sends the chat to `POST http://localhost:18789/v1/chat/completions` with model `openclaw/default`. OpenClaw loads these skills when this directory is the agent workspace.

The console agent id is `api-tester`, registered in `src/lib/settings/voice.ts`.

## Gateway setup

Do this on the machine that runs OpenClaw. The live file is `~/.openclaw/openclaw.json`. `gateway.yaml` is only a copy for review, and it contains no real token.

1. Install OpenClaw and run `openclaw onboard`. Choose a real model there.
2. In `~/.openclaw/openclaw.json`, set port `18789`, enable `gateway.http.endpoints.chatCompletions`, set `gateway.auth.mode` to `token`, and set `agents.defaults.workspace` to this `openclaw` directory.
3. Put the same token in the app `.env` as `OPENCLAW_API_KEY`. Set `OPENCLAW_GATEWAY_URL` to `http://localhost:18789`.
4. Restart the gateway.

```bash
curl -sS http://127.0.0.1:18789/v1/models -H "Authorization: Bearer the-gateway-token"
openclaw skills list
```

`/v1/models` should include `openclaw/default`. `openclaw skills list` should include `fetch-spec`, `suggest-cases`, `run-case`, and `write-report`. If the skills are missing, the workspace path is not this folder, or a `SKILL.md` has no `name` and `description`. `openclaw skills check` shows skills that were found but hidden.

## Try it

In the console, choose **API tester** and say: scan the Swagger at your JSON URL.

The parser is `skills/suggest-cases/scripts/parse-openapi.mjs`. It accepts an OpenAPI 3 or Swagger 2 JSON document. A YAML URL returns a real error asking for JSON. Suggested cases cover the documented success status, a missing required field, and auth only when the spec declares security. Live calls go through `skills/run-case/scripts/run-case.mjs` and only after approval. Approved reports are written under `reports/`.

## Where AI helped

A Cursor agent drafted the agent instructions, the four skills, and the parser. The parser tests check that endpoints come from the document. The gateway, the model key, and a real hosted spec still have to be connected on this machine.
