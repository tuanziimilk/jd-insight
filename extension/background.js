/* Service worker：只做三件小事
 *   1. 点扩展图标时，侧边栏能跟着当前标签开
 *   2. Alt+A 开/关侧边栏
 *   3. Alt+S 转发给内容脚本去存 JD（内容脚本自己也监听了按键，这里是兜底：
 *      当页面焦点在 iframe 或输入框里时，页面级 keydown 可能收不到）
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => {});
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === "open-panel") {
    try {
      await chrome.sidePanel.open({ tabId: tab?.id, windowId: tab?.windowId });
    } catch (e) {
      // 老版本 Chrome 不支持编程式打开，让用户自己点图标
      console.warn("sidePanel.open 不可用：", e.message);
    }
    return;
  }
  if (cmd === "save-jd" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "JDC_SAVE" }).catch(() => {});
  }
});
