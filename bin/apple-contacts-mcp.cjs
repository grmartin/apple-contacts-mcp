#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const readline = require("node:readline");

const SERVER_NAME = "apple-contacts-mcp";
const SERVER_VERSION = "0.2.0";
const FIELD_SEPARATOR = "\t";
const LIST_SEPARATOR = ",";
const MAX_SEARCH_LIMIT = 25;

const SERVER_INSTRUCTIONS = [
  "This server accesses local macOS Contacts through Contacts.app automation.",
  "Treat returned contact data as personal data.",
  "Call contacts_status before the first operation in a thread.",
  "Use search_contacts to identify an exact contact before updating.",
  "Use append_contact_note for dated interaction logs instead of overwriting notes manually.",
  "Create, update, and delete tools are dry-run by default.",
  "Actual writes require dryRun=false and confirm=true.",
  "Delete also requires confirmPhrase=\"delete contact\".",
  "Avoid returning email and phone values unless the user needs exact fields.",
  "Local writes may sync to iCloud, Google, Exchange, or other configured Contacts accounts.",
].join(" ");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolError(message) {
  const payload = { ok: false, error: message };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function appleString(value) {
  const s = String(value ?? "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${s}"`;
}

function appleMultilineString(value) {
  const lines = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
  if (!lines.length) return '""';
  return lines.map((line) => `"${line}"`).join(" & linefeed & ");
}

function scrubInput(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function requireString(args, key) {
  const value = scrubInput(args[key]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function optionalString(args, key, maxLength = 500) {
  if (args[key] == null) return null;
  return scrubInput(args[key], maxLength);
}

function boolValue(args, key, defaultValue = false) {
  if (args[key] == null) return defaultValue;
  return args[key] === true;
}

function numberValue(args, key, defaultValue) {
  const raw = args[key];
  if (raw == null) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  return parsed;
}

function normalizeLimit(value) {
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(value || 10)));
}

function normalizeLabel(value, fallback) {
  const label = scrubInput(value || fallback, 40).toLowerCase();
  return label || fallback;
}

function normalizeEmail(value) {
  const email = scrubInput(value, 320);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`invalid email address: ${email || "(empty)"}`);
  }
  return email;
}

function normalizePhone(value) {
  const phone = scrubInput(value, 80);
  if (!phone || !/[0-9]/.test(phone)) {
    throw new Error(`invalid phone number: ${phone || "(empty)"}`);
  }
  return phone;
}

function normalizeLabeledValues(values, kind) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error(`${kind} must be an array`);
  return values.slice(0, 10).map((item) => {
    if (typeof item === "string") {
      return {
        label: kind === "emails" ? "work" : "mobile",
        value: kind === "emails" ? normalizeEmail(item) : normalizePhone(item),
      };
    }
    if (!isPlainObject(item)) throw new Error(`${kind} entries must be objects or strings`);
    return {
      label: normalizeLabel(item.label, kind === "emails" ? "work" : "mobile"),
      value: kind === "emails" ? normalizeEmail(item.value) : normalizePhone(item.value),
    };
  });
}

function maskEmail(value) {
  const email = String(value || "");
  const at = email.indexOf("@");
  if (at <= 0) return email ? "[redacted-email]" : "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain}`;
}

function maskPhone(value) {
  const phone = String(value || "");
  const digits = phone.replace(/\D/g, "");
  if (!digits) return phone ? "[redacted-phone]" : "";
  return `***${digits.slice(-4)}`;
}

function commonHandlers() {
  return [
    "on scrub(v)",
    "  try",
    "    if v is missing value then return \"\"",
    "    set s to v as text",
    "  on error",
    "    return \"\"",
    "  end try",
    "  set oldDelims to AppleScript's text item delimiters",
    "  set AppleScript's text item delimiters to tab",
    "  set parts to text items of s",
    "  set AppleScript's text item delimiters to \" \"",
    "  set s to parts as text",
    "  set AppleScript's text item delimiters to linefeed",
    "  set parts to text items of s",
    "  set AppleScript's text item delimiters to \" \"",
    "  set s to parts as text",
    "  set AppleScript's text item delimiters to oldDelims",
    "  return s",
    "end scrub",
    "",
    "on joinList(values, delimiterText)",
    "  set oldDelims to AppleScript's text item delimiters",
    "  set AppleScript's text item delimiters to delimiterText",
    "  set output to values as text",
    "  set AppleScript's text item delimiters to oldDelims",
    "  return output",
    "end joinList",
  ];
}

function runAppleScript(lines, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [];
    for (const line of lines) args.push("-e", line);
    childProcess.execFile(
      "osascript",
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = [stderr && stderr.trim(), error.message].filter(Boolean).join(" ");
          reject(new Error(detail || "osascript failed"));
          return;
        }
        resolve(String(stdout || "").trim());
      },
    );
  });
}

