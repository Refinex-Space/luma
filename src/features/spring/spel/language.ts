/**
 * The SpEL parser with its highlighting (IDEA's SpEL colours mapped to the editor's tags:
 * bean references as special variables, `T(type)` as types, textual operators as keywords).
 */
import { styleTags, tags as t } from "@lezer/highlight";
import type { Tree } from "@lezer/common";
import { parser as baseParser } from "./parser";

export const spelParser = baseParser.configure({
  props: [
    styleTags({
      "BeanName FactoryBeanName": t.special(t.variableName),
      'BeanReference/"@" BeanReference/"&"': t.special(t.variableName),
      VariableName: t.local(t.variableName),
      PropertyName: t.propertyName,
      "CallExpression/MemberExpression/PropertyName": t.function(t.propertyName),
      "CallExpression/PropertyName": t.function(t.variableName),
      TypeName: t.typeName,
      "T new": t.keyword,
      Number: t.number,
      String: t.string,
      BooleanLiteral: t.bool,
      null: t.null,
      "and or not div mod eq ne lt gt le ge instanceof matches between": t.operatorKeyword,
      ArithOp: t.arithmeticOperator,
      CompareOp: t.compareOperator,
      LogicOp: t.logicOperator,
      '"?" ":" "?:"': t.operator,
      '"="': t.definitionOperator,
      '"." "?."': t.derefOperator,
      CollectionOp: t.special(t.squareBracket),
      "( )": t.paren,
      "[ ]": t.squareBracket,
      "{ }": t.brace,
      ",": t.separator,
    }),
  ],
});

export function parseSpel(text: string): Tree {
  return spelParser.parse(text);
}

/** Positions (in `text`) of the parse errors: where the parser gave up or skipped input. */
export function spelErrors(tree: Tree, text: string): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  tree.iterate({
    enter(n) {
      if (n.name === "String") {
        // The token takes an unterminated string too (to colour it while typed).
        const s = text.slice(n.from, n.to);
        if (!/^(?:'(?:[^']|'')*'|"(?:[^"]|"")*")$/.test(s)) out.push({ from: n.from, to: n.to });
        return;
      }
      if (!n.type.isError) return;
      const from = n.from;
      // An empty error node marks where something is missing: underline the next character (or the last).
      const to = n.to > n.from ? n.to : Math.min(text.length, from + 1);
      const start = to > from ? from : Math.max(0, from - 1);
      if (!out.some((e) => e.from === start)) out.push({ from: start, to: Math.max(to, start + 1) });
    },
  });
  return out;
}
