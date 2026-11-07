import { javaLanguage } from "@codemirror/lang-java";
import { describe, expect, it } from "vitest";
import { decodeJavaString, pieceAt, pieceOffset, regionPieces, spelRegions } from "./hosts";
import { parseSpel, spelErrors } from "./language";

/** Expressions of Spring's reference documentation and `spring-expression` tests. */
const VALID = [
  "'Hello World'",
  "'It''s'",
  '"say ""hi"""',
  "6.0221415E+23",
  "0x7FFFFFFF",
  "3L",
  "3.5f",
  "true",
  "NULL",
  "name",
  "placeOfBirth.city",
  "inventions[3]",
  "members[0].name",
  "officers['president'].placeOfBirth.city",
  "'abc'.substring(2, 3)",
  "isMember('Mihajlo Pupin')",
  "T(java.lang.Math).random()",
  "T(String)",
  "T(int[][])",
  "new org.spring.samples.spel.inventor.Inventor('Albert Einstein', 'German')",
  "new int[4]",
  "new int[]{1,2,3}",
  "new int[4][5]",
  "{1,2,3,4}",
  "{{'a','b'},{'x','y'}}",
  "{name:'Nikola',dob:'10-July-1856'}",
  "{:}",
  "{}",
  "2 == 2",
  "2 < -5.0",
  "'black' < 'block'",
  "'xyz' instanceof T(Integer)",
  "'5.00' matches '^-?\\d+(\\.\\d{2})?$'",
  "1 between {1, 5}",
  "true and false",
  "true AND false",
  "isMember('Nikola Tesla') or isMember('Albert Einstein')",
  "!true",
  "not true",
  "1 + 1 - 2 * 3 / 4 % 5 ^ 2",
  "7 div 2 mod 4",
  "name = 'Aleksandar Seovic'",
  "#this",
  "#root.method.name",
  "#primes.?[#this > 10]",
  "members.![placeOfBirth.city]",
  "map.^[value > 3]",
  "map.$[key == 'a']",
  "#reverseString('hello')",
  "@myBean.limit * 2",
  "&myFactoryBean",
  "@'my.bean-name'",
  "name ?: 'Unknown'",
  "placeOfBirth?.city",
  "false ? 'trueExp' : 'falseExp'",
  "#foo++",
  "--#foo",
  "#p0 + '-' + #result?.id",
  "systemProperties['user.region']",
  "#{1}",
];

const INVALID = ["1 +", "(1", "'unterminated", "T(", "a ? b", "#", "@", "a..b", "{1, }"];

describe("SpEL grammar", () => {
  it("parses Spring's sample expressions", () => {
    const failing = VALID.filter((e) => e !== "#{1}" && spelErrors(parseSpel(e), e).length);
    expect(failing).toEqual([]);
  });

  it("finds the errors of malformed expressions", () => {
    const missed = INVALID.filter((e) => !spelErrors(parseSpel(e), e).length);
    expect(missed).toEqual([]);
    expect(spelErrors(parseSpel("1 +"), "1 +")[0]).toEqual({ from: 2, to: 3 });
  });
});

describe("SpEL in Java", () => {
  const java = `class A {
  @Value("#{@cfg.limit * 2} and #{T(Math).PI}") int limit;
  @Cacheable(cacheNames = "users", key = "#p0 + \\"x\\"", unless = "#result == null")
  String find(Long id, final @Q String name) { return null; }
  @EventListener(condition = "#event.ok")
  void on(OrderPlaced event) {}
  @KafkaListener(topics = {"#{topics.split(',')}", "plain"})
  void listen() {}
  @Value("\${server.port}") static int port;
  @Value("#{x}") static String z;
}`;
  const regions = spelRegions(java, javaLanguage.parser.parse(java));

  it("finds the annotation strings Spring evaluates", () => {
    expect(regions.map((r) => [r.host.annotation, r.host.attribute, r.host.kind, r.host.mode, r.text])).toEqual([
      ["Value", "value", "value", "template", "#{@cfg.limit * 2} and #{T(Math).PI}"],
      ["Cacheable", "key", "cache", "expression", '#p0 + "x"'],
      ["Cacheable", "unless", "cache", "expression", "#result == null"],
      ["EventListener", "condition", "event", "expression", "#event.ok"],
      ["KafkaListener", "topics", "generic", "template", "#{topics.split(',')}"],
      ["Value", "value", "value", "template", "${server.port}"],
      ["Value", "value", "value", "template", "#{x}"],
    ]);
    expect(regions[1]!.target.params.map((p) => [p.name, p.type])).toEqual([
      ["id", "Long"],
      ["name", "String"],
    ]);
    expect([regions[1]!.target.returns, regions[0]!.target.kind]).toEqual(["String", "field"]);
    expect([regions[0]!.target.isStatic, regions[6]!.target.isStatic]).toEqual([false, true]);
  });

  it("splits templates and maps positions back through escapes", () => {
    const pieces = regionPieces(regions[0]!);
    expect(pieces.map((p) => p.text)).toEqual(["@cfg.limit * 2", "T(Math).PI"]);
    expect(java.slice(pieceOffset(pieces[1]!, 0), pieceOffset(pieces[1]!, 10))).toBe("T(Math).PI");
    expect(regionPieces(regions[5]!)).toEqual([]);
    const key = regionPieces(regions[1]!)[0]!;
    // `"x"` is written `\"x\"`: the closing quote is two characters after the x.
    const x = key.text.indexOf("x");
    expect(java.slice(pieceOffset(key, x), pieceOffset(key, x + 2))).toBe('x\\"');
    expect(pieceAt([key], pieceOffset(key, 3))).toEqual({ piece: key, at: 3 });
  });

  it("decodes Java escapes", () => {
    expect(decodeJavaString("a\\tb\\u0041\\\\", 10)).toEqual({ text: "a\tbA\\", map: [10, 11, 13, 14, 20, 22] });
  });
});

describe("SpEL problems", () => {
  it("reports syntax, unknown beans, static fields and unprefixed cache variables", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { java } = await import("@codemirror/lang-java");
    const { analysis, spelProblems } = await import("./editor");
    const doc = `class A {
  @Value("#{@orders.limit * } #{@ghost.x}") int a;
  @Value("#{1") int b;
  @Value("#{2}") static int c;
  @Cacheable(key = "p0 + #id + result") String f(Long id) { return null; }
}`;
    const state = EditorState.create({ doc, extensions: java() });
    const problems = spelProblems(analysis(state), new Set(["orders"]));
    const at = (from: number, to: number) => doc.slice(from, to);
    expect(problems.map((p) => [p.producer.replace("spring-spel-", ""), at(p.from, p.to), p.message])).toEqual([
      ["syntax", " ", "Expression is incomplete"],
      ["references", "@ghost", "Cannot resolve bean 'ghost'"],
      ["syntax", "#{1", "No ending suffix '}' for expression starting at character 0"],
      ["static-field", "#{2}", "Injection to static fields is not allowed"],
      ["cache-variable", "p0", "Cache SpEL variable 'p0' must be prefixed with #"],
      ["cache-variable", "result", "Cache SpEL variable 'result' must be prefixed with #"],
    ]);
    // Without the project's complete bean list, no bean is claimed missing.
    expect(spelProblems(analysis(state), null).some((p) => p.producer === "spring-spel-references")).toBe(false);
  });
});
