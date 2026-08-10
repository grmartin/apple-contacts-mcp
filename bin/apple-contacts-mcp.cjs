#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const readline = require("node:readline");

const SERVER_NAME = "apple-contacts-mcp";
const SERVER_VERSION = "0.3.0";
const MAX_SEARCH_LIMIT = 25;
const MAX_GROUP_LIMIT = 200;

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
  "search_contacts only fetches optional field groups (addresses, urls, relatedNames, socialProfiles, instantMessages, customDates, extendedName, orgDetails, birthday) when their includeX flag is set, to keep default searches fast.",
  "Instant messages are read-only: Contacts.app AppleScript automation cannot create or edit them (a macOS limitation).",
  "Groups: list_groups, create_group, add_to_group, and remove_from_group manage Contacts.app groups and membership.",
  "Smart Groups are rule-based and are not scriptable for membership changes; add_to_group/remove_from_group only work on regular groups.",
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

function normalizeGroupLimit(value) {
  return Math.max(1, Math.min(MAX_GROUP_LIMIT, Math.floor(value || MAX_GROUP_LIMIT)));
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

function normalizeAddresses(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error("addresses must be an array");
  return values.slice(0, 10).map((item) => {
    if (!isPlainObject(item)) throw new Error("addresses entries must be objects");
    const address = {
      label: normalizeLabel(item.label, "home"),
      street: optionalString(item, "street", 500) || "",
      city: optionalString(item, "city", 200) || "",
      state: optionalString(item, "state", 200) || "",
      zip: optionalString(item, "zip", 40) || "",
      country: optionalString(item, "country", 200) || "",
      countryCode: optionalString(item, "countryCode", 10) || "",
    };
    if (!address.street && !address.city && !address.state && !address.zip && !address.country) {
      throw new Error("addresses entries need at least one of street, city, state, zip, or country");
    }
    return address;
  });
}

function normalizeUrls(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error("urls must be an array");
  return values.slice(0, 10).map((item) => {
    if (typeof item === "string") {
      const value = scrubInput(item, 2000);
      if (!value) throw new Error("urls entries require a value");
      return { label: "home page", value };
    }
    if (!isPlainObject(item)) throw new Error("urls entries must be objects or strings");
    const value = scrubInput(item.value, 2000);
    if (!value) throw new Error("urls entries require a value");
    return { label: normalizeLabel(item.label, "home page"), value };
  });
}

function normalizeRelatedNames(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error("relatedNames must be an array");
  return values.slice(0, 10).map((item) => {
    if (!isPlainObject(item)) throw new Error("relatedNames entries must be objects");
    const label = scrubInput(item.label, 40);
    const value = scrubInput(item.value, 200);
    if (!label) throw new Error("relatedNames entries require a label (e.g. spouse, parent, child)");
    if (!value) throw new Error("relatedNames entries require a value (the related person's name)");
    return { label, value };
  });
}

function normalizeSocialProfiles(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error("socialProfiles must be an array");
  return values.slice(0, 10).map((item) => {
    if (!isPlainObject(item)) throw new Error("socialProfiles entries must be objects");
    const service = scrubInput(item.service, 100);
    const userName = scrubInput(item.userName, 200);
    const url = scrubInput(item.url, 2000);
    if (!service) throw new Error("socialProfiles entries require a service name");
    if (!userName && !url) throw new Error("socialProfiles entries require userName or url");
    return { service, userName, url };
  });
}

function normalizeDateParts(value) {
  const raw = scrubInput(value, 20);
  let match = /^--(\d{2})-(\d{2})$/.exec(raw);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`invalid date: ${raw}`);
    return { year: 1604, month, day };
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`invalid date: ${raw}`);
    return { year, month, day };
  }
  throw new Error(`date must use YYYY-MM-DD or --MM-DD (no year), got: ${raw || "(empty)"}`);
}

function formatDatePartsIso({ year, month, day }) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  if (year === 1604) return `--${mm}-${dd}`;
  return `${year}-${mm}-${dd}`;
}

function normalizeCustomDates(values) {
  if (values == null) return [];
  if (!Array.isArray(values)) throw new Error("customDates must be an array");
  return values.slice(0, 10).map((item) => {
    if (!isPlainObject(item)) throw new Error("customDates entries must be objects");
    const label = scrubInput(item.label, 40);
    if (!label) throw new Error("customDates entries require a label (e.g. Anniversary)");
    return { label, ...normalizeDateParts(item.value) };
  });
}

