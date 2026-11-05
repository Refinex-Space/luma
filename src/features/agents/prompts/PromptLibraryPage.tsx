/**
 * Settings › AI › Prompt Library: the groups and their prompts on the left, the selected one on
 * the right. A prompt is a template with `$VARIABLES` (highlighted; the chips under it insert
 * the ones its action fills); built-in ones can be edited and reset, one's own also renamed,
 * given a `/command`, moved and removed. Edits are saved as they are made, like the live
 * templates.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import type { AgentConfigChoice, AgentProvider } from "@/bindings";
import { useSettingsDialog } from "@/features/settings/model/staging";
import { confirm } from "@/workbench/messages";
import { call, commands, isTauri } from "@/platform/ipc";
import { tx, useTx } from "@/platform/i18n";
import { Button, Icon, IconButton, Input, Menu, Select, T, Tree, tooltipAttrs, type MenuItem } from "@/ui";
import {
  CHAT_VARS,
  VARIABLES,
  builtinPrompt,
  variableTokens,
  type Prompt,
  type PromptGroup,
  type PromptUse,
} from "./library";
import {
  addGroup,
  addPrompt,
  editPrompt,
  isEdited,
  libraryGroups,
  moveItem,
  removeItem,
  renameGroup,
  resetAllPrompts,
  resetPrompt,
  setCommand,
  setGeneration,
  usePromptLibrary,
} from "./store";
import styles from "./PromptLibrary.module.css";

type Node = { kind: "group"; group: PromptGroup } | { kind: "prompt"; prompt: Prompt; group: PromptGroup };
const nodeKey = (n: Node) => (n.kind === "group" ? n.group.id : n.prompt.id);

/** Where a built-in prompt is used: the info tip beside its name. */
const USES: Record<PromptUse, string> = {
  instructions: "Sent with the first message of every agent conversation, to every agent.",
  commitMessage: "Used by Generate Commit Message in the Commit tool window.",
  selfReview: "Used by AI Self-Review in the Commit tool window: it starts a conversation.",
  prSummary: "Used by Generate Description when creating a GitHub pull request.",
  documentation:
    "Used by Write Documentation (AI actions above a method, AI Actions in the editor), for files in this language.",
  unitTests:
    "Used by Generate Unit Tests (AI actions above a method, AI Actions in the editor), for files in this language.",
  findProblems: "Used by AI Actions › Find Problems in the editor, and as /find-problems in the agent chat.",
  newChat: "Used by AI Actions › New Chat Using Selection: the message the new chat starts with.",
  fixProblem: "Used by Fix with Agent on a problem in the editor (its hover card and ⌥↵).",
  explainCode: "Used by Explain Code: the AI actions above a method, and AI Actions in the editor.",
  optimizeCode: "Used by Optimize Code: the AI actions above a method, and AI Actions in the editor.",
  command: "Typed as its /command in the agent chat.",
};

