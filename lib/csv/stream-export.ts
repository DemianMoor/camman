import "server-only";

// Per-column declaration for a streamed CSV response. `key` is the field name
// in the mapped row object, `label` is the header text rendered in the CSV.
export type CsvColumn = { key: string; label: string };

export interface StreamCsvOptions<T> {
  filename: string;
  columns: CsvColumn[];
  rowSource: AsyncIterable<T>;
  rowMapper: (row: T) => Record<string, unknown>;
}

// CSV-escape a single value. Wraps in double quotes when the value contains
// comma, newline, carriage return, or quote; interior quotes are doubled.
// Dates serialize as ISO 8601; null/undefined become empty string; numbers
// and booleans serialize via String().
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === "number" || typeof value === "boolean")
    s = String(value);
  else s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Streams a CSV response back to the client. The body is a ReadableStream
// driven by `rowSource`, so memory usage stays bounded regardless of result
// size. Pass `rowSource` as an AsyncIterable (typically built via
// chunkedQuery below for offset-pagination, or via a true cursor when one
// is available).
export function streamCsvResponse<T>(opts: StreamCsvOptions<T>): Response {
  const { filename, columns, rowSource, rowMapper } = opts;
  const encoder = new TextEncoder();
  const headerLine =
    columns.map((c) => csvEscape(c.label)).join(",") + "\n";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(headerLine));
        for await (const row of rowSource) {
          const mapped = rowMapper(row);
          const line =
            columns.map((c) => csvEscape(mapped[c.key])).join(",") + "\n";
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

// Build an AsyncIterable that walks a result set in fixed-size chunks via
// offset pagination. Simpler than a true streaming cursor and works fine up
// to a few hundred thousand rows. If we need to export millions of rows
// this should be replaced with a server-side cursor (DECLARE … FETCH).
export async function* chunkedQuery<T>(opts: {
  chunkSize?: number;
  fetchChunk: (offset: number, limit: number) => Promise<T[]>;
}): AsyncGenerator<T> {
  const limit = opts.chunkSize ?? 5000;
  let offset = 0;
  while (true) {
    const rows = await opts.fetchChunk(offset, limit);
    if (rows.length === 0) return;
    for (const r of rows) yield r;
    if (rows.length < limit) return;
    offset += limit;
  }
}

// Build the export filename with a YYYY-MM-DD-HHMMSS suffix in the server's
// local time. The time portion uses no colons so the filename is valid on
// Windows. Prefix is sanitized to alphanumerics + hyphen + underscore so it's
// safe to interpolate into the Content-Disposition header.
export function buildExportFilename(prefix: string): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]+/g, "-");
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${safePrefix}-${yyyy}-${mm}-${dd}-${hh}${min}${ss}.csv`;
}
