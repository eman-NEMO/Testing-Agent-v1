import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentIdFromContext, isQaAgent, openSquad, prepareQaTurn, settleQaModel, startUsersFixture } from "./squad.ts";

const SPEC = readFileSync(path.join(process.cwd(), "openclaw", "fixtures", "users.openapi.json"), "utf8");

function dir() {
  return mkdtempSync(path.join(tmpdir(), "qa-"));
}

function squad(dataDir: string, fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>) {
  return openSquad({ dir: dataDir, fetchImpl });
}

function answered(prepared: { handled: boolean; text?: string; draft?: string; brief?: string }) {
  if (prepared.handled && prepared.text) return prepared.text;
  if (prepared.draft) return prepared.draft;
  throw new Error(prepared.brief ?? "expected a screen");
}

function screen(raw: string) {
  return JSON.parse(raw) as {
    screen: { text: string; choices: { value: string }[] };
    action_proposal: { id: string; tool: string; summary: string } | null;
    app_commands: { name: string; value: string }[];
  };
}

describe("qa squad", () => {
  it("reads the agent id from the console context", () => {
    assert.equal(agentIdFromContext("Agent role (qa-runner): runner"), "qa-runner");
    assert.equal(isQaAgent("qa-analyst"), true);
    assert.equal(isQaAgent("general"), false);
  });

  it("asks for a spec or a local URL when nothing has been provided", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    const book = squad(dir(), fetchImpl);
    const asked = screen(answered(await prepareQaTurn(book, [{ role: "user", text: "Test my API" }])));
    assert.match(asked.screen.text, /Attach your Swagger file, or give me its URL/);
    assert.equal(asked.action_proposal, null);
    assert.equal(calls, 0);
  });

  it("reads required fields from a Swagger URL that uses schema references", async () => {
    const spec = {
      openapi: "3.0.3",
      servers: [{ url: "http://127.0.0.1:4011" }],
      paths: {
        "/api/users": {
          post: {
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/UserCreate" } } } },
            responses: { 201: { description: "Created" }, 400: { description: "Invalid" } },
          },
        },
      },
      components: { schemas: { UserCreate: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } } } },
    };
    let requested = "";
    const fetchImpl = async (input: string) => {
      requested = input;
      return new Response(JSON.stringify(spec), { status: 200 });
    };
    const book = squad(dir(), fetchImpl);
    const stored = screen(answered(await prepareQaTurn(book, [{ role: "user", text: "Read the swagger at http://127.0.0.1:4011/openapi.json" }])));
    assert.equal(requested, "http://127.0.0.1:4011/openapi.json");
    assert.match(stored.screen.text, /POST \/api\/users requires email, password/);
    const suggested = screen(answered(await prepareQaTurn(book, [
      { role: "user", text: "Read the swagger at http://127.0.0.1:4011/openapi.json" },
      { role: "user", text: "Test users" },
    ], "qa-runner")));
    assert.match(suggested.screen.text, /1\. Valid request/);
    assert.match(suggested.screen.text, /Missing email/);
    assert.match(suggested.screen.text, /POST http:\/\/127\.0\.0\.1:4011\/api\/users/);
    assert.match(suggested.screen.text, /No expected status yet/);
    assert.doesNotMatch(suggested.screen.text, /Expects HTTP/);
  });

  it("reads an attached spec and does not invent a validation status", async () => {
    const partial = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Users", version: "1" },
      paths: { "/api/users": { post: { responses: { 201: { description: "Created" } }, requestBody: { content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } } } } } } },
    });
    const book = squad(dir());
    const stored = screen(answered(await prepareQaTurn(book, [{ role: "user", text: `The API is at http://127.0.0.1:4010\n\n${partial}` }])));
    assert.match(stored.screen.text, /POST \/api\/users/);
    assert.equal(stored.app_commands[0]?.value, "qa-runner");
    const suggested = screen(answered(await prepareQaTurn(book, [
      { role: "user", text: `The API is at http://127.0.0.1:4010\n\n${partial}` },
      { role: "user", text: "Test the user endpoints" },
    ], "qa-runner")));
    assert.match(suggested.screen.text, /1\. Valid request/);
    assert.match(suggested.screen.text, /Missing email/);
    assert.match(suggested.screen.text, /No expected status yet/);
    assert.doesNotMatch(suggested.screen.text, /Expects HTTP/);
  });

  it("suggests user scenarios from the attached spec and does not send them on deny", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("{}", { status: 201 });
    };
    const book = squad(dir(), fetchImpl);
    const turns = [{ role: "user", text: `API http://127.0.0.1:4010\n${SPEC}` }];
    await prepareQaTurn(book, turns);
    const suggested = screen(answered(await prepareQaTurn(book, [...turns, { role: "user", text: "Test users" }], "qa-runner")));
    assert.match(suggested.screen.text, /1\. Valid request/);
    assert.match(suggested.screen.text, /Missing email/);
    assert.match(suggested.screen.text, /Request body:/);
    assert.match(suggested.screen.text, /No expected status yet/);
    assert.match(suggested.screen.text, /existing email ada@example.com/);
    assert.equal(calls, 0);
    const one = screen(answered(await prepareQaTurn(book, [...turns, { role: "user", text: "Test users" }, { role: "user", text: "Run 2" }], "qa-runner")));
    assert.equal(one.action_proposal?.tool, "qa.execute");
    assert.match(one.action_proposal?.summary ?? "", /No expected status yet/);
    const asked = screen(answered(await prepareQaTurn(book, [...turns, { role: "user", text: "Test users" }, { role: "user", text: "Run all of these" }], "qa-runner")));
    assert.equal(asked.action_proposal?.tool, "qa.execute");
    assert.match(asked.action_proposal?.summary ?? "", /127\.0\.0\.1:4010/);
    const denied = screen(answered(await prepareQaTurn(book, [...turns, { role: "user", text: `Denied action [${asked.action_proposal?.id}] (Send API tests). Do not execute.` }], "qa-runner")));
    assert.match(denied.screen.text, /did not send the requests/);
    assert.equal(calls, 0);
  });

  it("runs a case the user writes and records what they say it should return", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "email is required" }), { status: 400 });
    };
    const book = squad(dir(), fetchImpl);
    const intro = { role: "user", text: `API http://127.0.0.1:4010\n${SPEC}` };
    await prepareQaTurn(book, [intro]);
    const asked = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: "please call POST /api/login body {\"email\":\"ada@example.com\"}" }], "qa-runner")));
    assert.equal(asked.action_proposal?.tool, "qa.execute");
    assert.match(asked.action_proposal?.summary ?? "", /POST http:\/\/127\.0\.0\.1:4010\/api\/login/);
    assert.match(asked.action_proposal?.summary ?? "", /No expected status yet/);
    assert.equal(calls, 0);
    const ran = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: `Approved action [${asked.action_proposal?.id}] (Send API tests via qa.execute). Proceed and report the result.` }], "qa-runner")));
    assert.match(ran.screen.text, /HTTP 400/);
    assert.match(ran.screen.text, /email is required/);
    assert.match(ran.screen.text, /Did this match what you expected/);
    assert.match(ran.screen.text, /what it should return/);
    assert.equal(calls, 1);
    const judged = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: "it should return HTTP 401" }], "qa-runner")));
    assert.match(judged.screen.text, /should return HTTP 401/);
    assert.match(judged.screen.text, /new request/);
    assert.match(judged.screen.text, /suggested case/);
    assert.equal(calls, 1);
    const again = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: "Run GET /api/health" }], "qa-runner")));
    await prepareQaTurn(book, [intro, { role: "user", text: `Approved action [${again.action_proposal?.id}] (Send API tests via qa.execute). Proceed and report the result.` }], "qa-runner");
    const passed = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: "This was expected" }], "qa-runner")));
    assert.match(passed.screen.text, /You said this result was expected/);
    assert.match(passed.screen.text, /new request/);
    assert.equal(calls, 2);
  });

  it("answers how many passed and failed, and lists one category", async () => {
    const dataDir = dir();
    const session = {
      baseUrl: "http://127.0.0.1:4011",
      operations: [],
      scenarios: [],
      omitted: [],
      executions: [
        { caseId: "a", name: "Valid request POST /api/users", method: "POST", path: "/api/users", expectedStatus: 201, actualStatus: 201, responseBody: "{}", outcome: "passed", reason: "HTTP 201 matched the spec.", shouldReturn: "" },
        { caseId: "b", name: "Missing email POST /api/users", method: "POST", path: "/api/users", expectedStatus: 400, actualStatus: 500, responseBody: "{}", outcome: "failed", reason: "Expected HTTP 400 and received HTTP 500.", shouldReturn: "" },
        { caseId: "c", name: "Your case GET /api/tasks", method: "GET", path: "/api/tasks", expectedStatus: 200, actualStatus: 200, responseBody: "[]", outcome: "passed", reason: "You said this result was expected.", shouldReturn: "[]" },
      ],
      pending: null,
      cursor: 0,
      focus: "",
      facts: { ids: {}, duplicateEmail: "", duplicateStatus: null },
      pendingAsk: null,
      awaitingVerdict: false,
      runnerPhase: null,
      lastRunIds: [],
    };
    writeFileSync(path.join(dataDir, "qa-session.json"), JSON.stringify(session));
    const book = openSquad({ dir: dataDir });
    const counts = screen(answered(await prepareQaTurn(book, [{ role: "user", text: "How many passed and failed" }], "qa-analyst")));
    assert.match(counts.screen.text, /2 passed and 1 failed/);
    const failed = screen(answered(await prepareQaTurn(book, [{ role: "user", text: "List failed" }], "qa-analyst")));
    assert.match(failed.screen.text, /1 failed/);
    assert.match(failed.screen.text, /POST \/api\/users/);
    assert.doesNotMatch(failed.screen.text, /GET \/api\/tasks/);
    const users = screen(answered(await prepareQaTurn(book, [{ role: "user", text: "List ran tests about users" }], "qa-analyst")));
    assert.match(users.screen.text, /2 ran for users/);
    assert.doesNotMatch(users.screen.text, /GET \/api\/tasks/);
    const tasks = screen(answered(await prepareQaTurn(book, [{ role: "user", text: "List passed about tasks" }], "qa-analyst")));
    assert.match(tasks.screen.text, /1 passed for tasks/);
    assert.match(tasks.screen.text, /GET \/api\/tasks/);
  });

  it("adds a case when the user supplies an id or a duplicate email status", async () => {
    const open = String.fromCharCode(123);
    const close = String.fromCharCode(125);
    const spec = JSON.stringify({
      openapi: "3.0.3",
      paths: {
        [`/api/tasks/${open}id${close}`]: {
          get: { responses: { 200: { description: "One" }, 404: { description: "Missing" } } },
        },
        "/api/users": {
          post: {
            responses: { 201: { description: "Created" }, 400: { description: "Invalid" } },
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } },
                },
              },
            },
          },
        },
      },
    });
    const book = squad(dir());
    const intro = { role: "user", text: `API http://127.0.0.1:4010\n${spec}` };
    const asked = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: "Test tasks" }], "qa-runner")));
    assert.match(asked.screen.text, /existing id 42/);
    assert.match(asked.screen.text, /No expected status yet/);
    assert.doesNotMatch(asked.screen.text, /Expects HTTP/);
    const added = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: "Test tasks" }, { role: "user", text: "existing id 42" }], "qa-runner")));
    assert.match(added.screen.text, /GET http:\/\/127\.0\.0\.1:4010\/api\/tasks\/42/);
    assert.match(added.screen.text, /No expected status yet/);
    const users = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: "Test users" }], "qa-runner")));
    assert.match(users.screen.text, /existing email ada@example.com/);
    const duplicate = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: "Test users" }, { role: "user", text: "existing email ada@example.com" }], "qa-runner")));
    assert.match(duplicate.screen.text, /Duplicate email/);
    assert.match(duplicate.screen.text, /ada@example.com/);
    assert.match(duplicate.screen.text, /No expected status yet/);
    assert.doesNotMatch(duplicate.screen.text, /Expects HTTP/);
  });

  it("runs only the approved requests and reports the real mismatch", async () => {
    const fixture = await startUsersFixture(0);
    try {
      const book = squad(dir());
      const intro = { role: "user", text: `The API is at ${fixture.baseUrl}\n${SPEC}` };
      await prepareQaTurn(book, [intro]);
      await prepareQaTurn(book, [intro, { role: "user", text: "Test users" }], "qa-runner");
      const asked = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: "Test users" }, { role: "user", text: "Run all of these" }], "qa-runner")));
      const ran = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: `Approved action [${asked.action_proposal?.id}] (Send API tests via qa.execute). Proceed and report the result.` }], "qa-runner")));
      assert.match(ran.screen.text, /Did this match what you expected/);
      assert.match(ran.screen.text, /POST http:\/\/127\.0\.0\.1:\d+\/api\/users/);
      assert.match(ran.screen.text, /Request body:/);
      assert.match(ran.screen.text, /Response: \{"error":"Internal Server Error"\}/);
      assert.doesNotMatch(ran.screen.text, /Expected HTTP 400/);
      assert.equal(ran.app_commands[0]?.value, "qa-runner");
      const again = screen(answered(await prepareQaTurn(book, [intro, { role: "user", text: `Approved action [${asked.action_proposal?.id}] (Send API tests via qa.execute). Proceed and report the result.` }], "qa-analyst")));
      assert.match(again.screen.text, /Nothing was sent/);
    } finally {
      await fixture.close();
    }
  });

  it("fetches the swagger path on any host and leaves a corrupt session untouched", async () => {
    const requested: string[] = [];
    const spec = JSON.stringify({
      openapi: "3.0.3",
      servers: [{ url: "https://api.example.com" }],
      paths: { "/api/users": { post: { responses: { 201: { description: "Created" } } } } },
    });
    const fetchImpl = async (input: string) => {
      requested.push(input);
      if (input.endsWith("/swagger.json")) return new Response("missing", { status: 404 });
      return new Response(spec, { status: 200 });
    };
    const book = squad(dir(), fetchImpl);
    const stored = screen(answered(await prepareQaTurn(book, [{ role: "user", text: "Read the swagger at https://api.example.com/swagger.json" }])));
    assert.deepEqual(requested, ["https://api.example.com/swagger.json"]);
    assert.match(stored.screen.text, /https:\/\/api\.example\.com/);

    const fallback: string[] = [];
    const second = squad(dir(), async (input: string) => {
      fallback.push(input);
      if (input.endsWith("/swagger.json")) return new Response("missing", { status: 404 });
      return new Response(spec, { status: 200 });
    });
    const discovered = screen(answered(await prepareQaTurn(second, [{ role: "user", text: "The API is at https://api.example.com" }])));
    assert.deepEqual(fallback, ["https://api.example.com/swagger.json", "https://api.example.com/openapi.json"]);
    assert.match(discovered.screen.text, /POST \/api\/users/);

    const dataDir = dir();
    const sessionPath = path.join(dataDir, "qa-session.json");
    writeFileSync(sessionPath, "{");
    const kept = screen(answered(await prepareQaTurn(openSquad({ dir: dataDir }), [{ role: "user", text: "Test users" }])));
    assert.match(kept.screen.text, /not valid JSON/);
    assert.equal(readFileSync(sessionPath, "utf8"), "{");
  });

  it("turns a model execute request into an approval and does not send it", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("{}", { status: 201 });
    };
    const book = squad(dir(), fetchImpl);
    const turns = [{ role: "user", text: `API http://127.0.0.1:4010\n${SPEC}` }, { role: "user", text: "Test users" }];
    await prepareQaTurn(book, turns, "qa-runner");
    const asked = screen(await settleQaModel(book, "{\"kind\":\"tool\",\"tool\":\"qa.execute\"}"));
    assert.equal(asked.action_proposal?.tool, "qa.execute");
    assert.equal(calls, 0);
  });

  it("asks the model to phrase the facts and keeps the real approval card", async () => {
    const book = squad(dir());
    const intro = { role: "user", text: `API http://127.0.0.1:4010\n${SPEC}` };
    await prepareQaTurn(book, [intro]);
    await prepareQaTurn(book, [intro, { role: "user", text: "Test users" }], "qa-runner");
    const prepared = await prepareQaTurn(book, [intro, { role: "user", text: "Test users" }, { role: "user", text: "Run all of these" }], "qa-runner");
    assert.equal(prepared.handled, false);
    if (prepared.handled) return;
    const facts = screen(prepared.draft);
    const spoken = screen(await settleQaModel(book, JSON.stringify({
      kind: "screen",
      screen: { text: "These requests are ready. I need your OK before I send them to 127.0.0.1:4010.", choices: [], navigation: [] },
      action_proposal: null,
      app_commands: [],
    })));
    assert.match(spoken.screen.text, /I need your OK/);
    assert.equal(spoken.action_proposal?.id, facts.action_proposal?.id);
    assert.equal(spoken.action_proposal?.tool, "qa.execute");
    const invented = screen(await settleQaModel(book, JSON.stringify({
      kind: "screen",
      screen: { text: "I sent POST /api/not-real and it returned HTTP 204.", choices: [], navigation: [] },
      action_proposal: null,
      app_commands: [],
    })));
    assert.equal(invented.screen.text, facts.screen.text);
    assert.equal(invented.action_proposal?.id, facts.action_proposal?.id);
  });
});
