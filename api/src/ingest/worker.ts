import type { Database, Querier } from '../db/pool.ts';
import { payloadHash, type RawRow, type SheetReader } from './source.ts';
import { GoogleSheetReader } from './source.ts';

/**
 * Google Sheets (or pasted CSV) -> crm.ingested_rows -> crm.leads.
 *
 * Three properties this pipeline has to have, in priority order:
 *
 *  1. Re-running it is always safe. Meta appends to the sheet and the worker
 *     re-reads the whole thing; the unique index on
 *     (source_id, source_row_key, payload_hash) means an unchanged row can
 *     never produce a second lead.
 *
 *  2. Nothing is ever dropped. A row with an undialable phone number is
 *     quarantined with a reason, not discarded - a mistyped number is a lead
 *     someone paid for.
 *
 *  3. One bad row cannot stop the run. Each row is its own transaction, so a
 *     single malformed record does not block the 200 leads behind it.
 *
 * Assignment needs no second pass: the lead-insert trigger hands each lead to
 * the least-loaded caller as it lands.
 */

export interface IngestSummary {
  runId: string;
  sourceId: string;
  seen: number;
  created: number;
  duplicate: number;
  quarantined: number;
  errors: string[];
}

interface SourceRow {
  id: string;
  name: string;
  spreadsheet_id: string | null;
  worksheet_name: string | null;
  column_map: Record<string, string>;
}

/** Canonical lead fields the mapper knows how to fill. */
const MAPPABLE = ['full_name', 'phone', 'email', 'city', 'campaign'] as const;

type Mappable = (typeof MAPPABLE)[number];

/**
 * Header names to try when the source has no explicit mapping for a field.
 *
 * A source configured without a column map would otherwise quarantine every
 * row for having "no phone number", which looks like a data problem and is a
 * configuration one. Meta and the ChatGPT export use a small, predictable set
 * of header names, so try those before giving up. An explicit mapping always
 * wins - this only fills gaps.
 */
const DEFAULT_ALIASES: Record<Mappable, string[]> = {
  full_name: ['full_name', 'full name', 'name', 'lead name', 'customer name'],
  phone: ['phone', 'phone number', 'phone_number', 'mobile', 'mobile number', 'contact number', 'whatsapp number'],
  email: ['email', 'email address', 'email_address', 'e-mail'],
  city: ['city', 'town', 'location'],
  campaign: ['campaign_name', 'campaign name', 'campaign', 'ad_name', 'ad name', 'form_name', 'form name'],
};

function findByAlias(
  values: Record<string, string>,
  aliases: string[],
): { header: string; value: string } | null {
  for (const [header, value] of Object.entries(values)) {
    if (aliases.includes(header.trim().toLowerCase())) {
      return { header, value };
    }
  }
  return null;
}

/**
 * Apply the source's column map. Everything the map does not claim is kept in
 * `extra` rather than thrown away - sheets grow columns without warning, and a
 * column nobody mapped yet is still information someone paid for.
 */
export function mapRow(
  values: Record<string, string>,
  columnMap: Record<string, string>,
): { mapped: Partial<Record<Mappable, string>>; extra: Record<string, string> } {
  const mapped: Partial<Record<Mappable, string>> = {};
  const claimed = new Set<string>();

  for (const field of MAPPABLE) {
    const header = columnMap[field];
    if (header) {
      claimed.add(header);
      const value = values[header];
      if (value) mapped[field] = value;
      continue;
    }

    const guess = findByAlias(values, DEFAULT_ALIASES[field]);
    if (guess) {
      claimed.add(guess.header);
      if (guess.value) mapped[field] = guess.value;
    }
  }

  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!claimed.has(key) && value) extra[key] = value;
  }

  return { mapped, extra };
}

export class IngestWorker {
  private readonly db: Database;
  /** User the ingestion acts as: the service account, or the admin who clicked. */
  private readonly actingUserId: string;

  constructor(db: Database, actingUserId: string) {
    this.db = db;
    this.actingUserId = actingUserId;
  }

