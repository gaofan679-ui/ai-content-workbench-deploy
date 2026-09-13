// Covers both HTTP headers and JSON body; never automatically repeats a POST.
export async function requestJewelry(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(options.method === "POST"
      ? "连接等待超时，后台是否已收到请求仍需核实。素材已保留，请检查原任务，不要连续点击。"
      : "暂时无法更新进度，后台任务可能仍在继续。请稍后刷新核对，不要重新生成。");
    if (error instanceof TypeError) throw new Error(options.method === "POST"
      ? "连接中断，后台是否收到本次请求仍需核实。素材已保留，稍后继续时会核对同一次提交。"
      : "连接中断，进度暂时无法更新。后台任务可能仍在继续，请稍后刷新核对。");
    throw error;
  } finally { clearTimeout(timer); }
}
