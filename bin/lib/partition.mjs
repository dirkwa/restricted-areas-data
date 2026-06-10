/**
 * Partition-exclusion matching.
 *
 * mapping.json's exclude.partitions holds canonical partition tokens
 * ("HighSeas"), but the workflows pass the raw member basename
 * ("Navigator_AllSites_HighSeas_052826") as --partition. An exact-equality
 * check therefore NEVER fired in CI/local builds — the HighSeas member
 * streamed straight through and only the area/bbox-span caps caught its
 * giants (the published v2026.05 exclusions tally shows partition: 0).
 *
 * Match the canonical token as an underscore-delimited component instead, so
 * both the short form ("HighSeas") and the member basename are excluded, while
 * an incidental substring never is.
 */
export function isExcludedPartition(partition, excludedTokens) {
  if (typeof partition !== 'string' || partition === '') return false
  const components = partition.split('_')
  return excludedTokens.some((token) => components.includes(token))
}

/**
 * The API-side counterpart of the HighSeas partition exclusion: the catalog
 * has no partition concept, but high-seas RFMO sites carry this country value
 * (verified against the 052826 download: 701 of the HighSeas member's 704
 * features, and zero features anywhere else). The sync skips them so the
 * mirror's exclusion holds for sites arriving via the API; the handful with a
 * real country remain subject to the area/bbox-span caps like everything else.
 */
export const HIGH_SEAS_COUNTRY = 'High Seas / International'

export function isHighSeasCountry(country) {
  return country === HIGH_SEAS_COUNTRY
}
