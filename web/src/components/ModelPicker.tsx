import { useEffect, useMemo, useState } from "react";
import { fetchCatalog, groupByCatalog } from "../api/models";
import type { CatalogGroup } from "../api/models";
import type { ModelRule } from "../types";
import { useT } from "../i18n";

interface Props {
  // currently bound rules (for edit mode preselection)
  initial?: ModelRule[];
  // called whenever the selection changes
  onChange: (rules: ModelRule[]) => void;
}

// Multi-select picker over CPA's global native model list. New selections use
// model-name-only rules so CPA's native routing remains in control.

export default function ModelPicker({ initial, onChange }: Props) {
  const t = useT();
  const [groups, setGroups] = useState<CatalogGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [query, setQuery] = useState("");

  // Selection key: "provider|group|model" (all lowercased). New catalog rows
  // have empty provider and group; non-empty legacy keys remain preservable.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const r of initial ?? []) {
      const g = (r.group ?? "").toLowerCase();
      s.add(r.provider.toLowerCase() + "|" + g + "|" + r.target_model.toLowerCase());
    }
    return s;
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const cat = await fetchCatalog();
        if (!alive) return;
        setGroups(groupByCatalog(cat));
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message || t("picker.loadFailed"));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const initialBySelectionKey = useMemo(() => {
    const byKey = new Map<string, ModelRule[]>();
    for (const rule of initial ?? []) {
      const group = (rule.group ?? "").toLowerCase();
      const key = rule.provider.toLowerCase() + "|" + group + "|" + rule.target_model.toLowerCase();
      byKey.set(key, [...(byKey.get(key) ?? []), rule]);
    }
    return byKey;
  }, []);

  // emit ModelRule[] whenever selection (or available groups) change.
  // Guard: do NOT emit before the catalog has loaded (groups is empty). On
  // mount, groups=[] would otherwise emit rules=[] and wipe any pre-filled
  // state the parent derived from `initial` (e.g. per-alias pricing on the
  // edit page). Selection can only map to real rules once groups exist, and
  // the user can't toggle anything before the catalog renders, so skipping
  // the empty-groups emit is safe and preserves edit-mode prefill.
  useEffect(() => {
    if (groups.length === 0) return;
    // Map every catalog (provider, group, model) that is currently selected.
    const covered = new Set<string>();
    const rules: ModelRule[] = [];
    for (const g of groups) {
      const gkey = (g.group ?? "").toLowerCase();
      for (const m of g.models) {
        const key = g.provider + "|" + gkey + "|" + m.toLowerCase();
        covered.add(key);
        if (selected.has(key)) {
          const originals = initialBySelectionKey.get(key);
          rules.push(...(originals ?? [{ alias: m, provider: "", target_model: m }]));
        }
      }
    }
    // Preserve legacy routed rules that are absent from the global model list
    // so editing a key never silently removes an existing authorization.
    for (const key of selected) {
      if (covered.has(key)) continue;
      const [provider, group, ...rest] = key.split("|");
      const model = rest.join("|");
      if (!model) continue;
      const originals = initialBySelectionKey.get(key);
      if (originals) {
        rules.push(...originals);
        continue;
      }
      if (!provider) continue;
      const rule: ModelRule = { alias: model, provider, target_model: model };
      if (group) rule.group = group;
      rules.push(rule);
    }
    onChange(rules);
  }, [selected, groups, onChange, initialBySelectionKey]);

  const filtered = useMemo(() => {
    if (!query.trim()) return groups;
    const q = query.trim().toLowerCase();
    return groups
      .map((g) => ({
        provider: g.provider,
        group: g.group,
        models: g.models.filter(
          (m) => m.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.models.length > 0);
  }, [groups, query]);

  const keyOf = (g: CatalogGroup, model: string) =>
    g.provider + "|" + (g.group ?? "").toLowerCase() + "|" + model.toLowerCase();

  const toggle = (g: CatalogGroup, model: string) => {
    const key = keyOf(g, model);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = (g: CatalogGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of g.models) next.add(keyOf(g, m));
      return next;
    });
  };

  const clearAll = (g: CatalogGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of g.models) next.delete(keyOf(g, m));
      return next;
    });
  };

  if (loading) return <div className="muted">{t("picker.loading")}</div>;
  if (error) return <div className="error">{error}</div>;
  if (groups.length === 0)
    return <div className="muted">{t("picker.empty")}</div>;

  return (
    <div>
      <input
        className="input"
        placeholder={t("picker.searchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 12 }}
      />
      <div className="muted" style={{ marginBottom: 8 }}>
        {t("picker.selected", { count: selected.size })}
      </div>
      {filtered.map((g) => {
        const head = g.provider || t("picker.title");
        const allSelected = g.models.every((m) => selected.has(keyOf(g, m)));
        return (
          <div className="picker-group" key={g.provider + "|" + (g.group ?? "")}>
            <div className="pg-head">
              <span>{head}</span>
              <span className="pg-actions">
                <button type="button" className="btn sm" onClick={() => (allSelected ? clearAll(g) : selectAll(g))}>
                  {allSelected ? t("picker.clearAll") : t("picker.selectAll")}
                </button>
              </span>
            </div>
            <div className="pg-models">
              {g.models.map((m) => {
                const key = keyOf(g, m);
                const active = selected.has(key);
                return (
                  <label key={key} className={active ? "active" : ""}>
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggle(g, m)}
                    />
                    {m}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
