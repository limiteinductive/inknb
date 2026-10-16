import { EditorState, Text } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  dropCursor,
  gutter,
  keymap,
  placeholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { search, searchKeymap } from "@codemirror/search";
import {
  agentEditField,
  agentEditHistory,
  anchorField,
  anchorHistory,
  conversationField,
} from "./text-state";
import { session } from "./session";
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
        conversationField,
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
        markdown(),
        syntaxHighlighting(
          HighlightStyle.define([
            {
              tag: tags.heading1,
              fontSize: "1.7em",
              fontWeight: "500",
              letterSpacing: "-.025em",
            },
            { tag: tags.heading2, fontSize: "1.3em", fontWeight: "500" },
            { tag: tags.heading3, fontWeight: "600" },
            { tag: tags.strong, fontWeight: "600" },
            { tag: tags.emphasis, fontStyle: "italic" },
            {
              tag: tags.monospace,
              fontFamily: "var(--mono-font)",
              fontSize: ".8em",
            },
            { tag: [tags.link, tags.url], color: "var(--accent)" },
            {
              tag: [tags.processingInstruction, tags.meta],
              color: "var(--faint)",
            },
          ]),
        ),
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
          ...markdownKeymap,
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
