export const ACTIVE_VARIABLES_START = "<!-- ACTIVE_VARIABLES_START -->";
export const ACTIVE_VARIABLES_END = "<!-- ACTIVE_VARIABLES_END -->";

const REQUIRED_VARIABLE_FIELDS = [
  "ID",
  "Applies when",
  "Evidence required",
  "Expected effect",
  "Fallback",
];

const MAX_VARIABLES = 30;
const MAX_NAME_LENGTH = 80;
const MAX_ID_LENGTH = 64;

/**
 * @typedef {{ id: string, name: string }} AnalysisVariable
 * @typedef {{
 *   variables: AnalysisVariable[],
 *   errors: string[],
 *   policyVersion: string | null,
 *   activeVariableRevision: string | null
 * }} AnalysisSkillParseResult
 */

function normalizeMarkdown(markdown) {
  return String(markdown ?? "").replace(/\r\n?/g, "\n");
}

function unwrapInlineCode(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("`") && trimmed.endsWith("`")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function markerIndexes(lines, marker) {
  return lines.flatMap((line, index) => (line.trim() === marker ? [index] : []));
}

function inspectVariableBlock(markdown) {
  const normalized = normalizeMarkdown(markdown);
  const lines = normalized.split("\n");
  const startIndexes = markerIndexes(lines, ACTIVE_VARIABLES_START);
  const endIndexes = markerIndexes(lines, ACTIVE_VARIABLES_END);
  const errors = [];

  if (startIndexes.length !== 1 || endIndexes.length !== 1) {
    errors.push("Keep exactly one ACTIVE_VARIABLES_START marker and one ACTIVE_VARIABLES_END marker.");
    return { normalized, lines, errors, entries: [], startIndex: -1, endIndex: -1 };
  }

  const startIndex = startIndexes[0];
  const endIndex = endIndexes[0];

  if (startIndex >= endIndex) {
    errors.push("The active-variable start marker must appear before the end marker.");
    return { normalized, lines, errors, entries: [], startIndex, endIndex };
  }

  const nameLineIndexes = [];
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    if (/^- Name:\s*/.test(lines[index])) nameLineIndexes.push(index);
  }

  const entries = nameLineIndexes.map((lineIndex, position) => {
    const nextLineIndex = nameLineIndexes[position + 1] ?? endIndex;
    const name = unwrapInlineCode(lines[lineIndex].replace(/^- Name:\s*/, ""));
    const fields = new Map();

    for (let index = lineIndex + 1; index < nextLineIndex; index += 1) {
      const fieldMatch = lines[index].match(/^\s{2,}- ([A-Za-z][A-Za-z ]+):\s*(.*)$/);
      if (fieldMatch) fields.set(fieldMatch[1], unwrapInlineCode(fieldMatch[2]));
    }

    return {
      name,
      fields,
      startLine: lineIndex,
      endLine: nextLineIndex,
    };
  });

  return { normalized, lines, errors, entries, startIndex, endIndex };
}

/**
 * Parse the deliberately small, human-editable active-variable contract.
 * Missing or malformed markers never fall back to starter variables.
 *
 * @param {string} markdown
 * @returns {AnalysisSkillParseResult}
 */
