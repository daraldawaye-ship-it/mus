/** Browser tabs and installed web apps are different reporting categories.
 * This is a reporting hint, not a security or permission claim. */
export type DeviceKind = "desktop_browser" | "mobile_browser" | "android_app" | "iphone_app";

export function currentDeviceKind(): DeviceKind {
  const agent = navigator.userAgent;
  const appleMobile = /iPhone|iPad|iPod/i.test(agent) ||
    (/Macintosh/i.test(agent) && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(agent);
  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone && appleMobile) return "iphone_app";
  if (standalone && android) return "android_app";
  return appleMobile || android || /Mobi|Mobile/i.test(agent)
    ? "mobile_browser" : "desktop_browser";
}