function rejectInstantMessages(value) {
  if (value == null) return;
  throw new Error(
    "instant messages are read-only: Contacts.app AppleScript automation cannot create or update them (a macOS limitation)",
  );
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
    "",
    "on replaceText(s, findText, replaceTextV)",
    "  set oldDelims to AppleScript's text item delimiters",
    "  set AppleScript's text item delimiters to findText",
    "  set parts to text items of s",
    "  set AppleScript's text item delimiters to replaceTextV",
    "  set outputText to parts as text",
    "  set AppleScript's text item delimiters to oldDelims",
    "  return outputText",
    "end replaceText",
    "",
    "on jsonEsc(v)",
    "  try",
    "    if v is missing value then return \"\"",
    "    set s to v as text",
    "  on error",
    "    return \"\"",
    "  end try",
    "  set s to my replaceText(s, \"\\\\\", \"\\\\\\\\\")",
    "  set s to my replaceText(s, \"\\\"\", \"\\\\\\\"\")",
    "  set s to my replaceText(s, tab, \"\\\\t\")",
    "  set s to my replaceText(s, linefeed, \"\\\\n\")",
    "  set s to my replaceText(s, return, \"\\\\r\")",
    "  return s",
    "end jsonEsc",
    "",
    "on jsonStr(v)",
    "  return \"\\\"\" & my jsonEsc(v) & \"\\\"\"",
    "end jsonStr",
    "",
    "on jsonBool(v)",
    "  if v is true then",
    "    return \"true\"",
    "  else",
    "    return \"false\"",
    "  end if",
    "end jsonBool",
    "",
    "on jsonPair(k, v)",
    "  return (\"\\\"\" & k & \"\\\":\" & v)",
    "end jsonPair",
    "",
    "on jsonObj(pairs)",
    "  return (\"{\" & my joinList(pairs, \",\") & \"}\")",
    "end jsonObj",
    "",
    "on jsonArr(itemList)",
    "  return (\"[\" & my joinList(itemList, \",\") & \"]\")",
    "end jsonArr",
    "",
    "on isoDate(d)",
    "  if d is missing value then return \"null\"",
    "  set y to year of d",
    "  set m to (month of d) as integer",
    "  set dy to day of d",
    "  set mm to text -2 thru -1 of (\"0\" & m)",
    "  set dd to text -2 thru -1 of (\"0\" & dy)",
    "  if y is 1604 then",
    "    return my jsonStr(\"--\" & mm & \"-\" & dd)",
    "  else",
    "    return my jsonStr((y as text) & \"-\" & mm & \"-\" & dd)",
    "  end if",
    "end isoDate",
    "",
    "on buildDate(y, m, d)",
    "  set dt to current date",
    "  set year of dt to y",
    "  set month of dt to m",
    "  set day of dt to d",
    "  set time of dt to 0",
    "  return dt",
    "end buildDate",
  ];
}

function appleScriptErrorDetail(error, stderr, timeoutMs) {
  const timedOut = error && (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT");
  const timeoutText = timedOut ? `osascript timed out after ${timeoutMs}ms` : "";
  return [timeoutText, stderr && stderr.trim(), error && error.message].filter(Boolean).join(" ");
}

function runAppleScript(lines, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [];
    for (const line of lines) args.push("-e", line);
    childProcess.execFile(
      "osascript",
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = appleScriptErrorDetail(error, stderr, timeoutMs);
          reject(new Error(detail || "osascript failed"));
          return;
        }
        resolve(String(stdout || "").trim());
      },
    );
  });
}

// Optional field groups for search_contacts. Only requested groups are computed by
// AppleScript, so a default search stays as fast as it was before these fields existed.
// Counts (emailCount, addressCount, ...) are always computed since `count of X` is cheap.
const ALL_GROUPS = {
  emails: true,
  phones: true,
  note: true,
  extendedName: true,
  orgDetails: true,
  birthday: true,
  addresses: true,
  urls: true,
  relatedNames: true,
  socialProfiles: true,
  instantMessages: true,
  customDates: true,
};

function resolveGroups(args) {
  return {
    emails: boolValue(args, "includeEmails", false),
    phones: boolValue(args, "includePhones", false),
    note: boolValue(args, "includeNote", false),
    extendedName: boolValue(args, "includeExtendedName", false),
    orgDetails: boolValue(args, "includeOrgDetails", false),
    birthday: boolValue(args, "includeBirthday", false),
    addresses: boolValue(args, "includeAddresses", false),
    urls: boolValue(args, "includeUrls", false),
    relatedNames: boolValue(args, "includeRelatedNames", false),
    socialProfiles: boolValue(args, "includeSocialProfiles", false),
    instantMessages: boolValue(args, "includeInstantMessages", false),
    customDates: boolValue(args, "includeCustomDates", false),
  };
}

