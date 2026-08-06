import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";

const REQUIRED_HEADERS = ["date", "product", "location", "quantity"] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const FORMULA_PREFIX = /^[=+@-]/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_PRODUCT_LENGTH = 160;
const MAX_LOCATION_LENGTH = 160;

export type ImportLocation = {
  id: string;
  brandId: string;
  name: string;
  importCode?: string;
  timeZone: string;
};

export type ImportProduct = {
  id: string;
  brandId: string;
  name: string;
  importCode?: string;
};

export type ImportLocationAlias = {
  locationId: string;
  sourceLabel: string;
};

export type ImportProductAlias = {
  productId: string;
  sourceLabel: string;
};

export type ImportMappings = Record<string, string>;

export type ValidatedHistoryRow = {
  rowNumber: number;
  businessDate: string;
  sourceProduct: string;
  sourceLocation: string;
  productId: string | null;
  productName: string;
  locationName: string;
  locationId: string;
  brandId: string;
  quantity: number;
};

export type UnresolvedLocation = {
  sourceLocation: string;
  rowNumbers: number[];
  rowCount: number;
};

export type ProductDecision = {
  sourceProduct: string;
  productId: string | null;
  productName: string;
  decision: "existing" | "mapped" | "new";
  rowNumbers: number[];
  rowCount: number;
};

export type HistoryImportPreview = {
  checksum: string;
  filename: string;
  rows: ValidatedHistoryRow[];
  rowCount: number;
  dateFrom: string;
  dateTo: string;
  products: string[];
  locations: string[];
  unresolvedLocations: UnresolvedLocation[];
  productDecisions: ProductDecision[];
  errors: string[];
};

type ProductResolution = {
  productId: string | null;
  productName: string;
  decision: ProductDecision["decision"];
};

export class HistoryImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryImportFileError";
  }
}

