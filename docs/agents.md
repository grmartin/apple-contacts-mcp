# Using Apple Contacts MCP With Agents

Apple Contacts MCP is a stdio MCP server. Any MCP-capable agent can use it by launching:

```bash
node /absolute/path/to/apple-contacts-mcp/bin/apple-contacts-mcp.cjs
```

Recommended agent policy:

- Call `contacts_status` first.
- Search narrowly.
- Prefer redacted results unless exact email/phone values are needed.
- Only pass the `includeX` flags on `search_contacts` you actually need (e.g. `includeRelatedNames`, `includeAddresses`, `includeBirthday`) — each one adds AppleScript work per result, and the defaults are tuned to keep a plain name search fast.
- Instant messages are read-only; don't attempt to create or update them.
- Treat returned contact data as personal data.
- Never write on the first pass. Use dry-run output as the user-facing diff.
- Apply writes only after explicit user approval.
- For interaction history, prefer `append_contact_note` over `update_contact` so existing notes are preserved.
- Keep appended notes short: one dated bullet, a two-sentence summary, and open threads.

Example MCP client configuration:

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

Recommended contact-note flow:

1. Use `search_contacts` to find the exact person.
2. Call `append_contact_note` with `dryRun: true`.
3. Show the appended note entry to the user.
4. After approval, call `append_contact_note` with `dryRun: false` and `confirm: true`.
