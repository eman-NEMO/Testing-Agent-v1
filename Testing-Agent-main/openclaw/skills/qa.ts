import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SESSION_FILE = "qa-session.json";
const SAMPLE_EMAIL = "qa.user@example.com";
const SAMPLE_PASSWORD = "correct-horse";

type Turn = { role: string; text: string };
type Prepared = { handled: true; text: string } | { handled: false; brief: string };
type Outcome = "passed" | "failed" | "blocked" | "unjudged";
type AgentRole = "qa" | "qa-runner" | "qa-analyst";
type Mode = "all" | "read" | "missing" | "one";

type Prop = { name: string; type: string; format?: string; minLength?: number };

export type Operation = {
  method: string;
  path: string;
  required: string[];
  props: Prop[];
  successStatus: number | null;
  invalidStatus: number | null;
  notFoundStatus: number | null;
};

export type Scenario = {
  id: string;
  name: string;
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  expectedStatus: number | null;
  createsData: boolean;
};

export type QaExecution = {
  caseId: string;
  name: string;
  method: string;
  path: string;
  expectedStatus: number | null;
  actualStatus: number | null;
  responseBody: string;
  outcome: Outcome;
  reason: string;
  shouldReturn: string;
};

export type QaPending = {
  id: string;
  tool: "qa.execute";
  title: string;
  summary: string;
  risk: "low" | "medium" | "high";
  caseIds: string[];
};

export type QaFacts = {
  ids: Record<string, string>;
  duplicateEmail: string;
  duplicateStatus: number | null;
};

export type QaSession = {
  baseUrl: string;
  operations: Operation[];
  scenarios: Scenario[];
  omitted: string[];
  executions: QaExecution[];
  pending: QaPending | null;
  cursor: number;
  focus: string;
  facts: QaFacts;
  pendingAsk: "id" | "duplicate" | null;
  awaitingVerdict: boolean;
  runnerPhase: "verdict" | "expect" | "next" | null;
  lastRunIds: string[];
  modulePage: number;
};

type Choice = { id: string; label: string; value: string };
type Command = { name: "set_agent"; value: string };
type Proposal = { id: string; title: string; tool: string; summary: string; risk: "low" | "medium" | "high" };

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export function defaultDataDir(): string {
  return path.join(process.cwd(), "openclaw", "data");
}

export function defaultSpecPath(): string {
  return path.join(process.cwd(), "openclaw", "fixtures", "users.openapi.json");
}

export function agentIdFromContext(context: string | undefined): string | null {
  const match = context?.match(/Agent role \(([^)]+)\)/);
  return match?.[1] ?? null;
}

export function isQaAgent(agentId: string | null): boolean {
  return agentId === "qa" || agentId === "qa-runner" || agentId === "qa-analyst";
}

/** Local stand-in used by tests. The live squad does not start it. */
export function startUsersFixture(port = 0): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => handleUsers(req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({
        baseUrl: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

export function openSquad(options: { dir: string; fetchImpl?: FetchImpl }) {
  const sessionPath = path.join(options.dir, SESSION_FILE);
  const fetchImpl: FetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  const load = (): { ok: true; session: QaSession } | { ok: false; error: string } => readSession(sessionPath);

  const save = (session: QaSession): boolean => writeSession(sessionPath, session);

  const ingest = async (session: QaSession, turns: Turn[]): Promise<string | null> => {
    let notice: string | null = null;
    const users = turns.filter((turn) => turn.role === "user");
    const latest = users[users.length - 1]?.text ?? "";
    const inline = extractSpecText(latest) ?? users.map((turn) => extractSpecText(turn.text)).find((item) => item) ?? null;
    const latestUrl = findUrl(latest);
    if (latestUrl && "rejected" in latestUrl) notice = "That address is not an http or https URL.";
    if (latestUrl && "origin" in latestUrl) session.baseUrl = latestUrl.origin;
    if (!latestUrl) {
      for (const turn of users) {
        const older = findUrl(turn.text);
        if (older && "rejected" in older) notice = "That address is not an http or https URL.";
        if (older && "origin" in older && !session.baseUrl) session.baseUrl = older.origin;
      }
    }
    if (inline && (extractSpecText(latest) || !session.operations.length)) {
      const parsed = parseOpenApi(inline);
      if (!parsed.ok) notice = parsed.error;
      else {
        session.operations = parsed.operations;
        if (parsed.serverUrl) session.baseUrl = parsed.serverUrl;
        notice = null;
      }
    }
    const specUrls = latestUrl && "specUrls" in latestUrl ? latestUrl.specUrls : !session.operations.length ? specUrlsFromHistory(users) : null;
    if (specUrls?.length && !extractSpecText(latest)) {
      if (latestUrl && "origin" in latestUrl) session.baseUrl = latestUrl.origin;
      const fetched = await readFirstSpec(fetchImpl, specUrls);
      if ("error" in fetched) notice = fetched.error;
      else {
        const parsed = parseOpenApi(fetched.raw);
        if (!parsed.ok) notice = parsed.error;
        else {
          session.operations = parsed.operations;
          if (parsed.serverUrl) session.baseUrl = parsed.serverUrl;
          else if (latestUrl && "origin" in latestUrl) session.baseUrl = latestUrl.origin;
          notice = null;
        }
      }
    }
    return notice;
  };

  return { load, save, ingest, fetchImpl, sessionPath };
}

export type Squad = ReturnType<typeof openSquad>;

export async function prepareQaTurn(squad: Squad, turns: Turn[], agentId = "qa"): Promise<Prepared> {
  const loaded = squad.load();
  if (!loaded.ok) return { handled: true, text: screenJson(loaded.error) };
  const session = loaded.session;
  const latest = [...turns].reverse().find((turn) => turn.role === "user")?.text ?? "";
  const notice = await squad.ingest(session, turns);
  if (!squad.save(session)) return { handled: true, text: screenJson("I could not save this session.") };

  const decision = parseDecision(latest);
  if (decision?.approved) return { handled: true, text: await execute(squad, decision.id) };
  if (decision && !decision.approved) return { handled: true, text: deny(squad, decision.id) };
  if (latest.trim().toLowerCase() === "cancel") return { handled: true, text: cancel(squad) };

  const role = normalizeRole(agentId);
  if (role === "qa-analyst") return { handled: true, text: analyze(squad, latest) };
  if (role === "qa-runner") return { handled: true, text: await runnerTurn(squad, latest, notice) };
  return { handled: true, text: readerTurn(squad, latest, notice) };
}

export function settleQaReply(modelText: string): "execute" | "stay" | string {
  const parsed = extractJson(modelText);
  if (!parsed || typeof parsed !== "object") return modelText;
  const tool = toolOf(parsed as Record<string, unknown>);
  if (tool === "qa.execute") return "execute";
  if (tool?.startsWith("qa.")) return "stay";
  return modelText;
}

export async function settleQaModel(squad: Squad, modelText: string): Promise<string> {
  const kind = settleQaReply(modelText);
  if (kind === "execute") return propose(squad, "all");
  if (kind === "stay") return screenJson("Tell me which area to test, such as users. I will suggest scenarios and wait for your approval.");
  return kind;
}

export function qaBrief(sessionPath: string): string {
  const loaded = readSession(sessionPath);
  const session = loaded.ok ? publicSession(loaded.session) : { error: loaded.error };
  return [
    "QA SQUAD: The reader stores a Swagger or OpenAPI document from an attached file or from the http or https URL the user gives. It follows $ref schemas in that document. The runner shows one scenario at a time, with the request and the expected status, and asks when a case needs a value the spec does not contain. After an approved call it shows the real status and response body. The analyst compares saved results with those expected statuses.",
    `SESSION: ${JSON.stringify(session)}`,
    "Do not invent an expected status. Do not say a request was sent unless the session executions say so. Set action_proposal to null. To ask for a send, return {\"kind\":\"tool\",\"tool\":\"qa.execute\"}.",
  ].join("\n");
}

export function parseOpenApi(raw: string): { ok: true; operations: Operation[]; serverUrl: string | null } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "That API spec is not valid JSON." };
  }
  if (!data || typeof data !== "object") return { ok: false, error: "That API spec is not an object." };
  const paths = (data as { paths?: unknown }).paths;
  if (!paths || typeof paths !== "object") return { ok: false, error: "That API spec has no paths." };
  const operations: Operation[] = [];
  for (const [pathKey, item] of Object.entries(paths)) {
    if (isSpecPath(pathKey) || !item || typeof item !== "object") continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = (item as Record<string, unknown>)[method];
      if (!op || typeof op !== "object") continue;
      operations.push(operationFrom(method, pathKey, op as Record<string, unknown>, data));
    }
  }
  if (!operations.length) return { ok: false, error: "That API spec has no operations I can test." };
  return { ok: true, operations, serverUrl: documentedServerUrl(data) };
}

