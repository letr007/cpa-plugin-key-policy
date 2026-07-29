import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

// Mark the test env so React's act() warning is silenced under jsdom.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot } from "react-dom/client";
import type { ModelRule } from "../types";

// Regression: on mount, before the model catalog finishes loading, ModelPicker
// must NOT call onChange with an empty rules array. Doing so wipes pre-filled
// parent state (e.g. per-alias pricing on the edit page). We mock fetchCatalog
// to resolve on a microtask so we can observe the empty-groups phase.

interface FakeGroup {
  provider: string;
  group?: string;
  models: string[];
}

vi.mock("../api/models", () => ({
  fetchCatalog: vi.fn(),
  formatTierLabel: (_t: (k: string) => string, group: string) => group,
  groupByCatalog: (catalog: { provider: string; model: string; group?: string }[]): FakeGroup[] => {
    const map = new Map<string, FakeGroup>();
    for (const c of catalog) {
      const g = (c.group ?? "").toLowerCase();
      const key = c.provider + "|" + g;
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { provider: c.provider, models: [] };
        if (g) bucket.group = g;
        map.set(key, bucket);
      }
      bucket.models.push(c.model);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      return (a.group ?? "").localeCompare(b.group ?? "");
    });
  },
}));

// Import AFTER the mock so ModelPicker picks up the mocked fetchCatalog.
import ModelPicker from "./ModelPicker";
import { fetchCatalog } from "../api/models";

const initial: ModelRule[] = [
  {
    alias: "grok-composer-2.5-fast",
    provider: "xai",
    target_model: "grok-composer-2.5-fast",
    input_price_per_million: 1,
    output_price_per_million: 2,
  },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ModelPicker empty-catalog guard", () => {
  it("does not emit before the catalog loads (preserves edit prefill)", async () => {
    let resolveCatalog: (v: { provider: string; model: string }[]) => void = () => {};
    (fetchCatalog as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((res) => (resolveCatalog = res)),
    );

    const calls: ModelRule[][] = [];
    const onChange = (rules: ModelRule[]) => calls.push([...rules]);

    await act(async () => {
      root = createRoot(container);
      root.render(<ModelPicker initial={initial} onChange={onChange} />);
      await tick();
    });

    // While the catalog is still loading (groups empty), NO emit happened.
    expect(calls.length).toBe(0);

    await act(async () => {
      resolveCatalog([{ provider: "xai", model: "grok-composer-2.5-fast" }]);
      await tick();
    });

    // After load, the existing routed rule is preserved verbatim, including
    // pricing fields; only newly selected global rows become providerless.
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(initial);
  });
});

describe("ModelPicker global catalog", () => {
  it("emits a providerless exact-model rule for a selected global model", async () => {
    let resolveCatalog: (v: { provider: string; model: string; group?: string }[]) => void = () => {};
    (fetchCatalog as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((res) => (resolveCatalog = res)),
    );

    const calls: ModelRule[][] = [];
    const onChange = (rules: ModelRule[]) => calls.push([...rules]);

    await act(async () => {
      root = createRoot(container);
      root.render(<ModelPicker initial={[]} onChange={onChange} />);
      await tick();
    });

    await act(async () => {
      resolveCatalog([{ provider: "", model: "gpt-5-codex" }]);
      await tick();
    });

    // Catalog load emits the empty selection first (no rows preselected).
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([]);

    const checkboxes = Array.from(
      container.querySelectorAll("input[type=checkbox]"),
    ) as HTMLInputElement[];
    expect(checkboxes.length).toBe(1);
    await act(async () => {
      checkboxes[0].click();
      await tick();
    });

    const last = calls[calls.length - 1];
    expect(last).toEqual([
      { alias: "gpt-5-codex", provider: "", target_model: "gpt-5-codex" },
    ]);
  });
});

describe("ModelPicker legacy rule preservation", () => {
  it("keeps a routed legacy rule the global catalog no longer covers", async () => {
    // A routed rule may no longer be listed by the global native catalog. It
    // must survive picker emission until a user explicitly removes it.
    const legacyInitial: ModelRule[] = [
      { alias: "gpt-5-codex", provider: "codex", target_model: "gpt-5-codex" },
    ];
    let resolveCatalog: (v: { provider: string; model: string; group?: string }[]) => void = () => {};
    (fetchCatalog as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((res) => (resolveCatalog = res)),
    );

    const calls: ModelRule[][] = [];
    const onChange = (rules: ModelRule[]) => calls.push([...rules]);

    await act(async () => {
      root = createRoot(container);
      root.render(<ModelPicker initial={legacyInitial} onChange={onChange} />);
      await tick();
    });

    await act(async () => {
      // Catalog has codex ONLY under tiers — no plain "codex" group.
      resolveCatalog([
        { provider: "codex", group: "free", model: "gpt-5-codex" },
        { provider: "codex", group: "team", model: "gpt-5-codex" },
      ]);
      await tick();
    });

    // The legacy group-less row survives the emit (not dropped).
    const last = calls[calls.length - 1];
    expect(last).toContainEqual({
      alias: "gpt-5-codex",
      provider: "codex",
      target_model: "gpt-5-codex",
    });
  });

  it("keeps missing providerless rules and multiple aliases for one target", async () => {
    const legacyInitial: ModelRule[] = [
      { alias: "gpt-5", provider: "", target_model: "gpt-5", per_call_usd: 1 },
      { alias: "fast", provider: "codex", target_model: "gpt-5-codex" },
      { alias: "backup", provider: "codex", target_model: "gpt-5-codex" },
    ];
    let resolveCatalog: (v: { provider: string; model: string; group?: string }[]) => void = () => {};
    (fetchCatalog as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((res) => (resolveCatalog = res)),
    );

    const calls: ModelRule[][] = [];
    await act(async () => {
      root = createRoot(container);
      root.render(<ModelPicker initial={legacyInitial} onChange={(rules) => calls.push([...rules])} />);
      await tick();
    });
    await act(async () => {
      resolveCatalog([{ provider: "", model: "other-model" }]);
      await tick();
    });

    const last = calls[calls.length - 1];
    expect(last).toEqual(expect.arrayContaining(legacyInitial));
    expect(last.filter((rule) => rule.target_model === "gpt-5-codex")).toHaveLength(2);
  });
});
