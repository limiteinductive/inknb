import catalog from "./shortcuts.json";
import type { Preferences } from "./domain";

export type ShortcutScope = "application" | "editor" | "composer" | "annotation";

export function normalizeShortcut(binding: string): string {
  return binding.trim().split(/\s+/).map(stroke => {
    const modifiers: string[] = [];
    let key = "";
    for (const part of stroke.split("+")) {
      const name = part.toLowerCase();
      const modifier = ["mod", "cmdorctrl", "commandorcontrol"].includes(name) ? (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Ctrl")
        : ["cmd", "command", "meta", "super"].includes(name) ? "Meta"
        : ["ctrl", "control"].includes(name) ? "Ctrl"
        : ["alt", "option"].includes(name) ? "Alt"
        : name === "shift" ? "Shift" : null;
      if (modifier) { modifiers.push(modifier); continue; }
      key = /^[a-z]$/i.test(part) ? `Key${part.toUpperCase()}` : /^\d$/.test(part) ? `Digit${part}`
        : ({ Esc: "Escape", Return: "Enter", Spacebar: "Space", "\\": "Backslash", "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote", "`": "Backquote" } as Record<string, string>)[part] ?? part;
    }
    return [...modifiers.sort(), key].join("+");
  }).join(" ");
}

export function shortcutBindings(identity: string, preferences: Pick<Preferences, "shortcuts">): string[] {
  const command = catalog.find(command => command.id === identity);
  return [...new Set((preferences.shortcuts[identity] ?? command?.defaults ?? []).map(normalizeShortcut))];
}

export function shortcutLabel(identity: string, preferences: Pick<Preferences, "shortcuts">): string {
  const binding = shortcutBindings(identity, preferences)[0];
  if (!binding) return "";
  const labels: Record<string, string> = { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↵", Escape: "Esc", Space: "Space", Tab: "⇥", Backspace: "⌫", Delete: "⌦", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Equal: "=", Minus: "−", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
  return binding.split(" ").map(stroke => stroke.split("+").map(part => labels[part] ?? part.replace(/^(Key|Digit)/, "")).join("")).join(" ");
}

export function shortcutTooltip(label: string, identity: string, preferences: Pick<Preferences, "shortcuts">): string {
  const shortcut = shortcutLabel(identity, preferences);
  return shortcut ? `${label} (${shortcut})` : label;
}

let focusVersion = 0;
if (typeof document !== "undefined") document.addEventListener("focusin", () => { focusVersion++; }, true);

export class ShortcutResolver {
  private sequence = "";
  private updatedAt = 0;
  private configuration = "";
  private target: EventTarget | null = null;
  private focusVersion = 0;

  handle(event: KeyboardEvent, preferences: Pick<Preferences, "shortcuts" | "shortcut_timeout_ms">, scope: ShortcutScope, run: (identity: string) => boolean | void): boolean {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
    const configuration = JSON.stringify(preferences.shortcuts);
    if (focusVersion !== this.focusVersion || event.target !== this.target || configuration !== this.configuration || performance.now() - this.updatedAt > preferences.shortcut_timeout_ms) this.sequence = "";
    this.focusVersion = focusVersion;
    this.configuration = configuration;
    this.target = event.target;
    if (this.sequence && event.key === "Escape") {
      this.sequence = "";
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    const modifiers = [event.altKey ? "Alt" : "", event.ctrlKey ? "Ctrl" : "", event.metaKey ? "Meta" : "", event.shiftKey ? "Shift" : ""].filter(Boolean);
    const key = event.code || normalizeShortcut(event.key);
    const stroke = [...modifiers, key].join("+");
    const commands = catalog.filter(command => command.scope === scope);
    let sequence = this.sequence ? `${this.sequence} ${stroke}` : stroke;
    let candidates = commands.filter(command => shortcutBindings(command.id, preferences).some(binding => binding === sequence || binding.startsWith(`${sequence} `)));
    if (!candidates.length && !["Control", "Meta", "Alt", "Shift"].includes(event.key)) {
      sequence = stroke;
      candidates = commands.filter(command => shortcutBindings(command.id, preferences).some(binding => binding === sequence || binding.startsWith(`${sequence} `)));
      this.sequence = "";
    }
    if (!candidates.length) {
      const context = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-shortcut-scope]")?.dataset.shortcutScope : null;
      const contextual = catalog.filter(command => command.scope === context);
      const retired = commands.some(command => command.defaults.some(binding => normalizeShortcut(binding) === stroke));
      const rebound = contextual.some(command => shortcutBindings(command.id, preferences).some(binding => binding === stroke || binding.startsWith(`${stroke} `)));
      if (!retired || rebound) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    const command = candidates.find(command => shortcutBindings(command.id, preferences).includes(sequence));
    this.sequence = command ? "" : sequence;
    this.updatedAt = performance.now();
    if (command && !(event.repeat && "repeat" in command && command.repeat === false) && run(command.id) === false) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
}
