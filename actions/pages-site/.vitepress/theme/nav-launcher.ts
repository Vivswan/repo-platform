// The nav's entry to the launcher: a field-shaped button that opens the
// launcher in a native modal dialog. It renders on every page; launcher.css
// hides it while a landing panel is on the page, so a landing page without
// a curated table keeps its search. Owns the keyboard shortcut everywhere
// (Cmd K, Ctrl K, and `/` outside a field): a capturing window listener
// that stops carbon's own search hotkeys and then focuses the panel when
// there is one, else opens the dialog.

import { defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import FleetLauncher, { searchIcon, shortcutKeys } from "./launcher.ts";
import { modifierLabel } from "./launcher-view.ts";

const PANEL_FIELD = ".fleet-launcher-mode-panel .fleet-launcher-input";

function isEditing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (target === null) return false;
  return target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
}

function isLauncherHotkey(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) return true;
  // Any `/` outside a field, modifiers included: carbon's own slash handler
  // takes exactly that set, and it must never see one.
  return event.key === "/" && !isEditing(event);
}

export default defineComponent({
  name: "NavLauncher",
  setup() {
    const opened = ref(false);
    const dialog = shallowRef<HTMLDialogElement | null>(null);
    const modifier = ref<"Cmd" | "Ctrl">("Cmd");

    async function show(): Promise<void> {
      const panel = document.querySelector<HTMLInputElement>(PANEL_FIELD);
      if (panel !== null) {
        panel.focus();
        panel.select();
        panel.scrollIntoView({ block: "center" });
        return;
      }
      opened.value = true;
      await nextTick();
      const element = dialog.value;
      if (element !== null && !element.open) element.showModal();
    }

    function close(): void {
      const element = dialog.value;
      if (element?.open) element.close();
      opened.value = false;
    }

    function onHotkey(event: KeyboardEvent): void {
      if (!isLauncherHotkey(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void show();
    }

    onMounted(() => {
      modifier.value = modifierLabel(navigator.platform);
      window.addEventListener("keydown", onHotkey, true);
    });
    onBeforeUnmount(() => window.removeEventListener("keydown", onHotkey, true));

    return () => {
      return [
        h(
          "button",
          {
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
              h(FleetLauncher, { rows: "[]", mode: "dialog", onClose: close }),
            )
          : null,
      ];
    };
  },
});
