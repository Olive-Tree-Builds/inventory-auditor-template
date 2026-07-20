import { createHash } from "node:crypto";

export type ResendConfig = {
  apiKey: string;
  from: string;
  endpoint?: string;
  fetch?: typeof fetch;
};

export type ForecastEmail = {
  recipient: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  idempotencyKey: string;
};

export type ResendReceipt = { id: string };

export type ResendErrorCode = "invalid_configuration" | "invalid_message" | "send_failed" | "invalid_response";

export class ResendError extends Error {
  readonly code: ResendErrorCode;
  readonly status: number | null;

  constructor(code: ResendErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "ResendError";
    this.code = code;
    this.status = status;
  }
}

function mailboxAddress(input: string): string {
  const value = String(input ?? "").trim();
  const angleAddress = value.match(/<([^<>]+)>$/)?.[1];
  return angleAddress ?? value;
}

function isEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailboxAddress(input));
}

function isSecureEndpoint(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function assertIdempotencyKey(key: string): void {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(key)) {
    throw new ResendError("invalid_message", "A stable, URL-safe email idempotency key is required.");
  }
}

/** Build a durable key without putting a recipient address into provider logs. */
export function buildEmailIdempotencyKey(input: {
  workspaceId: string;
  recipientUserId?: string;
  recipientKey?: string;
  scheduleId: string;
  forecastStartDate: string;
  forecastEndDate: string;
}): string {
  const recipientKey = String(input.recipientKey || (input.recipientUserId ? `user:${input.recipientUserId}` : "")).trim();
  const values = [
    input.workspaceId,
    recipientKey,
    input.scheduleId,
    input.forecastStartDate,
    input.forecastEndDate,
  ].map((entry) => String(entry ?? "").trim());
  if (values.some((entry) => !entry)) {
    throw new ResendError("invalid_message", "All email idempotency components are required.");
  }
  const digest = createHash("sha256").update(JSON.stringify(values)).digest("hex");
  return `inventory-auditor:${digest}`;
}

export class ResendEmailClient {
  private readonly config: ResendConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: ResendConfig) {
    if (
      !String(config.apiKey ?? "").trim() || !isEmail(config.from) ||
      !isSecureEndpoint(config.endpoint ?? "https://api.resend.com/emails")
    ) {
      throw new ResendError("invalid_configuration", "A Resend API key and valid sender are required.");
    }
    this.config = config;
    this.fetcher = config.fetch ?? fetch;
  }

  async send(message: ForecastEmail): Promise<ResendReceipt> {
    if (!isEmail(message.recipient) || !String(message.subject ?? "").trim() || message.subject.length > 200) {
      throw new ResendError("invalid_message", "A valid single recipient and subject are required.");
    }
    if (!String(message.html ?? "").trim() && !String(message.text ?? "").trim()) {
      throw new ResendError("invalid_message", "The email must contain HTML or plain text content.");
    }
    if (message.replyTo && !isEmail(message.replyTo)) {
      throw new ResendError("invalid_message", "The reply-to address is invalid.");
    }
    assertIdempotencyKey(message.idempotencyKey);

    if (Buffer.byteLength(message.html ?? "", "utf8") + Buffer.byteLength(message.text ?? "", "utf8") > 2_000_000) {
      throw new ResendError("invalid_message", "The email content exceeds the server delivery limit.");
    }

    let response: Response;
    try {
      response = await this.fetcher(this.config.endpoint ?? "https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.recipient],
          subject: message.subject.trim(),
          ...(message.html ? { html: message.html } : {}),
          ...(message.text ? { text: message.text } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
      });
    } catch {
      throw new ResendError("send_failed", "The forecast email provider could not be reached.");
    }
    if (!response.ok) {
      throw new ResendError("send_failed", "The forecast email provider rejected the send.", response.status);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const id = payload && typeof payload === "object" && "id" in payload ? (payload as { id?: unknown }).id : null;
    if (typeof id !== "string" || !id.trim()) {
      throw new ResendError("invalid_response", "The email provider returned an invalid delivery receipt.");
    }
    return { id };
  }
}
