// Small pure helpers: random codes, PINs, tier prefixes, HTML escaping, day lists.

export function generateRandomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Ambiguity-free charset (no 0/O, 1/I)
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[array[i] % chars.length];
  }
  return result;
}

export function generatePin() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(100000 + (array[0] % 900000)); // 6 digits
}

export function getTierPrefix(tier) {
  const normalized = (tier || "general").toLowerCase();
  if (normalized.includes("vip")) return "VIP";
  if (normalized.includes("guest") || normalized.includes("list")) return "GST";
  return "GEN";
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseDays(value, totalDays) {
  if (value === "ALL") return Array.from({ length: totalDays || 1 }, (_, i) => i + 1);
  return (value || "").split(",").map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d));
}
