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

/**
 * The note POSTs a run made, excluding the run transcript (lib/run-log.ts), which adds one of its own to every
 * Person an interested run touches. Assertions about what a workflow noted mean its history notes, so they
 * count these rather than every note on the wire.
 */
export function historyNoteCalls(calls: readonly FetchCall[]): readonly FetchCall[] {
  return calls.filter((call) => {
    if (!call.input.includes("/notes")) return false;
    const body = JSON.parse(String(call.init?.body)) as { data?: { title?: unknown } };
    return typeof body.data?.title !== "string" || !body.data.title.startsWith("run logs");
  });
}