function parsePairList(value) {
  if (!value) return [];
  return String(value)
    .split(LIST_SEPARATOR)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const equals = item.indexOf("=");
      if (equals === -1) return { label: "", value: item };
      return { label: item.slice(0, equals), value: item.slice(equals + 1) };
    });
}

function parseContactRows(
  text,
  { includeEmails = false, includePhones = false, includeNote = false, revealValues = false } = {},
) {
  if (!text) return [];
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, firstName, lastName, organization, jobTitle, emailsText, phonesText, noteText] =
        line.split(FIELD_SEPARATOR);
      const emails = parsePairList(emailsText);
      const phones = parsePairList(phonesText);
      const contact = {
        id,
        name,
        firstName,
        lastName,
        organization,
        jobTitle,
        emailCount: emails.length,
        phoneCount: phones.length,
      };
      if (includeEmails) {
        contact.emails = emails.map((item) => ({
          label: item.label,
          value: revealValues ? item.value : maskEmail(item.value),
        }));
      }
      if (includePhones) {
        contact.phones = phones.map((item) => ({
          label: item.label,
          value: revealValues ? item.value : maskPhone(item.value),
        }));
      }
      if (includeNote) {
        contact.note = noteText || "";
        contact.noteLength = contact.note.length;
      }
      return contact;
    });
}

function contactRowScriptForPerson(personRef = "p") {
  return [
    `set emailValues to {}`,
    `repeat with e in emails of ${personRef}`,
    `  set end of emailValues to (my scrub(label of e) & "=" & my scrub(value of e))`,
    `end repeat`,
    `set phoneValues to {}`,
    `repeat with ph in phones of ${personRef}`,
    `  set end of phoneValues to (my scrub(label of ph) & "=" & my scrub(value of ph))`,
    `end repeat`,
    `set emailText to my joinList(emailValues, ${appleString(LIST_SEPARATOR)})`,
    `set phoneText to my joinList(phoneValues, ${appleString(LIST_SEPARATOR)})`,
    `set outputRow to ((id of ${personRef} as text) & tab & my scrub(name of ${personRef}) & tab & my scrub(first name of ${personRef}) & tab & my scrub(last name of ${personRef}) & tab & my scrub(organization of ${personRef}) & tab & my scrub(job title of ${personRef}) & tab & emailText & tab & phoneText & tab & my scrub(note of ${personRef}))`,
  ];
}

async function contactsStatus() {
  const script = [
    ...commonHandlers(),
    "tell application \"Contacts\"",
    "  set peopleCount to count of people",
    "  set groupCount to count of groups",
    "  return \"people=\" & peopleCount & tab & \"groups=\" & groupCount",
    "end tell",
  ];
  const output = await runAppleScript(script);
  const fields = Object.fromEntries(
    output
      .split(FIELD_SEPARATOR)
      .map((part) => part.split("="))
      .filter((pair) => pair.length === 2),
  );
  return {
    ok: true,
    backend: "contacts-app-applescript",
    writeSupported: true,
    dryRunDefault: true,
    peopleCount: Number(fields.people || 0),
    groupCount: Number(fields.groups || 0),
    note: "Writes may sync to iCloud, Google, Exchange, or another configured Contacts account.",
  };
}

