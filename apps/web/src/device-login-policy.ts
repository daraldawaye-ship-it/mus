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

/** The shared-desktop login input intentionally has a non-password type
 * and a very narrow viewport (CSS). This reduces Chrome's opportunity to
 * associate an input with a stored password. The letters are real plain text
 * while typed; a narrow field is not secret masking or a security guarantee.
 * Registration and installed phone app retain native password field types.
 */
export function compactDesktopTextSecret(
  nativePasswordManagerAllowed: boolean,
  registering: boolean,
): boolean {
  return !registering && !nativePasswordManagerAllowed;
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
