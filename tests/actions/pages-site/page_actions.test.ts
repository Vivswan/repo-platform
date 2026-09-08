import { expect, test } from "bun:test";
import {
  INITIAL,
  type LabelState,
  observeLabel,
} from "../../../actions/pages-site/.vitepress/theme/page-actions.ts";

// A copy's whole life through the reducer: the label rests, reports, and
// rests again; each step pins both fields of the resulting state.
const SEQUENCES: Array<{ name: string; texts: string[]; states: LabelState[] }> = [
  {
    name: "a successful copy and its return to rest",
    texts: ["Markdown", "Copied", "Markdown"],
    states: [
      { idle: "Markdown", feedback: null },
      { idle: "Markdown", feedback: "Copied" },
      { idle: "Markdown", feedback: null },
    ],
  },
  {
    name: "a failed copy",
    texts: ["Markdown", "Unavailable", "Markdown"],
    states: [
      { idle: "Markdown", feedback: null },
      { idle: "Markdown", feedback: "Unavailable" },
      { idle: "Markdown", feedback: null },
    ],
  },
  {
    name: "a configured idle label with the DOM's surrounding whitespace",
    texts: ["\n  Copy page\n", "Copied", " Copy page "],
    states: [
      { idle: "Copy page", feedback: null },
      { idle: "Copy page", feedback: "Copied" },
      { idle: "Copy page", feedback: null },
    ],
  },
  {
    name: "a re-render that restates the idle text is not feedback",
    texts: ["Markdown", "Markdown", "Markdown"],
    states: [
      { idle: "Markdown", feedback: null },
      { idle: "Markdown", feedback: null },
      { idle: "Markdown", feedback: null },
    ],
  },
];

test.each(SEQUENCES)("observeLabel: $name", ({ texts, states }) => {
  const seen: LabelState[] = [];
  let state = INITIAL;
  for (const text of texts) {
    state = observeLabel(state, text);
    seen.push(state);
  }
  expect(seen).toEqual(states);
});
