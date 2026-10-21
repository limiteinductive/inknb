import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

const [command, builder, ...arguments_] = process.argv.slice(2);
if (!command || !builder || !isAbsolute(command) || !isAbsolute(builder))
  throw Error("Supply absolute inknb and builder executable paths.");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  !["document.changed", "document.opened", "document.saved"].includes(
    event.kind,
  )
)
  process.exit(0);

function call(method, parameters) {
  return JSON.parse(
    execFileSync(command, ["call", method, JSON.stringify(parameters)], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

const document = call("document_read", { documentId: event.documentId });
const preview = call("preview_read", { documentId: document.documentId });
if (preview.preview?.sourceHash === document.textHash) process.exit(0);
call("preview_build", {
  documentId: document.documentId,
  sourceHash: document.textHash,
  status: "building",
  message: null,
});
try {
  const directory = execFileSync(builder, arguments_, {
    input: JSON.stringify(document),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  call("preview_publish", {
    documentId: document.documentId,
    path: directory,
    expectedArtifactId: preview.preview?.artifactId ?? null,
  });
} catch (error) {
  const message = String(error.message).slice(0, 2000);
  call("preview_build", {
    documentId: document.documentId,
    sourceHash: document.textHash,
    status: "failed",
    message,
  });
  throw error;
}
