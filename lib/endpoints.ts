import { optionalEnv, requiredEnv } from "./env.ts";

//Base URLs====================================================================================

export const ATTIO_BASE = "https://api.attio.com/v2";
export const AIRCALL_BASE = "https://api.aircall.io/v1";
export const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
export const HEYREACH_BASE = "https://api.heyreach.io/api/public";

export function supabaseBaseUrl(): string {
  return requiredEnv("SUPABASE_URL");
}

//==============================================================================================

//Headers (API keys are read from env vars at call time, never hardcoded)=====================

export function attioHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${requiredEnv("ATTIO_API_KEY")}`,
    "Content-Type": "application/json",
  };
}

export function aircallAuthHeader(): string {
  const credentials = `${requiredEnv("AIRCALL_API_ID")}:${requiredEnv("AIRCALL_API_TOKEN")}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

export function instantlyAuthHeader(): string {
  return `Bearer ${requiredEnv("INSTANTLY_API_KEY")}`;
}

export function heyreachHeaders(): HeadersInit {
  return {
    "X-API-KEY": requiredEnv("HEYREACH_API_KEY"),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export function supabaseHeaders(): HeadersInit {
  const key = optionalEnv("SUPABASE_SECRET_KEY") ?? requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

//==============================================================================================
