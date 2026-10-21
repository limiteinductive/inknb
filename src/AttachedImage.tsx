import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ImageAsset } from "./images";

export default function AttachedImage({ image }: { image: ImageAsset }) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setSource(null);
    setFailed(false);
    void invoke<string>("image_read", {
      imageId: image.id,
      mediaType: image.mediaType,
    })
      .then((data) => {
        if (current) setSource(`data:${image.mediaType};base64,${data}`);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [image.id, image.mediaType]);
  if (failed)
    return (
      <p className="quiet-note" role="alert">
        Image unavailable: {image.name}
      </p>
    );
  return source ? (
    <img src={source} alt={image.name} draggable={false} />
  ) : (
    <span className="quiet-note">Loading image…</span>
  );
}
