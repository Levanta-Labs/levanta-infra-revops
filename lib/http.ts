import { optionalEnv } from "./env.js";
import { errorMessage } from "./json.js";

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

/** [DEBUG] Terminal catch for every route. Logs the raw error, returns only its message to the caller. */
export function serverError(label: string, error: unknown): Response {
  console.error(label, error);
  return json({ error: errorMessage(error) }, 500);
}

//=============================================================================================================
//Shared-secret verification. Both sides of the comparison are in this process, so a rejection can say exactly
//why it failed. The secrets themselves are never logged - only their length and how the two values diverge.
//=============================================================================================================

const BEARER = "Bearer ";

function describeMismatch(presented: string, expected: string): string {
  if (presented.trim() === expected.trim()) return "they differ only by surrounding whitespace";
  if (presented.toLowerCase() === expected.toLowerCase()) return "they differ only by letter case";
  if (presented.length !== expected.length) {
    return `the request sent ${presented.length} chars, the variable holds ${expected.length}`;
  }
  return `both are ${expected.length} chars but the contents differ`;
}

/** Compares an already-extracted credential against a configured secret, logging the precise reason on failure. */
function verifySecret(
  label: string,
  envName: string,
  headerName: string,
  presented: string,
  expected: string,
): boolean {
  if (presented === expected) {
    console.log(`[auth] ${label}: authorized`);
    return true;
  }
  console.warn(
    `[auth] ${label}: rejected - ${headerName} did not match ${envName} (${describeMismatch(presented, expected)})`,
  );
  return false;
}

//---------------------------------------------------------------------------------------------------------
//[SECURITY] Gate on all three cron routes. Called first in every GET, before any external request.
//FLOW: 1. no CRON_SECRET configured -> reject; nothing can be verified. 2. no authorization header -> reject.
//3. not "Bearer <secret>" -> reject. 4. otherwise compare against the configured value.
//Each branch is distinct because the four failures need different fixes, and a bare 401 names none of them.
//[DEBUG] Rejections log the reason and how the two values diverge - never either value.
//---------------------------------------------------------------------------------------------------------
export function isAuthorizedCron(request: Request): boolean {
  const secret = optionalEnv("CRON_SECRET");
  if (secret === null) {
    console.warn(
      "[auth] cron: rejected - CRON_SECRET is not configured on this deployment, so no request can be verified. Vercel only attaches the authorization header once CRON_SECRET exists in the project's environment variables, and a redeploy is required after adding it.",
    );
    return false;
  }
  const header = request.headers.get("authorization");
  if (header === null) {
    console.warn(
      `[auth] cron: rejected - the request carried no authorization header, though CRON_SECRET is configured (${secret.length} chars). A non-Vercel caller must send it explicitly.`,
    );
    return false;
  }
  if (!header.startsWith(BEARER)) {
    console.warn(
      `[auth] cron: rejected - the authorization header is not in "Bearer <secret>" form, which is how Vercel sends CRON_SECRET`,
    );
    return false;
  }
  return verifySecret("cron", "CRON_SECRET", "the authorization header", header.slice(BEARER.length), secret);
}

/**
 * [SECURITY] Gate on the Instantly and HeyReach webhook routes. Both providers send a shared value in a custom
 * x-webhook-secret header. Called before the request body is read, so an unauthenticated caller never reaches
 * a parser. Same three rejection branches as isAuthorizedCron, for the same diagnostic reason.
 */
export function hasWebhookSecret(request: Request, envName: string): boolean {
  const secret = optionalEnv(envName);
  if (secret === null) {
    console.warn(
      `[auth] ${envName}: rejected - ${envName} is not configured on this deployment, so no webhook can be verified. Add it in Vercel and configure the sender to send the same value.`,
    );
    return false;
  }
  const header = request.headers.get("x-webhook-secret");
  if (header === null) {
    console.warn(
      `[auth] ${envName}: rejected - the request carried no x-webhook-secret header, though ${envName} is configured (${secret.length} chars). Check the sender's custom-header configuration.`,
    );
    return false;
  }
  return verifySecret(envName, envName, "the x-webhook-secret header", header, secret);
}