function readerTurn(squad: Squad, latest: string, notice: string | null): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  const session = loaded.session;
  if (focusOf(latest) && session.operations.length && session.baseUrl) return suggest(squad, focusOf(latest) ?? "");
  if (!session.operations.length && !session.baseUrl) {
    return screenJson(notice ?? "Attach your Swagger file, or give me its URL, such as http://127.0.0.1:4011/swagger.json.");
  }
  if (!session.operations.length) return screenJson(notice ?? `I have ${session.baseUrl}, and I still need the OpenAPI file.`);
  if (!session.baseUrl) {
    return screenJson(`I found ${endpointList(session.operations)}. What is the base URL?`);
  }
  return screenJson(`I read the Swagger document and stored ${session.operations.length} endpoints for ${session.baseUrl}. ${endpointList(session.operations)}. ${fieldNote(session.operations)} Switching to the runner. Say which area to test, such as users.`, {
    commands: [{ name: "set_agent", value: "qa-runner" }],
  });
}

async function runnerTurn(squad: Squad, latest: string, notice: string | null): Promise<string> {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  const session = loaded.session;
  if (!session.operations.length || !session.baseUrl) {
    return screenJson(notice ?? "The reader still needs your spec and its URL.", { commands: [{ name: "set_agent", value: "qa" }] });
  }
  const step = stepOf(latest);
  if (step === "modules-next" || step === "modules-prev") return suggestionMenu(squad, step === "modules-next" ? 1 : -1);
  if (step === "new") return askForRequest(squad);
  if (step === "suggest") return suggestionMenu(squad);
  if (step === "next" || step === "prev") return moveCursor(squad, step === "next" ? 1 : -1);
  if (step) return propose(squad, step);
  const picked = caseNumber(latest);
  if (picked) return runNumber(squad, picked);
  const custom = addCustomCase(squad, latest);
  if (custom) return custom;
  const verdict = session.runnerPhase === "verdict" || session.runnerPhase === "expect" ? applyVerdict(squad, latest) : null;
  if (verdict) return verdict;
  const supplied = applySupply(squad, latest);
  if (supplied) return supplied;
  const focus = focusOf(latest);
  if (focus) return suggest(squad, focus);
  return suggestionMenu(squad);
}

function suggest(squad: Squad, focus: string): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  const chosen = matchOperations(loaded.session.operations, focus);
  if (!chosen.length) {
    return screenJson(`I do not see that area in the spec. I have ${endpointList(loaded.session.operations)}.`);
  }
  const built = scenariosFor(chosen, loaded.session.facts);
  const next = { ...loaded.session, focus, scenarios: built.scenarios, omitted: built.omitted, cursor: 0, pending: null, pendingAsk: nextAsk(chosen, loaded.session.facts), awaitingVerdict: false, runnerPhase: null };
  if (!squad.save(next)) return screenJson("I could not save those scenarios. Nothing was sent.");
  return showCase(next);
}

function propose(squad: Squad, mode: Mode): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  const chosen = selectScenarios(loaded.session.scenarios, mode, loaded.session.cursor);
  if (!chosen.length) return screenJson("That selection has no scenarios. Nothing was sent.");
  if (!allowedTarget(loaded.session.baseUrl)) return screenJson("That address is not an http or https URL. Nothing was sent.");
  const creates = chosen.some((item) => item.createsData);
  const only = chosen.length === 1 ? chosen[0] : null;
  const pending: QaPending = {
    id: `act_${randomBytes(3).toString("hex")}`,
    tool: "qa.execute",
    title: "Send API tests",
    summary: only
      ? `${only.method} ${loaded.session.baseUrl}${only.path}. ${only.expectedStatus == null ? "No expected status yet." : `Expects HTTP ${only.expectedStatus}.`} ${only.createsData ? "This creates data." : "This should not create data."}`
      : `${chosen.length} requests to ${loaded.session.baseUrl}. ${creates ? "Some create data." : "These should not create data."}`,
    risk: creates ? "medium" : "low",
    caseIds: chosen.map((item) => item.id),
  };
  if (!squad.save({ ...loaded.session, pending })) return screenJson("I could not store that approval request. Nothing was sent.");
  return screenJson("I prepared those requests. I need your OK before I send them.", { proposal: pending, navigation: ["cancel"] });
}

