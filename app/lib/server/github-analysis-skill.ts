const ANALYSIS_SKILL_PATH = "ANALYSIS_SKILL.md";
const API_VERSION = "2022-11-28";
const ACTIVE_VARIABLES_START = "<!-- ACTIVE_VARIABLES_START -->";
const ACTIVE_VARIABLES_END = "<!-- ACTIVE_VARIABLES_END -->";

export type GitHubAnalysisSkillConfig = {
  owner: string;
  repository: string;
  branch: "trunk";
  token: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
};

export type AnalysisSkillDocument = {
  content: string;
  sha: string;
  htmlUrl: string | null;
};

export type AnalysisSkillUpdateResult = {
  document: AnalysisSkillDocument;
  commitSha: string;
};

export type GitHubSkillErrorCode =
  | "invalid_configuration"
  | "invalid_policy"
  | "read_failed"
  | "invalid_response"
  | "conflict"
  | "update_failed"
  | "verification_failed";

export class GitHubSkillError extends Error {
  readonly code: GitHubSkillErrorCode;
  readonly status: number | null;

  constructor(code: GitHubSkillErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "GitHubSkillError";
    this.code = code;
    this.status = status;
  }
}

export class GitHubSkillConflictError extends GitHubSkillError {
  constructor(message = "ANALYSIS_SKILL.md changed after it was opened. Reload before saving again.") {
    super("conflict", message, 409);
    this.name = "GitHubSkillConflictError";
  }
}

type GitHubContentPayload = {
  type?: unknown;
  encoding?: unknown;
  content?: unknown;
  sha?: unknown;
  html_url?: unknown;
};

type GitHubUpdatePayload = {
  content?: { sha?: unknown };
  commit?: { sha?: unknown };
};

function countExactLine(markdown: string, marker: string): number {
  return markdown.split(/\r?\n/).filter((line) => line.trim() === marker).length;
}

/** Defensive validation at the repository boundary, independent of browser validation. */
export function validateAnalysisSkillForGitHub(markdown: string): string[] {
  const policy = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const issues: string[] = [];
  if (Buffer.byteLength(policy, "utf8") > 512_000) issues.push("The policy exceeds the 512 KB limit.");
  if (countExactLine(policy, ACTIVE_VARIABLES_START) !== 1 || countExactLine(policy, ACTIVE_VARIABLES_END) !== 1) {
    issues.push("The policy must contain exactly one active-variable start and end marker.");
    return issues;
  }

  const start = policy.indexOf(ACTIVE_VARIABLES_START);
  const end = policy.indexOf(ACTIVE_VARIABLES_END);
  if (start >= end) issues.push("The active-variable markers are out of order.");
  if (!/^- Policy version:\s*`\d+\.\d+\.\d+`\s*$/m.test(policy)) issues.push("Policy version metadata is invalid.");
  if (!/^- Active-variable revision:\s*`\d+`\s*$/m.test(policy)) issues.push("Active-variable revision metadata is invalid.");
  if (!/^- Last updated:\s*`\d{4}-\d{2}-\d{2}`\s*$/m.test(policy)) issues.push("Last-updated metadata is invalid.");

  for (const required of [
    "## Mandatory execution contract",
    "## Structured output contract",
    "prompt-injection",
    '"assessments"',
    '"adjustment_percent"',
    '"sources"',
    '"variable_id"',
  ]) {
    if (!policy.toLocaleLowerCase().includes(required.toLocaleLowerCase())) {
      issues.push(`The required policy contract marker “${required}” is missing.`);
    }
  }

  if (start < end) {
    const block = policy.slice(start + ACTIVE_VARIABLES_START.length, end);
    const entries = block.split(/(?=^- Name:\s*)/m).filter((entry) => /^- Name:\s*/.test(entry));
    const ids = new Set<string>();
    for (const entry of entries) {
      const name = entry.match(/^- Name:\s*`?([^`\n]+)`?\s*$/m)?.[1]?.trim() ?? "unnamed variable";
      const id = entry.match(/^\s{2,}- ID:\s*`([^`]+)`\s*$/m)?.[1] ?? "";
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) issues.push(`${name} has an invalid or missing stable ID.`);
      if (id && ids.has(id)) issues.push(`Active-variable ID “${id}” is duplicated.`);
      if (id) ids.add(id);
      for (const field of ["Applies when", "Evidence required", "Expected effect", "Fallback"]) {
        if (!new RegExp(`^\\s{2,}- ${field}:\\s*\\S`, "m").test(entry)) {
          issues.push(`${name} is missing its ${field} rule.`);
        }
      }
    }
  }

  return issues;
}

