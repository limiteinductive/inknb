import { Dialog, Modal, ModalOverlay, Popover } from "react-aria-components";
import type { PopoverProps } from "react-aria-components";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import IconButton from "./IconButton";
import "./panel.css";

interface PanelContentProps {
  title: string;
  label?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

function PanelContent({ title, label = title, leading, actions, children }: PanelContentProps) {
  return <Dialog aria-label={label}>
    <header className="panel-heading">
      {leading}
      <h2 slot="title">{title}</h2>
      {actions && <div className="panel-actions">{actions}</div>}
    </header>
    {children}
  </Dialog>;
}

export function PanelModal({ open, onOpenChange, className, size = "standard", placement = "center", agentControl, closeControl = "panel.close", actions, ...content }: PanelContentProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className: string;
  size?: "standard" | "wide";
  placement?: "center" | "top";
  agentControl?: string;
  closeControl?: string;
}) {
  return <ModalOverlay isOpen={open} onOpenChange={onOpenChange} isDismissable className="modal-overlay panel-overlay" data-placement={placement}>
    <Modal className={`${className} panel-surface`} data-size={size} data-inknb-control={agentControl}>
      <PanelContent {...content} actions={<>{actions}<IconButton icon={X} label={`Close ${content.title.toLowerCase()}`} agentControl={closeControl} appearance="glyph" onPress={() => onOpenChange(false)} /></>} />
    </Modal>
  </ModalOverlay>;
}

export function PanelBody({
  children,
  className = "",
  layout = "detail",
}: {
  children: ReactNode;
  className?: string;
  layout?: "detail" | "list";
}) {
  return (
    <div className={`panel-body ${className}`} data-layout={layout}>
      {children}
    </div>
  );
}

export function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="panel-empty" role="status">
      {children}
    </p>
  );
}

export default function PanelPopover({
  className,
  title,
  label = title,
  leading,
  actions,
  size = "standard",
  presentation = "popover",
  agentControl,
  closeControl,
  children,
  ...properties
}: Omit<
  PopoverProps,
  "children" | "className" | "placement" | "offset" | "maxHeight"
> & {
  className: string;
  title: string;
  label?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  size?: "standard" | "wide";
  presentation?: "popover" | "modal";
  agentControl?: string;
  closeControl?: string;
  children: ReactNode;
}) {
  if (presentation === "modal") return <PanelModal open={properties.isOpen ?? false} onOpenChange={open => properties.onOpenChange?.(open)} className={className} title={title} label={label} leading={leading} actions={actions} size={size} agentControl={agentControl} closeControl={closeControl}>{children}</PanelModal>;
  return (
    <Popover
      {...properties}
      className={`${className} panel-surface`}
      data-size={size}
      data-inknb-control={agentControl}
      placement="bottom end"
      offset={8}
      maxHeight={660}
    >
      <PanelContent title={title} label={label} leading={leading} actions={actions}>{children}</PanelContent>
    </Popover>
  );
}
