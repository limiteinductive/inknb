import { Dialog, Popover } from "react-aria-components";
import type { PopoverProps } from "react-aria-components";
import type { ReactNode } from "react";
import "./panel.css";

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
  children: ReactNode;
}) {
  return (
    <Popover
      {...properties}
      className={`${className} panel-surface`}
      data-size={size}
      placement="bottom end"
      offset={8}
      maxHeight={660}
    >
      <Dialog aria-label={label}>
        <header className="panel-heading">
          {leading}
          <h2 slot="title">{title}</h2>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
        {children}
      </Dialog>
    </Popover>
  );
}