function contactJsonScriptForPerson(personRef = "p", groups = {}) {
  const lines = [];
  const pairs = [
    `my jsonPair("id", my jsonStr(id of ${personRef} as text))`,
    `my jsonPair("name", my jsonStr(name of ${personRef}))`,
    `my jsonPair("firstName", my jsonStr(first name of ${personRef}))`,
    `my jsonPair("lastName", my jsonStr(last name of ${personRef}))`,
    `my jsonPair("organization", my jsonStr(organization of ${personRef}))`,
    `my jsonPair("jobTitle", my jsonStr(job title of ${personRef}))`,
  ];

  lines.push(
    `set emailCountVal to (count of emails of ${personRef})`,
    `set phoneCountVal to (count of phones of ${personRef})`,
    `set addressCountVal to (count of addresses of ${personRef})`,
    `set urlCountVal to (count of urls of ${personRef})`,
    `set relatedNameCountVal to (count of related names of ${personRef})`,
    `set socialProfileCountVal to (count of social profiles of ${personRef})`,
    `set instantMessageCountVal to (count of instant messages of ${personRef})`,
    `set customDateCountVal to (count of custom dates of ${personRef})`,
  );
  pairs.push(
    `my jsonPair("emailCount", emailCountVal as text)`,
    `my jsonPair("phoneCount", phoneCountVal as text)`,
    `my jsonPair("addressCount", addressCountVal as text)`,
    `my jsonPair("urlCount", urlCountVal as text)`,
    `my jsonPair("relatedNameCount", relatedNameCountVal as text)`,
    `my jsonPair("socialProfileCount", socialProfileCountVal as text)`,
    `my jsonPair("instantMessageCount", instantMessageCountVal as text)`,
    `my jsonPair("customDateCount", customDateCountVal as text)`,
  );

  if (groups.emails) {
    lines.push(
      `set emailItems to {}`,
      `repeat with e in emails of ${personRef}`,
      `  set end of emailItems to my jsonObj({my jsonPair("label", my jsonStr(label of e)), my jsonPair("value", my jsonStr(value of e))})`,
      `end repeat`,
    );
    pairs.push(`my jsonPair("emails", my jsonArr(emailItems))`);
  }
  if (groups.phones) {
    lines.push(
      `set phoneItems to {}`,
      `repeat with ph in phones of ${personRef}`,
      `  set end of phoneItems to my jsonObj({my jsonPair("label", my jsonStr(label of ph)), my jsonPair("value", my jsonStr(value of ph))})`,
      `end repeat`,
    );
    pairs.push(`my jsonPair("phones", my jsonArr(phoneItems))`);
  }
  if (groups.note) {
    pairs.push(`my jsonPair("note", my jsonStr(note of ${personRef}))`);
  }
  if (groups.extendedName) {
    pairs.push(
      `my jsonPair("title", my jsonStr(title of ${personRef}))`,
      `my jsonPair("middleName", my jsonStr(middle name of ${personRef}))`,
      `my jsonPair("suffix", my jsonStr(suffix of ${personRef}))`,
      `my jsonPair("nickname", my jsonStr(nickname of ${personRef}))`,
      `my jsonPair("maidenName", my jsonStr(maiden name of ${personRef}))`,
      `my jsonPair("phoneticFirstName", my jsonStr(phonetic first name of ${personRef}))`,
      `my jsonPair("phoneticMiddleName", my jsonStr(phonetic middle name of ${personRef}))`,
      `my jsonPair("phoneticLastName", my jsonStr(phonetic last name of ${personRef}))`,
    );
  }
  if (groups.orgDetails) {
    pairs.push(
      `my jsonPair("department", my jsonStr(department of ${personRef}))`,
      `my jsonPair("isCompany", my jsonBool(company of ${personRef}))`,
    );
  }
  if (groups.birthday) {
    pairs.push(`my jsonPair("birthday", my isoDate(birth date of ${personRef}))`);
  }
  if (groups.addresses) {
    lines.push(
      `set addressItems to {}`,
      `repeat with a in addresses of ${personRef}`,
      `  set end of addressItems to my jsonObj({my jsonPair("label", my jsonStr(label of a)), my jsonPair("street", my jsonStr(street of a)), my jsonPair("city", my jsonStr(city of a)), my jsonPair("state", my jsonStr(state of a)), my jsonPair("zip", my jsonStr(zip of a)), my jsonPair("country", my jsonStr(country of a)), my jsonPair("countryCode", my jsonStr(country code of a))})`,
      `end repeat`,
    );
    pairs.push(`my jsonPair("addresses", my jsonArr(addressItems))`);
  }
  if (groups.urls) {
    lines.push(
      `set urlItems to {}`,
      `repeat with u in urls of ${personRef}`,
      `  set end of urlItems to my jsonObj({my jsonPair("label", my jsonStr(label of u)), my jsonPair("value", my jsonStr(value of u))})`,
      `end repeat`,
    );
    pairs.push(`my jsonPair("urls", my jsonArr(urlItems))`);
  }
  if (groups.relatedNames) {
    lines.push(
      `set relatedNameItems to {}`,
      `repeat with rn in related names of ${personRef}`,
      `  set end of relatedNameItems to my jsonObj({my jsonPair("label", my jsonStr(label of rn)), my jsonPair("value", my jsonStr(value of rn))})`,
      `end repeat`,
    );
    pairs.push(`my jsonPair("relatedNames", my jsonArr(relatedNameItems))`);
  }
  if (groups.socialProfiles) {
    lines.push(
      `set socialProfileItems to {}`,
      `repeat with sp in social profiles of ${personRef}`,
      `  set end of socialProfileItems to my jsonObj({my jsonPair("service", my jsonStr(service name of sp)), my jsonPair("userName", my jsonStr(user name of sp)), my jsonPair("url", my jsonStr(url of sp))})`,
      `end repeat`,
    );
    pairs.push(`my jsonPair("socialProfiles", my jsonArr(socialProfileItems))`);
  }
  if (groups.instantMessages) {
    lines.push(
      `set instantMessageItems to {}`,
      `repeat with im in instant messages of ${personRef}`,
      `  set end of instantMessageItems to my jsonObj({my jsonPair("label", my jsonStr(label of im)), my jsonPair("service", my jsonStr(service name of im)), my jsonPair("userName", my jsonStr(user name of im))})`,
      `end repeat`,
    );
    pairs.push(`my jsonPair("instantMessages", my jsonArr(instantMessageItems))`);
  }
  if (groups.customDates) {
    lines.push(
      `set customDateItems to {}`,
      `repeat with cd in custom dates of ${personRef}`,
      `  set end of customDateItems to my jsonObj({my jsonPair("label", my jsonStr(label of cd)), my jsonPair("value", my isoDate(value of cd))})`,
      `end repeat`,
    );
    pairs.push(`my jsonPair("customDates", my jsonArr(customDateItems))`);
  }

  lines.push(`set outputRow to my jsonObj({${pairs.join(", ")}})`);
  return lines;
}

