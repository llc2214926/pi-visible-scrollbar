export function isSupportedPiVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version) return false;
  const major = BigInt(match[1]), minor = BigInt(match[2]);
  return major > 1n || (major === 1n && minor >= 6n);
}