export function parseAnalysisSkill(markdown) {
  const inspected = inspectVariableBlock(markdown);
  const errors = [...inspected.errors];
  const variables = [];
  const seenIds = new Set();
  const seenNames = new Set();
  const policyVersion = inspected.normalized.match(/^- Policy version:\s*`([^`]+)`\s*$/m)?.[1] ?? null;
  const activeVariableRevision = inspected.normalized.match(/^- Active-variable revision:\s*`([^`]+)`\s*$/m)?.[1] ?? null;
  const lastUpdated = inspected.normalized.match(/^- Last updated:\s*`([^`]+)`\s*$/m)?.[1] ?? null;

  if (!policyVersion || !/^\d+\.\d+\.\d+$/.test(policyVersion)) {
    errors.push("Policy version must use semantic versioning, such as 1.1.0.");
  }
  if (!activeVariableRevision || !/^\d+$/.test(activeVariableRevision)) {
    errors.push("Active-variable revision must be a whole number.");
  }
  if (!lastUpdated || !/^\d{4}-\d{2}-\d{2}$/.test(lastUpdated)) {
    errors.push("Last updated must be a date in YYYY-MM-DD format.");
  }

  if (inspected.entries.length > MAX_VARIABLES) {
    errors.push(`Use no more than ${MAX_VARIABLES} active variables.`);
  }

  for (const entry of inspected.entries) {
    const entryErrors = [];
    const name = entry.name;
    const id = entry.fields.get("ID") ?? "";

    if (!name) entryErrors.push("An active variable is missing its Name.");
    if (name.length > MAX_NAME_LENGTH) entryErrors.push(`Variable names must be ${MAX_NAME_LENGTH} characters or fewer.`);
    if (/\bTODO\b/i.test(name)) entryErrors.push("Replace every TODO variable name before activation.");

    if (!id) {
      entryErrors.push(`${name || "An active variable"} is missing its ID.`);
    } else if (id.length > MAX_ID_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      entryErrors.push(`${name || "An active variable"} has an invalid ID. Use lowercase letters, numbers, and hyphens.`);
    }

    for (const field of REQUIRED_VARIABLE_FIELDS.slice(1)) {
      const value = entry.fields.get(field) ?? "";
      if (!value || /\bTODO\b/i.test(value)) {
        entryErrors.push(`${name || "An active variable"} needs a completed “${field}” rule.`);
      }
    }

    const normalizedId = id.toLocaleLowerCase();
    const normalizedName = name.toLocaleLowerCase();
    if (id && seenIds.has(normalizedId)) entryErrors.push(`Active-variable ID “${id}” is duplicated.`);
    if (name && seenNames.has(normalizedName)) entryErrors.push(`Active-variable name “${name}” is duplicated.`);
    if (id) seenIds.add(normalizedId);
    if (name) seenNames.add(normalizedName);

    errors.push(...entryErrors);
    if (entryErrors.length === 0) variables.push({ id, name });
  }

  return { variables, errors, policyVersion, activeVariableRevision };
}

function slugifyVariableName(name) {
  return name
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_LENGTH) || "custom-variable";
}

/**
 * @param {string} markdown
 * @param {string} requestedName
 * @returns {{ markdown: string, error: string | null }}
 */
export function addAnalysisVariable(markdown, requestedName) {
  const name = String(requestedName ?? "").trim();
  if (!name) return { markdown, error: "Enter a variable name first." };
  if (name.length > MAX_NAME_LENGTH) return { markdown, error: `Variable names must be ${MAX_NAME_LENGTH} characters or fewer.` };

  const inspected = inspectVariableBlock(markdown);
  if (inspected.errors.length > 0) return { markdown, error: inspected.errors[0] };

  const usedIds = new Set(
    inspected.entries
      .map((entry) => entry.fields.get("ID"))
      .filter(Boolean)
      .map((id) => id.toLocaleLowerCase()),
  );
  const baseId = slugifyVariableName(name);
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    const suffixText = `-${suffix}`;
    id = `${baseId.slice(0, MAX_ID_LENGTH - suffixText.length)}${suffixText}`;
    suffix += 1;
  }

  const variableBlock = [
    `- Name: \`${name}\``,
    `  - ID: \`${id}\``,
    "  - Applies when: Current public evidence shows this condition is relevant to the exact location and forecast period.",
    "  - Evidence required: A current direct source plus comparable location-level historical sales when available.",
    "  - Expected effect: Derive direction and magnitude from supported historical comparisons; do not assume a fixed adjustment.",
    "  - Products affected: Only products with a demonstrated relationship to this condition.",
    "  - Fallback: Use zero adjustment and lower confidence when evidence is missing, stale, conflicting, or unsupported.",
    "",
  ];

  const lines = [...inspected.lines];
  lines.splice(inspected.endIndex, 0, ...variableBlock);
  return { markdown: lines.join("\n"), error: null };
}