  async runSource(sourceId: string, readerOverride?: SheetReader): Promise<IngestSummary> {
    const source = await this.db.withUser(this.actingUserId, (q) =>
      q.one<SourceRow>(
        `select id, name, spreadsheet_id, worksheet_name, column_map
           from crm.lead_sources where id = $1 and is_active`,
        [sourceId],
      ),
    );
    if (!source) throw new Error(`lead source ${sourceId} not found or inactive`);

    const reader =
      readerOverride ??
      (source.spreadsheet_id && source.worksheet_name
        ? new GoogleSheetReader(source.spreadsheet_id, source.worksheet_name)
        : null);
    if (!reader) throw new Error(`source ${source.name} has no sheet configured and no reader supplied`);

    const runId = await this.db.withUser(this.actingUserId, async (q) => {
      const row = await q.one<{ id: string }>(
        `insert into crm.ingestion_runs (source_id) values ($1) returning id`,
        [sourceId],
      );
      return row!.id;
    });

    const summary: IngestSummary = {
      runId,
      sourceId,
      seen: 0,
      created: 0,
      duplicate: 0,
      quarantined: 0,
      errors: [],
    };

    let rows: RawRow[];
    try {
      rows = await reader.read();
    } catch (err) {
      await this.finishRun(runId, summary, err instanceof Error ? err.message : String(err));
      throw err;
    }

    summary.seen = rows.length;

    // If the configured tab name only matched loosely, write the real title
    // back, so future syncs skip the rediscovery and the admin screen shows
    // the tab actually being read.
    if (reader instanceof GoogleSheetReader && reader.resolvedWorksheet) {
      const real = reader.resolvedWorksheet;
      if (real !== source.worksheet_name) {
        await this.db.withUser(this.actingUserId, (q) =>
          q.query('update crm.lead_sources set worksheet_name = $2 where id = $1', [sourceId, real]),
        );
      }
    }

    for (const row of rows) {
      try {
        // One transaction per row: a single bad record cannot take the run down.
        const outcome = await this.db.withUser(this.actingUserId, (q) =>
          this.ingestRow(q, source, runId, row),
        );
        summary[outcome] += 1;
      } catch (err) {
        summary.errors.push(`${row.rowKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.finishRun(runId, summary, null);
    return summary;
  }

  private async ingestRow(
    q: Querier,
    source: SourceRow,
    runId: string,
    row: RawRow,
  ): Promise<'created' | 'duplicate' | 'quarantined'> {
    const hash = payloadHash(row.values);

    // Idempotency. The unique index does the real work; this check just avoids
    // the noise of a failed insert on the common re-sync path.
    const seen = await q.one<{ id: string }>(
      `select id from crm.ingested_rows
        where source_id = $1 and source_row_key = $2 and payload_hash = $3`,
      [source.id, row.rowKey, hash],
    );
    if (seen) return 'duplicate';

    const { mapped, extra } = mapRow(row.values, source.column_map ?? {});
    const rawPhone = mapped.phone ?? '';

    const normalised = await q.one<{ normalise_phone: string | null }>(
      'select crm.normalise_phone($1) as normalise_phone',
      [rawPhone],
    );
    const phone = normalised?.normalise_phone ?? null;

    // Quarantine rather than drop: keep the row, record why, let the admin fix it.
    const reject =
      !rawPhone ? 'no phone number in the mapped column'
      : !phone ? `phone number is not dialable: ${rawPhone}`
      : !phone.startsWith('+91') ? `not an Indian mobile number: ${phone}`
      : null;

    if (reject) {
      await q.query(
        `insert into crm.ingested_rows
           (run_id, source_id, source_row_key, payload_hash, payload, status, reject_reason)
         values ($1, $2, $3, $4, $5, 'quarantined', $6)`,
        [runId, source.id, row.rowKey, hash, JSON.stringify(row.values), reject],
      );
      return 'quarantined';
    }

    // A repeat enquiry attaches to the existing lead - never a second lead.
    // A LIVE lead matches at any age; the dedupe window applies only to closed
    // ones, where a fresh enquiry genuinely is a fresh lead. The unique index
    // leads_one_live_per_phone_idx enforces the same rule at the schema level,
    // so a race between two syncs errors loudly instead of duplicating quietly.
    const existing = await q.one<{ id: string }>(
      `select id from crm.leads
        where phone_e164 = $1
          and (stage in ('new', 'calling', 'qualified')
               or created_at > now() - make_interval(days => crm.setting_int('lead.dedupe_window_days', 90)))
        order by (stage in ('new', 'calling', 'qualified')) desc, created_at desc
        limit 1`,
      [phone],
    );

    if (existing) {
      await q.query('select crm.attach_enquiry($1, $2, $3)', [
        existing.id,
        source.id,
        JSON.stringify({ row_key: row.rowKey }),
      ]);
      await q.query(
        `insert into crm.ingested_rows
           (run_id, source_id, source_row_key, payload_hash, payload, status, reject_reason, lead_id)
         values ($1, $2, $3, $4, $5, 'duplicate', $6, $7)`,
        [
          runId,
          source.id,
          row.rowKey,
          hash,
          JSON.stringify(row.values),
          'matched an existing lead - recorded as a repeat enquiry',
          existing.id,
        ],
      );
      return 'duplicate';
    }

    const lead = await q.one<{ id: string }>(
      `insert into crm.leads
         (source_id, full_name, phone_e164, phone_raw, email, city, campaign, extra)
       values ($1, $2, $3, $4, nullif($5, ''), nullif($6, ''), nullif($7, ''), $8)
       returning id`,
      [
        source.id,
        mapped.full_name ?? null,
        phone,
        rawPhone,
        mapped.email ?? '',
        mapped.city ?? '',
        mapped.campaign ?? '',
        JSON.stringify(extra),
      ],
    );

    await q.query(
      `insert into crm.ingested_rows
         (run_id, source_id, source_row_key, payload_hash, payload, status, lead_id)
       values ($1, $2, $3, $4, $5, 'accepted', $6)`,
      [runId, source.id, row.rowKey, hash, JSON.stringify(row.values), lead!.id],
    );

    return 'created';
  }

  private async finishRun(
    runId: string,
    summary: IngestSummary,
    error: string | null,
  ): Promise<void> {
    await this.db.withUser(this.actingUserId, (q) =>
      q.query(
        `update crm.ingestion_runs
            set finished_at = now(), rows_seen = $2, rows_created = $3,
                rows_duplicate = $4, rows_quarantined = $5, error_text = $6
          where id = $1`,
        [runId, summary.seen, summary.created, summary.duplicate, summary.quarantined, error],
      ),
    );
    if (!error) {
      await this.db.withUser(this.actingUserId, (q) =>
        q.query('update crm.lead_sources set last_synced_at = now() where id = $1', [
          summary.sourceId,
        ]),
      );
    }
  }

  /** Every active source with a sheet configured. */
  async runAll(): Promise<IngestSummary[]> {
    const sources = await this.db.withUser(this.actingUserId, (q) =>
      q.many<{ id: string }>(
        `select id from crm.lead_sources
          where is_active and spreadsheet_id is not null order by name`,
      ),
    );

    const summaries: IngestSummary[] = [];
    for (const source of sources) {
      summaries.push(await this.runSource(source.id));
    }
    return summaries;
  }
}
