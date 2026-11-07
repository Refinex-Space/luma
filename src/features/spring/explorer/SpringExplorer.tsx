/**
 * The Spring tool window (IDEA's Spring tool window, Beans): the application context's beans
 * by stereotype, filtered by the view options; below, the selected bean's documentation,
 * dependencies and its neighbourhood in the dependency graph.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useTx } from "@/platform/i18n";
import type { SpringBeanDetail, SpringBeanInfo } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  ProgressBar,
  SearchField,
  Select,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  Tabs,
  Tree,
  showContextMenu,
  type TreeHandle,
} from "@/ui";
import { BeanGraph } from "./BeanGraph";
import { BEAN_ICON, beanTone, groupBeans, nodeKey, type ExplorerNode, EDGE_LABELS } from "./model";
import { openBean, openGraph } from "./open";
import {
  refreshExplorer,
  selectBean,
  selectContext,
  setExplorerFilter,
  useSpringExplorer,
  watchExplorer,
} from "./store";
import styles from "./SpringExplorer.module.css";

export function SpringHeaderActions() {
  const contextId = useSpringExplorer((s) => s.contextId);
  const context = useSpringExplorer((s) => s.contexts.find((c) => c.id === s.contextId));
  return (
    <>
      <IconButton
        icon="md-diagram"
        size="small"
        title="Show Bean Dependencies Diagram"
        disabled={!context}
        onClick={() => openGraph({ context: contextId, roots: [], depth: 0, title: context?.label ?? "Spring" })}
      />
      <IconButton icon="refresh" size="small" title="Refresh" onClick={() => void refreshExplorer()} />
    </>
  );
}

function BeanRow({ bean }: { bean: SpringBeanInfo }) {
  return (
    <span className={clsx(styles.row, styles[beanTone(bean)], bean.presence !== "certain" && styles.uncertain)}>
      <Icon name={BEAN_ICON} size={16} className={styles.icon} />
      <span className={styles.name}>{bean.name}</span>
      {bean.primary && (
        <span className={styles.mark} title="@Primary">
          ★
        </span>
      )}
      {bean.typeName !== bean.name && <span className={styles.detail}>{bean.typeName}</span>}
    </span>
  );
}

export function SpringExplorer() {
  const tx = useTx();
  const { contexts, contextId, beans, loading, loaded, error, options, filter, selected, reveal } = useSpringExplorer();
  useEffect(() => watchExplorer(), []);
  const groups = useMemo(() => groupBeans(beans, options, filter), [beans, options, filter]);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  // Groups open by default; a filter opens every group it leaves.
  const effective = useMemo(
    () => (filter || !expanded ? new Set(groups.map((g) => nodeKey(g))) : expanded),
    [filter, expanded, groups],
  );
  const tree = useRef<TreeHandle>(null);
  useEffect(() => {
    if (!reveal || !selected) return;
    const group = groups.find((g) => g.beans.some((b) => b.bean.id === selected));
    if (group && !effective.has(nodeKey(group))) setExpanded(new Set([...effective, nodeKey(group)]));
    requestAnimationFrame(() => tree.current?.reveal(`bean:${selected}`));
    // Only when asked to reveal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const contextMenu = (node: ExplorerNode | null, _sel: Set<string>, e: React.MouseEvent) => {
    if (!node || node.kind !== "bean") return;
    const b = node.bean;
    showContextMenu(e, [
      { label: "Jump to Source", icon: "external-link", run: () => void openBean(b) },
      {
        label: "Show Bean Dependencies Diagram",
        icon: "md-diagram",
        run: () => openGraph({ context: contextId, roots: [b.id], depth: 1, title: b.name }),
      },
      { kind: "separator" },
      { label: "Copy Bean Name", icon: "copy", run: () => void navigator.clipboard?.writeText(b.name) },
    ]);
  };

  if (loaded && !contexts.length && !beans.length) {
    return (
      <div className={styles.view}>
        <EmptyState title={error ? tx`Spring model unavailable: ${error}` : "No Spring beans found"} />
      </div>
    );
  }

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        {contexts.length > 1 && (
          <Select
            className={styles.context}
            variant="ghost"
            aria-label={tx("Application context")}
            value={contextId}
            onChange={selectContext}
            options={contexts.map((c) => ({
              value: c.id,
              label: c.label,
              icon: c.kind === "boot" ? "spring-boot" : "spring",
              detail: [c.module, c.test ? tx("test") : null].filter(Boolean).join(" · ") || undefined,
            }))}
          />
        )}
        <SearchField
          className={styles.filter}
          variant="bare"
          value={filter}
          onChange={setExplorerFilter}
          aria-label={tx("Filter beans")}
          placeholder={tx("Filter beans")}
        />
      </div>
      {loading && !loaded && <ProgressBar className={styles.progress} aria-label={tx("Loading beans")} />}
      <div className={styles.body}>
        <SplitGroup orientation="vertical" id="spring-explorer-split">
          <SplitPanel id="beans" minSize={120} className={styles.panel}>
            <Tree<ExplorerNode>
              aria-label={tx("Spring beans")}
              handleRef={tree}
              roots={groups}
              getKey={nodeKey}
              getLabel={(n) => (n.kind === "group" ? n.label : n.bean.name)}
              getChildren={(n) => (n.kind === "group" ? n.beans : undefined)}
              isExpandable={(n) => n.kind === "group"}
              expanded={effective}
              onExpandedChange={(next) => setExpanded(next)}
              selected={selected ? new Set([`bean:${selected}`]) : new Set()}
              onSelectionChange={(_keys, lead) => selectBean(lead?.kind === "bean" ? lead.bean.id : null)}
              onActivate={(n) => {
                if (n.kind === "bean") void openBean(n.bean);
              }}
              onContextMenu={contextMenu}
              renderNode={(n) =>
                n.kind === "group" ? (
                  <span className={styles.row}>
                    <Icon name={n.icon} size={16} className={styles.icon} />
                    <span className={styles.name}>
                      <T>{n.label}</T>
                    </span>
                    <span className={styles.count}>{n.beans.length}</span>
                  </span>
                ) : (
                  <BeanRow bean={n.bean} />
                )
              }
              multiSelect={false}
              empty={<EmptyState title={filter ? "Nothing to show" : "No Spring beans found"} />}
            />
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="detail" minSize={120} defaultSize="40%" className={styles.panel}>
            <BeanDetailPane />
          </SplitPanel>
        </SplitGroup>
      </div>
    </div>
  );
}

type DetailTab = "documentation" | "dependencies" | "graph";

function BeanDetailPane() {
  const tx = useTx();
  const detail = useSpringExplorer((s) => s.detail);
  const beans = useSpringExplorer((s) => s.beans);
  const contextId = useSpringExplorer((s) => s.contextId);
  const [tab, setTab] = useState<DetailTab>("documentation");
  if (!detail) return <EmptyState title="Select a bean to see its details" />;
  return (
    <div className={styles.detailPane}>
      <Tabs
        variant="compact"
        className={styles.detailTabs}
        aria-label={tx("Bean details")}
        activeId={tab}
        onSelect={(id) => setTab(id as DetailTab)}
        items={[
          { id: "documentation", label: tx("Documentation") },
          { id: "dependencies", label: tx("Dependencies") },
          { id: "graph", label: tx("Bean Graph") },
        ]}
      />
      <div className={styles.detailBody}>
        {tab === "documentation" && <Documentation detail={detail} />}
        {tab === "dependencies" && <Dependencies detail={detail} beans={beans} />}
        {tab === "graph" && <BeanGraph context={contextId} roots={[detail.bean.id]} depth={1} compact />}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className={styles.key}>
        <T>{label}</T>
      </dt>
      <dd className={styles.value}>{children}</dd>
    </>
  );
}

function Documentation({ detail }: { detail: SpringBeanDetail }) {
  const tx = useTx();
  const b = detail.bean;
  const flags = [
    b.primary ? "@Primary" : null,
    b.fallback ? "@Fallback" : null,
    b.lazy ? "@Lazy" : null,
    b.presence === "conditional" ? tx("conditional") : b.presence === "inactive" ? tx("inactive profile") : null,
  ].filter(Boolean);
  return (
    <div className={styles.doc}>
      <div className={styles.docTitle}>
        <Icon name={BEAN_ICON} size={16} />
        <span className={styles.docName}>{b.name}</span>
        <span className={styles.detail}>{b.typeFqn}</span>
      </div>
      <dl className={styles.fields}>
        <Field label="Declaration">
          <button type="button" className={styles.link} onClick={() => void openBean(b)}>
            {b.declaration}
          </button>
          {b.module && <span className={styles.detail}> · {b.module}</span>}
        </Field>
        {b.aliases.length > 0 && <Field label="Aliases">{b.aliases.join(", ")}</Field>}
        <Field label="Scope">{b.scope ?? "singleton"}</Field>
        {flags.length > 0 && <Field label="Flags">{flags.join(", ")}</Field>}
        {b.qualifiers.length > 0 && <Field label="Qualifiers">{b.qualifiers.join(", ")}</Field>}
        {b.profiles.length > 0 && <Field label="Profiles">{b.profiles.join(", ")}</Field>}
        {b.conditions.length > 0 && <Field label="Conditions">{b.conditions.map((c) => `@${c}`).join(", ")}</Field>}
      </dl>
    </div>
  );
}

function Dependencies({ detail, beans }: { detail: SpringBeanDetail; beans: SpringBeanInfo[] }) {
  const tx = useTx();
  const byId = useMemo(() => new Map(beans.map((b) => [b.id, b])), [beans]);
  const link = (id: string) => {
    const b = byId.get(id);
    return (
      <button key={id} type="button" className={styles.link} onClick={() => (b ? void openBean(b) : selectBean(id))}>
        {b?.name ?? id.slice(id.lastIndexOf("/") + 1)}
      </button>
    );
  };
  return (
    <div className={styles.doc}>
      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>
          <T>Depends on</T>
        </h4>
        {detail.dependencies.length ? (
          <ul className={styles.list}>
            {detail.dependencies.map((d, i) => (
              <li key={i} className={styles.dep}>
                <span className={styles.via}>{tx(EDGE_LABELS[d.kind])}</span>
                <span className={styles.detail}>{d.label}</span>
                <span className={styles.arrow}>→</span>
                {d.beans.length ? (
                  d.beans.map((id, j) => (
                    <span key={id}>
                      {j > 0 && ", "}
                      {link(id)}
                    </span>
                  ))
                ) : (
                  <span className={styles.missing}>
                    <T>no bean</T>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.none}>—</p>
        )}
      </section>
      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>
          <T>Injected into</T>
        </h4>
        {detail.dependents.length ? (
          <ul className={styles.list}>
            {detail.dependents.map((d, i) => (
              <li key={i} className={styles.dep}>
                {link(d.bean)}
                <span className={styles.via}>{tx(EDGE_LABELS[d.kind])}</span>
                <span className={styles.detail}>{d.label}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.none}>—</p>
        )}
      </section>
    </div>
  );
}