async function searchContacts(args) {
  const query = requireString(args, "query");
  const limit = normalizeLimit(numberValue(args, "limit", 10));
  const includeEmails = boolValue(args, "includeEmails", false);
  const includePhones = boolValue(args, "includePhones", false);
  const includeNote = boolValue(args, "includeNote", false);
  const revealValues = boolValue(args, "revealValues", false);
  const script = [
    ...commonHandlers(),
    `set queryText to ${appleString(query)}`,
    `set maxResults to ${limit}`,
    "tell application \"Contacts\"",
    "  set rows to {}",
    "  repeat with p in people",
    "    set searchableText to (my scrub(name of p) & \" \" & my scrub(first name of p) & \" \" & my scrub(last name of p) & \" \" & my scrub(organization of p) & \" \" & my scrub(job title of p))",
    "    repeat with e in emails of p",
    "      set searchableText to searchableText & \" \" & my scrub(value of e)",
    "    end repeat",
    "    repeat with ph in phones of p",
    "      set searchableText to searchableText & \" \" & my scrub(value of ph)",
    "    end repeat",
    "    set matched to false",
    "    ignoring case",
    "      if searchableText contains queryText then set matched to true",
    "    end ignoring",
    "    if matched then",
    ...contactRowScriptForPerson("p").map((line) => `      ${line}`),
    "      set end of rows to outputRow",
    "      if (count of rows) is greater than or equal to maxResults then exit repeat",
    "    end if",
    "  end repeat",
    "  return my joinList(rows, linefeed)",
    "end tell",
  ];
  const output = await runAppleScript(script);
  const contacts = parseContactRows(output, { includeEmails, includePhones, includeNote, revealValues });
  return {
    ok: true,
    query,
    limit,
    count: contacts.length,
    redacted: (includeEmails || includePhones) && !revealValues,
    contacts,
  };
}

function buildScalarProperties(args) {
  const properties = {};
  for (const [argKey, outputKey] of [
    ["firstName", "first name"],
    ["lastName", "last name"],
    ["organization", "organization"],
    ["jobTitle", "job title"],
    ["department", "department"],
    ["nickname", "nickname"],
    ["note", "note"],
  ]) {
    const value = optionalString(args, argKey);
    if (value != null) properties[outputKey] = value;
  }
  return properties;
}

function scalarSummary(properties) {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value]));
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDate(value) {
  const date = scrubInput(value || localDateString(), 40);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error("date must use YYYY-MM-DD");
  }
  return date;
}

function normalizeOpenThreads(value) {
  if (value == null) return [];
  if (typeof value === "string") {
    const item = scrubInput(value, 800);
    return item ? [item] : [];
  }
  if (!Array.isArray(value)) throw new Error("openThreads must be a string or array of strings");
  return value
    .slice(0, 20)
    .map((item) => scrubInput(item, 500))
    .filter(Boolean);
}

function formatContactLogEntry({ date, summary, openThreads }) {
  const safeDate = normalizeDate(date);
  const safeSummary = scrubInput(summary, 1200);
  if (!safeSummary) throw new Error("summary is required");
  const threads = normalizeOpenThreads(openThreads);
  const openThreadText = threads.length ? threads.join("; ") : "None";
  return `- ${safeDate} - ${safeSummary}\n  Open threads: ${openThreadText}`;
}

function propertyAssignmentScript(personRef, properties, indent = "") {
  return Object.entries(properties).map(([key, value]) => {
    const expression = key === "note" ? appleMultilineString(value) : appleString(value);
    return `${indent}set ${key} of ${personRef} to ${expression}`;
  });
}

function propertyLiteral(key, value) {
  const expression = key === "note" ? appleMultilineString(value) : appleString(value);
  return `${key}:${expression}`;
}

async function createContact(args) {
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  const properties = buildScalarProperties(args);
  const emails = normalizeLabeledValues(args.emails || args.emailAddresses, "emails");
  const phones = normalizeLabeledValues(args.phones || args.phoneNumbers, "phones");
  if (!properties["first name"] && !properties["last name"] && !properties.organization) {
    throw new Error("create_contact requires firstName, lastName, or organization");
  }
  const proposed = {
    fields: scalarSummary(properties),
    emails,
    phones,
  };
  if (dryRun || !confirm) {
    return {
      ok: true,
      dryRun: true,
      wouldCreate: proposed,
      requiredForWrite: { dryRun: false, confirm: true },
    };
  }
  const propertyParts = Object.entries(properties).map(([key, value]) => propertyLiteral(key, value));
  const script = [
    ...commonHandlers(),
    "tell application \"Contacts\"",
    `  set p to make new person with properties {${propertyParts.join(", ")}}`,
    ...emails.map(
      (item) =>
        `  make new email at end of emails of p with properties {label:${appleString(item.label)}, value:${appleString(item.value)}}`,
    ),
    ...phones.map(
      (item) =>
        `  make new phone at end of phones of p with properties {label:${appleString(item.label)}, value:${appleString(item.value)}}`,
    ),
    "  save",
    ...contactRowScriptForPerson("p").map((line) => `  ${line}`),
    "  return outputRow",
    "end tell",
  ];
  const output = await runAppleScript(script);
  return {
    ok: true,
    dryRun: false,
    created: parseContactRows(output, { includeEmails: true, includePhones: true, revealValues: false })[0],
  };
}

