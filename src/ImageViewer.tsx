import { useEffect, useState } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components";
import { X } from "lucide-react";
import IconButton from "./IconButton";
import "./image-viewer.css";

export default function ImageViewer() {
  const [image, setImage] = useState<{ source: string; description: string } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    const open = (event: Event) => {
      const target = event instanceof CustomEvent ? event.detail : event.target;
      if (!(target instanceof HTMLImageElement) || !target.matches(".native-content img, .attached-image img, .response-content img, .preview-capture")) return;
      if (!target.complete || !target.naturalWidth) return;
      event.preventDefault();
      event.stopPropagation();
      setZoomed(false);
      setImage({ source: target.currentSrc || target.src, description: target.alt });
    };
    document.addEventListener("dblclick", open, true);
    window.addEventListener("inknb-image-zoom", open);
    return () => {
      document.removeEventListener("dblclick", open, true);
      window.removeEventListener("inknb-image-zoom", open);
    };
  }, []);
  return (
    <ModalOverlay className="modal-overlay" isOpen={Boolean(image)} onOpenChange={open => { if (!open) setImage(null); }} isDismissable>
      <Modal className="image-viewer">
        <Dialog aria-label={image?.description || "Image preview"}>
          <div className="image-viewer-scroll" data-zoomed={zoomed}>
            <Button
              className="image-viewer-image"
              aria-label={zoomed ? "Fit image to window" : "Zoom to actual size"}
              aria-pressed={zoomed}
              data-inknb-control="image.zoom"
              onPress={() => setZoomed(current => !current)}
            >
              {image && <img src={image.source} alt={image.description} draggable={false} />}
            </Button>
          </div>
          <div className="image-viewer-close">
            <IconButton icon={X} appearance="glyph" label="Close image preview" agentControl="image.close" onPress={() => setImage(null)} />
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
