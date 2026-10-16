import { execFileSync } from "node:child_process";

const [command] = process.argv.slice(2);
if (!command) throw new Error("Pass the installed inknb executable path.");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (event.kind !== "component.event" || event.payload.name !== "inspect-result")
  process.exit(0);

function call(method, parameters = {}) {
  return JSON.parse(
    execFileSync(command, ["call", method, JSON.stringify(parameters)], {
      encoding: "utf8",
    }),
  );
}

const document = call("document_read");
if (document.documentId !== event.documentId)
  throw new Error(
    "Open the event's document before handling this interaction.",
  );
const { component } = call("component_read", {
  componentId: event.payload.componentId,
});
if (component.data.handledEvent === event.id) process.exit(0);
const schedule = event.payload.payload.schedule;
const measurement = component.data.schedules.find(
  (row) => row.name === schedule,
);
if (!measurement)
  throw new Error("This schedule is no longer in the component data.");
call("component_update", {
  documentId: document.documentId,
  componentId: component.id,
  revision: component.revision,
  data: {
    ...component.data,
    handledEvent: event.id,
    answer: {
      schedule,
      text: `${measurement.plants} plants, ${measurement.water} litres. The count does not establish independent replication.`,
    },
  },
});
