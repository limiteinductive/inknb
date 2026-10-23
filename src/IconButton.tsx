import { Button, Tooltip, TooltipTrigger } from "react-aria-components";
import type { LucideIcon } from "lucide-react";

export default function IconButton({
  icon: Icon,
  label,
  onPress,
  active = false,
  agentControl,
  disabled = false,
  appearance = "standard",
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  active?: boolean;
  agentControl?: string;
  disabled?: boolean;
  appearance?: "standard" | "glyph";
}) {
  return (
    <TooltipTrigger delay={500}>
      <Button
        className={`icon-button ${active ? "active" : ""} ${appearance === "glyph" ? "icon-button-glyph" : ""}`}
        aria-label={label}
        isDisabled={disabled}
        data-inknb-control={agentControl}
        onPress={onPress}
      >
        <Icon size={appearance === "glyph" ? 14 : 17} strokeWidth={1.6} aria-hidden="true" />
      </Button>
      <Tooltip className="control-tooltip" offset={7}>
        {label}
      </Tooltip>
    </TooltipTrigger>
  );
}