export function PromptLibraryPage() {
  const lib = usePromptLibrary();
  const groups = useMemo(() => libraryGroups(lib), [lib]);
  const focus = useSettingsDialog((s) => s.focus);
  const [selected, setSelected] = useState<string>(focus ?? "general.chat-instructions");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  // Settings opened on a prompt (`ai.prompts#builtin.commit-message`): select it.
  const [seenFocus, setSeenFocus] = useState(focus);
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    if (focus) setSelected(focus);
  }

  const roots: Node[] = groups.map((group) => ({ kind: "group", group }));
  const find = (id: string): Node | null => {
    for (const group of groups) {
      if (group.id === id) return { kind: "group", group };
      const prompt = group.prompts.find((p) => p.id === id);
      if (prompt) return { kind: "prompt", prompt, group };
    }
    return null;
  };
  const current = find(selected);
  const group = current?.group;
  const own = current?.kind === "prompt" ? !current.prompt.builtin : !!group && !group.builtin;

  const select = (id: string) => setSelected(id);
  const newPrompt = () => {
    const target = group ?? groups[groups.length - 1]!;
    select(addPrompt(target.id));
    setCollapsed((c) => new Set([...c].filter((k) => k !== target.id)));
  };
  const items: MenuItem[] = [
    { id: "prompt", label: tx("Prompt"), icon: "file", run: newPrompt },
    { id: "group", label: tx("Group"), icon: "folder", run: () => select(addGroup(tx("New Group"))) },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.side}>
        <div className={styles.toolbar} role="toolbar" aria-label={tx("Prompts")}>
          <IconButton
            ref={addRef}
            icon="plus"
            title="Add"
            aria-haspopup="menu"
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
          />
          <Menu open={adding} onClose={() => setAdding(false)} anchor={addRef} items={items} aria-label="Add" />
          <IconButton
            icon="minus"
            title="Remove"
            disabled={!own}
            onClick={() => {
              const next = current?.kind === "prompt" ? current.group.id : groups[0]!.id;
              removeItem(selected);
              select(next);
            }}
          />
          <IconButton
            icon="copy"
            title="Duplicate"
            disabled={current?.kind !== "prompt"}
            onClick={() => current?.kind === "prompt" && select(addPrompt(current.group.id, current.prompt))}
          />
          <IconButton icon="arrow-up" title="Move Up" disabled={!own} onClick={() => moveItem(selected, -1)} />
          <IconButton icon="arrow-down" title="Move Down" disabled={!own} onClick={() => moveItem(selected, 1)} />
          <span className={styles.grow} />
          {/* Built-in prompts back to their defaults: the selected one, or every edited one. */}
          <IconButton
            icon="refresh"
            title="Reset to Default"
            disabled={!(current?.kind === "prompt" && current.prompt.builtin && isEdited(current.prompt.id, lib))}
            onClick={() => current?.kind === "prompt" && resetPrompt(current.prompt.id)}
          />
          <IconButton
            ref={moreRef}
            icon="more"
            title="More Actions"
            aria-haspopup="menu"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
          />
          <Menu
            open={more}
            onClose={() => setMore(false)}
            anchor={moreRef}
            placement="bottom-end"
            aria-label="More Actions"
            items={[
              {
                id: "resetAll",
                label: tx("Reset All Built-in Prompts"),
                icon: "refresh",
                disabled: !Object.keys(lib.edited).length,
                run: () =>
                  void confirm({
                    title: tx("Reset All Built-in Prompts"),
                    message: tx("Every built-in prompt goes back to its default. Your own prompts and groups stay."),
                    ok: tx("Reset"),
                    icon: "warning",
                  }).then((ok) => ok && resetAllPrompts()),
              },
            ]}
          />
        </div>
        <Tree<Node>
          aria-label="Prompt Library"
          className={styles.tree}
          roots={roots}
          getKey={nodeKey}
          getLabel={(n) => (n.kind === "group" ? n.group.name : n.prompt.name)}
          getChildren={(n) =>
            n.kind === "group"
              ? n.group.prompts.map((prompt) => ({ kind: "prompt", prompt, group: n.group }) as Node)
              : undefined
          }
          isExpandable={(n) => n.kind === "group"}
          expanded={new Set(groups.map((g) => g.id).filter((id) => !collapsed.has(id)))}
          onExpandedChange={(_next, node, open) =>
            setCollapsed((c) => {
              const s = new Set(c);
              if (open) s.delete(nodeKey(node));
              else s.add(nodeKey(node));
              return s;
            })
          }
          selected={new Set([selected])}
          onSelectionChange={(_sel, lead) => lead && select(nodeKey(lead))}
          renderNode={(n) =>
            n.kind === "group" ? (
              <span className={styles.groupRow}>
                <T>{n.group.name}</T>
              </span>
            ) : (
              <span className={styles.promptRow}>
                <span className={styles.promptName}>
                  <T>{n.prompt.name}</T>
                </span>
                {n.prompt.builtin && isEdited(n.prompt.id, lib) && (
                  <span
                    className={styles.edited}
                    role="img"
                    aria-label={tx("Edited")}
                    {...tooltipAttrs(tx("Edited"))}
                  />
                )}
                {n.prompt.command && <span className={styles.command}>/{n.prompt.command}</span>}
              </span>
            )
          }
        />
      </div>
      <div className={styles.main}>
        {current?.kind === "prompt" ? (
          <PromptEditor key={current.prompt.id} prompt={current.prompt} group={current.group} />
        ) : current?.kind === "group" ? (
          <GroupEditor key={current.group.id} group={current.group} onAdd={newPrompt} />
        ) : null}
      </div>
    </div>
  );
}

