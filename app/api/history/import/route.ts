import { z } from "zod";
import { requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk } from "../../../lib/api/http";
import { parseHistoryImport, type ImportMappings } from "../../../lib/server/history-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A 5 MiB file, two mapping JSON fields (1 MiB each), and multipart framing
// must fit inside this declared request envelope before formData() buffers it.
const MAX_MULTIPART_BYTES = 8 * 1024 * 1024;
const modeSchema = z.enum(["preview", "commit"]);
const mappingSchema = z
  .record(z.string().min(1).max(160), z.uuid())
  .refine((value) => Object.keys(value).length <= 20_000, "Too many import choices were provided.");

type OutcomeCounts = {
  insertedCount: number;
  correctedCount: number;
  unchangedCount: number;
  productsCreatedCount: number;
};

type LocationRecord = {
  id: string;
  brand_id: string;
  name: string;
  import_code: string;
  time_zone: string;
};

type ProductRecord = {
  id: string;
  brand_id: string;
  name: string;
  import_code: string;
};

type LocationAliasRecord = { location_id: string; source_name: string };
type ProductAliasRecord = { product_id: string; source_name: string };

const EMPTY_OUTCOMES: OutcomeCounts = {
  insertedCount: 0,
  correctedCount: 0,
  unchangedCount: 0,
  productsCreatedCount: 0,
};

function validateDeclaredContentLength(request: Request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null) return;
  if (!/^\d+$/.test(declaredLength)) {
    throw new HttpError(400, "The upload size header is invalid.", "invalid_content_length");
  }
  if (BigInt(declaredLength) > BigInt(MAX_MULTIPART_BYTES)) {
    throw new HttpError(413, "The complete upload request must be 8 MB or smaller.", "import_request_too_large");
  }
}

function parseMappings(value: FormDataEntryValue | null, kind: "location" | "product"): ImportMappings {
  if (value === null || value === "") return {};
  if (typeof value !== "string" || value.length > 1_000_000) {
    throw new HttpError(400, `The ${kind} choices could not be read.`, `invalid_${kind}_mappings`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    const result = mappingSchema.safeParse(parsed);
    if (!result.success) {
      throw new HttpError(400, `The ${kind} choices could not be read.`, `invalid_${kind}_mappings`);
    }
    return result.data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `The ${kind} choices could not be read.`, `invalid_${kind}_mappings`);
  }
}

function rpcRow(data: unknown): Record<string, unknown> {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(500, "The import result could not be verified.", "invalid_import_result");
  }
  return value as Record<string, unknown>;
}

function count(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(500, "The import result could not be verified.", "invalid_import_result");
  }
  return parsed;
}

function previewOutcomes(data: unknown): OutcomeCounts {
  const value = rpcRow(data);
  return {
    insertedCount: count(value.inserted_count),
    correctedCount: count(value.corrected_count),
    unchangedCount: count(value.unchanged_count),
    productsCreatedCount: count(value.new_product_count),
  };
}

function committedResult(data: unknown) {
  const value = rpcRow(data);
  const importBatchId = z.uuid().safeParse(value.import_batch_id);
  if (!importBatchId.success || typeof value.already_imported !== "boolean") {
    throw new HttpError(500, "The import result could not be verified.", "invalid_import_result");
  }
  return {
    importBatchId: importBatchId.data,
    insertedCount: count(value.inserted_count),
    correctedCount: count(value.corrected_count),
    unchangedCount: count(value.unchanged_count),
    productsCreatedCount: count(value.products_created),
    alreadyImported: value.already_imported,
  };
}

