import { describe, expect, it } from "vitest";
import { isRetryable, SocrataError, withRetry } from "./retry.js";
import { missingColumns, quoteList, soqlString } from "./soql.js";

describe("soql helpers", () => {
  it("escapes string literals", () => {
    expect(soqlString("O'Brien's")).toBe("'O''Brien''s'");
    expect(quoteList(["11222", "1'1"])).toBe("'11222','1''1'");
  });

  it("detects columns that vanished from a dataset", () => {
    expect(missingColumns([{ a: "1" }, { a: "2", b: "3" }], ["a", "b", "c"])).toEqual(["c"]);
    expect(missingColumns([], ["a"])).toEqual([]);
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("classifies errors", () => {
    expect(isRetryable(new SocrataError(429, ""))).toBe(true);
    expect(isRetryable(new SocrataError(503, ""))).toBe(true);
    expect(isRetryable(new SocrataError(404, ""))).toBe(false);
    expect(isRetryable(new TypeError("network"))).toBe(true);
  });

  it("gives up after the retry budget", async () => {
    let calls = 0;
    const fail = async () => { calls++; throw new SocrataError(500, "down"); };
    await expect(withRetry(fail, { retries: 2, sleep: noSleep })).rejects.toThrow("down");
    expect(calls).toBe(3);
  });

  it("backs off exponentially within the cap", async () => {
    const delays: number[] = [];
    const fail = async () => { throw new Error("x"); };
    await withRetry(fail, { retries: 4, baseMs: 100, maxMs: 300, sleep: noSleep, onRetry: (_, d) => delays.push(d) }).catch(() => {});
    expect(delays).toHaveLength(4);
    expect(delays[0]).toBeGreaterThanOrEqual(75);
    expect(delays[0]).toBeLessThanOrEqual(125);
    expect(Math.max(...delays)).toBeLessThanOrEqual(375);
  });
});