async function execute(squad: Squad, id: string): Promise<string> {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  const pending = loaded.session.pending;
  if (!pending || pending.id !== id) return screenJson("That approval is no longer waiting. Nothing was sent.");
  if (!allowedTarget(loaded.session.baseUrl)) return screenJson("That address is not an http or https URL. Nothing was sent.");
  const chosen = loaded.session.scenarios.filter((item) => pending.caseIds.includes(item.id));
  const executions: QaExecution[] = [];
  for (const item of chosen) executions.push(await runScenario(loaded.session.baseUrl, item, squad.fetchImpl));
  const next = { ...loaded.session, executions, pending: null, awaitingVerdict: true, runnerPhase: "verdict" as const, lastRunIds: executions.map((item) => item.caseId) };
  if (!squad.save(next)) return screenJson("I sent the requests but could not save the results.");
  return verdictScreen(next, executions);
}

function deny(squad: Squad, id: string): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  if (!loaded.session.pending || loaded.session.pending.id !== id) return screenJson("There is nothing waiting to cancel. Nothing was sent.");
  if (!squad.save({ ...loaded.session, pending: null })) return screenJson("I could not clear the waiting action. It was not executed.");
  return screenJson("I did not send the requests. The server was not called.");
}

function cancel(squad: Squad): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  if (!loaded.session.pending) return screenJson("Nothing is waiting.");
  return deny(squad, loaded.session.pending.id);
}

function analyze(squad: Squad, question: string): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  if (!loaded.session.executions.length) {
    return screenJson("No test has been run yet. Ask the runner which area to test.", { commands: [{ name: "set_agent", value: "qa-runner" }] });
  }
  return screenJson(answerAnalysis(loaded.session, question), {
    choices: [
      { id: "count_runs", label: "How many passed and failed", value: "How many passed and failed" },
      { id: "list_passed", label: "List passed", value: "List passed" },
      { id: "list_failed", label: "List failed", value: "List failed" },
    ],
  });
}

function answerAnalysis(session: QaSession, question: string): string {
  const category = categoryOf(question);
  const scoped = category ? session.executions.filter((item) => `${item.method} ${item.path} ${item.name}`.toLowerCase().includes(category)) : session.executions;
  if (category && !scoped.length) return `No ${category} test has been run. ${countLine(session.executions, "")}`;
  const passed = scoped.filter((item) => item.outcome === "passed");
  const failed = scoped.filter((item) => item.outcome === "failed");
  const where = category ? ` for ${category}` : "";
  const kind = kindOf(question);
  if (kind === "passed") return `${passed.length} passed${where}. ${runList(passed)}`;
  if (kind === "failed") return `${failed.length} failed${where}. ${runList(failed)}`;
  if (kind === "counts") return countLine(scoped, where);
  return `${scoped.length} ran${where}. ${countLine(scoped, "")} Passed: ${runList(passed)} Failed: ${runList(failed)}`;
}

function countLine(items: QaExecution[], where: string): string {
  const passed = items.filter((item) => item.outcome === "passed").length;
  const failed = items.filter((item) => item.outcome === "failed").length;
  const blocked = items.filter((item) => item.outcome === "blocked").length;
  const waiting = items.filter((item) => item.outcome === "unjudged").length;
  const extra = [blocked ? `${blocked} blocked` : "", waiting ? `${waiting} still waiting for your verdict` : ""].filter(Boolean).join(". ");
  return `${passed} passed and ${failed} failed${where}.${extra ? ` ${extra}.` : ""}`;
}

function runList(items: QaExecution[]): string {
  if (!items.length) return "None.";
  return items.map((item, index) => `${index + 1}. ${item.method} ${item.path}, HTTP ${item.actualStatus ?? "none"}. ${item.reason}`).join(" ");
}

function kindOf(question: string): "passed" | "failed" | "counts" | "all" {
  const text = question.toLowerCase();
  const fail = /\b(fail|failed|fails|failure|failures)\b/.test(text);
  const pass = /\b(pass|passed|success|successful|sucess|successes)\b/.test(text);
  const count = /\b(how many|number|count)\b/.test(text);
  if (fail && pass) return "counts";
  if (count && !fail && !pass) return "counts";
  if (fail) return "failed";
  if (pass) return "passed";
  return "all";
}

function categoryOf(question: string): string | null {
  const skip = new Set(["how", "many", "number", "count", "list", "lists", "ran", "run", "running", "tests", "test", "passed", "pass", "failed", "fail", "fails", "failure", "failures", "success", "successful", "sucess", "successes", "about", "the", "and", "for", "what", "which", "show", "give", "category", "cases", "case"]);
  const words = question.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !skip.has(word));
  return words[0] ?? null;
}

function scenariosFor(operations: Operation[], facts: QaFacts): { scenarios: Scenario[]; omitted: string[] } {
  const scenarios: Scenario[] = [];
  const omitted: string[] = [];
  for (const operation of operations) {
    const label = `${operation.method.toUpperCase()} ${operation.path}`;
    if (!operation.path.includes("{")) scenarios.push(scenario(operation, "Valid request", operation.path, sampleBody(operation), null, operation.method !== "get"));
    else if (facts.ids[operation.path]) scenarios.push(scenario(operation, "Valid request", operation.path.replace(/\{[^}]+\}/g, facts.ids[operation.path] ?? ""), sampleBody(operation), null, operation.method !== "get"));
    else omitted.push(`${label} needs an existing id for the success case. Tell me that id, such as existing id 42.`);
    for (const field of operation.required.slice(0, 4)) scenarios.push(scenario(operation, `Missing ${field}`, operation.path, sampleBody(operation, field), null, false));
    const email = operation.props.find((prop) => prop.format === "email");
    if (email) scenarios.push(scenario(operation, `Invalid ${email.name}`, operation.path, sampleBody(operation, undefined, { [email.name]: "not-an-email" }), null, false));
    const bounded = operation.props.find((prop) => typeof prop.minLength === "number" && prop.minLength > 1 && prop.format !== "email");
    if (bounded?.minLength) scenarios.push(scenario(operation, `Short ${bounded.name}`, operation.path, sampleBody(operation, undefined, { [bounded.name]: "a".repeat(bounded.minLength - 1) }), null, false));
    if (operation.path.includes("{")) scenarios.push(scenario(operation, "Missing id", operation.path.replace(/\{[^}]+\}/g, "missing-id"), null, null, false));
  }
  const emailOperation = operations.find((operation) => operation.props.some((prop) => prop.format === "email"));
  const email = emailOperation?.props.find((prop) => prop.format === "email");
  if (emailOperation && email && facts.duplicateEmail) {
    scenarios.push(scenario(emailOperation, "Duplicate email", emailOperation.path, sampleBody(emailOperation, undefined, { [email.name]: facts.duplicateEmail }), null, false));
  } else if (emailOperation) {
    omitted.push("Tell me an existing email if you want a duplicate-email case, such as existing email ada@example.com.");
  }
  const capped = scenarios.slice(0, 12).map((item, index) => ({ ...item, id: slug(`${index}_${item.id}`) }));
  if (scenarios.length > capped.length) omitted.push("I stopped at 12 scenarios so you can review this round.");
  return { scenarios: capped, omitted };
}

