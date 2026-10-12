import { SocrataError, withRetry } from "./retry.js";

/** Socrata returns every column as a string (or omits it when null). */
export type Row = Record<string, string | undefined>;

/** SoQL parameters such as `$select`, `$where`, `$order`, `$limit`, plus simple column filters. */
export type SoqlParams = Record<string, string | number>;

export type RequestOptions = {
  /** Abort a single attempt after this many ms. Default 20000. */
  timeoutMs?: number;
  /** Extra attempts after the first for 429s, 5xx and network errors. Default 3. */
  retries?: number;
  /** Merged into every `fetch` call, e.g. `{ cache: "no-store" }` or Next.js `{ next: { revalidate: 3600 } }`. */
  init?: RequestInit & Record<string, unknown>;
};

export type ClientOptions = RequestOptions & {
  /** Portal host, e.g. "data.cityofnewyork.us". */
  domain: string;
  /** Socrata app token; raises your rate limit. Sent as X-App-Token. */
  appToken?: string;
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Called before each retry; handy for logging. */
  onRetry?: (info: { dataset: string; attempt: number; delayMs: number; error: unknown }) => void;
};

export type PageOptions = RequestOptions & {
  /** Rows per request. Default 1000 (the SODA 2.1 page maximum is 50000). */
  pageSize?: number;
  /** Stop after this many rows in total. */
  maxRows?: number;
};

/** URL of a dataset's SODA 2.1 JSON endpoint with the given query parameters. */
export function resourceUrl(domain: string, dataset: string, params: SoqlParams = {}): string {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const q = qs.toString();
  return `https://${domain}/resource/${dataset}.json${q ? `?${q}` : ""}`;
}

export type SocrataClient = {
  /** One request: returns the rows for these parameters, retrying transient failures. */
  query<T extends Row = Row>(dataset: string, params?: SoqlParams, opts?: RequestOptions): Promise<T[]>;
  /** Pages through every matching row with `$limit`/`$offset`, yielding one page at a time. */
  pages<T extends Row = Row>(dataset: string, params?: SoqlParams, opts?: PageOptions): AsyncGenerator<T[]>;
  /** Collects every matching row across pages. */
  queryAll<T extends Row = Row>(dataset: string, params?: SoqlParams, opts?: PageOptions): Promise<T[]>;
};

export function createClient(options: ClientOptions): SocrataClient {
  const { domain, appToken, onRetry } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!domain) throw new TypeError("createClient: `domain` is required");
  if (!doFetch) throw new TypeError("createClient: no fetch implementation available");

  async function query<T extends Row = Row>(dataset: string, params: SoqlParams = {}, opts: RequestOptions = {}): Promise<T[]> {
    const url = resourceUrl(domain, dataset, params);
    const init = { ...options.init, ...opts.init };
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (appToken) headers.set("X-App-Token", appToken);
    const timeoutMs = opts.timeoutMs ?? options.timeoutMs ?? 20_000;

    return withRetry(
      async () => {
        const res = await doFetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new SocrataError(res.status, `${domain}/${dataset} returned ${res.status}: ${text.slice(0, 200)}`);
        }
        const body: unknown = await res.json();
        if (!Array.isArray(body)) throw new SocrataError(502, `${domain}/${dataset} returned a non-array body`);
        return body as T[];
      },
      {
        retries: opts.retries ?? options.retries ?? 3,
        onRetry: onRetry && ((attempt, delayMs, error) => onRetry({ dataset, attempt, delayMs, error })),
      },
    );
  }

  async function* pages<T extends Row = Row>(dataset: string, params: SoqlParams = {}, opts: PageOptions = {}): AsyncGenerator<T[]> {
    const pageSize = opts.pageSize ?? 1000;
    const maxRows = opts.maxRows ?? Infinity;
    // Offset paging is only stable with a deterministic order; ":id" is Socrata's row id.
    const base = { $order: ":id", ...params };
    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const limit = Math.min(pageSize, maxRows - offset);
      const page = await query<T>(dataset, { ...base, $limit: limit, $offset: offset }, opts);
      if (page.length) yield page;
      if (page.length < limit) return;
    }
  }

  async function queryAll<T extends Row = Row>(dataset: string, params: SoqlParams = {}, opts: PageOptions = {}): Promise<T[]> {
    const rows: T[] = [];
    for await (const page of pages<T>(dataset, params, opts)) rows.push(...page);
    return rows;
  }

  return { query, pages, queryAll };
}
