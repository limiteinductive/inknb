import { Fragment } from "react";
import type { Message } from "./domain";
import { parseAsideLink } from "./aside-reference";
import { useAsideSession } from "./use-session";

export default function PassageText({ message }: { message: Message }) {
  const session = useAsideSession();
  const references = [...(message.references ?? [])].sort(
    (first, second) => first.from - second.from,
  );
  const boundaries = [
    ...new Set([
      0,
      message.content.length,
      ...references.flatMap((reference) => [reference.from, reference.to]),
    ]),
  ].sort((first, second) => first - second);
  return (
    <p data-message-content="content">
      {boundaries.slice(0, -1).map((from, index) => {
        const to = boundaries[index + 1];
        const reference = references.find(
          (reference) => reference.from <= from && reference.to >= to,
        );
        const text = message.content.slice(from, to);
        if (reference)
          return (
            <button
              key={from}
              type="button"
              className="passage-citation"
              aria-description={reference.source.quote}
              onClick={() => {
                if (!window.getSelection()?.isCollapsed) return;
                void session
                  .control("passage_reveal", reference.source)
                  .catch((error) => session.fail(error));
              }}
            >
              {text}
            </button>
          );
        return (
          <Fragment key={from}>
            {text
              .split(/(inknb:\/\/aside\/[\da-f-]{36}\/[\da-f-]{36})/gi)
              .map((part, position) => {
                const aside = parseAsideLink(part);
                return aside ? (
                  <button
                    type="button"
                    key={position}
                    className="aside-citation"
                    onClick={() => {
                      if (window.getSelection()?.isCollapsed)
                        session.openAside(aside);
                    }}
                  >
                    Referenced aside
                  </button>
                ) : (
                  part
                );
              })}
          </Fragment>
        );
      })}
    </p>
  );
}
