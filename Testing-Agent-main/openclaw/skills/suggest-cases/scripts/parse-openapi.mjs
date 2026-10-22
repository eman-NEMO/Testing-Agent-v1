/**
 * Reads an OpenAPI 3 or Swagger 2 JSON document and prints only what is in it.
 * The tester agent must name endpoints from this output, not from memory.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
const MAX_BYTES = 5 * 1024 * 1024;

export function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`That is not a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The spec URL must start with http:// or https://.");
  }
  return url;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function localRef(doc, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cursor = doc;
  for (const part of parts) {
    cursor = asObject(cursor)?.[part];
    if (cursor == null) return null;
  }
  return cursor;
}

function schemaOf(doc, schema, depth = 0) {
  const node = asObject(schema);
  if (!node || depth > 4) return null;
  if (typeof node.$ref === "string") return schemaOf(doc, localRef(doc, node.$ref), depth + 1);
  return node;
}

function requiredFields(doc, schema) {
  const node = schemaOf(doc, schema);
  if (!node) return [];
  const required = Array.isArray(node.required) ? node.required.filter((name) => typeof name === "string") : [];
  return required.map((name) => `body:${name}`);
}

function parameterNames(doc, parameters) {
  if (!Array.isArray(parameters)) return [];
  const names = [];
  for (const raw of parameters) {
    const item = asObject(raw);
    if (!item) continue;
    const resolved = typeof item.$ref === "string" ? asObject(localRef(doc, item.$ref)) ?? item : item;
    if (resolved.required !== true || typeof resolved.name !== "string") continue;
    const where = typeof resolved.in === "string" ? resolved.in : "param";
    if (where === "body") names.push(...requiredFields(doc, resolved.schema));
    else names.push(`${where}:${resolved.name}`);
  }
  return names;
}

function responseCodes(responses) {
  const node = asObject(responses);
  if (!node) return [];
  return Object.keys(node).sort();
}

function hasSecurity(operation, doc) {
  if (Array.isArray(operation.security)) return operation.security.length > 0;
  return Array.isArray(doc.security) && doc.security.length > 0;
}

export function summarizeSpec(doc) {
  const root = asObject(doc);
  if (!root) throw new Error("The spec is not a JSON object.");
  const swagger2 = typeof root.swagger === "string";
  const openapi3 = typeof root.openapi === "string";
  if (!swagger2 && !openapi3) throw new Error("The document is neither OpenAPI 3 nor Swagger 2.");
  const paths = asObject(root.paths);
  if (!paths) throw new Error("This document has no paths object.");

  const endpoints = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    const item = asObject(pathItem);
    if (!item) continue;
    for (const method of METHODS) {
      const operation = asObject(item[method]);
      if (!operation) continue;
      const parameters = [...parameterNames(root, item.parameters), ...parameterNames(root, operation.parameters)];
      const bodySchema = asObject(operation.requestBody)?.content
        ? Object.values(asObject(operation.requestBody.content) ?? {})[0]
        : null;
      const bodyFields = requiredFields(root, asObject(bodySchema)?.schema);
      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: typeof operation.summary === "string" ? operation.summary : "",
        required: [...new Set([...parameters, ...bodyFields])],
        responses: responseCodes(operation.responses),
        security: hasSecurity(operation, root),
      });
    }
  }

  const info = asObject(root.info) ?? {};
  return {
    title: typeof info.title === "string" ? info.title : "",
    version: typeof info.version === "string" ? info.version : "",
    format: openapi3 ? "openapi" : "swagger",
    endpointCount: endpoints.length,
    endpoints,
  };
}

async function readUrl(value) {
  const url = assertHttpUrl(value);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: "follow" });
  if (!response.ok) throw new Error(`The spec URL returned ${response.status} ${response.statusText}.`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_BYTES) throw new Error("The spec is larger than 5 MB.");
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("The spec is larger than 5 MB.");
  return text;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`The spec is not JSON (${message}). Ask for the JSON URL, not a YAML URL.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fileFlag = args.indexOf("--file");
  const urlFlag = args.indexOf("--url");
  let text = "";
  if (fileFlag >= 0 && args[fileFlag + 1]) text = await readFile(args[fileFlag + 1], "utf8");
  else if (urlFlag >= 0 && args[urlFlag + 1]) text = await readUrl(args[urlFlag + 1]);
  else {
    throw new Error("Usage: node parse-openapi.mjs --url <https://host/openapi.json> | --file <spec.json>");
  }
  process.stdout.write(`${JSON.stringify(summarizeSpec(parseJson(text)), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
