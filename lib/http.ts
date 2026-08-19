import { optionalEnv } from "./env.ts";
import { errorMessage } from "./json.ts";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export async function requestJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export function serverError(label: string, error: unknown): Response {
  console.error(label, error);
  return json({ error: errorMessage(error) }, 500);
}

export function isAuthorizedCron(request: Request): boolean {
  const secret = optionalEnv("CRON_SECRET");
  return secret !== null && request.headers.get("authorization") === `Bearer ${secret}`;
}

export function hasWebhookSecret(request: Request, envName: string): boolean {
  const secret = optionalEnv(envName);
  return secret !== null && request.headers.get("x-webhook-secret") === secret;
}
