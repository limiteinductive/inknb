import { Button, Tooltip, TooltipTrigger } from "react-aria-components";
import type { LucideIcon } from "lucide-react";

export default function IconButton({
  icon: Icon,
  label,
  onPress,
  active = false,
  agentControl,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  active?: boolean;
  agentControl?: string;
  disabled?: boolean;
}) {
  return (
    <TooltipTrigger delay={500}>
      <Button
        className={`icon-button ${active ? "active" : ""}`}
        aria-label={label}
        isDisabled={disabled}
        data-inknb-control={agentControl}
        onPress={onPress}
      >
        <Icon size={17} strokeWidth={1.6} aria-hidden="true" />
      </Button>
      <Tooltip className="control-tooltip" offset={7}>
        {label}
      </Tooltip>
    </TooltipTrigger>
  );
}
