import type { Preferences } from "./domain";
import { shortcutLabel } from "./shortcuts";
import { workspace } from "./window-workspace";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Button, Menu, MenuItem, MenuTrigger, Popover, Separator, SubmenuTrigger, Text } from "react-aria-components";
import { ChevronRight } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

interface ContextMenuOptions {
  left: number;
  top: number;
  editable?: boolean;
  preferences?: Preferences;
  copy: boolean;
  actions?: { text: string; action: () => void | Promise<void> }[];
  aside?: () => void;
  region?: () => void;
  native?: {
    undo: () => void;
    redo: () => void;
    actions: { text: string; action: () => void }[];
    region?: () => void;
    table: (target: Element) => Pick<ContextMenuOptions, "actions" | "aside"> | undefined;
    image: (target: Element) => Pick<ContextMenuOptions, "actions" | "aside" | "region"> | undefined;
  };
}

type ContextEntry =
  | { kind: "action"; id: string; label: string; action: () => void | Promise<void>; shortcut?: string }
  | { kind: "separator"; id: string }
  | { kind: "submenu"; id: string; label: string; items: ContextEntry[] };
let currentMenu: { close: () => void } | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function ContextMenuItems({ items, activate }: { items: ContextEntry[]; activate: (action: () => void | Promise<void>) => void }) {
  return <>{items.map((item) => {
    if (item.kind === "separator") return <Separator key={item.id} className="context-menu-separator" />;
    if (item.kind === "submenu") return (
      <SubmenuTrigger key={item.id}>
        <MenuItem id={item.id} className="context-menu-item" textValue={item.label}>
          <Text slot="label">{item.label}</Text><ChevronRight size={14} aria-hidden="true" />
        </MenuItem>
        <Popover className="context-menu-popover" placement="right top" offset={5}>
          <Menu className="context-menu" aria-label={item.label}>
            <ContextMenuItems items={item.items} activate={activate} />
          </Menu>
        </Popover>
      </SubmenuTrigger>
    );
    return <MenuItem key={item.id} id={item.id} className="context-menu-item" textValue={item.label} onAction={() => activate(item.action)}>
      <Text slot="label">{item.label}</Text>
      {item.shortcut && <Text slot="keyboardShortcut" className="context-menu-shortcut">{item.shortcut}</Text>}
    </MenuItem>;
  })}</>;
}

