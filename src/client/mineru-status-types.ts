/** Non-sensitive MinerU readiness facts shared by Host and the settings card. */
export interface MineruStatus {
  installed: boolean
  tokenConfigured: boolean
  tokenSource?: 'environment' | 'config'
}