function normalizeLookup(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedDisplayLabel(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function isRealDate(value: string) {
  if (!DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function localBusinessDate(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!value.year || !value.month || !value.day) throw new Error("location timezone could not be resolved");
  return `${value.year}-${value.month}-${value.day}`;
}

function cellText(cell: ExcelJS.Cell) {
  if (cell.type === ExcelJS.ValueType.Formula || (typeof cell.value === "object" && cell.value && "formula" in cell.value)) {
    throw new Error("contains a formula");
  }
  if (cell.value instanceof Date) {
    if (
      cell.value.getUTCHours() !== 0
      || cell.value.getUTCMinutes() !== 0
      || cell.value.getUTCSeconds() !== 0
      || cell.value.getUTCMilliseconds() !== 0
    ) {
      throw new Error("contains a timestamp; use a date only");
    }
    return [
      cell.value.getUTCFullYear(),
      String(cell.value.getUTCMonth() + 1).padStart(2, "0"),
      String(cell.value.getUTCDate()).padStart(2, "0"),
    ].join("-");
  }
  return cell.text.trim();
}

async function loadWorksheet(filename: string, bytes: Buffer) {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension !== "xlsx" && extension !== "csv") throw new HistoryImportFileError("Use an .xlsx or .csv file.");

  const workbook = new ExcelJS.Workbook();
  try {
    if (extension === "csv") {
      // ExcelJS otherwise converts date-only CSV text into a timezone-sensitive
      // JavaScript Date before validation, making a valid YYYY-MM-DD look timed.
      await workbook.csv.read(Readable.from(bytes), { dateFormats: [] });
    } else {
      await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    }
  } catch {
    throw new HistoryImportFileError(
      extension === "xlsx"
        ? "The Excel workbook could not be read. Open it in Excel, Google Sheets, Numbers, or LibreOffice and save it again as a standard .xlsx file."
        : "The CSV file could not be read. Save it as a standard UTF-8 comma-separated file and try again.",
    );
  }

  const populatedWorksheets = workbook.worksheets.filter((worksheet) => worksheet.actualRowCount > 0);
  if (populatedWorksheets.length !== 1) {
    throw new HistoryImportFileError("Use one worksheet containing data. Extra completely blank worksheets are allowed.");
  }
  const worksheet = populatedWorksheets[0];
  if (worksheet.state !== "visible") throw new HistoryImportFileError("The worksheet containing data must be visible.");
  if (worksheet.hasMerges) throw new HistoryImportFileError("Merged cells are not allowed in the historical-data worksheet.");
  if (worksheet.getImages().length > 0) throw new HistoryImportFileError("Images are not allowed in the historical-data worksheet.");
  return worksheet;
}

function addLookup<T extends { id: string }>(lookup: Map<string, T[]>, sourceLabel: string | undefined, value: T) {
  if (!sourceLabel) return;
  const key = normalizeLookup(sourceLabel);
  if (!key) return;
  const existing = lookup.get(key) ?? [];
  if (!existing.some((candidate) => candidate.id === value.id)) {
    lookup.set(key, [...existing, value]);
  }
}

function prepareMappings(
  mappings: ImportMappings | undefined,
  validIds: ReadonlySet<string>,
  kind: "location" | "product",
  errors: string[],
) {
  const prepared = new Map<string, string>();
  for (const [sourceLabel, targetId] of Object.entries(mappings ?? {})) {
    const key = normalizeLookup(sourceLabel);
    const displayLabel = normalizedDisplayLabel(sourceLabel);
    if (!key) {
      errors.push(`A ${kind} choice has an empty source label.`);
      continue;
    }
    if (!validIds.has(targetId)) {
      errors.push(`The ${kind} choice for “${displayLabel}” is not available for this import.`);
      continue;
    }
    const existing = prepared.get(key);
    if (existing && existing !== targetId) {
      errors.push(`The ${kind} choice for “${displayLabel}” is ambiguous.`);
      continue;
    }
    prepared.set(key, targetId);
  }
  return prepared;
}

function addUnresolvedLocation(
  unresolved: Map<string, { sourceLocation: string; rowNumbers: number[] }>,
  sourceLocation: string,
  rowNumber: number,
) {
  const key = normalizeLookup(sourceLocation);
  const existing = unresolved.get(key);
  if (existing) {
    existing.rowNumbers.push(rowNumber);
  } else {
    unresolved.set(key, { sourceLocation, rowNumbers: [rowNumber] });
  }
}

function addProductDecision(
  decisions: Map<string, Omit<ProductDecision, "rowCount">>,
  sourceProduct: string,
  rowNumber: number,
  resolution: ProductResolution,
) {
  const key = normalizeLookup(sourceProduct);
  const existing = decisions.get(key);
  if (existing) {
    if (!existing.rowNumbers.includes(rowNumber)) existing.rowNumbers.push(rowNumber);
  } else {
    decisions.set(key, {
      sourceProduct,
      productId: resolution.productId,
      productName: resolution.productName,
      decision: resolution.decision,
      rowNumbers: [rowNumber],
    });
  }
}

export async function parseHistoryImport(input: {
  filename: string;
  bytes: Buffer;
  brandId: string;
  allowedLocations: ImportLocation[];
  allowedProducts?: ImportProduct[];
  locationAliases?: ImportLocationAlias[];
  productAliases?: ImportProductAlias[];
  locationMappings?: ImportMappings;
  productMappings?: ImportMappings;
  maxBytes?: number;
  maxRows?: number;
  now?: Date;
}): Promise<HistoryImportPreview> {
  const maxBytes = input.maxBytes ?? 5 * 1024 * 1024;
  const maxRows = input.maxRows ?? 20_000;
  const now = input.now ? new Date(input.now) : new Date();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new Error("The import limits are invalid.");
  }
  if (Number.isNaN(now.getTime())) throw new Error("The current date could not be determined.");
  if (input.bytes.byteLength === 0) throw new HistoryImportFileError("The file is empty.");
  if (input.bytes.byteLength > maxBytes) {
    throw new HistoryImportFileError(`The file is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB.`);
  }

  const worksheet = await loadWorksheet(input.filename, input.bytes);
  const populatedDataRowNumbers: number[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 1 && row.hasValues) populatedDataRowNumbers.push(rowNumber);
  });
  if (populatedDataRowNumbers.length === 0) {
    throw new HistoryImportFileError("Add at least one sales row below the headers.");
  }
  if (populatedDataRowNumbers.length > maxRows) {
    throw new HistoryImportFileError(`Use no more than ${maxRows.toLocaleString()} sales rows per import.`);
  }

  const header = worksheet.getRow(1);
  if (header.hidden) throw new HistoryImportFileError("The header row must be visible.");
  const headers = REQUIRED_HEADERS.map((_, index) => cellText(header.getCell(index + 1)).toLowerCase());
  const extraHeaders = [];
  for (let column = REQUIRED_HEADERS.length + 1; column <= Math.max(header.cellCount, REQUIRED_HEADERS.length); column += 1) {
    const value = cellText(header.getCell(column));
    if (value) extraHeaders.push(value);
  }
  if (headers.some((value, index) => value !== REQUIRED_HEADERS[index]) || extraHeaders.length > 0) {
    throw new HistoryImportFileError("Keep exactly these columns in this order: date, product, location, quantity.");
  }
  for (let column = 1; column <= worksheet.columnCount; column += 1) {
    if (worksheet.getColumn(column).hidden) throw new HistoryImportFileError("Hidden columns are not allowed.");
  }

  const allowedLocations = input.allowedLocations.filter((location) => location.brandId === input.brandId);
  const allowedProducts = (input.allowedProducts ?? []).filter((product) => product.brandId === input.brandId);
  const locationById = new Map(allowedLocations.map((location) => [location.id, location]));
  const productById = new Map(allowedProducts.map((product) => [product.id, product]));
  const errors: string[] = [];
  const explicitLocationMappings = prepareMappings(input.locationMappings, new Set(locationById.keys()), "location", errors);
  const explicitProductMappings = prepareMappings(input.productMappings, new Set(productById.keys()), "product", errors);

  const locationLookup = new Map<string, ImportLocation[]>();
  for (const location of allowedLocations) {
    addLookup(locationLookup, location.name, location);
    addLookup(locationLookup, location.importCode, location);
  }
  for (const alias of input.locationAliases ?? []) {
    const location = locationById.get(alias.locationId);
    if (location) addLookup(locationLookup, alias.sourceLabel, location);
  }

  const productLookup = new Map<string, ImportProduct[]>();
  for (const product of allowedProducts) addLookup(productLookup, product.name, product);
  for (const alias of input.productAliases ?? []) {
    const product = productById.get(alias.productId);
    if (product) addLookup(productLookup, alias.sourceLabel, product);
  }

  const rows: ValidatedHistoryRow[] = [];
  const duplicateKeys = new Set<string>();
  const products = new Set<string>();
  const locations = new Set<string>();
  const dates = new Set<string>();
  const localDateByLocation = new Map<string, string>();
  const unresolved = new Map<string, { sourceLocation: string; rowNumbers: number[] }>();
  const decisions = new Map<string, Omit<ProductDecision, "rowCount">>();

  for (const rowNumber of populatedDataRowNumbers) {
    const row = worksheet.getRow(rowNumber);
    if (row.hidden) {
      errors.push(`Row ${rowNumber}: hidden rows are not allowed.`);
      continue;
    }

    try {
      for (let column = REQUIRED_HEADERS.length + 1; column <= row.cellCount; column += 1) {
        const unexpectedValue = cellText(row.getCell(column));
        if (FORMULA_PREFIX.test(unexpectedValue)) throw new Error("contains a formula outside the four required columns");
        if (unexpectedValue) throw new Error("contains data outside the four required columns");
      }
      const businessDate = cellText(row.getCell(1));
      const sourceProduct = cellText(row.getCell(2));
      const sourceLocation = cellText(row.getCell(3));
      const quantityText = cellText(row.getCell(4));
      const productName = normalizedDisplayLabel(sourceProduct);
      const locationLabel = normalizedDisplayLabel(sourceLocation);

      if (!isRealDate(businessDate)) throw new Error("date must use YYYY-MM-DD with no timestamp");
      if (!productName) throw new Error("product is required");
      if (sourceProduct.length > MAX_PRODUCT_LENGTH) throw new Error(`product must be ${MAX_PRODUCT_LENGTH} characters or fewer`);
      if (FORMULA_PREFIX.test(productName)) throw new Error("product cannot begin with a spreadsheet formula character");
      if (CONTROL_CHARACTER.test(sourceProduct)) throw new Error("product contains an unsupported control character");
      if (!locationLabel) throw new Error("location is required");
      if (sourceLocation.length > MAX_LOCATION_LENGTH) throw new Error(`location must be ${MAX_LOCATION_LENGTH} characters or fewer`);
      if (FORMULA_PREFIX.test(locationLabel)) throw new Error("location cannot begin with a spreadsheet formula character");
      if (CONTROL_CHARACTER.test(sourceLocation)) throw new Error("location contains an unsupported control character");
      if (!/^\d+$/.test(quantityText)) throw new Error("quantity must be a whole number of zero or more");
      const quantity = Number(quantityText);
      if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 10_000_000) {
        throw new Error("quantity is outside the accepted range");
      }

      const productKey = normalizeLookup(sourceProduct);
      const explicitlyMappedProductId = explicitProductMappings.get(productKey);
      let productResolution: ProductResolution;
      if (explicitlyMappedProductId) {
        const product = productById.get(explicitlyMappedProductId);
        if (!product) throw new Error(`product “${productName}” is not available for the selected brand`);
        productResolution = {
          productId: product.id,
          productName: product.name,
          decision: "mapped",
        };
      } else {
        const productMatches = productLookup.get(productKey) ?? [];
        if (productMatches.length > 1) {
          throw new Error(`product “${productName}” is ambiguous; choose the existing product it should use`);
        }
        const product = productMatches[0];
        productResolution = product
          ? { productId: product.id, productName: product.name, decision: "existing" }
          : { productId: null, productName, decision: "new" };
      }
      addProductDecision(decisions, sourceProduct, rowNumber, productResolution);

      const locationKey = normalizeLookup(sourceLocation);
      const explicitlyMappedLocationId = explicitLocationMappings.get(locationKey);
      let location: ImportLocation | undefined;
      if (explicitlyMappedLocationId) {
        location = locationById.get(explicitlyMappedLocationId);
      } else {
        const locationMatches = locationLookup.get(locationKey) ?? [];
        if (locationMatches.length > 1) {
          throw new Error(`location “${locationLabel}” is ambiguous; choose the location it should use`);
        }
        location = locationMatches[0];
      }

      dates.add(businessDate);
      if (!location) {
        addUnresolvedLocation(unresolved, sourceLocation, rowNumber);
        continue;
      }

      let currentLocalDate = localDateByLocation.get(location.id);
      if (!currentLocalDate) {
        try {
          currentLocalDate = localBusinessDate(now, location.timeZone);
          localDateByLocation.set(location.id, currentLocalDate);
        } catch {
          throw new Error(`location “${location.name}” has an invalid timezone configuration`);
        }
      }
      if (businessDate > currentLocalDate) {
        throw new Error(`date cannot be after ${currentLocalDate}, the location's current local business date`);
      }

      const resolvedProductKey = productResolution.productId
        ? `id:${productResolution.productId}`
        : `new:${normalizeLookup(productResolution.productName)}`;
      const duplicateKey = `${location.id}\u0000${resolvedProductKey}\u0000${businessDate}`;
      if (duplicateKeys.has(duplicateKey)) throw new Error("duplicates another row in this file after applying your choices");
      duplicateKeys.add(duplicateKey);

      products.add(productResolution.productName);
      locations.add(location.name);
      rows.push({
        rowNumber,
        businessDate,
        sourceProduct,
        sourceLocation,
        productId: productResolution.productId,
        productName: productResolution.productName,
        locationName: location.name,
        locationId: location.id,
        brandId: input.brandId,
        quantity,
      });
    } catch (error) {
      errors.push(`Row ${rowNumber}: ${error instanceof Error ? error.message : "invalid row"}.`);
    }
  }

  if (rows.length === 0 && unresolved.size === 0 && errors.length === 0) errors.push("No sales rows were found.");
  const sortedDates = [...dates].sort();
  return {
    checksum: createHash("sha256").update(input.bytes).digest("hex"),
    filename: input.filename,
    rows,
    rowCount: rows.length,
    dateFrom: sortedDates[0] ?? "",
    dateTo: sortedDates.at(-1) ?? "",
    products: [...products].sort((left, right) => left.localeCompare(right)),
    locations: [...locations].sort((left, right) => left.localeCompare(right)),
    unresolvedLocations: [...unresolved.values()]
      .map((item) => ({ ...item, rowCount: item.rowNumbers.length }))
      .sort((left, right) => left.sourceLocation.localeCompare(right.sourceLocation)),
    productDecisions: [...decisions.values()]
      .map((item) => ({ ...item, rowCount: item.rowNumbers.length }))
      .sort((left, right) => left.sourceProduct.localeCompare(right.sourceProduct)),
    errors: errors.slice(0, 100),
  };
}
