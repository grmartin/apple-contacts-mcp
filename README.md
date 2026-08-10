# Apple Contacts MCP

Local-first MCP server for safely searching, editing, and maintaining Apple Contacts notes on macOS.

The server uses `Contacts.app` automation through AppleScript today. That keeps install simple and uses macOS privacy prompts instead of cloud credentials. Writes are dry-run by default and require explicit confirmation.

## Tools

- `contacts_status`: check Contacts.app access and return aggregate counts.
- `search_contacts`: search local contacts by name, organization, job title, email, or phone. Optional field groups (emails, phones, note, extendedName, orgDetails, birthday, addresses, urls, relatedNames, socialProfiles, instantMessages, customDates) are only fetched when their `includeX` flag is set, so a default search stays fast.
- `create_contact`: create a contact, including name/title/phonetic fields, organization, birthday, note, emails, phones, addresses, urls, related names ("relatives"), social profiles, and custom dates. Dry-run by default.
- `update_contact`: update any scalar field or append new emails, phones, addresses, urls, related names, social profiles, or custom dates. Dry-run by default.
- `append_contact_note`: append a dated interaction log entry to a contact note. Dry-run by default.
- `list_groups`: list Contacts.app groups by id, name, and member count. Optional `query` filters by name substring.
- `create_group`: create a new group. Dry-run by default.
- `add_to_group` / `remove_from_group`: add or remove a contact from a group by `contactId` and `groupId`. Dry-run by default.
- `delete_contact`: delete a contact. Dry-run by default and requires a confirmation phrase.
- `test_roundtrip`: create, edit, verify, and delete one dummy contact.

## Field Coverage

Almost every field Contacts.app exposes over AppleScript is supported for read and write:

- **Name**: firstName, middleName, lastName, title, suffix, nickname, maidenName, phoneticFirstName/MiddleName/LastName
- **Org**: organization, department, jobTitle, isCompany
- **Dates**: birthday (`YYYY-MM-DD`, or `--MM-DD` for no year), custom dates (e.g. Anniversary)
- **Contact methods**: emails, phones, urls
- **Addresses**: label, street, city, state, zip, country, countryCode
- **Related names**: Apple's "relatives" field — label (spouse, parent, child, ...) plus a name
- **Social profiles**: service, userName, url
- **Note**: free text, with `append_contact_note` for dated logs

Two exclusions:

- **Photos** are not read or written. Even checking whether a contact *has* a photo via AppleScript (`image of person`) forces Contacts.app to transfer the full image over Apple Events — roughly 1-2 seconds per contact — so it's left out entirely to keep searches fast.
- **Instant messages** are read-only. `search_contacts` can return them, but `make new instant message` reliably fails under Contacts.app AppleScript automation on current macOS (a platform limitation, not a bug in this server), so `create_contact`/`update_contact` reject any instant-message input with a clear error.

## Groups

`list_groups`, `create_group`, `add_to_group`, and `remove_from_group` manage Contacts.app groups and membership. Smart Groups (rule-based, built from search criteria) are not scriptable for membership changes — `add_to_group`/`remove_from_group` only work on regular groups. There is no `delete_group` tool yet; delete a group directly in Contacts.app if needed.

## Requirements

- macOS with Contacts.app
- Node.js 18 or newer
- Contacts/Automation permissions when macOS prompts

## Quick Start

```bash
git clone <repo-url>
cd apple-contacts-mcp
npm test
npm run smoke
```

`npm run smoke` verifies the MCP handshake and tool list without touching Contacts.

To run a live dummy create/edit/note/delete roundtrip:

```bash
npm run smoke:live
```

macOS may prompt for Contacts or Automation permissions. The live smoke test creates one dummy contact, edits it, appends a note, verifies the change, and deletes the dummy.

## Install For Your Agent

This is a stdio MCP server. Any MCP-capable agent needs the same command:

```bash
node /absolute/path/to/apple-contacts-mcp/bin/apple-contacts-mcp.cjs
```

Use an absolute path. Relative paths are easy to break when an agent launches MCP servers from another working directory.

## Install In Codex

After cloning:

```bash
codex mcp add apple-contacts -- node /absolute/path/to/apple-contacts-mcp/bin/apple-contacts-mcp.cjs
```

Then restart Codex or start a new Codex thread so the MCP tools are loaded.

To confirm the server is registered:

```bash
codex mcp list
```

Ask Codex:

```text
Use apple-contacts to run contacts_status.
```

## Install In Claude Desktop

Open the Claude Desktop config file on macOS:

```bash
open "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

Add this under the top-level `mcpServers` object, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "apple-contacts": {
      "command": "node",
      "args": ["/absolute/path/to/apple-contacts-mcp/bin/apple-contacts-mcp.cjs"]
    }
  }
}
```

If the file already has other MCP servers, add only the `apple-contacts` entry inside the existing `mcpServers` object.

Ask Claude:

```text
Use the Apple Contacts MCP server to run contacts_status. Do not show any contact values.
```

## Install In Other Agents

Add a stdio MCP server with:

```json
{
  "mcpServers": {
    "apple-contacts": {
      "command": "node",
      "args": ["/absolute/path/to/apple-contacts-mcp/bin/apple-contacts-mcp.cjs"]
    }
  }
}
```

If your agent has an MCP CLI, use its equivalent of:

```bash
<agent> mcp add apple-contacts -- node /absolute/path/to/apple-contacts-mcp/bin/apple-contacts-mcp.cjs
```

Good first prompt for any agent:

```text
Install this repository as a local MCP server named apple-contacts. Use the absolute path to bin/apple-contacts-mcp.cjs, then restart or reload your MCP tools and run contacts_status. Treat contact data as personal data and keep writes dry-run unless I explicitly approve them.
```

## Permissions

This server automates `Contacts.app` locally. The first live call may trigger macOS permission prompts for Contacts and/or Automation. Approve those prompts for the terminal or app that is launching the MCP server.

If a call fails because `Contacts.app` is not running, open Contacts and retry:

```bash
open -a Contacts
```

## Write Safety

Create, update, and delete operations are dry-run by default. An actual write must pass both:

```json
{
  "dryRun": false,
  "confirm": true
}
```

Delete also requires:

```json
{
  "confirmPhrase": "delete contact"
}
```

This gives agents a natural two-step flow: propose the change first, then apply only after user approval.

## Contact Notes

Use `append_contact_note` for CRM-style interaction logs instead of overwriting the full note field.

Input:

```json
{
  "contactId": "CONTACT-ID-FROM-search_contacts",
  "date": "2026-06-04",
  "summary": "Met at an AI founder dinner. They are interested in local-first agent tooling.",
  "openThreads": [
    "Send the GitHub repo",
    "Follow up about a demo next week"
  ],
  "dryRun": true
}
```

The appended note entry uses:

```text
- 2026-06-04 - Met at an AI founder dinner. They are interested in local-first agent tooling.
  Open threads: Send the GitHub repo; Follow up about a demo next week
```

An actual append requires:

```json
{
  "dryRun": false,
  "confirm": true
}
```

## Privacy

This server runs locally on your Mac. It does not call a cloud API or upload contacts on its own. Your agent will still see whatever contact data you ask the MCP server to return, so use field filters and redaction when possible.

Contacts may sync through iCloud, Google, Exchange, or another configured account. A local write can propagate to those services.

## Current Backend

The first backend is AppleScript automation of `Contacts.app`. A future backend may use a signed Swift helper around Apple's `Contacts.framework` for more structured access.

Direct SQLite writes to `~/Library/Application Support/AddressBook` are intentionally not supported.

## License

MIT
