import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const server = require("../bin/apple-contacts-mcp.cjs");

test("lists the expected MCP tools", () => {
  assert.deepEqual(
    server.toolDefinitions().map((tool) => tool.name),
    [
      "contacts_status",
      "search_contacts",
      "create_contact",
      "update_contact",
      "append_contact_note",
      "delete_contact",
      "test_roundtrip",
    ],
  );
});

test("initialize returns server metadata", async () => {
  const response = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(response.result.serverInfo.name, "apple-contacts-mcp");
});

test("create_contact is dry-run by default", async () => {
  const result = await server.callTool("create_contact", {
    firstName: "Codex",
    lastName: "Dry Run",
    note: "Dry-run note",
    emails: [{ label: "work", value: "codex-dry-run@example.invalid" }],
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldCreate.fields["first name"], "Codex");
  assert.equal(result.wouldCreate.fields.note, "Dry-run note");
});

test("parses contact rows and redacts values by default", () => {
  const rows = server.parseContactRows(
    "abc\tAda Lovelace\tAda\tLovelace\tAnalytical Engines\tCountess\twork=ada@example.com\tmobile=+1 555 123 4567\tExisting note",
    { includeEmails: true, includePhones: true, includeNote: true, revealValues: false },
  );
  assert.equal(rows[0].emails[0].value, "a***@example.com");
  assert.equal(rows[0].phones[0].value, "***4567");
  assert.equal(rows[0].note, "Existing note");
});

test("formats contact log entries", () => {
  const entry = server.formatContactLogEntry({
    date: "2026-06-04",
    summary: "Met after a founder event. They want a follow-up demo.",
    openThreads: ["Send repo", "Schedule demo"],
  });
  assert.equal(
    entry,
    "- 2026-06-04 - Met after a founder event. They want a follow-up demo.\n  Open threads: Send repo; Schedule demo",
  );
});
