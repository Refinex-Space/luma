/**
 * Data grid preferences shared by every result and table view, kept per viewer like
 * IDEA's: the data extractor Copy uses (and Export Data starts with), and whether
 * the CSV formats copy a header row.
 */
import { create } from "zustand";
import { extractorOf, type ExportFormat } from "./export";

const KEY = "luma.database.grid";

/** The aggregate the grid's status pill shows for a selection (IDEA's aggregator widget). */
export type GridAggregate = "count" | "distinct" | "nulls" | "sum" | "avg" | "median" | "min" | "max";

/** IDEA's table heatmap: numeric cells tinted by their place between the column's min and max. */
export type GridColoring = "off" | "sequential" | "diverging";

interface GridPrefs {
  extractor: ExportFormat;
  coloring: GridColoring;
  aggregate: GridAggregate;
  /** The CSV formats (CSV, TSV, pipe, semicolon) copy the column names first. */
  copyHeader: boolean;
}

function read(): GridPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<GridPrefs>;
    return {
      extractor: extractorOf(raw.extractor).id,
      copyHeader: raw.copyHeader === true,
      aggregate: raw.aggregate ?? "sum",
      coloring: raw.coloring === "sequential" || raw.coloring === "diverging" ? raw.coloring : "off",
    };
  } catch {
    return { extractor: "csv", copyHeader: false, aggregate: "sum", coloring: "off" };
  }
}

export const useGridPrefs = create<GridPrefs>(read);

useGridPrefs.subscribe((s) => {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        extractor: s.extractor,
        copyHeader: s.copyHeader,
        aggregate: s.aggregate,
        coloring: s.coloring,
      }),
    );
  } catch {
    // Not persisted (private window): this session still follows.
  }
});

export const setExtractor = (extractor: ExportFormat) => useGridPrefs.setState({ extractor });
export const setCopyHeader = (copyHeader: boolean) => useGridPrefs.setState({ copyHeader });
export const setAggregate = (aggregate: GridAggregate) => useGridPrefs.setState({ aggregate });
export const setColoring = (coloring: GridColoring) => useGridPrefs.setState({ coloring });
