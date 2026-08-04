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
/**
 * Turn a worksheet tab name into an A1 range Google will accept.
 *
 * In A1 notation a sheet name containing a space - or a dash, or starting
 * with a digit - must be single-quoted, and literal quotes inside it are
 * doubled. Unquoted, "Sheet 1" comes back as "Unable to parse range: Sheet 1",
 * which reads like the tab is missing rather than mis-escaped.
 *
 * Quoting is harmless for simple names, so quote unconditionally rather than
 * trying to guess which names need it.
 *
 * The name is quoted verbatim - deliberately not trimmed. Google allows a tab
 * called "Form Responses 1 " and Forms creates them, so trimming here would
 * make the one title that is exactly right impossible to ask for. Sloppy input
 * is handled by resolveWorksheet() instead, which can see the real titles.
 */
export function sheetRange(worksheetName: string): string {
  return `'${worksheetName.replace(/'/g, "''")}'`;
}

export function normaliseSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return fromUrl ? fromUrl[1]! : trimmed;
}

/** Google reports a tab that does not exist as a *parse* failure of the range. */
export const isRangeFailure = (message: string): boolean =>
  /parse range|unable to parse|not found.*range/i.test(message);

export const errorMessage = (err: unknown): string =>
  (err as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ??
  (err instanceof Error ? err.message : String(err));

/**
 * Compare tab names the way a person reads them, not the way bytes compare.
 *
 * Whitespace is dropped entirely rather than merely collapsed. "Sheet 1" and
 * "Sheet1" are the same tab to everyone except a string comparison, and that
 * single space is the most common way this goes wrong - more common than the
 * trailing space Forms leaves on "Form Responses 1 ", or the non-breaking space
 * that arrives when a title is pasted out of a browser. None of them render.
 *
 * Being this permissive is only safe because resolveWorksheet() refuses to pick
 * between two candidates: a spreadsheet with both "Sheet 1" and "Sheet1" gets
 * an error, not a coin toss.
 */
export const looseTitle = (title: string): string =>
  title.replace(/[\s\u00a0\u200b]+/g, '').toLowerCase();

/**
 * Find the real tab title the configured name was meant to refer to.
 *
 * Only an unambiguous match counts. If two tabs both loosely match, picking one
 * would be a guess about which feed the leads come from - and silently reading
 * the wrong tab is far worse than an error that says so.
 */
export function resolveWorksheet(configured: string, titles: string[]): string | null {
  const exact = titles.find((t) => t === configured);
  if (exact) return exact;
  const loose = titles.filter((t) => looseTitle(t) === looseTitle(configured));
  return loose.length === 1 ? loose[0]! : null;
}

/**
 * "Unable to parse range: 'Sheet 1'" is a dead end: it does not say whether the
 * name is mis-escaped, mis-spelled, or simply not in this spreadsheet. Since we
 * are already authenticated and holding the spreadsheet id, we can answer that
 * question instead of leaving someone to guess - so name the tabs that do exist.
 *
 * Titles are quoted and their spaces made visible, because the whole reason a
 * name can be wrong while looking right is whitespace nobody can see.
 */
export function describeRangeFailure(raw: string, titles: string[]): string {
  if (titles.length === 0) return raw;
  const list = titles.map((t) => `"${t.replace(/[\s ]/g, '·')}"`).join(', ');
  return `${raw}. This spreadsheet's tabs are: ${list} (· marks a space). Set the source's worksheet tab to one of these.`;
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
  /** Set when the configured name had to be matched loosely to a real tab. */
  resolvedWorksheet: string | null = null;

  constructor(spreadsheetId: string, worksheetName: string) {
    this.spreadsheetId = spreadsheetId;
    this.worksheetName = worksheetName;
  }

  describe(): string {
    return `google:${this.spreadsheetId}/${this.resolvedWorksheet ?? this.worksheetName}`;
  }

  async read(): Promise<RawRow[]> {
    const { google } = await import('googleapis');

    const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      ...(credentialsJson ? { credentials: JSON.parse(credentialsJson) } : {}),
    });

    const sheets = google.sheets({ version: 'v4', auth });

    let res;
    try {
      res = await sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: sheetRange(this.worksheetName),
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      });
    } catch (err) {
      const raw = errorMessage(err);
      if (!isRangeFailure(raw)) throw err;

      // Only reachable when we are authenticated and the spreadsheet is
      // readable - so listing its tabs will succeed. If it somehow does not,
      // the original error is the more useful one to surface.
      let titles: string[] = [];
      try {
        const meta = await sheets.spreadsheets.get({
          spreadsheetId: this.spreadsheetId,
          fields: 'sheets.properties.title',
        });
        titles = (meta.data.sheets ?? [])
          .map((s) => s.properties?.title)
          .filter((t): t is string => Boolean(t));
      } catch {
        throw err;
      }

      // A Forms-created tab is routinely called "Form Responses 1 " with a
      // trailing space. Reporting that as an error asks someone to spot a
      // character that does not render. If exactly one tab is the obvious
      // intended match, read it and carry on.
      const resolved = resolveWorksheet(this.worksheetName, titles);
      if (!resolved) throw new Error(describeRangeFailure(raw, titles));

      this.resolvedWorksheet = resolved;
      res = await sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: sheetRange(resolved),
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      });
    }

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
