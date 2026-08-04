import { createHash } from 'node:crypto';

/**
 * A sheet row as read from the source, before any interpretation.
 * `rowKey` must be stable for the life of the row - it is half of the
 * idempotency key that stops a re-sync creating duplicate leads.
 */
export interface RawRow {
  rowKey: string;
  values: Record<string, string>;
}

export interface SheetReader {
  /** Human name, for logs and the ingestion_runs record. */
  describe(): string;
  read(): Promise<RawRow[]>;
}

/**
 * Accept either a bare spreadsheet id or the whole browser URL.
 *
 * What is in someone's clipboard is the URL - that is what they copied out of
 * the address bar. Demanding the id buried in the middle of it, and failing
 * hours later with a 404 from Google when they get it wrong, is a bad trade
 * for one regex.
 */
export function normaliseSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return fromUrl ? fromUrl[1]! : trimmed;
}

export const payloadHash = (values: Record<string, string>): string =>
  createHash('sha256')
    .update(JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');

/**
 * Reads a Google Sheet through the Sheets API.
 *
 * Auth is a service account with read-only scope; share the sheet with the
 * service account's email. Credentials come from GOOGLE_APPLICATION_CREDENTIALS
 * or GOOGLE_SERVICE_ACCOUNT_JSON, never from the database.
 */
export class GoogleSheetReader implements SheetReader {
  private readonly spreadsheetId: string;
  private readonly worksheetName: string;

  constructor(spreadsheetId: string, worksheetName: string) {
    this.spreadsheetId = spreadsheetId;
    this.worksheetName = worksheetName;
  }

  describe(): string {
    return `google:${this.spreadsheetId}/${this.worksheetName}`;
  }

  async read(): Promise<RawRow[]> {
    const { google } = await import('googleapis');

    const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      ...(credentialsJson ? { credentials: JSON.parse(credentialsJson) } : {}),
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: this.worksheetName,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });

    const rows = res.data.values ?? [];
    if (rows.length === 0) return [];

    const headers = (rows[0] ?? []).map((h) => String(h ?? '').trim());

    return rows.slice(1).flatMap((row, index) => {
      const values: Record<string, string> = {};
      let hasContent = false;
      headers.forEach((header, col) => {
        if (!header) return;
        const cell = row[col];
        const text = cell === undefined || cell === null ? '' : String(cell).trim();
        values[header] = text;
        if (text) hasContent = true;
      });
      if (!hasContent) return [];
      // Sheet row number: +2 for the header row and 1-based indexing. Stable as
      // long as rows are appended, which is how Meta writes into the sheet.
      return [{ rowKey: `row:${index + 2}`, values }];
    });
  }
}

/** In-memory reader used by tests and for replaying a captured sheet. */
export class StaticSheetReader implements SheetReader {
  private readonly rows: RawRow[];
  private readonly name: string;

  constructor(rows: RawRow[], name = 'static') {
    this.rows = rows;
    this.name = name;
  }

  describe(): string {
    return `static:${this.name}`;
  }

  async read(): Promise<RawRow[]> {
    return this.rows;
  }
}

/** Build rows from CSV text, for one-off imports and for tests. */
export function rowsFromCsv(csv: string): RawRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    out.push(current);
    return out.map((v) => v.trim());
  };

  const headers = parseLine(lines[0]!);
  return lines.slice(1).map((line, index) => {
    const cells = parseLine(line);
    const values: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) values[h] = cells[i] ?? '';
    });
    return { rowKey: `row:${index + 2}`, values };
  });
}
