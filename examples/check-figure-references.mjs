import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";

const [command, consumer = "figure-references"] = process.argv.slice(2);
if (!command) throw new Error("Pass the installed inknb executable path.");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (event.kind !== "document.changed") process.exit(0);

function call(method, parameters = {}) {
  return JSON.parse(
    execFileSync(command, ["call", method, JSON.stringify(parameters)], {
      encoding: "utf8",
    }),
  );
}

const document = call("document_read");
if (
  document.documentId !== event.documentId ||
  document.revision !== event.revision ||
  !document.path
)
  process.exit(0);
const tokens = new MarkdownIt()
  .parse(document.text, {})
  .flatMap((token) => token.children ?? []);
const references = [
  ...new Set(
    tokens
      .filter((token) => token.type === "image")
      .map((token) => String(token.attrGet("src") ?? "")),
  ),
];
const missing = references.filter((reference) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) return false;
  const decoded = decodeURIComponent(reference.split("#")[0].split("?")[0]);
  return !existsSync(path.resolve(path.dirname(document.path), decoded));
});
const content = `Missing local figure files:\n${missing.map((reference) => `• ${reference}`).join("\n")}`;
const owned = document.metadata.threads.filter((thread) =>
  thread.messages.every(
    (message) =>
      message.author === "agent" &&
      message.agent?.provider === "automation" &&
      message.agent.sessionId === consumer,
  ),
);
for (const thread of owned) {
  if (
    !thread.resolved &&
    (missing.length === 0 || thread.messages[0].content !== content)
  )
    call("annotation_resolve", {
      documentId: document.documentId,
      threadId: thread.id,
      consumer,
    });
}
if (
  missing.length === 0 ||
  owned.some((thread) => thread.messages[0].content === content)
)
  process.exit(0);
const digest = createHash("sha256")
  .update(`${document.documentId}:${consumer}:${content}`)
  .digest("hex");
const messageId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
call("annotation_create", {
  documentId: document.documentId,
  revision: document.revision,
  from: 0,
  to: 0,
  expectedText: "",
  messageId,
  consumer,
  label: "Figure references",
  content,
});