function assertConfig(config: GitHubAnalysisSkillConfig): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(config.owner) || !/^[A-Za-z0-9_.-]+$/.test(config.repository)) {
    throw new GitHubSkillError("invalid_configuration", "GitHub owner and repository names are invalid.");
  }
  if (config.branch !== "trunk") {
    throw new GitHubSkillError("invalid_configuration", "Analysis Skill updates are restricted to trunk.");
  }
  if (!String(config.token ?? "").trim()) {
    throw new GitHubSkillError("invalid_configuration", "A repository-scoped GitHub credential is required.");
  }
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
}

function isSecureApiBaseUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function decodeBase64Content(input: string): string | null {
  const compact = input.replace(/\s/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) return null;
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) return null;
  return decoded.toString("utf8");
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class GitHubAnalysisSkillClient {
  private readonly config: GitHubAnalysisSkillConfig;
  private readonly fetcher: typeof fetch;
  private readonly contentUrl: string;

  constructor(config: GitHubAnalysisSkillConfig) {
    assertConfig(config);
    this.config = config;
    this.fetcher = config.fetch ?? fetch;
    const base = String(config.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    if (!isSecureApiBaseUrl(base)) {
      throw new GitHubSkillError("invalid_configuration", "The GitHub API base URL must use HTTPS.");
    }
    this.contentUrl = `${base}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/contents/${ANALYSIS_SKILL_PATH}`;
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.config.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "inventory-auditor",
    };
  }

  async read(): Promise<AnalysisSkillDocument> {
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.contentUrl}?ref=${encodeURIComponent(this.config.branch)}`,
        { method: "GET", headers: this.headers(), cache: "no-store", redirect: "error" },
      );
    } catch {
      throw new GitHubSkillError("read_failed", "The Analysis Skill could not be read from GitHub.");
    }
    if (!response.ok) {
      throw new GitHubSkillError("read_failed", "The Analysis Skill could not be read from GitHub.", response.status);
    }

    const payload = (await readJson(response)) as GitHubContentPayload | null;
    const content = typeof payload?.content === "string" ? decodeBase64Content(payload.content) : null;
    if (
      !payload || payload.type !== "file" || payload.encoding !== "base64" ||
      content === null || !isSha(payload.sha)
    ) {
      throw new GitHubSkillError("invalid_response", "GitHub returned an invalid Analysis Skill document.");
    }

    return {
      content,
      sha: payload.sha,
      htmlUrl: typeof payload.html_url === "string" ? payload.html_url : null,
    };
  }

  async update(input: {
    expectedSha: string;
    markdown: string;
    commitMessage: string;
  }): Promise<AnalysisSkillUpdateResult> {
    if (!isSha(input.expectedSha)) {
      throw new GitHubSkillError("invalid_configuration", "A valid expected GitHub blob SHA is required.");
    }
    const message = String(input.commitMessage ?? "").trim();
    if (!message || message.length > 160) {
      throw new GitHubSkillError("invalid_configuration", "Use a commit message between 1 and 160 characters.");
    }
    const policyIssues = validateAnalysisSkillForGitHub(input.markdown);
    if (policyIssues.length) {
      throw new GitHubSkillError("invalid_policy", policyIssues[0]);
    }

    const current = await this.read();
    if (current.sha !== input.expectedSha) throw new GitHubSkillConflictError();

    let response: Response;
    try {
      response = await this.fetcher(this.contentUrl, {
        method: "PUT",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        redirect: "error",
        body: JSON.stringify({
          message,
          content: Buffer.from(input.markdown, "utf8").toString("base64"),
          sha: input.expectedSha,
          branch: this.config.branch,
        }),
      });
    } catch {
      throw new GitHubSkillError("update_failed", "GitHub could not be reached for the Analysis Skill update.");
    }
    if (response.status === 409 || response.status === 422) throw new GitHubSkillConflictError();
    if (!response.ok) {
      throw new GitHubSkillError("update_failed", "GitHub rejected the Analysis Skill update.", response.status);
    }

    const payload = (await readJson(response)) as GitHubUpdatePayload | null;
    const updatedSha = payload?.content?.sha;
    const commitSha = payload?.commit?.sha;
    if (!isSha(updatedSha) || !isSha(commitSha)) {
      throw new GitHubSkillError("invalid_response", "GitHub returned an invalid update receipt.");
    }

    const verified = await this.read();
    if (verified.sha !== updatedSha || verified.content !== input.markdown) {
      throw new GitHubSkillError(
        "verification_failed",
        "GitHub accepted the update but the saved Analysis Skill could not be verified.",
      );
    }

    return { document: verified, commitSha };
  }
}
