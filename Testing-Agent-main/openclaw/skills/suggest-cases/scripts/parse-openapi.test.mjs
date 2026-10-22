import assert from "node:assert/strict";
import test from "node:test";
import { assertHttpUrl, summarizeSpec } from "./parse-openapi.mjs";

test("summarizeSpec lists only operations present in the document", () => {
  const summary = summarizeSpec({
    openapi: "3.0.3",
    info: { title: "Shop", version: "1.2.0" },
    security: [{ bearer: [] }],
    paths: {
      "/orders": {
        parameters: [{ name: "verbose", in: "query", required: false }],
        get: {
          summary: "List orders",
          parameters: [{ name: "limit", in: "query", required: true }],
          responses: { "200": { description: "ok" }, "401": { description: "denied" } },
        },
        post: {
          summary: "Create an order",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["sku"] } } },
          },
          responses: { "201": { description: "created" } },
          security: [],
        },
      },
    },
  });

  assert.equal(summary.title, "Shop");
  assert.equal(summary.endpointCount, 2);
  assert.deepEqual(summary.endpoints[0], {
    method: "GET",
    path: "/orders",
    summary: "List orders",
    required: ["query:limit"],
    responses: ["200", "401"],
    security: true,
  });
  assert.equal(summary.endpoints[1].security, false);
  assert.deepEqual(summary.endpoints[1].required, ["body:sku"]);
});

test("summarizeSpec rejects a document that is not an API spec", () => {
  assert.throws(() => summarizeSpec({ info: { title: "notes" } }), /neither OpenAPI 3 nor Swagger 2/);
});

test("assertHttpUrl accepts http(s) only", () => {
  assert.equal(assertHttpUrl("https://api.example.com/openapi.json").hostname, "api.example.com");
  assert.throws(() => assertHttpUrl("file:///C:/spec.json"), /http/);
});
