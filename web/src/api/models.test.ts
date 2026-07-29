import { afterEach, describe, expect, it, vi } from "vitest";

const { get, nativeGet } = vi.hoisted(() => ({
  get: vi.fn(),
  nativeGet: vi.fn(),
}));
vi.mock("axios", () => ({ default: { get: nativeGet } }));
vi.mock("./client", () => ({
  apiClient: () => ({ get }),
}));
vi.mock("../store/session", () => ({
  getSession: () => ({ baseUrl: "http://cpa.example/" }),
}));

import { fetchCatalog, formatTierLabel, groupByCatalog, normalizeCatalog } from "./models";

afterEach(() => {
  get.mockReset();
  nativeGet.mockReset();
});

describe("normalizeCatalog", () => {
  it("accepts common model shapes and de-duplicates IDs case-insensitively", () => {
    expect(normalizeCatalog({
      data: [
        { id: "GPT-5" },
        { model: "gpt-5" },
        { name: "claude-sonnet-4" },
        "gemini-2.5-pro",
        { id: "" },
      ],
    })).toEqual([
      { provider: "", model: "claude-sonnet-4" },
      { provider: "", model: "gemini-2.5-pro" },
      { provider: "", model: "GPT-5" },
    ]);
  });

  it("accepts root arrays and models wrappers", () => {
    expect(normalizeCatalog(["gpt-5"])).toEqual([{ provider: "", model: "gpt-5" }]);
    expect(normalizeCatalog({ models: [{ id: "claude-sonnet-4" }] })).toEqual([
      { provider: "", model: "claude-sonnet-4" },
    ]);
  });

  it("groups all models together", () => {
    expect(groupByCatalog([
      { provider: "", model: "claude-sonnet-4" },
      { provider: "", model: "gpt-5" },
    ])).toEqual([{ provider: "", models: ["claude-sonnet-4", "gpt-5"] }]);
  });

  it("keeps classify group labels compatible with legacy displays", () => {
    const t = (key: string, values?: Record<string, string | number>) =>
      key === "picker.tier.classify" ? `Custom · ${values?.name}` : key;
    expect(formatTierLabel(t, "classify:vip")).toBe("Custom · vip");
  });
});

describe("fetchCatalog", () => {
  it("gets the first native key then makes one independent /v1/models request", async () => {
    get.mockResolvedValueOnce({ data: { apiKeys: [{ apiKey: "native-first" }, "native-second"] } });
    nativeGet.mockResolvedValueOnce({ data: { data: [{ id: "gpt-5" }] } });

    await expect(fetchCatalog()).resolves.toEqual([{ provider: "", model: "gpt-5" }]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/v0/management/api-keys");
    expect(nativeGet).toHaveBeenCalledTimes(1);
    expect(nativeGet).toHaveBeenCalledWith("http://cpa.example/v1/models", {
      headers: { Authorization: "Bearer native-first" },
    });
  });

  it("reports a clear error and does not request models without a native key", async () => {
    get.mockResolvedValueOnce({ data: { "api-keys": [] } });

    await expect(fetchCatalog()).rejects.toThrow("No native API key is configured");
    expect(get).toHaveBeenCalledTimes(1);
    expect(nativeGet).not.toHaveBeenCalled();
  });
});