async function getContactById(contactId, options = {}) {
  const script = [
    ...commonHandlers(),
    `set contactId to ${appleString(contactId)}`,
    "tell application \"Contacts\"",
    "  set matches to people whose id is contactId",
    "  if (count of matches) is not 1 then error \"expected exactly one contact for id \" & contactId & \", found \" & (count of matches)",
    "  set p to item 1 of matches",
    ...contactRowScriptForPerson("p").map((line) => `  ${line}`),
    "  return outputRow",
    "end tell",
  ];
  const output = await runAppleScript(script);
  return parseContactRows(output, options)[0];
}

async function updateContact(args) {
  const contactId = requireString(args, "contactId");
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  const changes = isPlainObject(args.changes) ? args.changes : args;
  const properties = buildScalarProperties(changes);
  const addEmails = normalizeLabeledValues(changes.addEmails || changes.emailsToAdd, "emails");
  const addPhones = normalizeLabeledValues(changes.addPhones || changes.phonesToAdd, "phones");
  if (!Object.keys(properties).length && !addEmails.length && !addPhones.length) {
    throw new Error("update_contact requires at least one scalar field, note, addEmails, or addPhones");
  }
  const before = await getContactById(contactId, {
    includeEmails: true,
    includePhones: true,
    includeNote: Object.prototype.hasOwnProperty.call(properties, "note"),
    revealValues: false,
  });
  const proposed = {
    contactId,
    before,
    changes: {
      fields: scalarSummary(properties),
      addEmails,
      addPhones,
    },
  };
  if (dryRun || !confirm) {
    return {
      ok: true,
      dryRun: true,
      proposed,
      requiredForWrite: { dryRun: false, confirm: true },
    };
  }
  const script = [
    ...commonHandlers(),
    `set contactId to ${appleString(contactId)}`,
    "tell application \"Contacts\"",
    "  set matches to people whose id is contactId",
    "  if (count of matches) is not 1 then error \"expected exactly one contact for id \" & contactId & \", found \" & (count of matches)",
    "  set p to item 1 of matches",
    ...propertyAssignmentScript("p", properties, "  "),
    ...addEmails.map(
      (item) =>
        `  make new email at end of emails of p with properties {label:${appleString(item.label)}, value:${appleString(item.value)}}`,
    ),
    ...addPhones.map(
      (item) =>
        `  make new phone at end of phones of p with properties {label:${appleString(item.label)}, value:${appleString(item.value)}}`,
    ),
    "  save",
    ...contactRowScriptForPerson("p").map((line) => `  ${line}`),
    "  return outputRow",
    "end tell",
  ];
  const output = await runAppleScript(script);
  return {
    ok: true,
    dryRun: false,
    before,
    after: parseContactRows(output, {
      includeEmails: true,
      includePhones: true,
      includeNote: Object.prototype.hasOwnProperty.call(properties, "note"),
      revealValues: false,
    })[0],
  };
}

async function appendContactNote(args) {
  const contactId = requireString(args, "contactId");
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  const appendedEntry = formatContactLogEntry({
    date: args.date,
    summary: args.summary,
    openThreads: args.openThreads,
  });
  const before = await getContactById(contactId, { includeNote: true });
  const proposed = {
    contactId,
    contact: {
      id: before.id,
      name: before.name,
      organization: before.organization,
      jobTitle: before.jobTitle,
      noteLength: before.noteLength || 0,
    },
    appendedEntry,
  };
  if (dryRun || !confirm) {
    return {
      ok: true,
      dryRun: true,
      proposed,
      requiredForWrite: { dryRun: false, confirm: true },
    };
  }
  const script = [
    ...commonHandlers(),
    `set contactId to ${appleString(contactId)}`,
    `set appendedEntry to ${appleMultilineString(appendedEntry)}`,
    "tell application \"Contacts\"",
    "  set matches to people whose id is contactId",
    "  if (count of matches) is not 1 then error \"expected exactly one contact for id \" & contactId & \", found \" & (count of matches)",
    "  set p to item 1 of matches",
    "  try",
    "    set existingNote to note of p",
    "    if existingNote is missing value then set existingNote to \"\"",
    "  on error",
    "    set existingNote to \"\"",
    "  end try",
    "  if existingNote is \"\" then",
    "    set note of p to appendedEntry",
    "  else",
    "    set note of p to existingNote & linefeed & appendedEntry",
    "  end if",
    "  save",
    ...contactRowScriptForPerson("p").map((line) => `  ${line}`),
    "  return outputRow",
    "end tell",
  ];
  const output = await runAppleScript(script);
  return {
    ok: true,
    dryRun: false,
    appended: true,
    appendedEntry,
    beforeNoteLength: before.noteLength || 0,
    after: parseContactRows(output, { includeNote: true })[0],
  };
}