function scenario(operation: Operation, name: string, requestPath: string, body: Record<string, unknown> | null, expectedStatus: number | null, createsData: boolean): Scenario {
  return {
    id: slug(`${operation.method}_${requestPath}_${name}`),
    name: `${name} ${operation.method.toUpperCase()} ${requestPath}`,
    method: operation.method.toUpperCase(),
    path: requestPath,
    body,
    expectedStatus,
    createsData,
  };
}

function sampleBody(operation: Operation, skip?: string, overrides?: Record<string, unknown>): Record<string, unknown> | null {
  if (operation.method === "get" || operation.method === "delete") return null;
  const body: Record<string, unknown> = {};
  for (const prop of operation.props) {
    if (prop.name === skip) continue;
    body[prop.name] = overrides?.[prop.name] ?? sampleValue(prop);
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key !== skip) body[key] = value;
  }
  return body;
}

function sampleValue(prop: Prop): unknown {
  if (prop.format === "email") return SAMPLE_EMAIL;
  if (prop.name === "password") return SAMPLE_PASSWORD;
  if (typeof prop.minLength === "number" && prop.minLength > 1) return "a".repeat(prop.minLength);
  if (prop.type === "integer" || prop.type === "number") return 1;
  if (prop.type === "boolean") return true;
  return "sample";
}

function matchOperations(operations: Operation[], focus: string): Operation[] {
  const words = focus.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && word !== "the" && word !== "test" && word !== "endpoint" && word !== "endpoints" && word !== "related");
  if (!words.length || words.includes("all")) return operations;
  return operations.filter((operation) => words.some((word) => operation.path.toLowerCase().includes(word)));
}

function selectScenarios(scenarios: Scenario[], mode: Mode, cursor: number): Scenario[] {
  if (mode === "one") return scenarios[cursor] ? [scenarios[cursor]] : [];
  if (mode === "read") return scenarios.filter((item) => !item.createsData);
  if (mode === "missing") return scenarios.filter((item) => item.name.startsWith("Missing "));
  return scenarios;
}

async function runScenario(baseUrl: string, item: Scenario, fetchImpl: FetchImpl): Promise<QaExecution> {
  if (!allowedTarget(baseUrl)) return execution(item, null, "", "blocked", "That address is not an http or https URL.");
  try {
    const init: RequestInit = {
      method: item.method,
      headers: item.body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    };
    if (item.body) init.body = JSON.stringify(item.body);
    const response = await fetchImpl(`${baseUrl}${item.path}`, init);
    const responseBody = clip(await response.text(), 240);
    if (item.expectedStatus == null) return execution(item, response.status, responseBody, "unjudged", "Waiting for you to say what this should return.");
    const outcome: Outcome = response.status === item.expectedStatus ? "passed" : "failed";
    const reason = outcome === "passed" ? `HTTP ${response.status} matched the spec.` : `Expected HTTP ${item.expectedStatus} and received HTTP ${response.status}.`;
    return execution(item, response.status, responseBody, outcome, reason);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return execution(item, null, "", "blocked", timedOut ? "The request timed out." : "The test server did not answer.");
  }
}

function execution(item: Scenario, actualStatus: number | null, responseBody: string, outcome: Outcome, reason: string): QaExecution {
  return { caseId: item.id, name: item.name, method: item.method, path: item.path, expectedStatus: item.expectedStatus, actualStatus, responseBody, outcome, reason, shouldReturn: "" };
}

function speakCalls(session: QaSession, results: QaExecution[]): string {
  const failed = results.filter((item) => item.outcome === "failed").length;
  const blocked = results.filter((item) => item.outcome === "blocked").length;
  const unjudged = results.some((item) => item.outcome === "unjudged");
  const lead = unjudged ? "Here is the result. Tell me if this was expected, or what it should return." : failed || blocked ? "The call did not match the spec." : "The call matched the spec.";
  const blocks = results.map((result) => {
    const item = session.scenarios.find((scenario) => scenario.id === result.caseId);
    const request = item?.body ? `Request body: ${JSON.stringify(item.body)}` : "Request body: none";
    const status = result.actualStatus == null ? "No HTTP status" : `HTTP ${result.actualStatus}`;
    const response = result.responseBody ? `Response: ${result.responseBody}` : "Response: empty";
    const expected = result.expectedStatus == null ? "No expected status yet." : `Expected HTTP ${result.expectedStatus}.`;
    const judged = result.shouldReturn ? ` You said it should return ${result.shouldReturn}.` : "";
    return `${result.name}. ${result.method} ${session.baseUrl}${result.path}. ${request}. ${expected} ${status}. ${response}. ${result.reason}${judged}`;
  });
  return `${lead} ${blocks.join(" ")}`.replace(/\s+/g, " ").trim();
}

function verdictScreen(session: QaSession, results: QaExecution[]): string {
  return screenJson(`${speakCalls(session, results)} Did this match what you expected? If not, tell me what it should return.`, {
    choices: [
      { id: "yes_match", label: "Yes, it matched", value: "Yes, it matched" },
      { id: "no_match", label: "No, it did not", value: "No, it did not" },
    ],
    commands: [{ name: "set_agent", value: "qa-runner" }],
  });
}

function nextStepScreen(session: QaSession, results: QaExecution[]): string {
  return screenJson(`${speakCalls(session, results)} Do you want to write a new request, or run a suggested case?`, {
    choices: [
      { id: "new_request", label: "New request", value: "New request" },
      { id: "run_suggestion", label: "Run a suggestion", value: "Run a suggestion" },
    ],
    commands: [{ name: "set_agent", value: "qa-runner" }],
  });
}

function askForRequest(squad: Squad): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  const next = { ...loaded.session, runnerPhase: null, awaitingVerdict: false };
  if (!squad.save(next)) return screenJson("I could not save this step.");
  return screenJson("Tell me the method, path, and JSON body. For example: POST /api/login body {\"email\":\"ada@example.com\"}.", {
    commands: [{ name: "set_agent", value: "qa-runner" }],
  });
}