function GroupEditor({ group, onAdd }: { group: PromptGroup; onAdd: () => void }) {
  const tx = useTx();
  return (
    <div className={styles.editor}>
      <div className={styles.head}>
        {group.builtin ? (
          <h3 className={styles.title}>
            <T>{group.name}</T>
          </h3>
        ) : (
          <Input
            className={styles.nameInput}
            aria-label={tx("Group name")}
            value={group.name}
            onChange={(e) => renameGroup(group.id, e.target.value)}
          />
        )}
      </div>
      <div className={styles.groupEmpty}>
        <Button icon="plus" onClick={onAdd}>
          <T>New Prompt</T>
        </Button>
      </div>
    </div>
  );
}

function PromptEditor({ prompt, group }: { prompt: Prompt; group: PromptGroup }) {
  const tx = useTx();
  const lib = usePromptLibrary();
  const use: PromptUse = prompt.use ?? "command";
  const edited = prompt.builtin && isEdited(prompt.id, lib);
  const variables = prompt.variables ?? CHAT_VARS;
  return (
    <div className={styles.editor}>
      <div className={styles.head}>
        {prompt.builtin ? (
          <h3 className={styles.title}>
            {/* A language's prompt says what for: "Write Documentation › Java". */}
            {prompt.extensions && (
              <span className={styles.titleGroup}>
                <T>{group.name}</T> ›{" "}
              </span>
            )}
            <T>{prompt.name}</T>
          </h3>
        ) : (
          <Input
            className={styles.nameInput}
            aria-label={tx("Prompt name")}
            value={prompt.name}
            onChange={(e) => editPrompt(prompt.id, { name: e.target.value })}
          />
        )}
        <span className={styles.info} role="img" aria-label={tx(USES[use])} {...tooltipAttrs(tx(USES[use]))}>
          <Icon name="info" size={16} />
        </span>
        <span className={styles.grow} />
        {edited && (
          <Button variant="ghost" icon="refresh" onClick={() => resetPrompt(prompt.id)}>
            <T>Reset to Default</T>
          </Button>
        )}
      </div>
      {(!prompt.builtin || prompt.command) && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>
            <T>Command</T>
          </span>
          <span className={styles.commandInput}>
            <span className={styles.slash}>/</span>
            <Input
              aria-label={tx("Command")}
              value={prompt.command ?? ""}
              disabled={prompt.builtin}
              placeholder={tx("none")}
              onChange={(e) => editPrompt(prompt.id, { command: e.target.value })}
              onBlur={(e) => setCommand(prompt.id, e.target.value)}
            />
          </span>
        </label>
      )}
      {(use === "commitMessage" || use === "prSummary") && <GenerationPicker />}
      <TemplateEditor
        value={prompt.text}
        variables={variables}
        placeholder={builtinPrompt(prompt.id)?.text}
        onChange={(text) => editPrompt(prompt.id, { text })}
      />
    </div>
  );
}

/**
 * The template: `$VARIABLES` drawn as tags by a layer under the textarea (its own text
 * transparent, like the agent composer), the ones its action does not fill marked; the chips
 * under it insert a variable at the caret.
 */
