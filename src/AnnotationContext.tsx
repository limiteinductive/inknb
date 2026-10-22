import { X } from "lucide-react";
import type { MessageAnnotation } from "./passage-reference";
import { useAsideSession } from "./use-session";
import IconButton from "./IconButton";
import "./passage-annotations.css";

export default function AnnotationContext({
  annotations,
  onRemove,
}: {
  annotations: MessageAnnotation[];
  onRemove?: (id: string) => void;
}) {
  const session = useAsideSession();
  return (
    <div className="annotation-context" aria-label="Passage context">
      {annotations.map((annotation) => (
        <div className="annotation-context-entry" key={annotation.id}>
          <div className="annotation-context-text">
            {annotation.comment && (
              <p data-message-content={`annotation-comment:${annotation.id}`}>
                {annotation.comment}
              </p>
            )}
            <button
              type="button"
              className="annotation-context-source"
              data-message-content={`annotation-quote:${annotation.id}`}
              aria-label={`Show passage: ${annotation.source.quote}`}
              onClick={() => {
                if (!window.getSelection()?.isCollapsed) return;
                void session
                  .control("passage_reveal", annotation.source)
                  .catch((error) => session.fail(error));
              }}
            >
              {annotation.source.quote}
            </button>
          </div>
          {onRemove && (
            <IconButton
              icon={X}
              label="Remove annotation context"
              onPress={() => onRemove(annotation.id)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