function suggestionMenu(squad: Squad, delta = 0): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  const areas = uniqueAreas(loaded.session.operations);
  const pageSize = areas.length > 3 ? 2 : 3;
  const pages = Math.max(1, Math.ceil(areas.length / pageSize));
  const modulePage = Math.min(pages - 1, Math.max(0, loaded.session.modulePage + delta));
  const slice = areas.slice(modulePage * pageSize, modulePage * pageSize + pageSize);
  const choices: Choice[] = slice.map((area) => ({ id: slug(`area_${area}`).slice(0, 32), label: area.slice(0, 40), value: `Test ${area}` }));
  if (modulePage > 0) choices.push({ id: "prev_modules", label: "Previous modules", value: "Previous modules" });
  if (modulePage < pages - 1) choices.push({ id: "next_modules", label: "Next modules", value: "Next modules" });
  if (choices.length < 4) choices.push({ id: "own_request", label: "My own request", value: "New request" });
  const next = { ...loaded.session, modulePage, runnerPhase: null, awaitingVerdict: false };
  if (!squad.save(next)) return screenJson("I could not save this step.");
  return screenJson(`Pick a module. I will suggest requests for its endpoints, and you tell me after each run whether the result matched. Or write your own, such as POST /api/login body {"email":"ada@example.com"}.`, {
    choices: choices.slice(0, 4),
    commands: [{ name: "set_agent", value: "qa-runner" }],
  });
}

function fieldNote(operations: Operation[]): string {
  const noted = operations.filter((item) => item.required.length).slice(0, 4);
  if (!noted.length) return "";
  return noted.map((item) => `${item.method.toUpperCase()} ${item.path} requires ${item.required.join(", ")}.`).join(" ");
}

function endpointList(operations: Operation[]): string {
  const shown = operations.slice(0, 6).map((item) => `${item.method.toUpperCase()} ${item.path}`);
  const extra = operations.length - shown.length;
  return extra > 0 ? `${shown.join(", ")}, and ${extra} more` : shown.join(", ");
}

function uniqueAreas(operations: Operation[]): string[] {
  const areas = operations.map((item) => item.path.split("/").filter((part) => part && !part.startsWith("{")).pop() ?? item.path);
  return [...new Set(areas)];
}

function operationFrom(method: string, pathKey: string, op: Record<string, unknown>, root: unknown): Operation {
  const schema = resolveSchema(root, requestSchema(op));
  const required = Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties as Record<string, { type?: unknown; format?: unknown; minLength?: unknown }> : {};
  const props = Object.entries(properties).map(([name, value]) => ({
    name,
    type: typeof value?.type === "string" ? value.type : "string",
    ...(value?.format === "email" ? { format: "email" } : {}),
    ...(typeof value?.minLength === "number" ? { minLength: value.minLength } : {}),
  }));
  const statuses = responseStatuses(op["responses"]);
  return {
    method,
    path: pathKey.startsWith("/") ? pathKey : `/${pathKey}`,
    required,
    props,
    successStatus: statuses.find((status) => status >= 200 && status < 300) ?? null,
    invalidStatus: statuses.includes(400) ? 400 : statuses.includes(422) ? 422 : null,
    notFoundStatus: statuses.includes(404) ? 404 : null,
  };
}

function requestSchema(op: Record<string, unknown>): unknown {
  const body = op["requestBody"];
  if (!body || typeof body !== "object") return null;
  const content = (body as { content?: Record<string, { schema?: unknown }> }).content;
  if (!content) return null;
  const json = Object.entries(content).find(([name]) => name.toLowerCase().startsWith("application/json"));
  return json?.[1]?.schema ?? null;
}

function resolveSchema(root: unknown, schema: unknown, depth = 0): { required?: unknown; properties?: unknown } | null {
  if (!schema || typeof schema !== "object" || depth > 6) return null;
  const bag = schema as Record<string, unknown>;
  if (typeof bag["$ref"] === "string") return resolveSchema(root, lookupRef(root, bag["$ref"]), depth + 1);
  if (Array.isArray(bag["allOf"])) {
    const required: unknown[] = [];
    const properties: Record<string, unknown> = {};
    for (const part of bag["allOf"]) {
      const resolved = resolveSchema(root, part, depth + 1);
      if (Array.isArray(resolved?.required)) required.push(...resolved.required);
      if (resolved?.properties && typeof resolved.properties === "object") Object.assign(properties, resolved.properties);
    }
    return { required, properties };
  }
  if (bag["properties"] && typeof bag["properties"] === "object") {
    const properties: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(bag["properties"] as Record<string, unknown>)) properties[name] = resolveSchema(root, value, depth + 1) ?? value;
    return { ...bag, properties };
  }
  return bag;
}

function lookupRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return null;
  let cursor: unknown = root;
  for (const part of ref.slice(2).split("/").map((item) => decodeURIComponent(item))) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor ?? null;
}

function documentedServerUrl(data: unknown): string | null {
  const servers = (data as { servers?: { url?: unknown }[] }).servers;
  const raw = servers?.find((item) => typeof item?.url === "string")?.url;
  if (typeof raw !== "string" || !allowedTarget(raw)) return null;
  return new URL(raw).origin;
}

function isSpecPath(pathKey: string): boolean {
  const name = pathKey.split("?")[0]?.toLowerCase() ?? "";
  return name.endsWith("/openapi.json") || name.endsWith("/swagger.json") || name.endsWith("/api-docs");
}

function specUrlsFromHistory(turns: Turn[]): string[] | null {
  for (const turn of [...turns].reverse()) {
    const url = findUrl(turn.text);
    if (url && "specUrls" in url) return url.specUrls;
  }
  return null;
}

async function readFirstSpec(fetchImpl: FetchImpl, specUrls: string[]): Promise<{ raw: string } | { error: string }> {
  let last = "I could not reach a Swagger document.";
  for (const specUrl of specUrls) {
    try {
      const response = await fetchImpl(specUrl, { method: "GET", signal: AbortSignal.timeout(4000) });
      const raw = await response.text();
      if (!response.ok) {
        last = `I could not read the Swagger document at ${specUrl}. It returned HTTP ${response.status}.`;
        continue;
      }
      return { raw };
    } catch {
      last = `I could not reach the Swagger document at ${specUrl}.`;
    }
  }
  return { error: last };
}

function responseStatuses(responses: unknown): number[] {
  if (!responses || typeof responses !== "object") return [];
  return Object.keys(responses).map((key) => Number(key)).filter((status) => Number.isInteger(status) && status >= 100 && status <= 599);
}

