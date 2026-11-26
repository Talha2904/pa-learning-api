import type { AiSettings, AiSettingsRepository } from '../../domain/repositories/ai-settings-repository.js';
import type { SqlExecutor } from '../database/database.js';

interface Row {
  checks_enabled: boolean | null;
  updated_by: string | null;
  updated_at: Date | string | null;
}

const toSettings = (r: Row | undefined): AiSettings => ({
  checksEnabled: r?.checks_enabled ?? null,
  updatedBy: r?.updated_by ?? null,
  updatedAt: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
});

export class PgAiSettingsRepository implements AiSettingsRepository {
  constructor(private readonly db: SqlExecutor) {}

  async get(): Promise<AiSettings> {
    const res = await this.db.query<Row>('select checks_enabled, updated_by, updated_at from ai_settings where id = 1');
    return toSettings(res.rows[0]);
  }

  async setChecksEnabled(enabled: boolean, updatedBy: string): Promise<AiSettings> {
    const res = await this.db.query<Row>(
      `insert into ai_settings (id, checks_enabled, updated_by, updated_at) values (1, $1, $2, now())
       on conflict (id) do update set checks_enabled = excluded.checks_enabled,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at
       returning checks_enabled, updated_by, updated_at`,
      [enabled, updatedBy],
    );
    return toSettings(res.rows[0]);
  }
}
