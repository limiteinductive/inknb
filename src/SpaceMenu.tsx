import { useSyncExternalStore } from "react";
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
} from "react-aria-components";
import { ChevronDown, Check, SquareArrowOutUpRight } from "lucide-react";
import { workspace } from "./window-workspace";

export default function SpaceMenu() {
  const state = useSyncExternalStore(
    workspace.subscribe,
    workspace.getSnapshot,
  );

  return (
    <MenuTrigger>
      <Button
        className="space-switcher"
        aria-label={`Space: ${state.spaceTitle}`}
        data-inknb-control="space.menu"
      >
        <span>{state.spaceTitle}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </Button>
      <Popover className="space-popover" placement="bottom start" offset={8}>
        <Menu
          className="space-menu"
          aria-label="Spaces"
          onAction={(identity) => {
            const spaceId =
              identity === "window" ? state.spaceId : String(identity);
            if (spaceId)
              void workspace
                .request({
                  kind: "open-space",
                  spaceId,
                  newWindow: identity === "window",
                })
                .catch((error) => workspace.fail(error));
          }}
        >
          {state.spaceRegistry?.spaces.map((space) => (
            <MenuItem
              key={space.id}
              id={space.id}
              data-inknb-control={`space.open:${space.id}`}
              className="space-menu-item"
            >
              <span>{space.title}</span>
              {space.id === state.spaceId && (
                <Check size={15} aria-hidden="true" />
              )}
            </MenuItem>
          ))}
          <MenuItem
            id="window"
            data-inknb-control="space.new-window"
            className="space-menu-item space-menu-divider"
          >
            <span>Open in new window</span>
            <SquareArrowOutUpRight size={15} aria-hidden="true" />
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
