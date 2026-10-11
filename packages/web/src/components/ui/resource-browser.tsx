import { type ReactNode, useMemo, useState } from "react";
import { UI } from "../../strings.ts";
import { Button } from "./button.tsx";
import { NavItem } from "./display.tsx";
import { useFormGuard } from "./form-guard.tsx";
import { SearchInput } from "./input.tsx";
import { ListDetailLayout, PageState } from "./page-layout.tsx";

export function ResourceBrowser<T>({
  items,
  id,
  title,
  subtitle,
  icon,
  detail,
  label,
  emptyText,
}: {
  items: T[];
  id: (item: T) => string;
  title: (item: T) => string;
  subtitle?: (item: T) => string;
  icon?: (item: T) => ReactNode;
  detail: (item: T) => ReactNode;
  label: string;
  emptyText: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const guard = useFormGuard();
  const visible = useMemo(
    () =>
      items.filter((item) =>
        `${title(item)} ${subtitle?.(item) ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ),
    [items, query, title, subtitle],
  );
  // Filtering the list does not silently destroy the active editor.
  const active = items.find((item) => id(item) === selected) ?? items[0];
  const pick = async (next: string | null) => {
    if (next === null) {
      setDetailOpen(false);
      return;
    }
    if (active && id(active) === next) {
      setDetailOpen(true);
      return;
    }
    if (await guard.confirmLeave()) {
      setSelected(next);
      setDetailOpen(true);
    }
  };
  return (
    <ListDetailLayout
      label={label}
      selected={detailOpen && !!active}
      className="resource-browser"
      list={
        <>
          <div className="resource-search">
            <SearchInput
              aria-label={label}
              placeholder={UI.searchResources}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {visible.length === 0 ? (
            <PageState kind="empty" title={query ? UI.noSearchResults : emptyText} />
          ) : (
            visible.map((item) => (
              <NavItem
                key={id(item)}
                current={!!active && id(active) === id(item)}
                className="resource-list-item"
                icon={icon?.(item)}
                onClick={() => void pick(id(item))}
              >
                <span className="resource-list-copy">
                  <strong>{title(item)}</strong>
                  {subtitle && <span>{subtitle(item)}</span>}
                </span>
              </NavItem>
            ))
          )}
        </>
      }
      detail={
        active ? (
          <div key={id(active)} className="resource-detail">
            <Button
              className="self-start md:hidden"
              variant="ghost"
              onClick={() => void pick(null)}
            >
              {UI.backToList}
            </Button>
            {detail(active)}
          </div>
        ) : (
          <PageState kind="empty" title={emptyText} />
        )
      }
    />
  );
}
