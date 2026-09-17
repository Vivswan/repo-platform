// launcher.css hides the button while a landing panel is on the page, so a landing page without a curated table keeps
// its search. The keyboard shortcut (Cmd K, Ctrl K, and `/` outside a field) is a capturing window listener that
// stops carbon's own search hotkeys; the same listener, with a pointerdown twin, keeps the page's input modality for
// the launcher's focus ring.

import { useEventListener } from "@vueuse/core";
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
  VisuallyHidden,
} from "reka-ui";
import { defineComponent, h, onMounted, ref, type VNode } from "vue";
import FleetLauncher, { keyboardInput, searchIcon, shortcutKeys } from "./launcher.ts";
import { hotkeyIntent, modifierLabel } from "./launcher-view.ts";

const PANEL_FIELD = ".fleet-launcher-mode-panel .fleet-launcher-input";
const DIALOG_FIELD = ".fleet-launcher-dialog .fleet-launcher-input";
const LABEL = "Search the docs";

function isEditing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (target === null) return false;
  return target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
}

/** The shortcut's landing: the field takes focus with its text selected,
 *  so a repeat press from a result row types over the old query. */
function aim(field: HTMLInputElement | null): void {
  if (field === null) return;
  field.focus();
  field.select();
}

/** Lucide's `x` glyph for the dialog's close button. */
function closeIcon(): VNode {
  return h(
    "svg",
    {
      width: 20,
      height: 20,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    [h("path", { d: "M18 6 6 18" }), h("path", { d: "m6 6 12 12" })],
  );
}

export default defineComponent({
  name: "NavLauncher",
  setup() {
    const opened = ref(false);
    const modifier = ref<"Cmd" | "Ctrl">("Cmd");

    function show(): void {
      const panel = document.querySelector<HTMLInputElement>(PANEL_FIELD);
      if (panel !== null) {
        aim(panel);
        panel.scrollIntoView({ block: "center" });
        return;
      }
      if (opened.value) aim(document.querySelector<HTMLInputElement>(DIALOG_FIELD));
      else opened.value = true;
    }

    function onKeydown(event: KeyboardEvent): void {
      // Marked before the shortcut check: this handler stops the event, so
      // no later listener could see the key that opens the dialog.
      keyboardInput.value = true;
      const intent = hotkeyIntent(event, isEditing(event));
      if (intent === null) return;
      event.stopImmediatePropagation();
      if (intent === "swallow") return;
      event.preventDefault();
      show();
    }

    useEventListener("keydown", onKeydown, { capture: true });
    useEventListener(
      "pointerdown",
      () => {
        keyboardInput.value = false;
      },
      { capture: true },
    );

    onMounted(() => {
      modifier.value = modifierLabel(navigator.platform);
    });

    return () =>
      h(
        DialogRoot,
        {
          open: opened.value,
          "onUpdate:open": (value: boolean) => {
            opened.value = value;
          },
        },
        () => [
          h(DialogTrigger, { asChild: true }, () =>
            h("button", { type: "button", class: "fleet-launcher-button", "aria-label": LABEL }, [
              searchIcon(18),
              h("span", { class: "fleet-launcher-button-text" }, "Search"),
              shortcutKeys(modifier.value),
            ]),
          ),
          h(DialogPortal, null, () => [
            h(DialogOverlay, { class: "fleet-launcher-backdrop" }),
            // No description: the title says it all, and reka's dev warning reads the attribute's absence.
            h(
              DialogContent,
              { class: "fleet-launcher-dialog", "aria-describedby": undefined },
              // The Close button after the launcher in the DOM, so Tab from the field reaches it (the rows are out
              // of the Tab order); the CSS seats it over the field's right end.
              () => [
                h(VisuallyHidden, null, () => h(DialogTitle, null, () => LABEL)),
                h(FleetLauncher, {
                  rows: "[]",
                  mode: "dialog",
                  onClose: () => {
                    opened.value = false;
                  },
                }),
                h(DialogClose, { asChild: true }, () =>
                  h(
                    "button",
                    { type: "button", class: "fleet-launcher-close", "aria-label": "Close search" },
                    closeIcon(),
                  ),
                ),
              ],
            ),
          ]),
        ],
      );
  },
});