function focusOf(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  if (stepOf(normalized)) return null;
  const match = normalized.match(/\b(?:test|check)\b\s+(.+)/);
  if (match?.[1]) return match[1];
  return null;
}

function stepOf(text: string): Mode | "next" | "prev" | "new" | "suggest" | "modules-next" | "modules-prev" | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === "next case") return "next";
  if (normalized === "previous case") return "prev";
  if (normalized === "run this case") return "one";
  if (normalized === "run all of these") return "all";
  if (normalized === "only read-only") return "read";
  if (normalized === "missing fields only") return "missing";
  if (normalized === "new request") return "new";
  if (normalized === "run a suggestion") return "suggest";
  if (normalized === "next modules") return "modules-next";
  if (normalized === "previous modules") return "modules-prev";
  return null;
}

function showCase(session: QaSession): string {
  if (!session.scenarios.length) return screenJson(session.omitted.join(" ") || "I have no case to show yet.", { commands: [{ name: "set_agent", value: "qa-runner" }] });
  const lines = session.scenarios.map((item, index) => {
    const body = item.body ? JSON.stringify(item.body) : "none";
    return `${index + 1}. ${item.name}. ${item.method} ${session.baseUrl}${item.path}. Request body: ${body}.`;
  });
  const note = session.omitted.length ? ` ${session.omitted.join(" ")}` : "";
  const text = `${session.scenarios.length} cases. ${lines.join(" ")} No expected status yet. Say Run and a number, such as Run 2.${note} Nothing has been sent. You can also write your own request.`;
  return screenJson(text, { choices: caseChoices(session), commands: [{ name: "set_agent", value: "qa-runner" }] });
}

function caseChoices(session: QaSession): Choice[] {
  const choices: Choice[] = session.scenarios.slice(0, 3).map((_, index) => ({ id: `run_${index + 1}`, label: `Run ${index + 1}`, value: `Run ${index + 1}` }));
  if (choices.length < 4) choices.push({ id: "own_request", label: "My own request", value: "New request" });
  return choices.slice(0, 4);
}

function caseNumber(text: string): number | null {
  const match = text.trim().match(/^run(?:\s+case)?\s+(\d+)$/i);
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return number > 0 ? number : null;
}

function runNumber(squad: Squad, number: number): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  if (!loaded.session.scenarios.length) return screenJson("I have no case to show yet.");
  if (number > loaded.session.scenarios.length) return screenJson(`I only have ${loaded.session.scenarios.length} cases. Say Run and a number from that list.`);
  const next = { ...loaded.session, cursor: number - 1 };
  if (!squad.save(next)) return screenJson("I could not save that case. Nothing was sent.");
  return propose(squad, "one");
}

function moveCursor(squad: Squad, delta: number): string {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  if (!loaded.session.scenarios.length) return screenJson("I have no case to show yet.");
  const cursor = Math.min(loaded.session.scenarios.length - 1, Math.max(0, loaded.session.cursor + delta));
  const next = { ...loaded.session, cursor };
  if (!squad.save(next)) return screenJson("I could not save this case. Nothing was sent.");
  return showCase(next);
}

function applySupply(squad: Squad, text: string): string | null {
  const loaded = squad.load();
  if (!loaded.ok) return null;
  const supply = readSupply(text, loaded.session.pendingAsk);
  if (!supply) return null;
  const facts: QaFacts = { ...loaded.session.facts, ids: { ...loaded.session.facts.ids } };
  if (supply.id) {
    const pathKey = unansweredIdPath(matchOperations(loaded.session.operations, loaded.session.focus || "all"), facts);
    if (pathKey) facts.ids[pathKey] = supply.id;
  }
  if (supply.email) facts.duplicateEmail = supply.email;
  if (supply.status != null) facts.duplicateStatus = supply.status;
  const chosen = matchOperations(loaded.session.operations, loaded.session.focus || "all");
  const built = scenariosFor(chosen, facts);
  const added = supply.id
    ? built.scenarios.findIndex((item) => item.path.endsWith(`/${supply.id}`))
    : built.scenarios.findIndex((item) => item.name.startsWith("Duplicate email"));
  const cursor = added >= 0 ? added : loaded.session.cursor;
  const next = { ...loaded.session, facts, scenarios: built.scenarios, omitted: built.omitted, cursor, pending: null, pendingAsk: nextAsk(chosen, facts) };
  if (!squad.save(next)) return screenJson("I could not save that detail. Nothing was sent.");
  return showCase(next);
}

function readSupply(text: string, pendingAsk: QaSession["pendingAsk"]): { id: string; email: string; status: number | null } | null {
  const named = text.match(/\bexisting id\s+(\S+)/i)?.[1]?.replace(/[.,]+$/, "") ?? "";
  const duplicate = text.match(/\bexisting email\s+(\S+)(?:\s+expects\s+(\d{3}))?/i);
  const bare = text.trim();
  const bareId = !named && pendingAsk === "id" && /^[A-Za-z0-9._-]{1,80}$/.test(bare) ? bare : "";
  const id = named || bareId;
  const email = duplicate?.[1]?.replace(/[.,]+$/, "") ?? "";
  const status = duplicate?.[2] ? Number(duplicate[2]) : null;
  if (!id && !email) return null;
  return { id, email, status };
}

function nextAsk(operations: Operation[], facts: QaFacts): QaSession["pendingAsk"] {
  if (unansweredIdPath(operations, facts)) return "id";
  if (operations.some((operation) => operation.props.some((prop) => prop.format === "email")) && !facts.duplicateEmail) return "duplicate";
  return null;
}

function unansweredIdPath(operations: Operation[], facts: QaFacts): string | null {
  return operations.find((operation) => operation.successStatus != null && operation.path.includes("{") && !facts.ids[operation.path])?.path ?? null;
}

function addCustomCase(squad: Squad, text: string): string | null {
  const parsed = parseCustomCase(text);
  if (!parsed) return null;
  if ("error" in parsed) return screenJson(parsed.error);
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  const item = scenario({ method: parsed.method.toLowerCase(), path: parsed.path, required: [], props: [], successStatus: null, invalidStatus: null, notFoundStatus: null }, "Your case", parsed.path, parsed.body, parsed.expectedStatus, parsed.method !== "GET" && parsed.method !== "DELETE");
  const scenarios = [...loaded.session.scenarios, item].slice(-12);
  const next = { ...loaded.session, scenarios, cursor: scenarios.length - 1, pending: null, omitted: [], runnerPhase: null, awaitingVerdict: false };
  if (!squad.save(next)) return screenJson("I could not save that case. Nothing was sent.");
  return propose(squad, "one");
}

