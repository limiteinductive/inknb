import { useLayoutEffect, useRef, useState } from "react";
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Tooltip,
  TooltipTrigger,
} from "react-aria-components";
import { Check, ChevronDown, Users } from "lucide-react";
import { agentAttribution, requestAgentIds } from "./domain";
import type { Metadata, Preferences } from "./domain";
import type { AsideDraft } from "./images";

export default function CommentRecipients({
  metadata,
  preferences,
  draft,
  threadId,
  controlId,
  compact = false,
  disabled = false,
  onChange,
}: {
  metadata: Metadata;
  preferences: Preferences;
  draft?: AsideDraft;
  threadId?: string;
  controlId: string;
  compact?: boolean;
  disabled?: boolean;
  onChange: (recipients: string[]) => void;
}) {
  const recipients = requestAgentIds(
    metadata,
    threadId,
    draft,
    preferences.comment_recipients,
  );
  const disconnected = recipients.filter(
    (identity) => !metadata.agents.some((agent) => agent.id === identity),
  );
  const label = recipients
    .map((identity) => {
      const agent = metadata.agents.find((agent) => agent.id === identity);
      return agent ? agentAttribution(agent) : "Disconnected agent";
    })
    .join(", ");
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasOpen.current && !open)
      queueMicrotask(() => trigger.current?.focus({ preventScroll: true }));
    wasOpen.current = open;
  }, [open]);
  if (
    preferences.comment_recipients === "default" ||
    (metadata.agents.length < 2 && !disconnected.length)
  )
    return null;
  return (
    <MenuTrigger isOpen={open} onOpenChange={setOpen}>
      <TooltipTrigger delay={500}>
        <Button
          ref={trigger}
          className="text-button recipient-trigger"
          data-compact={compact}
          data-inknb-control={`recipient.open:${controlId}`}
          aria-label={`Send to agents: ${label || "Choose recipients"}`}
          isDisabled={disabled}
        >
          {compact && <Users size={14} aria-hidden="true" />}
          {(!compact || recipients.length > 1) && (
            <span>
              {recipients.length > 1
                ? `${recipients.length}${compact ? "" : " agents"}`
                : label || "Choose recipients"}
            </span>
          )}
          <ChevronDown size={12} aria-hidden="true" />
        </Button>
        <Tooltip className="control-tooltip" offset={7}>
          Send to: {label || "Choose recipients"}
        </Tooltip>
      </TooltipTrigger>
      <Popover className="menu-popover" placement="bottom start" offset={5}>
        <Menu
          className="menu"
          aria-label="Send to agents"
          selectionMode="multiple"
          shouldCloseOnSelect={false}
          disallowEmptySelection
          selectedKeys={recipients}
          onSelectionChange={(selection) => {
            if (selection !== "all" && selection.size)
              onChange([...selection].map(String));
          }}
        >
          {disconnected.map((identity) => (
            <MenuItem
              key={identity}
              id={identity}
              className="menu-item"
              textValue="Disconnected agent"
            >
              {({ isSelected }) => (
                <>
                  <span>Disconnected agent</span>
                  {isSelected && <Check size={15} aria-hidden="true" />}
                </>
              )}
            </MenuItem>
          ))}
          {metadata.agents.map((agent) => (
            <MenuItem
              key={agent.id}
              id={agent.id}
              textValue={agentAttribution(agent)}
              className="menu-item"
              data-inknb-control={`recipient.select:${agent.id}`}
            >
              {({ isSelected }) => (
                <>
                  <span>{agentAttribution(agent)}</span>
                  {isSelected && <Check size={15} aria-hidden="true" />}
                </>
              )}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
