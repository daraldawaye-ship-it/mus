/**
 * Position the user shortcut submenu using physical viewport coordinates.
 * A CSS logical "inline-start" offset is not sufficient: the avatar
 * dropdown may be near either screen edge regardless of RTL direction.
 */
export type ShortcutAnchor = {left:number;right:number;top:number};
export type ShortcutViewport = {width:number;height:number};
export type ShortcutPlacement =
  | {mode:"inline"}
  | {mode:"side";side:"left"|"right";left:number;top:number;width:number;maxHeight:number};

export function positionShortcutFlyout(
  anchor:ShortcutAnchor,viewport:ShortcutViewport,
):ShortcutPlacement {
  const margin=8;
  const overlap=2; // no mouse-leave gap between parent and flyout
  const desiredWidth=Math.min(290,Math.max(0,viewport.width-2*margin));
  const leftSpace=anchor.left-margin+overlap;
  const rightSpace=viewport.width-anchor.right-margin+overlap;
  const maximumSideSpace=Math.max(leftSpace,rightSpace);
  // A narrow sliver beside the avatar is less useful than a fully readable
  // list nested under "اختصار إلى".
  if (maximumSideSpace < Math.min(220,desiredWidth)) return {mode:"inline"};
  const side=rightSpace>=leftSpace?"right":"left";
  const width=Math.min(desiredWidth,maximumSideSpace);
  const left=side==="right"?anchor.right-overlap:anchor.left-width+overlap;
  const maxHeight=Math.min(540,Math.max(0,viewport.height-2*margin));
  const top=Math.max(margin,Math.min(anchor.top,viewport.height-margin-maxHeight));
  return {mode:"side",side,left,top,width,maxHeight};
}