function parseCustomCase(text: string): { method: string; path: string; body: Record<string, unknown> | null; expectedStatus: number | null } | { error: string } | null {
  if (stepOf(text)) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/?[A-Za-z0-9][A-Za-z0-9_./{}-]*)/i);
  if (!match?.[1] || !match[2]) return null;
  const pathName = match[2].startsWith("/") ? cleanPath(match[2]) : `/${cleanPath(match[2])}`;
  if (pathName === "/") return null;
  const expects = trimmed.match(/\bexpects\s+(\d{3})\b/i);
  const expectedStatus = expects?.[1] ? Number(expects[1]) : null;
  const start = trimmed.indexOf("{");
  if (start < 0) return { method: match[1].toUpperCase(), path: pathName, body: null, expectedStatus };
  const json = extractObject(trimmed.slice(start));
  if (!json) return { error: "Give the request body as JSON, such as POST /api/login body {\"email\":\"ada@example.com\"}." };
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "The request body must be a JSON object." };
    return { method: match[1].toUpperCase(), path: pathName, body: parsed as Record<string, unknown>, expectedStatus };
  } catch {
    return { error: "That request body is not valid JSON." };
  }
}

function applyVerdict(squad: Squad, text: string): string | null {
  const loaded = squad.load();
  if (!loaded.ok) return screenJson(loaded.error);
  const verdict = parseVerdict(text);
  if (loaded.session.runnerPhase === "expect" && !verdict?.expected) {
    const answer = verdict?.shouldReturn || text.trim();
    if (!answer || stepOf(answer)) return null;
    return finishVerdict(squad, loaded.session, { expected: false, shouldReturn: answer });
  }
  if (!verdict || loaded.session.runnerPhase !== "verdict") return null;
  if (!verdict.expected && !verdict.shouldReturn) {
    const next = { ...loaded.session, runnerPhase: "expect" as const, awaitingVerdict: true };
    if (!squad.save(next)) return screenJson("I could not save that answer. The call was already sent.");
    return screenJson("What should this call return? For example: it should return HTTP 400.", { commands: [{ name: "set_agent", value: "qa-runner" }] });
  }
  return finishVerdict(squad, loaded.session, verdict);
}

function finishVerdict(squad: Squad, session: QaSession, verdict: { expected: boolean; shouldReturn: string }): string {
  const ids = new Set(session.lastRunIds);
  const executions = session.executions.map((current) => {
    if (!ids.has(current.caseId)) return current;
    const status = current.actualStatus == null ? "no HTTP status" : `HTTP ${current.actualStatus}`;
    return verdict.expected
      ? { ...current, outcome: "passed" as const, expectedStatus: current.actualStatus, reason: "You said this result was expected.", shouldReturn: current.responseBody || status }
      : { ...current, outcome: "failed" as const, reason: `You said it should return ${verdict.shouldReturn}. The server returned ${status}.`, shouldReturn: verdict.shouldReturn };
  });
  const next = { ...session, executions, awaitingVerdict: false, runnerPhase: "next" as const };
  if (!squad.save(next)) return screenJson("I could not save your verdict. The call was already sent.");
  const shown = executions.filter((item) => ids.has(item.caseId));
  return nextStepScreen(next, shown.length ? shown : executions);
}

function parseVerdict(text: string): { expected: boolean; shouldReturn: string } | null {
  const normalized = text.trim();
  if (/^(?:this was expected|expected|yes(?:,| it matched)?|yes,? (?:this|that|it) was expected|yes, it matched)\.?$/i.test(normalized)) return { expected: true, shouldReturn: "" };
  const should = normalized.match(/\b(?:it )?should return\s+([\s\S]+)/i);
  if (should?.[1]) return { expected: false, shouldReturn: should[1].trim().replace(/[.\s]+$/, "") };
  if (/^(?:not expected|this was not expected|no, it did not|no)\.?$/i.test(normalized)) return { expected: false, shouldReturn: "" };
  return null;
}

function cleanPath(value: string): string {
  return value.replace(/[),.;]+$/, "");
}

function extractObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return null;
}

function normalizeRole(agentId: string): AgentRole {
  if (agentId === "qa-runner" || agentId === "qa-analyst") return agentId;
  return "qa";
}

function parseDecision(text: string): { id: string; approved: boolean } | null {
  const approved = text.match(/^Approved action \[([^\]]+)\] \([^)]* via qa\.execute\)/);
  if (approved?.[1]) return { id: approved[1], approved: true };
  const denied = text.match(/^Denied action \[([^\]]+)\]/);
  if (denied?.[1]) return { id: denied[1], approved: false };
  return null;
}

function findUrl(text: string): { origin: string; specUrls: string[] } | { rejected: string } | null {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match?.[0]) return null;
  try {
    const url = new URL(match[0].replace(/[),.;]+$/, ""));
    if (!allowedTarget(url.origin)) return { rejected: url.origin };
    const pathName = url.pathname && url.pathname !== "/" ? `${url.pathname}${url.search}` : "";
    const specUrls = pathName ? [`${url.origin}${pathName}`] : [`${url.origin}/swagger.json`, `${url.origin}/openapi.json`];
    return { origin: url.origin, specUrls };
  } catch {
    return null;
  }
}