export async function POST(request: Request) {
  try {
    validateDeclaredContentLength(request);
    const { supabase, membership, user } = await requireWorkspaceContext(["super_admin", "admin"]);
    const form = await request.formData();
    const file = form.get("file");
    const mode = modeSchema.parse(form.get("mode") || "preview");
    const brandId = z.uuid().parse(form.get("brandId"));
    const locationMappings = parseMappings(form.get("locationMappings"), "location");
    const productMappings = parseMappings(form.get("productMappings"), "product");
    if (!(file instanceof File)) throw new HttpError(400, "Choose an Excel or CSV file.", "file_required");
    if (file.size === 0) throw new HttpError(400, "The selected file is empty.", "empty_import_file");
    if (file.size > 5 * 1024 * 1024) {
      throw new HttpError(413, "Use a file that is 5 MB or smaller.", "import_file_too_large");
    }

    const { data: brand, error: brandError } = await supabase
      .from("ia_brands")
      .select("id, name")
      .eq("workspace_id", membership.workspace_id)
      .eq("id", brandId)
      .eq("is_active", true)
      .maybeSingle();
    if (brandError) throw new HttpError(500, "The selected brand could not be checked.", "brand_unavailable");
    if (!brand) throw new HttpError(404, "The selected brand is not available.", "brand_not_found");

    const { data: assignments, error: assignmentsError } = await supabase
      .from("ia_user_location_assignments")
      .select("location_id")
      .eq("workspace_id", membership.workspace_id)
      .eq("user_id", user.id)
      .eq("is_active", true);
    if (assignmentsError) {
      throw new HttpError(500, "Your assigned locations could not be checked.", "location_assignments_unavailable");
    }
    const assignedLocationIds = [...new Set((assignments ?? []).map((assignment) => String(assignment.location_id)))];
    const assignedLocationIdSet = new Set(assignedLocationIds);
    const noLocations = Promise.resolve({ data: [] as LocationRecord[], error: null });
    const noLocationAliases = Promise.resolve({ data: [] as LocationAliasRecord[], error: null });

    const [locationsResult, productsResult, locationAliasesResult, productAliasesResult] = await Promise.all([
      assignedLocationIds.length ? supabase
        .from("ia_locations")
        .select("id, brand_id, name, import_code, time_zone")
        .eq("workspace_id", membership.workspace_id)
        .eq("brand_id", brandId)
        .eq("is_active", true)
        .in("id", assignedLocationIds) : noLocations,
      supabase
        .from("ia_products")
        .select("id, brand_id, name, import_code")
        .eq("workspace_id", membership.workspace_id)
        .eq("brand_id", brandId)
        .is("archived_at", null),
      assignedLocationIds.length ? supabase
        .from("ia_location_import_aliases")
        .select("location_id, source_name")
        .eq("workspace_id", membership.workspace_id)
        .eq("brand_id", brandId)
        .in("location_id", assignedLocationIds) : noLocationAliases,
      supabase
        .from("ia_product_import_aliases")
        .select("product_id, source_name")
        .eq("workspace_id", membership.workspace_id)
        .eq("brand_id", brandId),
    ]);
    if (locationsResult.error || productsResult.error || locationAliasesResult.error || productAliasesResult.error) {
      throw new HttpError(500, "The brand's import choices could not be loaded.", "import_choices_unavailable");
    }

    const availableLocations = ((locationsResult.data ?? []) as LocationRecord[])
      .filter((location) => assignedLocationIdSet.has(String(location.id)))
      .map((location) => ({
        id: String(location.id),
        brandId: String(location.brand_id),
        name: String(location.name),
        importCode: location.import_code ? String(location.import_code) : undefined,
        timeZone: String(location.time_zone),
      }));
    const availableProducts = ((productsResult.data ?? []) as ProductRecord[]).map((product) => ({
      id: String(product.id),
      brandId: String(product.brand_id),
      name: String(product.name),
      importCode: product.import_code ? String(product.import_code) : undefined,
    }));

    let preview;
    try {
      preview = await parseHistoryImport({
        filename: file.name,
        bytes: Buffer.from(await file.arrayBuffer()),
        brandId,
        allowedLocations: availableLocations,
        allowedProducts: availableProducts,
        locationAliases: ((locationAliasesResult.data ?? []) as LocationAliasRecord[])
          .filter((alias) => assignedLocationIdSet.has(String(alias.location_id)))
          .map((alias) => ({
            locationId: String(alias.location_id),
            sourceLabel: String(alias.source_name),
          })),
        productAliases: ((productAliasesResult.data ?? []) as ProductAliasRecord[]).map((alias) => ({
          productId: String(alias.product_id),
          sourceLabel: String(alias.source_name),
        })),
        locationMappings,
        productMappings,
        maxBytes: 5 * 1024 * 1024,
        maxRows: 20_000,
      });
    } catch {
      throw new HttpError(
        400,
        "The file could not be read. Use the four-column Excel or CSV template and try again.",
        "invalid_import_file",
      );
    }

    const summary = {
      selectedBrand: { id: String(brand.id), name: String(brand.name) },
      availableLocations: availableLocations
        .map(({ id, name, importCode, timeZone }) => ({ id, name, importCode, timeZone }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      availableProducts: availableProducts
        .map(({ id, name, importCode }) => ({ id, name, importCode }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      checksum: preview.checksum,
      filename: preview.filename,
      rowCount: preview.rowCount,
      dateFrom: preview.dateFrom,
      dateTo: preview.dateTo,
      products: preview.products,
      locations: preview.locations,
      errors: preview.errors,
      unresolvedLocations: preview.unresolvedLocations,
      productDecisions: preview.productDecisions,
    };
    if (preview.errors.length > 0 || preview.unresolvedLocations.length > 0) {
      return jsonOk({ ...summary, outcomes: EMPTY_OUTCOMES, committed: false, alreadyImported: false });
    }

    const { data: existingBatch, error: existingBatchError } = await supabase
      .from("ia_import_batches")
      .select("row_count")
      .eq("workspace_id", membership.workspace_id)
      .eq("brand_id", brandId)
      .eq("source_sha256", preview.checksum)
      .eq("status", "committed")
      .maybeSingle();
    if (existingBatchError) {
      throw new HttpError(500, "Previous imports could not be checked.", "import_history_unavailable");
    }
    if (existingBatch) {
      return jsonOk({
        ...summary,
        outcomes: {
          insertedCount: 0,
          correctedCount: 0,
          unchangedCount: count(existingBatch.row_count),
          productsCreatedCount: 0,
        },
        committed: false,
        alreadyImported: true,
      });
    }

    const rows = preview.rows.map((row) => ({
      location_id: row.locationId,
      product_id: row.productId,
      product_name: row.productName,
      source_location: row.sourceLocation,
      source_product: row.sourceProduct,
      business_date: row.businessDate,
      quantity: row.quantity,
    }));
    const { data: outcomeData, error: outcomeError } = await supabase.rpc("ia_preview_historical_import_v2", {
      p_brand_id: brandId,
      p_rows: rows,
    });
    if (outcomeError) {
      throw new HttpError(400, "The import preview could not be prepared. No sales rows were saved.", "import_preview_failed");
    }
    const outcomes = previewOutcomes(outcomeData);
    if (mode === "preview") return jsonOk({ ...summary, outcomes, committed: false, alreadyImported: false });

    const { data, error } = await supabase.rpc("ia_import_historical_sales_v2", {
      p_brand_id: brandId,
      p_checksum: preview.checksum,
      p_filename: preview.filename.slice(0, 255),
      p_rows: rows,
    });
    if (error) {
      throw new HttpError(400, "The validated rows could not be imported. No sales rows were saved.", "import_failed");
    }

    const result = committedResult(data);
    return jsonOk({
      ...summary,
      outcomes: {
        insertedCount: result.insertedCount,
        correctedCount: result.correctedCount,
        unchangedCount: result.unchangedCount,
        productsCreatedCount: result.productsCreatedCount,
      },
      committed: !result.alreadyImported,
      alreadyImported: result.alreadyImported,
      result,
    });
  } catch (error) {
    return jsonError(error);
  }
}