function ContextMenuSurface({ options, items, close, activate }: { options: ContextMenuOptions; items: ContextEntry[]; close: () => void; activate: (action: () => void | Promise<void>) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <MenuTrigger isOpen onOpenChange={(open) => { if (!open) close(); }}>
    <Button ref={trigger} aria-label="Context actions" excludeFromTabOrder className="context-menu-anchor" style={{ left: options.left, top: options.top }} />
    <Popover triggerRef={trigger} className="context-menu-popover" placement="bottom start" offset={0}>
      <Menu className="context-menu" aria-label="Context actions" autoFocus="first">
        <ContextMenuItems items={items} activate={activate} />
      </Menu>
    </Popover>
  </MenuTrigger>;
}

export async function showContextMenu(options: ContextMenuOptions) {
  currentMenu?.close();
  const target = document.activeElement;
  const selection = getSelection();
  const range = target?.tagName !== "IFRAME" && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
  const fieldSelection = field && field.selectionStart !== null && field.selectionEnd !== null
    ? { from: field.selectionStart, to: field.selectionEnd, direction: field.selectionDirection ?? "none" } : null;
  const preferences = options.preferences ?? workspace.getSnapshot().preferences;
  const items: ContextEntry[] = (options.actions ?? []).map((action, index) => ({ kind: "action", id: `action:${index}`, label: action.text, action: action.action }));
  if (options.editable)
    items.push(
      { kind: "action", id: "undo", label: "Undo", shortcut: shortcutLabel("undo", preferences), action: options.native?.undo ?? (() => invoke<void>("editing_action", { action: "undo" })) },
      { kind: "action", id: "redo", label: "Redo", shortcut: shortcutLabel("redo", preferences), action: options.native?.redo ?? (() => invoke<void>("editing_action", { action: "redo" })) },
      { kind: "separator", id: "editing" },
      ...([{ id: "cut", label: "Cut" }, { id: "copy", label: "Copy" }, { id: "paste", label: "Paste" }, { id: "select-all", label: "Select all" }].map((item): ContextEntry => ({ kind: "action", ...item, shortcut: shortcutLabel(item.id, preferences), action: () => invoke<void>("editing_action", { action: item.id }) }))),
    );
  else if (options.copy) items.push({ kind: "action", id: "copy", label: "Copy", shortcut: shortcutLabel("copy", preferences), action: () => invoke<void>("editing_action", { action: "copy" }) });
  if (items.length && (options.aside || options.region))
    items.push({ kind: "separator", id: "aside-separator" });
  if (options.aside) items.push({ kind: "action", id: "aside", label: "Add aside", action: options.aside });
  if (options.region)
    items.push({ kind: "action", id: "region", label: "Comment on region", action: options.region });
  if (options.native?.actions.length)
    items.push(
      { kind: "separator", id: "format-separator" },
      { kind: "submenu", id: "format", label: "Format", items: options.native.actions.map((action, index) => ({ kind: "action", id: `format:${index}`, label: action.text, action: action.action })) },
    );
  if (!items.length) return;
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  return new Promise<void>((resolve, reject) => {
    const close = (complete = true) => {
      currentMenu = null;
      flushSync(() => root?.render(null));
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
      if (range?.commonAncestorContainer.isConnected) {
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      if (fieldSelection && field?.isConnected) field.setSelectionRange(fieldSelection.from, fieldSelection.to, fieldSelection.direction);
      if (complete) resolve();
    };
    const activate = (action: () => void | Promise<void>) => {
      close(false);
      try { Promise.resolve(action()).then(resolve, reject); } catch (error) { reject(error); }
    };
    currentMenu = { close: () => close() };
    flushSync(() => root?.render(<ContextMenuSurface options={options} items={items} close={close} activate={activate} />));
  });
}

export function useContextMenus(
  aside: (() => (() => void) | undefined) | undefined,
  onError: (error: unknown) => void,
  native?: () => ContextMenuOptions["native"],
  preferences?: Preferences,
) {
  const callbacks = useRef({ aside, onError, native, preferences });
  callbacks.current = { aside, onError, native, preferences };
  useEffect(() => {
    const contextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      if (target.closest(".preview-content")) return;
      const editable = target.closest<HTMLElement>(
        'input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable="true"]',
      );
      if (
        !editable &&
        target.closest(
          "button, .library-sidebar, .titlebar, .statusbar, .message-heading",
        )
      )
        return;
      const selection = getSelection();
      const copy = Boolean(
        selection &&
        !selection.isCollapsed &&
        selection.rangeCount &&
        selection.getRangeAt(0).intersectsNode(target),
      );
      const bounds = target.getBoundingClientRect();
      const keyboard = event.clientX === 0 && event.clientY === 0;
      const native = target.closest(".native-content, .page-region-content, .source-editor-host .cm-content")
        ? callbacks.current.native?.()
        : undefined;
      const image = native?.image(target);
      const table = image ? undefined : native?.table(target);
      void showContextMenu({
        preferences: callbacks.current.preferences,
        left: keyboard ? bounds.left : event.clientX,
        top: keyboard ? bounds.bottom : event.clientY,
        editable: !image && Boolean(editable),
        copy: !image && copy,
        actions: image?.actions ?? table?.actions,
        region: image?.region ?? (target.closest(".native-content")
          ? native?.region
          : undefined),
        native: image ? undefined : native,
        aside: image?.aside ?? table?.aside ?? (target.closest(".native-content, .page-region-content, .source-editor-host .cm-content")
          ? callbacks.current.aside?.()
          : undefined),
      }).catch((error) => callbacks.current.onError(error));
    };
    document.addEventListener("contextmenu", contextMenu, true);
    return () => {
      document.removeEventListener("contextmenu", contextMenu, true);
      currentMenu?.close();
    };
  }, []);
}
