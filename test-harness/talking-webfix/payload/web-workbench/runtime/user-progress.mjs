export function userVisibleProgress(message) {
  const value = String(message || "").trim();
  if (!value) return "";
  if (/^Reconnecting\.\.\.\s*\d+\/\d+/i.test(value)) {
    return "网络连接有波动，系统正在恢复当前检查；不会重复提交。";
  }
  return value.slice(0, 300);
}
