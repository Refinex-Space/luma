/**
 * Settings › Editor › Rainbow Brackets (the bundled plugin's page): what is coloured by
 * nesting depth, with a live preview of the staged choices. The colours themselves are
 * the colour scheme's `Rainbow brackets › Level 1–5`.
 */
import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { lumaTheme } from "@/editor/core/cm/theme";
import { lumaHighlightStyle } from "@/editor/core/cm/highlight";
import { rainbowBrackets, type RainbowOptions } from "@/editor/core/cm/rainbowBrackets";
import { indentGuides, rainbowIndentGuides } from "@/editor/core/cm/indentGuides";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { useSettingsForm } from "@/workbench/contributions";
import { T } from "@/ui";
import { editorPage } from "./kit";
import styles from "./Editor.module.css";

export const RAINBOW_BRACKETS_PAGE = "editor.rainbowBrackets";

const JAVA = `public class FlatMap {
    public static <T, U, R> Optional<R> flatMap2(Optional<T> opt1, Optional<U> opt2,
                                                 BiFunction<T, U, Optional<R>> func) {
        return opt1.flatMap(a ->
                opt2.flatMap(b -> func.apply(a, b)));
    }

    int[] squares(List<Map<String, Integer>> rows) {
        if (rows.size() > 0 && rows.get(0).isEmpty()) {
            return new int[]{(((1 + 2) * 3))};
        }
        return new int[0];
    }
}`;

const HTML = `<div class="form-group">
    <label for="model">Rainbow Brackets</label>
    <div class="col">
        <input id="model" type="text"/>
        <span>Just enjoy it!</span>
    </div>
</div>`;

interface Staged {
  enabled: boolean;
  rainbow: RainbowOptions & { indentGuides: boolean };
}

function useStaged(): Staged {
  const form = useSettingsForm();
  const enabled = form.useValue("editor.rainbowBrackets") !== false;
  const raw = (form.useValue("editor.rainbow") ?? {}) as Partial<Staged["rainbow"]>;
  const on = (v: boolean | undefined) => v !== false;
  return {
    enabled,
    rainbow: {
      round: on(raw.round),
      square: on(raw.square),
      curly: on(raw.curly),
      angle: on(raw.angle),
      tags: on(raw.tags),
      indentGuides: on(raw.indentGuides),
    },
  };
}

function extensionsFor(s: Staged) {
  return [
    s.enabled && s.rainbow.indentGuides ? rainbowIndentGuides : indentGuides,
    s.enabled ? rainbowBrackets(s.rainbow) : [],
  ];
}

/** A read-only editor showing `doc` in `language` with the staged rainbow options. */
function Sample({ doc, language, label, staged }: { doc: string; language: string; label: string; staged: Staged }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const rainbow = useRef(new Compartment());
  const lang = useRef(new Compartment());

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc,
        extensions: [
          lumaTheme,
          syntaxHighlighting(lumaHighlightStyle),
          indentUnit.of("    "),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lang.current.of([]),
          rainbow.current.of([]),
        ],
      }),
    });
    view.current = v;
    let live = true;
    void languages
      .find((l) => l.name === language)
      ?.load()
      .then((support) => live && v.dispatch({ effects: lang.current.reconfigure(support) }));
    return () => {
      live = false;
      v.destroy();
      view.current = null;
    };
  }, [doc, language]);

  useEffect(() => {
    view.current?.dispatch({ effects: rainbow.current.reconfigure(extensionsFor(staged)) });
  });

  return <div ref={host} className={styles.rainbowSample} aria-label={label} role="img" />;
}

function RainbowPreview() {
  const staged = useStaged();
  return (
    <div className={styles.rainbowPreview}>
      <div className={styles.rainbowSamples}>
        <Sample doc={JAVA} language="Java" label={tx("Java preview")} staged={staged} />
        <Sample doc={HTML} language="HTML" label={tx("HTML preview")} staged={staged} />
      </div>
      <button
        type="button"
        className={styles.rainbowColors}
        onClick={() => void executeAction("file.settings", "editor.colorScheme")}
      >
        <span className={styles.rainbowSwatches} aria-hidden>
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} style={{ background: `var(--syn-bracket-${n})` }} />
          ))}
        </span>
        <T>Change the colours in Color Scheme › Language Defaults › Rainbow brackets</T>
      </button>
    </div>
  );
}

export const RAINBOW_BRACKETS_SETTINGS_PAGE = editorPage({
  id: RAINBOW_BRACKETS_PAGE,
  title: "Rainbow Brackets",
  // Right after Color Scheme.
  order: 23.5,
  keywords: ["rainbow", "brackets", "braces", "parentheses", "bracket pair colorization", "nesting", "tags"],
  sections: [
    {
      items: [
        {
          t: "check",
          key: "editor.rainbowBrackets",
          label: "Color brackets by nesting depth",
          children: [
            { t: "check", key: "editor.rainbow.round", label: "Round brackets ( )" },
            { t: "check", key: "editor.rainbow.square", label: "Square brackets [ ]" },
            { t: "check", key: "editor.rainbow.curly", label: "Curly braces { }" },
            {
              t: "check",
              key: "editor.rainbow.angle",
              label: "Angle brackets < > of type arguments",
              hint: "Generics such as List<Map<K, V>>; comparison operators are never coloured.",
            },
            { t: "check", key: "editor.rainbow.tags", label: "HTML, XML and JSX tags" },
            {
              t: "check",
              key: "editor.rainbow.indentGuides",
              label: "Rainbow indent guides",
              hint: "Shown while Editor › General › Appearance › Show indent guides is on.",
            },
          ],
        },
      ],
    },
  ],
  footer: RainbowPreview,
});
