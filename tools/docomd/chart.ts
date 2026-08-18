import type { Root, RootContent, Table } from "mdast";
import type { Node } from "unist";
import { toString as mdastToString } from "mdast-util-to-string";
import { SKIP, visit } from "unist-util-visit";
import { parseAttrs } from "./parse.ts";

// A markdown table flagged as a chart by a trailing `{ .chart ... }` attribute
// list (MkDocs attr_list's block form):
//
//   | Month | Desktop | Mobile |
//   | ----- | ------- | ------ |
//   | Jan   | 186     | 80     |
//   { .chart type=bar title="Monthly active users" }
//
// The real table is kept in the output: it is the no-JS fallback, the SEO content,
// the screen-reader view, and what an AI grounds against, all from one source of
// truth. The chart is painted on top client-side (LayerChart is a Svelte/d3
// component, so it cannot be server-rendered like shiki or KaTeX). This module only
// annotates the table; src/lib/markdown/charts.ts mounts the chart on the client.

export type ChartType = "bar" | "line" | "area" | "pie" | "donut";

export interface ChartSpec {
  type: ChartType;
  title: string | null;
  /** Whether multi-series bars/areas stack instead of grouping/overlapping. */
  stacked: boolean;
  /** Whether to show the series legend. */
  legend: boolean;
  /** Whether a bar chart runs horizontally. */
  horizontal: boolean;
}

/** Custom mdast node: a table promoted to a chart. It keeps the original table as
 *  its only child so the rehype handler can convert it (the table is preserved in
 *  the HTML). */
export interface DocoChart extends Node {
  type: "docoChart";
  spec: ChartSpec;
  children: [Table];
}

const CHART_TYPES = new Set<ChartType>(["bar", "line", "area", "pie", "donut"]);

function toSpec(props: Record<string, string | undefined>): ChartSpec {
  const raw = (props.type ?? "bar").toLowerCase();
  const type = CHART_TYPES.has(raw as ChartType) ? (raw as ChartType) : "bar";
  return {
    type,
    title: typeof props.title === "string" && props.title.length > 0 ? props.title : null,
    stacked: props.stacked === "true",
    legend: props.legend !== "false",
    horizontal: props.horizontal === "true",
  };
}

/** remark: promote a table immediately followed by a `{ .chart ... }` attribute
 *  list into a chart node. The table is preserved as the chart's data source; the
 *  marker paragraph is consumed. */
export function remarkChart() {
  return (tree: Root): undefined => {
    visit(tree, "table", (node, index, parent) => {
      if (parent === undefined || index === undefined) return;
      const next = parent.children.at(index + 1);
      if (next?.type !== "paragraph") return;
      const parsed = parseAttrs(mdastToString(next).trim());
      if (!parsed?.classes.includes("chart")) return;

      const chart: DocoChart = { type: "docoChart", spec: toSpec(parsed.props), children: [node] };
      // Replace the table + marker paragraph with the chart node, then skip past
      // it so the wrapped table is not revisited.
      parent.children.splice(index, 2, chart as unknown as RootContent);
      return [SKIP, index + 1];
    });
  };
}