function parseContactRows(text, { revealValues = false } = {}) {
  if (!text) return [];
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const contact = JSON.parse(line);
      if (Array.isArray(contact.emails)) {
        contact.emails = contact.emails.map((item) => ({
          label: item.label,
          value: revealValues ? item.value : maskEmail(item.value),
        }));
      }
      if (Array.isArray(contact.phones)) {
        contact.phones = contact.phones.map((item) => ({
          label: item.label,
          value: revealValues ? item.value : maskPhone(item.value),
        }));
      }
      if (typeof contact.note === "string") {
        contact.noteLength = contact.note.length;
      }
      return contact;
    });
}

function parseJsonLines(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function searchContactsScript(query, limit, groups = {}) {
  return [
    ...commonHandlers(),
    `set queryText to ${appleString(query)}`,
    `set maxResults to ${limit}`,
    "tell application \"Contacts\"",
    "  set rows to {}",
    "  set seenIds to {}",
    "  set candidateLists to {}",
    "  set end of candidateLists to (people whose name contains queryText)",
    "  set end of candidateLists to (people whose first name contains queryText)",
    "  set end of candidateLists to (people whose last name contains queryText)",
    "  set end of candidateLists to (people whose organization contains queryText)",
    "  set end of candidateLists to (people whose job title contains queryText)",
    "  set end of candidateLists to (people whose value of emails contains queryText)",
    "  set end of candidateLists to (people whose value of phones contains queryText)",
    "  repeat with candidateList in candidateLists",
    "    repeat with p in candidateList",
    "      set contactId to (id of p as text)",
    "      if seenIds does not contain contactId then",
    "        set end of seenIds to contactId",
    ...contactJsonScriptForPerson("p", groups).map((line) => `        ${line}`),
    "        set end of rows to outputRow",
    "        if (count of rows) is greater than or equal to maxResults then return my joinList(rows, linefeed)",
    "      end if",
    "    end repeat",
    "  end repeat",
    "  return my joinList(rows, linefeed)",
    "end tell",
  ];
}

function groupJsonScriptForGroup(groupRef = "g") {
  return [
    `set memberCountVal to (count of people of ${groupRef})`,
    `set outputRow to my jsonObj({my jsonPair("id", my jsonStr(id of ${groupRef} as text)), my jsonPair("name", my jsonStr(name of ${groupRef})), my jsonPair("memberCount", memberCountVal as text)})`,
  ];
}

function listGroupsScript(query, limit) {
  const lines = [...commonHandlers(), `set maxResults to ${limit}`, 'tell application "Contacts"', "  set rows to {}"];
  if (query) {
    lines.push(`  set queryText to ${appleString(query)}`, "  set candidateGroups to (groups whose name contains queryText)");
  } else {
    lines.push("  set candidateGroups to groups");
  }
  lines.push(
    "  repeat with g in candidateGroups",
    ...groupJsonScriptForGroup("g").map((line) => `    ${line}`),
    "    set end of rows to outputRow",
    "    if (count of rows) is greater than or equal to maxResults then return my joinList(rows, linefeed)",
    "  end repeat",
    "  return my joinList(rows, linefeed)",
    "end tell",
  );
  return lines;
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
      .split("\t")
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
  const revealValues = boolValue(args, "revealValues", false);
  const groups = resolveGroups(args);
  const script = searchContactsScript(query, limit, groups);
  const output = await runAppleScript(script);
  const contacts = parseContactRows(output, { revealValues });
  return {
    ok: true,
    query,
    limit,
    count: contacts.length,
    redacted: (groups.emails || groups.phones) && !revealValues,
    contacts,
  };
}

async function listGroups(args) {
  const query = optionalString(args, "query", 200);
  const limit = normalizeGroupLimit(numberValue(args, "limit", MAX_GROUP_LIMIT));
  const script = listGroupsScript(query, limit);
  const output = await runAppleScript(script);
  const groups = parseJsonLines(output);
  return { ok: true, query: query || null, limit, count: groups.length, groups };
}

async function getGroupById(groupId) {
  const script = [
    ...commonHandlers(),
    `set groupId to ${appleString(groupId)}`,
    'tell application "Contacts"',
    "  set matches to groups whose id is groupId",
    '  if (count of matches) is not 1 then error "expected exactly one group for id " & groupId & ", found " & (count of matches)',
    "  set g to item 1 of matches",
    ...groupJsonScriptForGroup("g").map((line) => `  ${line}`),
    "  return outputRow",
    "end tell",
  ];
  const output = await runAppleScript(script);
  return JSON.parse(output);
}

async function createGroup(args) {
  const name = requireString(args, "name");
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  const proposed = { name };
  if (dryRun || !confirm) {
    return {
      ok: true,
      dryRun: true,
      wouldCreate: proposed,
      requiredForWrite: { dryRun: false, confirm: true },
    };
  }
  const script = [
    ...commonHandlers(),
    `set groupName to ${appleString(name)}`,
    'tell application "Contacts"',
    "  set g to make new group with properties {name:groupName}",
    "  save",
    ...groupJsonScriptForGroup("g").map((line) => `  ${line}`),
    "  return outputRow",
    "end tell",
  ];
  const output = await runAppleScript(script);
  return { ok: true, dryRun: false, created: JSON.parse(output) };
}

async function addToGroup(args) {
  const contactId = requireString(args, "contactId");
  const groupId = requireString(args, "groupId");
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  const [contact, group] = await Promise.all([getContactById(contactId, {}), getGroupById(groupId)]);
  const proposed = { contact: { id: contact.id, name: contact.name }, group };
  if (dryRun || !confirm) {
    return {
      ok: true,
      dryRun: true,
      proposed,
      requiredForWrite: { dryRun: false, confirm: true },
    };
  }
  const script = [
    `set contactId to ${appleString(contactId)}`,
    `set groupId to ${appleString(groupId)}`,
    'tell application "Contacts"',
    "  set personMatches to people whose id is contactId",
    '  if (count of personMatches) is not 1 then error "expected exactly one contact for id " & contactId & ", found " & (count of personMatches)',
    "  set groupMatches to groups whose id is groupId",
    '  if (count of groupMatches) is not 1 then error "expected exactly one group for id " & groupId & ", found " & (count of groupMatches)',
    "  set p to item 1 of personMatches",
    "  set g to item 1 of groupMatches",
    "  add p to g",
    "  save",
    "end tell",
  ];
  await runAppleScript(script);
  return { ok: true, dryRun: false, added: true, contact: proposed.contact, group };
}

async function removeFromGroup(args) {
  const contactId = requireString(args, "contactId");
  const groupId = requireString(args, "groupId");
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  const [contact, group] = await Promise.all([getContactById(contactId, {}), getGroupById(groupId)]);
  const proposed = { contact: { id: contact.id, name: contact.name }, group };
  if (dryRun || !confirm) {
    return {
      ok: true,
      dryRun: true,
      proposed,
      requiredForWrite: { dryRun: false, confirm: true },
    };
  }
  const script = [
    `set contactId to ${appleString(contactId)}`,
    `set groupId to ${appleString(groupId)}`,
    'tell application "Contacts"',
    "  set personMatches to people whose id is contactId",
    '  if (count of personMatches) is not 1 then error "expected exactly one contact for id " & contactId & ", found " & (count of personMatches)',
    "  set groupMatches to groups whose id is groupId",
    '  if (count of groupMatches) is not 1 then error "expected exactly one group for id " & groupId & ", found " & (count of groupMatches)',
    "  set p to item 1 of personMatches",
    "  set g to item 1 of groupMatches",
    "  remove p from g",
    "  save",
    "end tell",
  ];
  await runAppleScript(script);
  return { ok: true, dryRun: false, removed: true, contact: proposed.contact, group };
}

const SCALAR_STRING_FIELDS = [
  ["title", "title"],
  ["firstName", "first name"],
  ["middleName", "middle name"],
  ["lastName", "last name"],
  ["suffix", "suffix"],
  ["nickname", "nickname"],
  ["maidenName", "maiden name"],
  ["phoneticFirstName", "phonetic first name"],
  ["phoneticMiddleName", "phonetic middle name"],
  ["phoneticLastName", "phonetic last name"],
  ["organization", "organization"],
  ["department", "department"],
  ["jobTitle", "job title"],
  ["note", "note"],
];
const SCALAR_BOOLEAN_FIELDS = [["isCompany", "company"]];
const SCALAR_DATE_FIELDS = [["birthday", "birth date"]];

function buildScalarProperties(args) {
  const stringProps = {};
  for (const [argKey, outputKey] of SCALAR_STRING_FIELDS) {
    const value = optionalString(args, argKey);
    if (value != null) stringProps[outputKey] = value;
  }
  const booleanProps = {};
  for (const [argKey, outputKey] of SCALAR_BOOLEAN_FIELDS) {
    if (args[argKey] != null) booleanProps[outputKey] = args[argKey] === true;
  }
  const dateProps = {};
  for (const [argKey, outputKey] of SCALAR_DATE_FIELDS) {
    if (args[argKey] != null) dateProps[outputKey] = normalizeDateParts(args[argKey]);
  }
  return { stringProps, booleanProps, dateProps };
}

function scalarSummary({ stringProps, booleanProps, dateProps }) {
  const summary = { ...stringProps };
  for (const [key, value] of Object.entries(booleanProps)) summary[key] = value;
  for (const [key, value] of Object.entries(dateProps)) summary[key] = formatDatePartsIso(value);
  return summary;
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

function scalarDateVariableLines(dateProps, prefix) {
  const lines = [];
  const varNames = {};
  let i = 0;
  for (const [outputKey, parts] of Object.entries(dateProps)) {
    const varName = `${prefix}${i++}`;
    lines.push(`set ${varName} to my buildDate(${parts.year}, ${parts.month}, ${parts.day})`);
    varNames[outputKey] = varName;
  }
  return { lines, varNames };
}

function listDateVariableLines(items, prefix) {
  const lines = [];
  const varNames = items.map((item, i) => {
    const varName = `${prefix}${i}`;
    lines.push(`set ${varName} to my buildDate(${item.year}, ${item.month}, ${item.day})`);
    return varName;
  });
  return { lines, varNames };
}

function propertyAssignmentScript(personRef, { stringProps, booleanProps, dateVarNames }, indent = "") {
  const lines = [];
  for (const [key, value] of Object.entries(stringProps)) {
    const expression = key === "note" ? appleMultilineString(value) : appleString(value);
    lines.push(`${indent}set ${key} of ${personRef} to ${expression}`);
  }
  for (const [key, value] of Object.entries(booleanProps)) {
    lines.push(`${indent}set ${key} of ${personRef} to ${value ? "true" : "false"}`);
  }
  for (const [key, varName] of Object.entries(dateVarNames)) {
    lines.push(`${indent}set ${key} of ${personRef} to ${varName}`);
  }
  return lines;
}

function propertyLiteral(key, value) {
  const expression = key === "note" ? appleMultilineString(value) : appleString(value);
  return `${key}:${expression}`;
}

function addressCreationLines(personRef, addresses, indent = "") {
  return addresses.map(
    (a) =>
      `${indent}make new address at end of addresses of ${personRef} with properties {label:${appleString(a.label)}, street:${appleString(a.street)}, city:${appleString(a.city)}, state:${appleString(a.state)}, zip:${appleString(a.zip)}, country:${appleString(a.country)}, country code:${appleString(a.countryCode)}}`,
  );
}

function urlCreationLines(personRef, urls, indent = "") {
  return urls.map(
    (u) =>
      `${indent}make new url at end of urls of ${personRef} with properties {label:${appleString(u.label)}, value:${appleString(u.value)}}`,
  );
}

function relatedNameCreationLines(personRef, relatedNames, indent = "") {
  return relatedNames.map(
    (r) =>
      `${indent}make new related name at end of related names of ${personRef} with properties {label:${appleString(r.label)}, value:${appleString(r.value)}}`,
  );
}

function socialProfileCreationLines(personRef, profiles, indent = "") {
  return profiles.map(
    (s) =>
      `${indent}make new social profile at end of social profiles of ${personRef} with properties {user name:${appleString(s.userName)}, url:${appleString(s.url)}, service name:${appleString(s.service)}}`,
  );
}

function customDateCreationLines(personRef, customDates, dateVarNames, indent = "") {
  return customDates.map(
    (c, i) =>
      `${indent}make new custom date at end of custom dates of ${personRef} with properties {label:${appleString(c.label)}, value:${dateVarNames[i]}}`,
  );
}

async function createContact(args) {
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  rejectInstantMessages(args.instantMessages);
  const { stringProps, booleanProps, dateProps } = buildScalarProperties(args);
  const emails = normalizeLabeledValues(args.emails || args.emailAddresses, "emails");
  const phones = normalizeLabeledValues(args.phones || args.phoneNumbers, "phones");
  const addresses = normalizeAddresses(args.addresses);
  const urls = normalizeUrls(args.urls);
  const relatedNames = normalizeRelatedNames(args.relatedNames);
  const socialProfiles = normalizeSocialProfiles(args.socialProfiles);
  const customDates = normalizeCustomDates(args.customDates);
  if (!stringProps["first name"] && !stringProps["last name"] && !stringProps.organization) {
    throw new Error("create_contact requires firstName, lastName, or organization");
  }
  const proposed = {
    fields: scalarSummary({ stringProps, booleanProps, dateProps }),
    emails,
    phones,
    addresses,
    urls,
    relatedNames,
    socialProfiles,
    customDates,
  };
  if (dryRun || !confirm) {
    return {
      ok: true,
      dryRun: true,
      wouldCreate: proposed,
      requiredForWrite: { dryRun: false, confirm: true },
    };
  }
  const { lines: scalarDateLines, varNames: scalarDateVarNames } = scalarDateVariableLines(dateProps, "scalarDate");
  const { lines: customDateVarLines, varNames: customDateVarNames } = listDateVariableLines(
    customDates,
    "customDateVar",
  );
  const propertyParts = Object.entries(stringProps).map(([key, value]) => propertyLiteral(key, value));
  const script = [
    ...commonHandlers(),
    ...scalarDateLines,
    ...customDateVarLines,
    "tell application \"Contacts\"",
    `  set p to make new person with properties {${propertyParts.join(", ")}}`,
    ...Object.entries(booleanProps).map(([key, value]) => `  set ${key} of p to ${value ? "true" : "false"}`),
    ...Object.entries(scalarDateVarNames).map(([key, varName]) => `  set ${key} of p to ${varName}`),
    ...emails.map(
      (item) =>
        `  make new email at end of emails of p with properties {label:${appleString(item.label)}, value:${appleString(item.value)}}`,
    ),
    ...phones.map(
      (item) =>
        `  make new phone at end of phones of p with properties {label:${appleString(item.label)}, value:${appleString(item.value)}}`,
    ),
    ...addressCreationLines("p", addresses, "  "),
    ...urlCreationLines("p", urls, "  "),
    ...relatedNameCreationLines("p", relatedNames, "  "),
    ...socialProfileCreationLines("p", socialProfiles, "  "),
    ...customDateCreationLines("p", customDates, customDateVarNames, "  "),
    "  save",
    ...contactJsonScriptForPerson("p", ALL_GROUPS).map((line) => `  ${line}`),
    "  return outputRow",
    "end tell",
  ];
  const output = await runAppleScript(script);
  return {
    ok: true,
    dryRun: false,
    created: parseContactRows(output, { revealValues: false })[0],
  };
}

async function getContactById(contactId, groups = ALL_GROUPS) {
  const script = [
    ...commonHandlers(),
    `set contactId to ${appleString(contactId)}`,
    "tell application \"Contacts\"",
    "  set matches to people whose id is contactId",
    "  if (count of matches) is not 1 then error \"expected exactly one contact for id \" & contactId & \", found \" & (count of matches)",
    "  set p to item 1 of matches",
    ...contactJsonScriptForPerson("p", groups).map((line) => `  ${line}`),
    "  return outputRow",
    "end tell",
  ];
  const output = await runAppleScript(script);
  return parseContactRows(output, { revealValues: false })[0];
}

async function updateContact(args) {
  const contactId = requireString(args, "contactId");
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  const changes = isPlainObject(args.changes) ? args.changes : args;
  rejectInstantMessages(changes.addInstantMessages);
  const { stringProps, booleanProps, dateProps } = buildScalarProperties(changes);
  const addEmails = normalizeLabeledValues(changes.addEmails || changes.emailsToAdd, "emails");
  const addPhones = normalizeLabeledValues(changes.addPhones || changes.phonesToAdd, "phones");
  const addAddresses = normalizeAddresses(changes.addAddresses);
  const addUrls = normalizeUrls(changes.addUrls);
  const addRelatedNames = normalizeRelatedNames(changes.addRelatedNames);
  const addSocialProfiles = normalizeSocialProfiles(changes.addSocialProfiles);
  const addCustomDates = normalizeCustomDates(changes.addCustomDates);
  const hasScalarChange =
    Object.keys(stringProps).length || Object.keys(booleanProps).length || Object.keys(dateProps).length;
  const hasCollectionChange =
    addEmails.length ||
    addPhones.length ||
    addAddresses.length ||
    addUrls.length ||
    addRelatedNames.length ||
    addSocialProfiles.length ||
    addCustomDates.length;
  if (!hasScalarChange && !hasCollectionChange) {
    throw new Error(
      "update_contact requires at least one scalar field, note, or an addX array of new entries (addEmails, addPhones, addAddresses, addUrls, addRelatedNames, addSocialProfiles, addCustomDates)",
    );
  }
  const before = await getContactById(contactId, ALL_GROUPS);
  const proposed = {
    contactId,
    before,
    changes: {
      fields: scalarSummary({ stringProps, booleanProps, dateProps }),
      addEmails,
      addPhones,
      addAddresses,
      addUrls,
      addRelatedNames,
      addSocialProfiles,
      addCustomDates,
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
  const { lines: scalarDateLines, varNames: scalarDateVarNames } = scalarDateVariableLines(dateProps, "scalarDate");
  const { lines: customDateVarLines, varNames: customDateVarNames } = listDateVariableLines(
    addCustomDates,
    "customDateVar",
  );
  const script = [
    ...commonHandlers(),
    ...scalarDateLines,
    ...customDateVarLines,
    `set contactId to ${appleString(contactId)}`,
    "tell application \"Contacts\"",
    "  set matches to people whose id is contactId",
    "  if (count of matches) is not 1 then error \"expected exactly one contact for id \" & contactId & \", found \" & (count of matches)",
    "  set p to item 1 of matches",
    ...propertyAssignmentScript("p", { stringProps, booleanProps, dateVarNames: scalarDateVarNames }, "  "),
    ...addEmails.map(
      (item) =>
        `  make new email at end of emails of p with properties {label:${appleString(item.label)}, value:${appleString(item.value)}}`,
    ),
    ...addPhones.map(
      (item) =>
        `  make new phone at end of phones of p with properties {label:${appleString(item.label)}, value:${appleString(item.value)}}`,
    ),
    ...addressCreationLines("p", addAddresses, "  "),
    ...urlCreationLines("p", addUrls, "  "),
    ...relatedNameCreationLines("p", addRelatedNames, "  "),
    ...socialProfileCreationLines("p", addSocialProfiles, "  "),
    ...customDateCreationLines("p", addCustomDates, customDateVarNames, "  "),
    "  save",
    ...contactJsonScriptForPerson("p", ALL_GROUPS).map((line) => `  ${line}`),
    "  return outputRow",
    "end tell",
  ];
  const output = await runAppleScript(script);
  return {
    ok: true,
    dryRun: false,
    before,
    after: parseContactRows(output, { revealValues: false })[0],
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
  const before = await getContactById(contactId, { note: true });
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
    ...contactJsonScriptForPerson("p", { note: true }).map((line) => `  ${line}`),
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
    after: parseContactRows(output, { revealValues: false })[0],
  };
}

async function deleteContact(args) {
  const contactId = requireString(args, "contactId");
  const dryRun = boolValue(args, "dryRun", true);
  const confirm = boolValue(args, "confirm", false);
  const confirmPhrase = scrubInput(args.confirmPhrase);
  const before = await getContactById(contactId, ALL_GROUPS);
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
      description:
        "Search Apple Contacts by name, organization, job title, email, or phone. Core fields (name, organization, jobTitle) and all group counts are always returned; optional field groups (emails, phones, note, extendedName, orgDetails, birthday, addresses, urls, relatedNames, socialProfiles, instantMessages, customDates) are only fetched when their includeX flag is set, to keep default searches fast.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: MAX_SEARCH_LIMIT },
          includeEmails: { type: "boolean", default: false },
          includePhones: { type: "boolean", default: false },
          includeNote: { type: "boolean", default: false },
          includeExtendedName: {
            type: "boolean",
            default: false,
            description: "title, middleName, suffix, nickname, maidenName, phoneticFirstName/MiddleName/LastName.",
          },
          includeOrgDetails: { type: "boolean", default: false, description: "department, isCompany." },
          includeBirthday: { type: "boolean", default: false },
          includeAddresses: { type: "boolean", default: false },
          includeUrls: { type: "boolean", default: false },
          includeRelatedNames: {
            type: "boolean",
            default: false,
            description: "Apple Contacts' 'relatives' field, e.g. spouse, parent, child, sibling.",
          },
          includeSocialProfiles: { type: "boolean", default: false },
          includeInstantMessages: {
            type: "boolean",
            default: false,
            description: "Read-only; instant messages cannot be created or updated (a macOS limitation).",
          },
          includeCustomDates: { type: "boolean", default: false },
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
          title: { type: "string" },
          firstName: { type: "string" },
          middleName: { type: "string" },
          lastName: { type: "string" },
          suffix: { type: "string" },
          nickname: { type: "string" },
          maidenName: { type: "string" },
          phoneticFirstName: { type: "string" },
          phoneticMiddleName: { type: "string" },
          phoneticLastName: { type: "string" },
          organization: { type: "string" },
          department: { type: "string" },
          jobTitle: { type: "string" },
          isCompany: { type: "boolean" },
          birthday: { type: "string", description: "YYYY-MM-DD, or --MM-DD for a birthday with no year." },
          note: { type: "string" },
          emails: { type: "array", items: { type: "object" } },
          phones: { type: "array", items: { type: "object" } },
          addresses: {
            type: "array",
            items: { type: "object" },
            description: "{label, street, city, state, zip, country, countryCode}.",
          },
          urls: { type: "array", items: { type: "object" }, description: "{label, value}." },
          relatedNames: {
            type: "array",
            items: { type: "object" },
            description: "Apple Contacts' 'relatives' field: {label:'spouse'|'parent'|'child'|..., value:'Full Name'}.",
          },
          socialProfiles: {
            type: "array",
            items: { type: "object" },
            description: "{service, userName, url}.",
          },
          customDates: {
            type: "array",
            items: { type: "object" },
            description: "{label:'Anniversary', value:'YYYY-MM-DD' or '--MM-DD'}.",
          },
          dryRun: { type: "boolean", default: true },
          confirm: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
    },
    {
      name: "update_contact",
      title: "Update Contact",
      description:
        "Update an Apple Contact by contactId. changes may set any scalar field (firstName, lastName, title, middleName, suffix, nickname, maidenName, phoneticFirstName/MiddleName/LastName, organization, department, jobTitle, isCompany, birthday, note) and/or append new entries via addEmails, addPhones, addAddresses, addUrls, addRelatedNames, addSocialProfiles, addCustomDates. Instant messages are read-only. Dry-run by default; actual writes require dryRun=false and confirm=true.",
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
      name: "list_groups",
      title: "List Contact Groups",
      description:
        "List Contacts.app groups by id, name, and member count. Optional query filters by name substring. Smart Groups (rule-based) may not support membership changes via add_to_group/remove_from_group.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: MAX_GROUP_LIMIT },
        },
        additionalProperties: false,
      },
    },
    {
      name: "create_group",
      title: "Create Contact Group",
      description: "Create a new Contacts.app group. Dry-run by default; actual writes require dryRun=false and confirm=true.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          dryRun: { type: "boolean", default: true },
          confirm: { type: "boolean", default: false },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "add_to_group",
      title: "Add Contact To Group",
      description:
        "Add a contact to a Contacts.app group by contactId and groupId. Only works on regular groups; Smart Groups are rule-based and not scriptable for membership. Dry-run by default; actual writes require dryRun=false and confirm=true.",
      inputSchema: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          groupId: { type: "string" },
          dryRun: { type: "boolean", default: true },
          confirm: { type: "boolean", default: false },
        },
        required: ["contactId", "groupId"],
        additionalProperties: false,
      },
    },
    {
      name: "remove_from_group",
      title: "Remove Contact From Group",
      description:
        "Remove a contact from a Contacts.app group by contactId and groupId. Only works on regular groups; Smart Groups are rule-based and not scriptable for membership. Dry-run by default; actual writes require dryRun=false and confirm=true.",
      inputSchema: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          groupId: { type: "string" },
          dryRun: { type: "boolean", default: true },
          confirm: { type: "boolean", default: false },
        },
        required: ["contactId", "groupId"],
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
  if (name === "list_groups") return listGroups(args);
  if (name === "create_group") return createGroup(args);
  if (name === "add_to_group") return addToGroup(args);
  if (name === "remove_from_group") return removeFromGroup(args);
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
  searchContactsScript,
  listGroupsScript,
  appleScriptErrorDetail,
  maskEmail,
  maskPhone,
};

if (require.main === module) {
  runStdio();
}
