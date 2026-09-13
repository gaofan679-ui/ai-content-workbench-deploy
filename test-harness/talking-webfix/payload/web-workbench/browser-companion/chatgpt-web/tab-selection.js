export async function selectReadyChatGPTPage(tabs, probe) {
  const ordered = [...(tabs || [])].sort((left, right) => Number(Boolean(right?.active)) - Number(Boolean(left?.active)));
  if (ordered.length === 0) {
    return { tab: null, page: { loggedIn: false, composerReady: false, pageState: "tab_closed" } };
  }

  let fallback = {
    tab: ordered[0],
    page: { loggedIn: false, composerReady: false, pageState: "page_unavailable" },
  };
  for (const tab of ordered) {
    if (!tab?.id) continue;
    try {
      const page = await probe(tab);
      if (page && fallback.page.pageState === "page_unavailable") fallback = { tab, page };
      if (page?.loggedIn === true && page?.composerReady === true) return { tab, page };
      if (page?.loggedIn === true) fallback = { tab, page };
    } catch {
      // A stale or still-loading ChatGPT tab must not hide another ready tab.
    }
  }
  return fallback;
}
