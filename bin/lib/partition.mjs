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
