import { EditorSelection, EditorState, Text } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { MessageSquarePlus } from "lucide-react";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  dropCursor,
  gutter,
  keymap,
  placeholder,
  showTooltip,
  tooltips,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import {
  agentEditField,
  agentEditHistory,
  anchorField,
  anchorHistory,
  conversationField,
  selectionActionField,
  setSelectionAction,
} from "./text-state";
import type { DocumentSession } from "./session";
import { threadHasStaleSources } from "./domain";

class ConversationMarker extends GutterMarker {
  constructor(readonly stale: boolean) {
    super();
  }
  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = `conversation-marker ${this.stale ? "stale" : ""}`;
    marker.textContent = "·";
    marker.setAttribute(
      "aria-label",
      this.stale
        ? "A source changed. Open this conversation."
        : "Open conversation on this line",
    );
    return marker;
  }
}

class InlineConversation extends WidgetType {
  constructor(
    readonly identity: string,
    readonly render: (host: HTMLElement, identity: string) => () => void,
  ) {
    super();
  }
  private cleanup: (() => void) | undefined;
  eq(other: InlineConversation): boolean {
    return other.identity === this.identity;
  }
  toDOM(): HTMLElement {
    const host = document.createElement("div");
    host.className = "inline-conversation";
    this.cleanup = this.render(host, this.identity);
    return host;
  }
  destroy(): void {
    queueMicrotask(() => this.cleanup?.());
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export function createEditor(
  host: HTMLElement,
  session: DocumentSession,
  render: (host: HTMLElement, identity: string) => () => void,
): EditorView {
  const snapshot = session.getSnapshot();
  const decorations = EditorView.decorations.compute(
    [anchorField, conversationField, "doc"],
    (state) => {
      const anchors = state.field(anchorField);
      const active = state.field(conversationField);
      const ranges: Range<Decoration>[] = [];
      for (const [identity, anchor] of Object.entries(anchors)) {
        if (anchor.status === "detached") continue;
        if (identity === active.identity) {
          if (anchor.to > anchor.from)
            ranges.push(
              Decoration.mark({ class: "annotated-passage" }).range(
                anchor.from,
                anchor.to,
              ),
            );
          if (active.inline)
            ranges.push(
              Decoration.widget({
                widget: new InlineConversation(identity, render),
                block: true,
                side: 1,
              }).range(state.doc.lineAt(anchor.to).to),
            );
        }
      }
      return Decoration.set(ranges, true);
    },
  );
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: Text.of(snapshot.text.split("\n")),
      selection: EditorSelection.range(
        Math.min(snapshot.selection.from, snapshot.text.length),
        Math.min(snapshot.selection.to, snapshot.text.length),
      ),
      extensions: [
        EditorState.lineSeparator.of("\n"),
        EditorView.contentAttributes.of({
          "aria-label": "Manuscript",
          spellcheck: "true",
          autocapitalize: "sentences",
          autocorrect: "on",
        }),
        EditorView.lineWrapping,
        history(),
        anchorField.init(() =>
          Object.fromEntries(
            snapshot.metadata.threads.map((thread) => [
              thread.id,
              thread.anchor,
            ]),
          ),
        ),
        conversationField.init(() => ({
          identity: snapshot.activeThread,
          inline: snapshot.preferences.placement === "inline",
        })),
        selectionActionField,
        tooltips({
          tooltipSpace(view) {
            const rectangle = view.scrollDOM.getBoundingClientRect();
            return {
              left: rectangle.left + 12,
              right: rectangle.right - 12,
              top: rectangle.top + 8,
              bottom: rectangle.bottom - 8,
            };
          },
        }),
        showTooltip.compute(["selection", selectionActionField], (state) => {
          const selection = state.selection.main;
          if (selection.empty || state.field(selectionActionField) !== "ready")
            return null;
          return {
            pos: selection.head,
            above: selection.head < selection.anchor,
            create(view) {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "icon-button selection-aside";
              button.setAttribute("aria-label", "Add aside");
              button.title = "Add aside";
              button.dataset.inknbControl = "aside.selection";
              const iconRoot = createRoot(button);
              iconRoot.render(
                createElement(MessageSquarePlus, {
                  size: 17,
                  strokeWidth: 1.6,
                  "aria-hidden": true,
                }),
              );
              button.addEventListener("mousedown", (event) =>
                event.preventDefault(),
              );
              button.addEventListener("click", () => session.startComment());
              button.addEventListener("keydown", (event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                view.dispatch({ effects: setSelectionAction.of("hidden") });
                view.focus();
              });
              return {
                dom: button,
                offset: { x: 0, y: 8 },
                getCoords(position) {
                  const viewport = view.scrollDOM.getBoundingClientRect();
                  const head = view.coordsAtPos(position);
                  if (!head)
                    return {
                      left: viewport.left,
                      right: viewport.left,
                      top: viewport.bottom,
                      bottom: viewport.bottom,
                    };
                  if (
                    head.bottom <= viewport.top ||
                    head.top >= viewport.bottom
                  )
                    return head;
                  const anchor = view.coordsAtPos(selection.anchor);
                  const top = Math.min(head.top, anchor?.top ?? head.top);
                  const bottom = Math.max(
                    head.bottom,
                    anchor?.bottom ?? head.bottom,
                  );
                  const actionSpace = button.offsetHeight + 8;
                  if (
                    top - actionSpace < viewport.top + 8 &&
                    bottom + actionSpace > viewport.bottom - 8
                  )
                    return head;
                  return {
                    left: head.left,
                    right: head.right,
                    top,
                    bottom,
                  };
                },
                destroy() {
                  queueMicrotask(() => iconRoot.unmount());
                },
              };
            },
          };
        }),
        ViewPlugin.define(
          (view) => {
            const finishSelection = (event: PointerEvent) => {
              if (view.state.field(selectionActionField) !== "selecting")
                return;
              view.dispatch({
                effects: setSelectionAction.of(
                  event.type === "pointercancel" ? "hidden" : "ready",
                ),
              });
            };
            window.addEventListener("pointerup", finishSelection);
            window.addEventListener("pointercancel", finishSelection);
            return {
              destroy() {
                window.removeEventListener("pointerup", finishSelection);
                window.removeEventListener("pointercancel", finishSelection);
              },
            };
          },
          {
            eventHandlers: {
              pointerdown(event, view) {
                if (event.button === 0)
                  view.dispatch({
                    effects: setSelectionAction.of("selecting"),
                  });
              },
              blur(event, view) {
                const action = view.dom.querySelector(".selection-aside");
                if (action?.contains(event.relatedTarget as Node | null))
                  return;
                view.dispatch({ effects: setSelectionAction.of("hidden") });
              },
            },
          },
        ),
        agentEditField.init(() =>
          Object.fromEntries(
            snapshot.metadata.proposals
              .filter(
                (proposal) =>
                  proposal.status === "applied" || proposal.status === "undone",
              )
              .map((proposal) => [
                proposal.id,
                proposal.status as "applied" | "undone",
              ]),
          ),
        ),
        agentEditHistory,
        anchorHistory,
        decorations,
        search({ top: true }),
        dropCursor(),
        placeholder("Begin here."),
        gutter({
          class: "conversation-gutter",
          lineMarker(view, line) {
            const hasAnchor = Object.values(view.state.field(anchorField)).some(
              (anchor) =>
                anchor.status !== "detached" &&
                anchor.from >= line.from &&
                anchor.from <= line.to,
            );
            const stale = session
              .getSnapshot()
              .metadata.threads.some(
                (thread) =>
                  thread.anchor.from >= line.from &&
                  thread.anchor.from <= line.to &&
                  threadHasStaleSources(thread),
              );
            return hasAnchor ? new ConversationMarker(stale) : null;
          },
          lineMarkerChange: (update) =>
            update.docChanged ||
            update.startState.field(anchorField) !==
              update.state.field(anchorField),
          domEventHandlers: {
            mousedown(view, line) {
              const match = Object.entries(view.state.field(anchorField)).find(
                ([, anchor]) =>
                  anchor.status !== "detached" &&
                  anchor.from >= line.from &&
                  anchor.from <= line.to,
              );
              if (match) {
                session.selectThread(match[0]);
                return true;
              }
              return false;
            },
          },
        }),
        keymap.of([
          {
            key: "Mod-Shift-a",
            run: () => {
              session.startComment();
              return true;
            },
          },
          {
            key: "Escape",
            run: () => {
              session.selectThread(null);
              session.update({
                composer: false,
                activeThread: null,
                focus: false,
              });
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) =>
          session.onEditorUpdate(update),
        ),
      ],
    }),
  });
  view.scrollDOM.setAttribute("aria-label", "Writing surface");
  view.scrollDOM.dataset.inknbControl = "manuscript";
  view.scrollDOM.dataset.inknbScroll = "true";
  session.view = view;
  return view;
}
