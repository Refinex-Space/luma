/** Settings › Editor pages (General and sub-pages, Code Editing, Font, Color Scheme, Rainbow Brackets, Code Style, Inspections, Natural Languages › Spelling, File Encodings, Inlay Hints). */
import type { PageSpec } from "../spec";
import { GENERAL_PAGES } from "./general";
import { FONT_PAGE } from "./font";
import { COLOR_SCHEME_PAGE } from "./colorScheme";
import { RAINBOW_BRACKETS_SETTINGS_PAGE } from "./rainbowBrackets";
import { CODE_STYLE_PAGES } from "./codeStyle";
import { INSPECTIONS_PAGE } from "./inspections";
import { NATURAL_LANGUAGES_PAGE, SPELLING_PAGE } from "./spelling";

export { codeStyleLanguagePages } from "./codeStyle";

export const EDITOR_PAGES: PageSpec[] = [
  ...GENERAL_PAGES,
  FONT_PAGE,
  COLOR_SCHEME_PAGE,
  RAINBOW_BRACKETS_SETTINGS_PAGE,
  ...CODE_STYLE_PAGES,
  INSPECTIONS_PAGE,
  NATURAL_LANGUAGES_PAGE,
  SPELLING_PAGE,
];
