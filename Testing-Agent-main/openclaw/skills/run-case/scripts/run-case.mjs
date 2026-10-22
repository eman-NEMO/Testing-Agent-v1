/**
 * Calls one endpoint and prints the real status and a short body.
 * The agent may start this only after an Approved action for that same call.
 */
import { pathToFileURL } from "node:url";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MAX_BODY = 4000;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  const method = (arg("--method") ?? "").toUpperCase();
  const rawUrl = arg("--url");
  const body = arg("--body");
  if (!METHODS.has(method) || !rawUrl) {
    throw new Error("Usage: node run-case.mjs --method GET --url <https://host/path> [--body <json>]");
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`That is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The case URL must start with http:// or https://.");
  }
  if (body && method === "GET") throw new Error("A GET case does not send a body.");

  const response = await fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body && method !== "GET" && method !== "HEAD" ? body : undefined,
  });
  const text = await response.text();
  const report = {
    method,
    url: url.toString(),
    status: response.status,
    statusText: response.statusText,
    location: response.headers.get("location"),
    body: text.slice(0, MAX_BODY),
    truncated: text.length > MAX_BODY,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
