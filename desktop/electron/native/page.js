function readPageCommand(argv) {
  var id = argv[0],
    source = argv[1],
    target = JSON.parse(argv[2] || "{}");
  if (
    [
      "com.apple.Safari",
      "com.google.Chrome",
      "com.microsoft.edgemac",
      "com.brave.Browser",
    ].indexOf(id) < 0
  )
    throw new Error("UNSUPPORTED");
  var browser = browserTarget(id, target.pid);
  if (!browser.running()) return JSON.stringify({ status: "not_running" });
  var windows = browser.windows();
  if (windows.length === 0) return JSON.stringify({ status: "no_window" });
  var tab = null,
    selectedWindow = null,
    selectedIndex = -1;
  if (target.windowId !== undefined) {
    for (var wi = 0; wi < windows.length; wi++) {
      if (String(windows[wi].id()) !== String(target.windowId)) continue;
      var tabs = windows[wi].tabs();
      if (id === "com.apple.Safari") {
        var index = Number(target.tabId);
        if (index >= 0 && index < tabs.length && Number.isInteger(index)) {
          var candidate = tabs[index];
          if (
            !target.title ||
            String(candidate.name()).slice(0, 500) === target.title
          ) {
            tab = candidate;
            selectedWindow = windows[wi];
            selectedIndex = index;
          }
        }
      } else {
        for (var ti = 0; ti < tabs.length; ti++)
          if (String(tabs[ti].id()) === String(target.tabId)) {
            tab = tabs[ti];
            selectedWindow = windows[wi];
            selectedIndex = ti;
            break;
          }
      }
    }
    if (!tab) return JSON.stringify({ status: "stale_tab" });
  } else
    tab =
      id === "com.apple.Safari"
        ? windows[0].currentTab()
        : windows[0].activeTab();
  if (!/^https?:\/\//i.test(String(tab.url())))
    return JSON.stringify({ status: "unsupported" });
  if (target.activate === true && selectedWindow) {
    browser.showTab(selectedWindow, tab, selectedIndex);
    delay(0.4);
  }
  return id === "com.apple.Safari"
    ? browser.doJavaScript(source, { in: tab })
    : tab.execute({ javascript: source });
}
function run(argv) {
  try {
    return readPageCommand(argv);
  } catch (error) {
    var code = Number(error.errorNumber),
      message = String(error);
    var status =
      code === -1743
        ? "permission_required"
        : code === -1712
          ? "timeout"
          : code === -1728
            ? "stale_tab"
            : code === -600 || code === -609
              ? "not_running"
              : /JavaScript.*(disabled|not allowed|not permitted)|Executing JavaScript through AppleScript is turned off|不允许.*JavaScript|JavaScript.*(禁止|停用|关闭)/i.test(
                    message,
                  )
                ? "javascript_permission_required"
                : "read_failed";
    return JSON.stringify({ status: status });
  }
}
