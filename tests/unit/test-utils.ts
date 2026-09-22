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
 * What a fake should answer for /notes. The endpoint is now read as well as written - the duplicate check in
 * lib/interested.ts lists a person's notes before writing one - and the two need different shapes: a listing
 * is an array, a create is the note. A fake that answers the listing with a non-array makes recentlyNoted
 * fail open, which is correct behaviour but not what a test asserting on the workflow means to exercise.
 */
export function notesResponse(init: RequestInit | undefined): Response {
  return (init?.method ?? "GET") === "GET" ? jsonResponse({ data: [] }) : jsonResponse({ data: {} });
}

/** Every note actually written. Excludes the listing GETs the duplicate check makes. */
export function noteWrites(calls: readonly FetchCall[]): readonly FetchCall[] {
  return calls.filter((call) => call.input.includes("/notes") && call.init?.method === "POST");
}

/**
 * The note POSTs a run made, excluding the run transcript (lib/run-log.ts), which adds one of its own to every
 * Person an interested run touches. Assertions about what a workflow noted mean its history notes, so they
 * count these rather than every note on the wire.
 */
export function historyNoteCalls(calls: readonly FetchCall[]): readonly FetchCall[] {
  return noteWrites(calls).filter((call) => {
    const body = JSON.parse(String(call.init?.body)) as { data?: { title?: unknown } };
    return typeof body.data?.title !== "string" || !body.data.title.startsWith("run logs");
  });
}
