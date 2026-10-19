# QA Squad

Three voice agents that test an API you provide. They do not ship with a fixed endpoint list.

## Run

1. Start your API. It should serve its Swagger file, such as `GET /swagger.json` or `GET /openapi.json`, or you can attach that file in the console.
2. Start this console from the repo root: `npm install`, then `npm run dev`.
3. In **Settings → Voice & Agents**, choose **QA Reader**.
4. Say “Test my API”, then attach the Swagger file or give its URL, such as `http://127.0.0.1:4011/swagger.json`. The reader fetches that address on whatever host you give. A host with no path is tried at `/swagger.json`, then `/openapi.json`. The reader follows schemas referenced inside that document.
5. The runner shows one case at a time for the area you name, for example “Test users”. Each case shows the method, URL, request body, and expected status. Use **Next case** and **Previous case** to move. If a case needs an existing id, say `existing id 42`. If you want a duplicate-email case, say `existing email ada@example.com expects 409`.
6. Choose **Run this case** or **Run all of these**. You can also give a case that was not suggested, such as `Run POST /api/login body {"email":"ada@example.com"}`. Approve the card before any request is sent. Deny sends nothing.
7. The runner then shows that call with its real status and response body. If you did not give an expected status, say **This was expected** or `it should return HTTP 400`. Switch to **QA Analyst** and ask `How many passed and failed`, `List passed`, `List failed`, or `List ran tests about users`.

Any `http` or `https` host you give is fetched. Requests are still sent only after you approve them.

## Layout

- `agents/qa-reader.md`, `qa-runner.md`, `qa-analyst.md` — the three roles
- `skills/requirements-analysis.md`, `test-design.md`, `api-testing.md`, `failure-triage.md` — the rules those roles follow
- `skills/qa.ts` — parsing, scenario suggestions, approved calls, and the comparison
- `data/qa-session.json` — created when a spec is stored

A corrupt session file is reported and left unchanged.

## Safety limits

The squad does not edit application code. It calls the host in the URL you give, and only after approval. A batch that creates data is marked on the approval card. Expected statuses come from the spec you supplied. A rule the spec does not mention is left out of the plan.
