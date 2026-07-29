import axios from "axios";
import { apiClient } from "./client";
import { getSession } from "../store/session";
import type { CatalogModel } from "../types";

interface ModelsResponse {
  data?: unknown;
}

// Retained for legacy rule displays outside the catalog picker.
export function formatTierLabel(
  t: (key: string, values?: Record<string, string | number>) => string,
  group: string,
): string {
  if (group.toLowerCase().startsWith("classify:")) {
    return t("picker.tier.classify", { name: group.slice("classify:".length) });
  }
  const key = "picker.tier." + group;
  const translated = t(key);
  return translated === key ? group : translated;
}

// Retained for credential-mapping metadata outside the catalog picker.
export function readPlanType(entry: Record<string, unknown>): string {
  const idToken = entry.id_token;
  if (idToken && typeof idToken === "object") {
    const token = idToken as Record<string, unknown>;
    const plan = token.plan_type;
    if (typeof plan === "string" && plan.trim()) return plan.trim().toLowerCase();
    const nested = token.claims;
    if (nested && typeof nested === "object") {
      const nestedPlan = (nested as Record<string, unknown>).plan_type;
      if (typeof nestedPlan === "string" && nestedPlan.trim()) return nestedPlan.trim().toLowerCase();
    }
  }
  const tier = entry.tier;
  return typeof tier === "string" ? tier.trim().toLowerCase() : "";
}

// Normalize OpenAI-compatible /v1/models responses into the one global catalog
// used by the picker. Model IDs are the only authorization identity now; the
// provider and group fields remain empty so CPA performs native routing.
export function normalizeCatalog(payload: ModelsResponse | unknown): CatalogModel[] {
  const root = payload as (ModelsResponse & { models?: unknown }) | null;
  const data = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.data)
      ? root.data
      : root?.models;
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const catalog: CatalogModel[] = [];
  for (const entry of data) {
    const model = typeof entry === "string"
      ? entry.trim()
      : typeof entry === "object" && entry !== null
        ? readModelID(entry as Record<string, unknown>)
        : "";
    const dedupeKey = model.toLowerCase();
    if (!model || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    catalog.push({ provider: "", model });
  }
  return catalog.sort((a, b) => a.model.localeCompare(b.model));
}

function readModelID(entry: Record<string, unknown>): string {
  for (const field of ["id", "model", "name"]) {
    const value = entry[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstNativeAPIKey(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const root = payload as Record<string, unknown>;
  const keys = root["api-keys"] ?? root.apiKeys;
  if (!Array.isArray(keys)) return "";
  for (const item of keys) {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (item && typeof item === "object") {
      const entry = item as Record<string, unknown>;
      for (const field of ["api-key", "apiKey", "key", "Key"]) {
        const value = entry[field];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }
  return "";
}

// Fetch the global model list with the first native CPA API key. This is
// intentionally a two-request flow: management supplies the key, then /v1/models
// supplies the only catalog source.
export async function fetchCatalog(): Promise<CatalogModel[]> {
  const c = apiClient();
  const { data: keys } = await c.get<unknown>("/v0/management/api-keys");
  const key = firstNativeAPIKey(keys);
  if (!key) {
    throw new Error("No native API key is configured; add one before loading models.");
  }
  const session = getSession();
  if (!session?.baseUrl) throw new Error("not authenticated");
  // Do not reuse the management client: a native-key 401 must not clear the
  // management session used to configure the picker.
  const { data } = await axios.get<ModelsResponse>(session.baseUrl.replace(/\/$/, "") + "/v1/models", {
    headers: { Authorization: "Bearer " + key },
  });
  return normalizeCatalog(data);
}

// Catalog models are all globally routable, so they intentionally render as one
// group with no provider or tier identity.
export interface CatalogGroup {
  provider: string;
  group?: string;
  models: string[];
}

export function groupByCatalog(catalog: CatalogModel[]): CatalogGroup[] {
  if (catalog.length === 0) return [];
  return [{ provider: "", models: catalog.map((entry) => entry.model) }];
}
