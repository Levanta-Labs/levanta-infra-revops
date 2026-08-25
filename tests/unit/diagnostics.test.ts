import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { credentialHint } from "../../lib/endpoints.js";
import { optionalEnv, resetEnvReporting } from "../../lib/env.js";
import { hasWebhookSecret, isAuthorizedCron } from "../../lib/http.js";

const SECRET = "s3cr3t-value-nobody-should-log";
const originalLog = console.log;
const originalWarn = console.warn;
let output: string[] = [];

beforeEach(() => {
  output = [];
  const capture = (...parts: unknown[]) => void output.push(parts.map(String).join(" "));
  console.log = capture;
  console.warn = capture;
  resetEnvReporting();
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  delete process.env.DIAG_SECRET;
  delete process.env.CRON_SECRET;
});

const combined = (): string => output.join("\n");
const cronRequest = (headers: Record<string, string>): Request =>
  new Request("https://example.test/api/cron/x", { headers });

describe("environment reporting", () => {
  test("names a variable that is not set", () => {
    expect(optionalEnv("DIAG_SECRET")).toBeNull();
    expect(combined()).toContain("DIAG_SECRET: NOT SET");
  });

  test("flags a value that is only whitespace", () => {
    process.env.DIAG_SECRET = "   ";
    expect(optionalEnv("DIAG_SECRET")).toBeNull();
    expect(combined()).toContain("SET BUT BLANK");
  });

  test("flags surrounding whitespace that had to be trimmed", () => {
    process.env.DIAG_SECRET = ` ${SECRET} `;
    expect(optionalEnv("DIAG_SECRET")).toBe(SECRET);
    expect(combined()).toContain("surrounding whitespace");
  });

  test("reports each variable once, however many times it is read", () => {
    process.env.DIAG_SECRET = SECRET;
    optionalEnv("DIAG_SECRET");
    optionalEnv("DIAG_SECRET");
    optionalEnv("DIAG_SECRET");
    expect(output.filter((line) => line.includes("DIAG_SECRET")).length).toBe(1);
  });
});

describe("cron authorization diagnostics", () => {
  test("distinguishes an unconfigured secret from a bad one", () => {
    expect(isAuthorizedCron(cronRequest({ authorization: `Bearer ${SECRET}` }))).toBe(false);
    expect(combined()).toContain("CRON_SECRET is not configured");
  });

  test("reports a missing header separately from a wrong value", () => {
    process.env.CRON_SECRET = SECRET;
    expect(isAuthorizedCron(cronRequest({}))).toBe(false);
    expect(combined()).toContain("carried no authorization header");
  });

  test("reports a header that omits the Bearer prefix", () => {
    process.env.CRON_SECRET = SECRET;
    expect(isAuthorizedCron(cronRequest({ authorization: SECRET }))).toBe(false);
    expect(combined()).toContain('not in "Bearer <secret>" form');
  });

  test("identifies a case-only difference", () => {
    process.env.CRON_SECRET = SECRET;
    expect(isAuthorizedCron(cronRequest({ authorization: `Bearer ${SECRET.toUpperCase()}` }))).toBe(false);
    expect(combined()).toContain("differ only by letter case");
  });

  test("compares lengths when the values are unrelated", () => {
    process.env.CRON_SECRET = SECRET;
    expect(isAuthorizedCron(cronRequest({ authorization: "Bearer nope" }))).toBe(false);
    expect(combined()).toContain(`the variable holds ${SECRET.length}`);
  });

  test("confirms a successful authorization", () => {
    process.env.CRON_SECRET = SECRET;
    expect(isAuthorizedCron(cronRequest({ authorization: `Bearer ${SECRET}` }))).toBe(true);
    expect(combined()).toContain("cron: authorized");
  });
});

describe("webhook secret diagnostics", () => {
  test("names the variable that is missing", () => {
    const request = new Request("https://example.test/hook", {
      headers: { "x-webhook-secret": SECRET },
    });
    expect(hasWebhookSecret(request, "DIAG_SECRET")).toBe(false);
    expect(combined()).toContain("DIAG_SECRET is not configured");
  });

  test("distinguishes an absent header from a mismatched one", () => {
    process.env.DIAG_SECRET = SECRET;
    expect(hasWebhookSecret(new Request("https://example.test/hook"), "DIAG_SECRET")).toBe(false);
    expect(combined()).toContain("carried no x-webhook-secret header");
  });
});

describe("provider credential hints", () => {
  test("points at the responsible variables on 401 and 403", () => {
    expect(credentialHint("aircall", 401)).toContain("AIRCALL_API_ID");
    expect(credentialHint("attio", 403)).toContain("ATTIO_API_KEY");
    expect(combined()).toContain("[credential]");
  });

  test("stays silent for statuses that are not about credentials", () => {
    expect(credentialHint("instantly", 429)).toBe("");
    expect(credentialHint("supabase", 500)).toBe("");
    expect(combined()).toBe("");
  });
});

describe("secret confidentiality", () => {
  test("no diagnostic path ever prints the secret itself", () => {
    process.env.CRON_SECRET = SECRET;
    process.env.DIAG_SECRET = SECRET;
    isAuthorizedCron(cronRequest({}));
    isAuthorizedCron(cronRequest({ authorization: SECRET }));
    isAuthorizedCron(cronRequest({ authorization: "Bearer wrong-but-similar" }));
    isAuthorizedCron(cronRequest({ authorization: `Bearer ${SECRET}` }));
    hasWebhookSecret(new Request("https://example.test/hook"), "DIAG_SECRET");
    optionalEnv("DIAG_SECRET");

    expect(output.length).toBeGreaterThan(0);
    expect(combined()).not.toContain(SECRET);
  });
});
