import { Button, DialogTrigger, Switch } from "react-aria-components";
import { invoke } from "@tauri-apps/api/core";
import { useDocumentSession, useSession } from "./use-session";
import PanelPopover, { PanelBody, PanelEmpty } from "./PanelPopover";
import { agentAttribution } from "./domain";

export default function AgentConnections() {
  const session = useDocumentSession();
  const state = useSession();
  return (
    <DialogTrigger>
      <Button
        className={`connection-status ${state.metadata.agents.length ? "connected" : ""}`}
        aria-label={`Agent connections, ${state.metadata.agents.length}`}
        data-inknb-control="agents.open"
      >
        <span className="status-dot" />
      </Button>
      <PanelPopover
        className="agent-connection-popover"
        title="Agents"
        label="Agent connections"
      >
        <PanelBody className="agent-connection-body">
          {!state.metadata.agents.length && (
            <PanelEmpty>No agents connected.</PanelEmpty>
          )}
          {state.metadata.agents.map((agent) => (
            <div className="connected-agent" key={agent.id}>
              <strong>{agentAttribution(agent)}</strong>
              <details>
                <summary>{agent.provider} session</summary>
                <code>{agent.sessionId}</code>
                <span>Self-declared identity</span>
              </details>
              <div className="agent-actions">
                {agent.sessionUrl && (
                  <Button
                    className="text-button"
                    onPress={() =>
                      void invoke("open_reference", {
                        documentPath: state.path,
                        reference: agent.sessionUrl,
                      }).catch((error) => session.fail(error))
                    }
                  >
                    Open session
                  </Button>
                )}
                <Button
                  className="text-button"
                  isDisabled={state.metadata.defaultAgentId === agent.id}
                  onPress={() =>
                    void session
                      .control("agent_default", {
                        documentId: state.metadata.documentId,
                        agentId: agent.id,
                      })
                      .catch((error) => session.fail(error))
                  }
                >
                  {state.metadata.defaultAgentId === agent.id
                    ? "Default recipient"
                    : "Make default"}
                </Button>
                <Button
                  className="text-button"
                  onPress={() =>
                    void session
                      .control("agent_disconnect", {
                        documentId: state.metadata.documentId,
                        agentId: agent.id,
                      })
                      .catch((error) => session.fail(error))
                  }
                >
                  Disconnect
                </Button>
              </div>
            </div>
          ))}
          <Switch
            className="permission"
            isSelected={session.agentAccess === "edit"}
            onChange={(enabled) =>
              session.changed({
                ...state.metadata,
                agentAccess: enabled ? "edit" : "read",
              })
            }
          >
            <span className="switch-track">
              <span />
            </span>
            Allow agent edits in this document
          </Switch>
          {state.metadata.agentAccess !== null && (
            <Button
              className="text-button"
              onPress={() =>
                session.changed({ ...state.metadata, agentAccess: null })
              }
            >
              Use app default
            </Button>
          )}
        </PanelBody>
      </PanelPopover>
    </DialogTrigger>
  );
}
