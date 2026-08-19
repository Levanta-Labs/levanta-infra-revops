export interface FetchCall {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

export function installFetchMock(
  handler: (input: string, init: RequestInit | undefined, callIndex: number) => Response | Promise<Response>,
): { readonly calls: FetchCall[]; restore(): void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ input: url, init });
    return handler(url, init, calls.length - 1);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