async function deleteContact(args) {
  const contactId = requireString(args, "contactId");
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  const confirmPhrase = scrubInput(args.confirmPhrase);
  const before = await getContactById(contactId, { includeEmails: true, includePhones: true, revealValues: false });
  if (dryRun || !confirm || confirmPhrase !== "delete contact") {
    return {
      ok: true,
      dryRun: true,
      wouldDelete: before,
      requiredForWrite: { dryRun: false, confirm: true, confirmPhrase: "delete contact" },
    };
  }
  const script = [
    `set contactId to ${appleString(contactId)}`,
    "tell application \"Contacts\"",
    "  set matches to people whose id is contactId",
    "  if (count of matches) is not 1 then error \"expected exactly one contact for id \" & contactId & \", found \" & (count of matches)",
    "  delete item 1 of matches",
    "  save",
    "  return \"deleted\"",
    "end tell",
  ];
  await runAppleScript(script);
  return { ok: true, dryRun: false, deleted: before };
}

async function testRoundtrip(args) {
  const confirm = boolValue(args, "confirm", false);
  if (!confirm) {
    return {
      ok: true,
      dryRun: true,
      wouldCreateEditAndDelete: true,
      requiredForWrite: { confirm: true },
    };
  }
  const unique = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const email = `codex-dummy-${unique}@example.invalid`;
  const created = await createContact({
    firstName: "Codex",
    lastName: "Dummy Contact",
    organization: "Apple Contacts MCP Test",
    note: "Initial smoke-test note.",
    emails: [{ label: "work", value: email }],
    dryRun: false,
    confirm: true,
  });
  const contactId = created.created.id;
  const editedTitle = "Edited by Apple Contacts MCP";
  const updated = await updateContact({
    contactId,
    changes: { jobTitle: editedTitle },
    dryRun: false,
    confirm: true,
  });
  const editedOk = updated.after.jobTitle === editedTitle;
  const noteResult = await appendContactNote({
    contactId,
    summary: "Created and edited a dummy contact to verify Apple Contacts MCP note logging.",
    openThreads: ["Delete the dummy contact before finishing the smoke test"],
    dryRun: false,
    confirm: true,
  });
  const noteOk = noteResult.after.note.includes("Created and edited a dummy contact");
  const deleted = await deleteContact({
    contactId,
    dryRun: false,
    confirm: true,
    confirmPhrase: "delete contact",
  });
  return {
    ok: true,
    created: true,
    editedOk,
    noteOk,
    deleted: Boolean(deleted.deleted),
    testEmail: email,
  };
}

function toolDefinitions() {
  return [
    {
      name: "contacts_status",
      title: "Contacts Status",
      description: "Check Apple Contacts access and return aggregate counts without exposing contact values.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "search_contacts",
      title: "Search Contacts",
      description: "Search Apple Contacts by name, organization, job title, email, or phone.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: MAX_SEARCH_LIMIT },
          includeEmails: { type: "boolean", default: false },
          includePhones: { type: "boolean", default: false },
          includeNote: { type: "boolean", default: false },
          revealValues: { type: "boolean", default: false },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "create_contact",
      title: "Create Contact",
      description: "Create an Apple Contact. Dry-run by default; actual writes require dryRun=false and confirm=true.",
      inputSchema: {
        type: "object",
        properties: {
          firstName: { type: "string" },
          lastName: { type: "string" },
          organization: { type: "string" },
          jobTitle: { type: "string" },
          department: { type: "string" },
          nickname: { type: "string" },
          note: { type: "string" },
          emails: { type: "array", items: { type: "object" } },
          phones: { type: "array", items: { type: "object" } },
          dryRun: { type: "boolean", default: true },
          confirm: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
    {
      name: "update_contact",
      title: "Update Contact",
      description: "Update an Apple Contact by contactId. Dry-run by default; actual writes require dryRun=false and confirm=true.",
      inputSchema: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          changes: { type: "object" },
          dryRun: { type: "boolean", default: true },
          confirm: { type: "boolean", default: false },
        },
        required: ["contactId", "changes"],
        additionalProperties: false,
      },
    },
    {
      name: "append_contact_note",
      title: "Append Contact Note",
      description: "Append a dated interaction log entry to a contact note. Dry-run by default; actual writes require dryRun=false and confirm=true.",
      inputSchema: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD. Defaults to the local current date." },
          summary: { type: "string", description: "Short interaction summary, ideally two sentences." },
          openThreads: { type: "array", items: { type: "string" } },
          dryRun: { type: "boolean", default: true },
          confirm: { type: "boolean", default: false },
        },
        required: ["contactId", "summary"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_contact",
      title: "Delete Contact",
      description: "Delete an Apple Contact by contactId. Dry-run by default and requires confirmPhrase='delete contact'.",
      inputSchema: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          dryRun: { type: "boolean", default: true },
          confirm: { type: "boolean", default: false },
          confirmPhrase: { type: "string" },
        },
        required: ["contactId"],
        additionalProperties: false,
      },
    },
    {
      name: "test_roundtrip",
      title: "Test Contacts Roundtrip",
      description: "Create, edit, verify, and delete one dummy contact. Requires confirm=true.",
      inputSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
  ];
}

