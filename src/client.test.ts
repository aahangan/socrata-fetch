import { describe, expect, it, vi } from "vitest";
import { createClient, resourceUrl } from "./client.js";
import { SocrataError } from "./retry.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("resourceUrl", () => {
  it("builds an encoded SODA endpoint URL", () => {
    expect(resourceUrl("data.example.org", "abcd-1234", { $limit: 5, $where: "a = 'b'" })).toBe(
      "https://data.example.org/resource/abcd-1234.json?%24limit=5&%24where=a+%3D+%27b%27",
    );
    expect(resourceUrl("data.example.org", "abcd-1234")).toBe("https://data.example.org/resource/abcd-1234.json");
  });
});

describe("query", () => {
  it("returns rows and sends the app token", async () => {
    const fetch = vi.fn().mockResolvedValue(json([{ id: "1" }]));
    const client = createClient({ domain: "data.example.org", appToken: "tok", fetch });
    await expect(client.query("abcd-1234", { $limit: 1 })).resolves.toEqual([{ id: "1" }]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://data.example.org/resource/abcd-1234.json?%24limit=1");
    expect(new Headers(init.headers).get("X-App-Token")).toBe("tok");
  });

  it("retries 5xx and 429, reporting each retry", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(json([{ id: "1" }]));
    const onRetry = vi.fn();
    const client = createClient({ domain: "d", fetch, onRetry });
    vi.useFakeTimers();
    const p = client.query("x", {}, { retries: 2 });
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await expect(p).resolves.toEqual([{ id: "1" }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ dataset: "x", attempt: 1 });
  });

  it("does not retry a bad request", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("bad query", { status: 400 }));
    const client = createClient({ domain: "d", fetch });
    const err = await client.query("x").catch((e) => e);
    expect(err).toBeInstanceOf(SocrataError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("bad query");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-array body", async () => {
    const client = createClient({ domain: "d", fetch: vi.fn().mockResolvedValue(json({ error: true })), retries: 0 });
    await expect(client.query("x")).rejects.toThrow(/non-array/);
  });

  it("merges client and per-request fetch init", async () => {
    const fetch = vi.fn().mockResolvedValue(json([]));
    const client = createClient({ domain: "d", fetch, init: { cache: "force-cache", next: { revalidate: 60 } } });
    await client.query("x", {}, { init: { cache: "no-store" } });
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: "no-store", next: { revalidate: 60 } });
  });
});

describe("paging", () => {
  const table = Array.from({ length: 25 }, (_, i) => ({ id: String(i) }));
  const pagedFetch = () =>
    vi.fn(async (url: string | URL | Request) => {
      const q = new URL(String(url)).searchParams;
      const offset = Number(q.get("$offset")), limit = Number(q.get("$limit"));
      return json(table.slice(offset, offset + limit));
    });

  it("collects every row with a stable order", async () => {
    const fetch = pagedFetch();
    const rows = await createClient({ domain: "d", fetch }).queryAll("x", {}, { pageSize: 10 });
    expect(rows).toHaveLength(25);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("$order")).toBe(":id");
  });

  it("respects maxRows and a caller-provided order", async () => {
    const fetch = pagedFetch();
    const rows = await createClient({ domain: "d", fetch }).queryAll("x", { $order: "date DESC" }, { pageSize: 10, maxRows: 15 });
    expect(rows.map((r) => r.id)).toEqual(table.slice(0, 15).map((r) => r.id));
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("$limit")).toBe("5");
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("$order")).toBe("date DESC");
  });

  it("yields pages lazily", async () => {
    const pages = [];
    for await (const page of createClient({ domain: "d", fetch: pagedFetch() }).pages("x", {}, { pageSize: 20 })) pages.push(page.length);
    expect(pages).toEqual([20, 5]);
  });
});