function TemplateEditor({
  value,
  variables,
  placeholder,
  onChange,
}: {
  value: string;
  variables: readonly string[];
  placeholder?: string;
  onChange: (text: string) => void;
}) {
  const tx = useTx();
  const ref = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const tokens = useMemo(() => variableTokens(value, variables), [value, variables]);
  useLayoutEffect(() => {
    const el = ref.current;
    const l = layer.current;
    if (!el || !l) return;
    const sync = () => {
      l.style.width = `${el.clientWidth}px`;
      l.style.transform = `translateY(${-el.scrollTop}px)`;
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, []);
  const insert = (name: string) => {
    const el = ref.current;
    if (!el) return;
    const at = el.selectionStart;
    const end = el.selectionEnd;
    const text = `$${name}`;
    onChange(value.slice(0, at) + text + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + text.length, at + text.length);
    });
  };
  const layerContent: ReactNode[] = [];
  let at = 0;
  for (const t of tokens) {
    if (t.from > at) layerContent.push(value.slice(at, t.from));
    layerContent.push(
      <span key={t.from} className={clsx(styles.variable, !t.known && styles.unknownVariable)}>
        {value.slice(t.from, t.to)}
      </span>,
    );
    at = t.to;
  }
  layerContent.push(value.slice(at) + (value.endsWith("\n") ? " " : ""));
  const unknown = tokens.filter((t) => !t.known).map((t) => t.name);
  return (
    <div className={styles.template}>
      <div className={styles.textBox}>
        <div className={styles.layerClip} aria-hidden="true">
          <div ref={layer} className={clsx(styles.text, styles.layer)}>
            {layerContent}
          </div>
        </div>
        <textarea
          ref={ref}
          className={clsx(styles.text, styles.input)}
          aria-label={tx("Prompt")}
          spellCheck={false}
          value={value}
          placeholder={placeholder ? undefined : tx("Write the prompt…")}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <div className={styles.variables}>
        {variables.map((name) => {
          const v = VARIABLES.find((x) => x.name === name);
          return (
            <button
              key={name}
              type="button"
              className={styles.variableChip}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(name)}
              {...tooltipAttrs(v ? `${tx(v.description)} · ${v.example}` : name)}
            >
              ${name}
            </button>
          );
        })}
      </div>
      {unknown.length > 0 && (
        <div className={styles.warning} role="status">
          <Icon name="warning" size={14} />
          {tx`Not filled here: ${[...new Set(unknown)].map((n) => `$${n}`).join(", ")}`}
        </div>
      )}
    </div>
  );
}

/**
 * The agent, model and thinking effort one-off generations use (commit messages, pull request
 * descriptions). Lists the installed agents; their settings are read the first time one is
 * picked.
 */
function GenerationPicker() {
  const tx = useTx();
  const choice = usePromptLibrary((s) => s.generation);
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    void call(commands.agentProviders())
      .then((list) => setProviders(list.filter((p) => p.installed)))
      .catch(() => {});
  }, []);
  const provider = providers.find((p) => p.id === choice?.provider);
  // An agent whose settings were never read: read them (a session is opened and closed).
  useEffect(() => {
    if (!provider || provider.config.length) return;
    let alive = true;
    void call(commands.agentLoadConfig(provider.id))
      .then(() => call(commands.agentProviders()))
      .then((list) => alive && setProviders(list.filter((p) => p.installed)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [provider]);
  const option = (category: string) =>
    provider?.config.find(
      (o) => o.category === category || (category === "thought_level" && /effort|reason|think/i.test(o.id)),
    );
  const model = option("model");
  const effort = option("thought_level");
  const value = (o: typeof model) => (o ? (choice?.config.find((c) => c.id === o.id)?.value ?? null) : null);
  const set = (o: NonNullable<typeof model>, v: string) => {
    const config: AgentConfigChoice[] = [
      ...(choice?.config ?? []).filter((c) => c.id !== o.id),
      { id: o.id, value: v },
    ];
    setGeneration({ provider: choice!.provider, config });
  };
  const missing = !!choice && providers.length > 0 && !provider;
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>
        <T>Generate with</T>
      </span>
      <div className={styles.pickers}>
        <Select
          aria-label={tx("Agent")}
          value={provider ? provider.id : null}
          placeholder={tx(providers.length ? "Agent of the last task" : "No agent installed")}
          disabled={!providers.length}
          options={providers.map((p) => ({ value: p.id, label: p.name, icon: `agent-${p.id}` }))}
          onChange={(id) => setGeneration({ provider: id, config: [] })}
        />
        {model && (
          <Select
            aria-label={tx("Model")}
            value={value(model)}
            placeholder={tx("Agent default")}
            searchable={model.values.length > 8}
            options={model.values.map((v) => ({ value: v.value, label: v.name, detail: v.description ?? undefined }))}
            onChange={(v) => set(model, v)}
          />
        )}
        {effort && (
          <Select
            aria-label={tx("Thinking")}
            value={value(effort)}
            placeholder={tx("Agent default")}
            options={effort.values.map((v) => ({ value: v.value, label: v.name }))}
            onChange={(v) => set(effort, v)}
          />
        )}
        {choice && <IconButton icon="close" size="small" title="Use the Default" onClick={() => setGeneration(null)} />}
      </div>
      {missing && (
        <div className={styles.warning} role="status">
          <Icon name="warning" size={14} />
          <T>The chosen agent is not installed: the agent of the last task is used.</T>
        </div>
      )}
    </div>
  );
}