async function callTool(name, args) {
  if (!isPlainObject(args)) throw new Error("tool arguments must be an object");
  if (name === "contacts_status") return contactsStatus(args);
  if (name === "search_contacts") return searchContacts(args);
  if (name === "create_contact") return createContact(args);
  if (name === "update_contact") return updateContact(args);
  if (name === "append_contact_note") return appendContactNote(args);
  if (name === "delete_contact") return deleteContact(args);
  if (name === "test_roundtrip") return testRoundtrip(args);
  throw new Error(`unknown Apple Contacts MCP tool: ${name}`);
}

async function handleRpc(message) {
  if (!isPlainObject(message)) return rpcError(null, -32600, "Invalid Request");
  const messageId = message.id;
  const method = message.method;
  const params = isPlainObject(message.params) ? message.params : {};
  if (typeof method !== "string") return messageId != null ? rpcError(messageId, -32600, "Invalid Request") : null;
  if (method.startsWith("notifications/") || method === "$/cancelRequest") return null;
  try {
    if (method === "initialize") {
      return rpcResponse(messageId, {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          title: "Apple Contacts MCP",
          version: SERVER_VERSION,
          description: "Local-first MCP server for safely searching, editing, and maintaining Apple Contacts notes on macOS.",
        },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    if (method === "ping") return rpcResponse(messageId, {});
    if (method === "tools/list") return rpcResponse(messageId, { tools: toolDefinitions() });
    if (method === "tools/call") {
      const name = params.name;
      if (typeof name !== "string") return rpcError(messageId, -32602, "tools/call requires a tool name");
      const args = params.arguments || {};
      if (!isPlainObject(args)) return rpcError(messageId, -32602, "tools/call arguments must be an object");
      try {
        return rpcResponse(messageId, toolResult(await callTool(name, args)));
      } catch (error) {
        return rpcResponse(messageId, toolError(error && error.message ? error.message : String(error)));
      }
    }
    if (method === "resources/list") return rpcResponse(messageId, { resources: [] });
    if (method === "resources/templates/list") return rpcResponse(messageId, { resourceTemplates: [] });
    if (method === "prompts/list") return rpcResponse(messageId, { prompts: [] });
  } catch (error) {
    return rpcError(messageId, -32000, error && error.message ? error.message : String(error));
  }
  return rpcError(messageId, -32601, `Method not found: ${method}`);
}

function writeRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function runStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let decoded;
    try {
      decoded = JSON.parse(trimmed);
    } catch (error) {
      writeRpc(rpcError(null, -32700, `Parse error: ${error.message}`));
      return;
    }
    if (Array.isArray(decoded)) {
      const responses = [];
      for (const request of decoded) {
        const response = await handleRpc(request);
        if (response) responses.push(response);
      }
      if (responses.length) writeRpc(responses);
      return;
    }
    const response = await handleRpc(decoded);
    if (response) writeRpc(response);
  });
}

module.exports = {
  SERVER_NAME,
  SERVER_VERSION,
  toolDefinitions,
  callTool,
  formatContactLogEntry,
  handleRpc,
  parseContactRows,
  maskEmail,
  maskPhone,
};

if (require.main === module) {
  runStdio();
}
