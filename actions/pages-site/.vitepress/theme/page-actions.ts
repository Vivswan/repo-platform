// Carbon reports a copy's result by swapping the Markdown trigger label's
// TEXT ("Copied", "Unavailable") for 1.8 seconds with no class or attribute
// change, so the icon-only trigger needs this attribute to show it. The
// idle label is the first text seen: the observer starts before any copy.

import { defineComponent, onBeforeUnmount, onMounted } from "vue";

const LABEL = ".VPLlmsPageActions .trigger-label";
const TRIGGER = ".trigger";
const ATTRIBUTE = "data-feedback";

export interface LabelState {
  /** The label's resting text: the first text seen, since the observer
   *  starts before any copy can happen. */
  idle: string | null;
  /** The text to surface, or null while the label rests. */
  feedback: string | null;
}

export const INITIAL: LabelState = { idle: null, feedback: null };

/** The next state after the label reads `text`. */
export function observeLabel(state: LabelState, text: string): LabelState {
  const current = text.trim();
  if (state.idle === null) return { idle: current, feedback: null };
  return { idle: state.idle, feedback: current === state.idle ? null : current };
}

export default defineComponent({
  name: "PageActionsFeedback",
  setup() {
    let state = INITIAL;
    let observer: MutationObserver | null = null;

    function sync(): void {
      const label = document.querySelector<HTMLElement>(LABEL);
      const trigger = label?.closest<HTMLElement>(TRIGGER) ?? null;
      if (label === null || trigger === null) return;
      state = observeLabel(state, label.textContent ?? "");
      if (state.feedback === null) trigger.removeAttribute(ATTRIBUTE);
      else trigger.setAttribute(ATTRIBUTE, state.feedback);
    }

    onMounted(() => {
      sync();
      // The whole body, not the label: the doc column re-renders across
      // routes, and a page without the menu has no label to observe.
      observer = new MutationObserver(sync);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    onBeforeUnmount(() => observer?.disconnect());

    return () => null;
  },
});
