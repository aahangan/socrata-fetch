# socrata-fetch

[![CI](https://github.com/aahangan/socrata-fetch/actions/workflows/ci.yml/badge.svg)](https://github.com/aahangan/socrata-fetch/actions/workflows/ci.yml)

A tiny, dependency-free TypeScript client for [Socrata](https://dev.socrata.com/) open-data portals: NYC Open Data,
Chicago Data Portal, data.ny.gov, and hundreds of other city, state and federal portals.

It does the things you end up writing yourself once a data job runs unattended:

- **Retries with exponential backoff and jitter** on 429s, 5xx responses, timeouts and network errors (but not on bad queries)
- **Per-request timeouts**
- **Paging** through large result sets with a stable sort order
- **SoQL escaping** for string literals and `in (...)` lists
- **Schema-drift detection**: notice when a column you depend on disappears from a feed
- **Works anywhere `fetch` does**: Node 18+, Bun, Deno, edge runtimes and browsers; pass Next.js cache options straight through

Extracted from the data pipeline behind [RatSignal](https://getratsignal.com), which reads NYC and Chicago restaurant-inspection
data every morning.

## Install

```bash
npm install github:aahangan/socrata-fetch
```

Pin a version with a tag: `npm install github:aahangan/socrata-fetch#v0.1.0`. The package builds itself on install.

## Usage

```ts
import { createClient, quoteList } from "socrata-fetch";

const nyc = createClient({
  domain: "data.cityofnewyork.us",
  appToken: process.env.SOCRATA_APP_TOKEN, // optional, raises your rate limit
});

// Restaurants cited for rats or mice, newest first
const rows = await nyc.query("43nn-pn8j", {
  $select: "dba, zipcode, inspection_date, violation_code",
  $where: `violation_code in (${quoteList(["04K", "04L"])})`,
  $order: "inspection_date DESC",
  $limit: 50,
});
```

### Paging through everything

```ts
// Collect all rows (pages of 1000 by default)
const all = await nyc.queryAll("43nn-pn8j", { $where: "inspection_date > '2026-01-01'" }, { pageSize: 5000 });

// Or stream page by page to keep memory flat
for await (const page of nyc.pages("43nn-pn8j", {}, { pageSize: 5000, maxRows: 100_000 })) {
  await save(page);
}
```

Offset paging is only reliable with a deterministic order, so `pages` and `queryAll` sort by Socrata's row id (`:id`)
unless you pass your own `$order`.

### Typed rows

Socrata returns every value as a string, and omits columns that are null:

```ts
type Inspection = { camis: string; dba?: string; inspection_date?: string };
const rows = await nyc.query<Inspection>("43nn-pn8j", { $limit: 10 });
```

### Errors and retries

```ts
import { SocrataError } from "socrata-fetch";

const client = createClient({
  domain: "data.cityofchicago.org",
  retries: 3,          // extra attempts after the first (default 3)
  timeoutMs: 20_000,   // per attempt (default 20s)
  onRetry: ({ dataset, attempt, delayMs, error }) => console.warn(`retry ${attempt} for ${dataset} in ${delayMs}ms`, error),
});

try {
  await client.query("4ijn-s7e5", { $where: "not valid soql" });
} catch (err) {
  if (err instanceof SocrataError) console.error(err.status, err.message); // 400: not retried
}
```

### Catching schema changes

Portals occasionally rename or drop columns. `missingColumns` flags columns that appear in none of the returned rows:

```ts
import { missingColumns } from "socrata-fetch";

const gone = missingColumns(rows, ["camis", "dba", "zipcode"]);
if (gone.length) alert(`Feed changed: missing ${gone.join(", ")}`);
```

### Caching (Next.js and others)

Anything in `init` is passed to `fetch`, per client or per request:

```ts
const client = createClient({ domain: "data.cityofnewyork.us", init: { next: { revalidate: 3600 } } });
await client.query("43nn-pn8j", { $limit: 10 }, { init: { cache: "no-store" } }); // bypass for this call
```

You can also supply your own `fetch` implementation (for tests, proxies or instrumentation) with `createClient({ fetch })`.

## API

| Export | Description |
|---|---|
| `createClient(options)` | Returns `{ query, pages, queryAll }` bound to one portal domain |
| `client.query(dataset, params?, opts?)` | One request, with retries and timeout |
| `client.pages(dataset, params?, opts?)` | Async generator over pages (`pageSize`, `maxRows`) |
| `client.queryAll(dataset, params?, opts?)` | All matching rows across pages |
| `resourceUrl(domain, dataset, params?)` | The SODA 2.1 JSON URL for a query |
| `soqlString(value)` / `quoteList(values)` | Escape values for SoQL |
| `missingColumns(rows, required)` | Required columns absent from every row |
| `withRetry(fn, opts?)` / `isRetryable(err)` | The retry helper, usable on its own |
| `SocrataError` | Error with the HTTP `status` |

## License

MIT
