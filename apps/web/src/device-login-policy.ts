/** Password-manager behavior depends on the physical device and launch mode,
 * never on viewport width: a laptop window narrowed to phone width is still shared.
 * Native/browser password managers remain ultimately controlled by the user agent.
 */
export function mobileInstalledApp(
  userAgent:string,
  installed:boolean,
  platform="",
  maxTouchPoints=0,
):boolean {
  const phone=/iPhone|iPod|Android.*Mobile|Mobile.*Android/i.test(userAgent);
  const ipad=/iPad/i.test(userAgent) || (platform==="MacIntel" && maxTouchPoints>1);
  return installed && (phone || ipad);
}
export function allowPasswordAutofillOnDevice():boolean {
  if(typeof window==="undefined" || typeof navigator==="undefined")return false;
  const standalone=["standalone","minimal-ui","window-controls-overlay"].some(mode=>
    window.matchMedia?.(`(display-mode: ${mode})`).matches) ||
    (navigator as Navigator & {standalone?:boolean}).standalone===true;
  return mobileInstalledApp(navigator.userAgent,standalone,
    navigator.platform,navigator.maxTouchPoints);
}

/** A desktop Chrome/Edge/Safari text input can be visually masked with
 * -webkit-text-security so the login form does not expose a native password
 * input to browser password managers. Never allow an unmasked text fallback:
 * on unsupported browsers retain the native type=password.
 *
 * A text field still exposes its value to scripts and browser extensions,
 * exactly like a password field: this is a UX heuristic, not a security
 * boundary or a way to erase credentials already saved in Chrome.
 */
export function useMaskedDesktopSignInField(
  allowNativePasswordManager: boolean,
  supportsTextMask: boolean,
  registering: boolean,
): boolean {
  return !registering && !allowNativePasswordManager && supportsTextMask;
}
export function browserSupportsTextMask(): boolean {
  return typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("-webkit-text-security", "disc");
}

/** This store contains ONLY the optional login identifier, NEVER credentials. */
const IDENTIFIER_KEY="alraesy-login-identifier-v1";
export function savedLoginIdentifier():string {
  if(typeof window==="undefined")return "";
  try {
    return window.localStorage.getItem(IDENTIFIER_KEY)?.slice(0,254)??"";
  } catch {return "";}
}
export function rememberLoginIdentifier(login:string):void {
  if(typeof window==="undefined")return;
  const value=login.trim();
  if(value.length>254 || !value)return;
  try{window.localStorage.setItem(IDENTIFIER_KEY,value);}catch{/* storage blocked */}
}
