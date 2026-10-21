import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PreviewAnchor } from "./preview-model";

export default function PreviewCapture({
  capture,
}: {
  capture: NonNullable<PreviewAnchor["capture"]>;
}) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setImage(null);
    setError(null);
    void invoke<string>("preview_capture_read", { captureId: capture.id })
      .then((data) => {
        if (current) setImage(`data:image/png;base64,${data}`);
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [capture.id]);
  if (error)
    return (
      <p className="quiet-note" role="alert">
        Preview image unavailable.
      </p>
    );
  return image ? (
    <img
      className="preview-capture"
      src={image}
      width={capture.width}
      height={capture.height}
      alt="Selected preview region"
      draggable={false}
    />
  ) : null;
}
