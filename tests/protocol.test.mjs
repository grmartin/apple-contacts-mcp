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
      "list_groups",
      "create_group",
      "add_to_group",
      "remove_from_group",
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
  const line = JSON.stringify({
    id: "abc",
    name: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    organization: "Analytical Engines",
    jobTitle: "Countess",
    emails: [{ label: "work", value: "ada@example.com" }],
    phones: [{ label: "mobile", value: "+1 555 123 4567" }],
    note: "Existing note",
  });
  const rows = server.parseContactRows(line, { revealValues: false });
  assert.equal(rows[0].emails[0].value, "a***@example.com");
  assert.equal(rows[0].phones[0].value, "***4567");
  assert.equal(rows[0].note, "Existing note");
  assert.equal(rows[0].noteLength, "Existing note".length);
});

test("parses contact rows and reveals values when requested", () => {
  const line = JSON.stringify({
    id: "abc",
    name: "Ada Lovelace",
    relatedNames: [{ label: "spouse", value: "William King" }],
    birthday: "1815-12-10",
  });
  const rows = server.parseContactRows(line, { revealValues: true });
  assert.equal(rows[0].relatedNames[0].value, "William King");
  assert.equal(rows[0].birthday, "1815-12-10");
});

test("search_contacts script uses native Contacts predicates", () => {
  const script = server.searchContactsScript("Ada", 10).join("\n");
  assert.match(script, /people whose name contains queryText/);
  assert.match(script, /people whose value of emails contains queryText/);
  assert.match(script, /people whose value of phones contains queryText/);
  assert.match(script, /seenIds/);
  assert.doesNotMatch(script, /repeat with p in people/);
});

test("search_contacts script omits optional field groups by default (keeps default search fast)", () => {
  const script = server.searchContactsScript("Ada", 10).join("\n");
  assert.doesNotMatch(script, /repeat with a in addresses/);
  assert.doesNotMatch(script, /repeat with rn in related names/);
  assert.doesNotMatch(script, /repeat with sp in social profiles/);
  assert.doesNotMatch(script, /repeat with im in instant messages/);
  assert.doesNotMatch(script, /repeat with cd in custom dates/);
  assert.doesNotMatch(script, /repeat with u in urls/);
  assert.match(script, /addressCountVal/);
});

test("search_contacts script includes only the requested optional field groups", () => {
  const script = server.searchContactsScript("Ada", 10, { relatedNames: true, addresses: true }).join("\n");
  assert.match(script, /repeat with rn in related names/);
  assert.match(script, /repeat with a in addresses/);
  assert.doesNotMatch(script, /repeat with sp in social profiles/);
});

test("create_contact rejects instant messages (Contacts.app AppleScript limitation)", async () => {
  await assert.rejects(
    () =>
      server.callTool("create_contact", {
        firstName: "Codex",
        instantMessages: [{ service: "Skype", userName: "codex" }],
      }),
    /instant messages are read-only/,
  );
});

test("update_contact rejects addInstantMessages", async () => {
  await assert.rejects(
    () =>
      server.callTool("update_contact", {
        contactId: "does-not-matter",
        changes: { addInstantMessages: [{ service: "Skype", userName: "codex" }] },
      }),
    /instant messages are read-only/,
  );
});

test("create_contact dry-run normalizes birthday and related names", async () => {
  const result = await server.callTool("create_contact", {
    firstName: "Codex",
    birthday: "--05-17",
    relatedNames: [{ label: "spouse", value: "Ada Lovelace" }],
  });
  assert.equal(result.wouldCreate.fields["birth date"], "--05-17");
  assert.equal(result.wouldCreate.relatedNames[0].label, "spouse");
  assert.equal(result.wouldCreate.relatedNames[0].value, "Ada Lovelace");
});

test("create_group is dry-run by default", async () => {
  const result = await server.callTool("create_group", { name: "Book Club" });
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldCreate.name, "Book Club");
});

test("create_group requires a name", async () => {
  await assert.rejects(() => server.callTool("create_group", {}), /name is required/);
});

test("list_groups script queries all groups without a filter", () => {
  const script = server.listGroupsScript(null, 200).join("\n");
  assert.match(script, /set candidateGroups to groups/);
  assert.doesNotMatch(script, /groups whose name contains/);
});

test("list_groups script filters by name when a query is given", () => {
  const script = server.listGroupsScript("Book Club", 200).join("\n");
  assert.match(script, /groups whose name contains queryText/);
});

test("AppleScript timeout errors are explicit", () => {
  const detail = server.appleScriptErrorDetail(
    { killed: true, signal: "SIGTERM", message: "Command failed: osascript" },
    "",
    20000,
  );
  assert.match(detail, /osascript timed out after 20000ms/);
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
