import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "request_failed",
  ) {
    super(message);
  }
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function jsonError(error: unknown) {
  if (error instanceof HttpError) {
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "invalid_input",
          message: "Check the highlighted information and try again.",
          fields: error.flatten().fieldErrors,
        },
      },
      { status: 400 },
    );
  }

  console.error("Inventory Auditor request failed", error instanceof Error ? error.message : "Unknown error");
  return NextResponse.json(
    { ok: false, error: { code: "internal_error", message: "Something went wrong. Try again or contact your workspace administrator." } },
    { status: 500 },
  );
}

export async function readJson(request: Request, maxBytes = 65_536): Promise<unknown> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 3_000_000) {
    throw new HttpError(500, "The request limit is invalid.", "invalid_request_limit");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new HttpError(413, "The request body is too large.", "request_too_large");
  }
  if (!request.body) throw new HttpError(400, "The request body is not valid JSON.", "invalid_json");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "The request body is too large.", "request_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The request body is not valid JSON.", "invalid_json");
  } finally {
    reader.releaseLock();
  }
}
