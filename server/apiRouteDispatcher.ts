export type ApiDispatchRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

export type ApiDispatchResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): ApiDispatchResponse;
  json(data: unknown): unknown;
  send(data: Buffer | string): unknown;
};

export type ApiRouteHandler = (
  req: ApiDispatchRequest,
  res: ApiDispatchResponse
) => unknown;

export type ApiRouteDefinition = {
  readonly segments: readonly string[];
  readonly handler: ApiRouteHandler;
};

export function defineApiRoute(
  segments: readonly string[],
  handler: unknown
): ApiRouteDefinition {
  return {
    segments,
    handler: handler as ApiRouteHandler
  };
}

export async function dispatchApiRoutes(
  req: ApiDispatchRequest,
  res: ApiDispatchResponse,
  routes: readonly ApiRouteDefinition[]
): Promise<unknown> {

  res.setHeader("Cache-Control", "no-store");

  const rawPath = req.query?.__route_path ?? req.query?.path;

  const pathSegments: string[] =
    Array.isArray(rawPath)
      ? rawPath
      : typeof rawPath === "string"
        ? rawPath.split("/")
        : [];

  for (const route of routes) {

    if (route.segments.length !== pathSegments.length) {
      continue;
    }

    const params: Record<string, string> = {};
    let matches = true;

    for (let i = 0; i < route.segments.length; i++) {

      const expected = route.segments[i];
      const actual = pathSegments[i];

      if (expected.startsWith(":")) {

        if (!actual) {
          matches = false;
          break;
        }

        params[expected.slice(1)] = actual;

      } else if (expected !== actual) {

        matches = false;
        break;

      }
    }

    if (!matches) continue;

    // Preserve the original request, body, headers, URL and query values.
    // Add verified path parameters without mutating the original request.

    const routedRequest = Object.assign(
      Object.create(req),
      {
        query: {
          ...(req.query ?? {}),
          ...params
        }
      }
    ) as ApiDispatchRequest;

    return await route.handler(routedRequest, res);
  }

  return res.status(404).json({
    success: false,
    error: "API route not found."
  });
}
