import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../Icon.tsx";
import { cn } from "./cn.ts";
import { Spinner } from "./spinner.tsx";

/** Shared structural primitives. Business data, navigation and actions stay with the caller. */
export function PageHeader({
  title,
  description,
  leading,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header data-slot="page-header" className={cn("page-header", className)}>
      {leading && <div className="page-header-leading">{leading}</div>}
      <div className="page-header-copy">
        <h2>{title}</h2>
        {description && <div className="page-description">{description}</div>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

export function PageSection({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section {...props} data-slot="page-section" className={cn("page-section", className)}>
      {(title || description || actions) && (
        <div className="page-section-heading">
          <div>
            {title && <h3>{title}</h3>}
            {description && <p className="page-description">{description}</p>}
          </div>
          {actions && <div className="page-section-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function ListDetailLayout({
  list,
  detail,
  selected = false,
  label,
  className,
}: {
  list: ReactNode;
  detail: ReactNode;
  selected?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <section
      data-slot="list-detail"
      data-selected={selected}
      aria-label={label}
      className={cn("list-detail-layout", className)}
    >
      <div className="list-detail-list">{list}</div>
      <div className="list-detail-detail">{detail}</div>
    </section>
  );
}

export function PageState({
  kind,
  title,
  description,
  actions,
  icon,
}: {
  kind: "loading" | "empty" | "error";
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div
      data-slot="page-state"
      data-state={kind}
      role={kind === "error" ? "alert" : "status"}
      aria-busy={kind === "loading" || undefined}
      className="page-state"
    >
      <div className="page-state-symbol">
        {kind === "loading" ? (
          <Spinner />
        ) : (
          <Icon name={icon ?? (kind === "error" ? "circleAlert" : "folder")} size="lg" />
        )}
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {actions && <div className="page-state-actions">{actions}</div>}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-slot="settings-row" className="settings-row">
      <div>
        <div className="settings-row-title">{title}</div>
        {description && <p className="page-description">{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function PageToolbar({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} data-slot="page-toolbar" className={cn("page-toolbar", className)}>
      {children}
    </div>
  );
}

export function ApplicationFrame({
  sidebar,
  collapsed,
  label,
  sidebarLabel,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  sidebar: ReactNode;
  collapsed: boolean;
  label: string;
  sidebarLabel: string;
}) {
  return (
    <div
      {...props}
      data-slot="application-frame"
      data-collapsed={collapsed}
      className={cn("app-shell application-frame", className)}
    >
      {!collapsed && (
        <aside className="app-sidebar" aria-label={sidebarLabel}>
          {sidebar}
        </aside>
      )}
      <main className="app-stage" aria-label={label}>
        {children}
      </main>
    </div>
  );
}