/**
 * @param {string} markdown
 * @param {string} variableId
 * @returns {{ markdown: string, error: string | null }}
 */
export function removeAnalysisVariable(markdown, variableId) {
  const inspected = inspectVariableBlock(markdown);
  if (inspected.errors.length > 0) return { markdown, error: inspected.errors[0] };

  const entry = inspected.entries.find((candidate) => candidate.fields.get("ID") === variableId);
  if (!entry) return { markdown, error: "That variable is no longer present in the draft." };

  const lines = [...inspected.lines];
  let deleteCount = entry.endLine - entry.startLine;
  while (deleteCount > 0 && lines[entry.startLine + deleteCount - 1]?.trim() === "") deleteCount -= 1;
  lines.splice(entry.startLine, Math.max(deleteCount, 1));
  return { markdown: lines.join("\n"), error: null };
}

function compareSemanticVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

/**
 * Prepare a validated preview activation with auditable metadata. The live app
 * will perform this same operation on the server before its compare-and-swap
 * GitHub update.
 *
 * @param {string} draftMarkdown
 * @param {string} activeMarkdown
 * @param {string} [today]
 * @returns {{ markdown: string, error: string | null }}
 */
export function prepareAnalysisSkillActivation(draftMarkdown, activeMarkdown, today = new Date().toISOString().slice(0, 10)) {
  const draftPolicy = parseAnalysisSkill(draftMarkdown);
  if (draftPolicy.errors.length > 0) return { markdown: draftMarkdown, error: draftPolicy.errors[0] };
  if (!String(activeMarkdown ?? "").trim()) {
    return { markdown: normalizeMarkdown(draftMarkdown), error: null };
  }
  const activePolicy = parseAnalysisSkill(activeMarkdown);
  if (activePolicy.errors.length > 0) return { markdown: draftMarkdown, error: "The currently active Analysis Skill is invalid and cannot be versioned safely." };
  if (normalizeMarkdown(draftMarkdown) === normalizeMarkdown(activeMarkdown)) return { markdown: draftMarkdown, error: null };

  const activeVersion = activePolicy.policyVersion;
  const draftVersion = draftPolicy.policyVersion;
  const activeVersionParts = activeVersion.split(".").map(Number);
  const nextVersion = compareSemanticVersions(draftVersion, activeVersion) > 0
    ? draftVersion
    : `${activeVersionParts[0]}.${activeVersionParts[1]}.${activeVersionParts[2] + 1}`;

  const draftBlock = inspectVariableBlock(draftMarkdown);
  const activeBlock = inspectVariableBlock(activeMarkdown);
  const draftVariables = draftBlock.lines.slice(draftBlock.startIndex + 1, draftBlock.endIndex).join("\n").trim();
  const activeVariables = activeBlock.lines.slice(activeBlock.startIndex + 1, activeBlock.endIndex).join("\n").trim();
  const activeRevision = Number(activePolicy.activeVariableRevision);
  const draftRevision = Number(draftPolicy.activeVariableRevision);
  const nextRevision = draftVariables === activeVariables
    ? Math.max(draftRevision, activeRevision)
    : Math.max(draftRevision, activeRevision + 1);

  const prepared = normalizeMarkdown(draftMarkdown)
    .replace(/^- Policy version:\s*`[^`]+`\s*$/m, `- Policy version: \`${nextVersion}\``)
    .replace(/^- Active-variable revision:\s*`[^`]+`\s*$/m, `- Active-variable revision: \`${nextRevision}\``)
    .replace(/^- Last updated:\s*`[^`]+`\s*$/m, `- Last updated: \`${today}\``);

  return { markdown: prepared, error: null };
}