function allowedTarget(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function extractSpecText(text: string): string | null {
  const mark = text.search(/"openapi"\s*:/);
  if (mark < 0) return null;
  const start = text.lastIndexOf("{", mark);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function publicSession(session: QaSession) {
  return {
    baseUrl: session.baseUrl,
    operations: session.operations.map((item) => `${item.method.toUpperCase()} ${item.path}`),
    scenarios: session.scenarios.map((item) => ({ name: item.name, expectedStatus: item.expectedStatus })),
    executions: session.executions.map((item) => ({ name: item.name, outcome: item.outcome, expectedStatus: item.expectedStatus, actualStatus: item.actualStatus })),
    pending: session.pending ? { id: session.pending.id, tool: session.pending.tool } : null,
  };
}

function emptySession(): QaSession {
  return { baseUrl: "", operations: [], scenarios: [], omitted: [], executions: [], pending: null, cursor: 0, focus: "", facts: { ids: {}, duplicateEmail: "", duplicateStatus: null }, pendingAsk: null, awaitingVerdict: false, runnerPhase: null, lastRunIds: [], modulePage: 0 };
}

function readSession(file: string): { ok: true; session: QaSession } | { ok: false; error: string } {
  if (!existsSync(file)) return { ok: true, session: emptySession() };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const message = error instanceof SyntaxError ? "qa-session.json is not valid JSON." : "Could not read qa-session.json.";
    return { ok: false, error: message };
  }
  const session = coerceSession(data);
  if (!session) return { ok: false, error: "qa-session.json has a shape I cannot read." };
  return { ok: true, session };
}

function coerceSession(data: unknown): QaSession | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const bag = data as Record<string, unknown>;
  if (Object.keys(bag).length === 0) return emptySession();
  if (!Array.isArray(bag["operations"])) return emptySession();
  if (!bag["operations"].every(isOperation)) return null;
  const scenarios = Array.isArray(bag["scenarios"]) && bag["scenarios"].every(isScenario) ? bag["scenarios"] : [];
  const executions = Array.isArray(bag["executions"]) && bag["executions"].every(isExecution) ? bag["executions"].map(normalizeExecution) : [];
  const pending = bag["pending"] == null ? null : isPending(bag["pending"]) ? bag["pending"] : null;
  const facts = readFacts(bag["facts"]);
  const pendingAsk = bag["pendingAsk"] === "id" || bag["pendingAsk"] === "duplicate" ? bag["pendingAsk"] : null;
  const cursor = typeof bag["cursor"] === "number" && bag["cursor"] >= 0 ? Math.floor(bag["cursor"]) : 0;
  return {
    baseUrl: typeof bag["baseUrl"] === "string" ? bag["baseUrl"] : "",
    operations: bag["operations"],
    scenarios,
    omitted: Array.isArray(bag["omitted"]) ? bag["omitted"].filter((item): item is string => typeof item === "string") : [],
    executions,
    pending,
    cursor,
    focus: typeof bag["focus"] === "string" ? bag["focus"] : "",
    facts,
    pendingAsk,
    awaitingVerdict: bag["awaitingVerdict"] === true,
    runnerPhase: bag["runnerPhase"] === "verdict" || bag["runnerPhase"] === "expect" || bag["runnerPhase"] === "next" ? bag["runnerPhase"] : null,
    lastRunIds: Array.isArray(bag["lastRunIds"]) ? bag["lastRunIds"].filter((item): item is string => typeof item === "string") : [],
    modulePage: typeof bag["modulePage"] === "number" && bag["modulePage"] >= 0 ? Math.floor(bag["modulePage"]) : 0,
  };
}

function readFacts(value: unknown): QaFacts {
  const empty = { ids: {}, duplicateEmail: "", duplicateStatus: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const bag = value as Record<string, unknown>;
  const ids: Record<string, string> = {};
  if (bag["ids"] && typeof bag["ids"] === "object" && !Array.isArray(bag["ids"])) {
    for (const [key, item] of Object.entries(bag["ids"] as Record<string, unknown>)) {
      if (typeof item === "string" && item) ids[key] = item;
    }
  }
  const status = bag["duplicateStatus"];
  return {
    ids,
    duplicateEmail: typeof bag["duplicateEmail"] === "string" ? bag["duplicateEmail"] : "",
    duplicateStatus: typeof status === "number" ? status : null,
  };
}

function isOperation(value: unknown): value is Operation {
  if (!value || typeof value !== "object") return false;
  const bag = value as Record<string, unknown>;
  return typeof bag["method"] === "string" && typeof bag["path"] === "string" && Array.isArray(bag["required"]) && Array.isArray(bag["props"]);
}

function isScenario(value: unknown): value is Scenario {
  if (!value || typeof value !== "object") return false;
  const bag = value as Record<string, unknown>;
  return typeof bag["id"] === "string" && typeof bag["name"] === "string" && typeof bag["method"] === "string" && typeof bag["path"] === "string" && (bag["expectedStatus"] === null || typeof bag["expectedStatus"] === "number") && typeof bag["createsData"] === "boolean";
}

function isExecution(value: unknown): value is QaExecution {
  if (!value || typeof value !== "object") return false;
  const bag = value as Record<string, unknown>;
  const outcome = bag["outcome"];
  return typeof bag["caseId"] === "string" && typeof bag["name"] === "string" && (bag["expectedStatus"] === null || typeof bag["expectedStatus"] === "number") && (outcome === "passed" || outcome === "failed" || outcome === "blocked" || outcome === "unjudged") && typeof bag["reason"] === "string";
}

function normalizeExecution(value: QaExecution): QaExecution {
  return { ...value, shouldReturn: typeof value.shouldReturn === "string" ? value.shouldReturn : "" };
}

function isPending(value: unknown): value is QaPending {
  if (!value || typeof value !== "object") return false;
  const bag = value as Record<string, unknown>;
  const risk = bag["risk"];
  return typeof bag["id"] === "string" && bag["tool"] === "qa.execute" && typeof bag["title"] === "string" && typeof bag["summary"] === "string" && (risk === "low" || risk === "medium" || risk === "high") && Array.isArray(bag["caseIds"]);
}

function writeSession(file: string, session: QaSession): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(session, null, 2));
    return true;
  } catch {
    return false;
  }
}

function screenJson(text: string, options?: { proposal?: Proposal; choices?: Choice[]; navigation?: string[]; commands?: Command[] }): string {
  return JSON.stringify({
    kind: "screen",
    screen: { text, choices: options?.choices ?? [], navigation: options?.navigation ?? [] },
    action_proposal: options?.proposal ?? null,
    app_commands: options?.commands ?? [],
  });
}

function toolOf(record: Record<string, unknown>): string | null {
  if (record["kind"] === "tool" && typeof record["tool"] === "string") return record["tool"];
  const proposal = record["action_proposal"];
  if (proposal && typeof proposal === "object" && typeof (proposal as { tool?: unknown }).tool === "string") return (proposal as { tool: string }).tool;
  return null;
}

function extractJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function slug(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
  return /^[a-z]/.test(clean) ? clean : `case_${clean || "item"}`;
}

function clip(value: string, max = 120): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}...`;
}

function handleUsers(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "GET" && req.url?.split("?")[0] === "/openapi.json") {
    const file = defaultSpecPath();
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing spec" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(readFileSync(file));
    return;
  }
  if (req.method !== "POST" || req.url?.split("?")[0] !== "/api/users") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Request body must be JSON." }));
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(body, "email") || body["email"] == null || body["email"] === "") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
      return;
    }
    const email = body["email"];
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "email must be a valid address" }));
      return;
    }
    const password = body["password"];
    if (typeof password !== "string" || password.length < 8) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "password must be at least 8 characters" }));
      return;
    }
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "user_test", email }));
  });
}
