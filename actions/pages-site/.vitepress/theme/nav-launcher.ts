// launcher.css hides the button while a landing panel is on the page, so a landing page without a curated table keeps
// its search. The keyboard shortcut (Cmd K, Ctrl K, and `/` outside a field) is a capturing window listener that stops
// carbon's own search hotkeys; the same listener, with a pointerdown twin, keeps the page's input modality for the
// launcher's focus ring.

import {
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  type VNode,
} from "vue";
import FleetLauncher, { keyboardInput, searchIcon, shortcutKeys } from "./launcher.ts";
import { hotkeyIntent, modifierLabel } from "./launcher-view.ts";

const PANEL_FIELD = ".fleet-launcher-mode-panel .fleet-launcher-input";
const DIALOG_FIELD = ".fleet-launcher-dialog .fleet-launcher-input";

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
    const dialog = shallowRef<HTMLDialogElement | null>(null);
    const button = shallowRef<HTMLButtonElement | null>(null);
    const modifier = ref<"Cmd" | "Ctrl">("Cmd");

    async function show(): Promise<void> {
      const panel = document.querySelector<HTMLInputElement>(PANEL_FIELD);
      if (panel !== null) {
        aim(panel);
        panel.scrollIntoView({ block: "center" });
        return;
      }
      if (!opened.value) {
        opened.value = true;
        await nextTick();
      }
      const element = dialog.value;
      if (element === null) return;
      if (!element.open) element.showModal();
      aim(element.querySelector<HTMLInputElement>(DIALOG_FIELD));
    }

    // Focus goes back to the button on every close, not only the ones the
    // browser restores itself: opened by the shortcut, the dialog had taken
    // focus from the body, and Escape or the backdrop would leave it there.
    function close(): void {
      const element = dialog.value;
      if (element?.open) element.close();
      opened.value = false;
      button.value?.focus();
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
      void show();
    }

    function onPointerdown(): void {
      keyboardInput.value = false;
    }

    onMounted(() => {
      modifier.value = modifierLabel(navigator.platform);
      window.addEventListener("keydown", onKeydown, true);
      window.addEventListener("pointerdown", onPointerdown, true);
    });
    onBeforeUnmount(() => {
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("pointerdown", onPointerdown, true);
    });

    return () => {
      return [
        h(
          "button",
          {
            ref: button,
            type: "button",
            class: "fleet-launcher-button",
            "aria-label": "Search the docs",
            "aria-haspopup": "dialog",
            onClick: () => void show(),
          },
          [
            searchIcon(18),
            h("span", { class: "fleet-launcher-button-text" }, "Search"),
            shortcutKeys(modifier.value),
          ],
        ),
        opened.value
          ? h(
              "dialog",
              {
                ref: dialog,
                class: "fleet-launcher-dialog",
                "aria-label": "Search the docs",
                onClose: close,
                // A click that reaches the dialog itself landed on the
                // backdrop; clicks inside land on the launcher's elements.
                onClick: (event: MouseEvent) => {
                  if (event.target === dialog.value) close();
                },
              },
              // After the launcher in the DOM, so Tab from the field
              // reaches it (the rows are out of the Tab order); the CSS
              // seats it over the field's right end.
              [
                h(FleetLauncher, { rows: "[]", mode: "dialog", onClose: close }),
                h(
                  "button",
                  {
                    type: "button",
                    class: "fleet-launcher-close",
                    "aria-label": "Close search",
                    onClick: close,
                  },
                  closeIcon(),
                ),
              ],
            )
          : null,
      ];
    };
  },
});
