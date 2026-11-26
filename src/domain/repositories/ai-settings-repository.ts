/** The Learning Team's on/off switch for automatic AI evidence checks. */
export interface AiSettings {
  /** null = never set in the app; the server default (AI_VERIFICATION_ENABLED) applies. */
  checksEnabled: boolean | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AiSettingsRepository {
  get(): Promise<AiSettings>;
  setChecksEnabled(enabled: boolean, updatedBy: string): Promise<AiSettings>;
}
