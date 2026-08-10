---
name: apple-contacts
description: Safely search, create, update, and delete Apple Contacts through the local Apple Contacts MCP server.
---

# Apple Contacts MCP

Use this skill when a user asks to inspect or change their local macOS Contacts.

Safety rules:

- Treat contact records as personal data.
- Prefer `contacts_status` before the first contact operation in a thread.
- Use `search_contacts` to find an exact contact before updating.
- Use `append_contact_note` for interaction logs; do not overwrite an existing note unless explicitly asked.
- Do not update or delete a real contact unless the user has approved the exact contact and the exact diff.
- Create/update/append-note/delete tools are dry-run by default. Actual writes require `dryRun: false` and `confirm: true`.
- Avoid returning phone numbers and email addresses unless the user needs those exact fields.
- `search_contacts` only fetches optional field groups (addresses, urls, relatedNames, socialProfiles, instantMessages, customDates, extendedName, orgDetails, birthday) when their `includeX` flag is set — pass only the flags you need to keep searches fast.
- "Relatives" live in the `relatedNames` field (label like spouse/parent/child plus a name); use `includeRelatedNames` to read them and `relatedNames`/`addRelatedNames` to write them.
- Instant messages are read-only (a Contacts.app AppleScript limitation) — `create_contact`/`update_contact` will reject instant-message input.
- Use `list_groups` to find a group's `groupId` before `add_to_group`/`remove_from_group`. Smart Groups (rule-based) can't have membership changed this way — only regular groups.
- There is no `delete_group` tool; groups are deleted directly in Contacts.app, not through this MCP.
- Mention that edits may sync to iCloud, Google, Exchange, or any configured Contacts account.
- Never edit the SQLite AddressBook database directly.

Recommended update flow:

1. Call `search_contacts` with a narrow query.
2. Show the candidate contact and intended change to the user.
3. Call `update_contact` with `dryRun: true` to produce the proposed diff.
4. After explicit approval, call `update_contact` with `dryRun: false` and `confirm: true`.

Recommended note-log flow:

1. Call `search_contacts` with a narrow query.
2. Draft a note entry using `- YYYY-MM-DD - two-sentence interaction summary` plus `Open threads: ...`.
3. Call `append_contact_note` with `dryRun: true`.
4. After explicit approval, call `append_contact_note` with `dryRun: false` and `confirm: true`.
