type Rect={top:number;right:number;bottom:number;left:number};
type View={left:number;top:number;width:number;height:number};
const gutter=6,gap=4,targetHeight=240;

export function dockSearchPlacement(anchor:Rect,view:View,clip?:Rect){
  const leftEdge=view.left+gutter, rightEdge=view.left+view.width-gutter;
  const topEdge=view.top+gutter,bottomEdge=view.top+view.height-gutter;
  if(view.width<=2*gutter||view.height<=2*gutter||anchor.bottom<=topEdge||anchor.top>=bottomEdge||
     anchor.right<=leftEdge||anchor.left>=rightEdge||
     (clip&&(anchor.top>=clip.bottom||anchor.bottom<=clip.top||anchor.right<=clip.left||anchor.left>=clip.right)))return null;
  const width=Math.min(Math.max(0,anchor.right-anchor.left),rightEdge-leftEdge);
  if(!width)return null;
  const left=Math.min(Math.max(leftEdge,anchor.left),rightEdge-width);
  const below=Math.max(0,bottomEdge-anchor.bottom-gap);
  const above=Math.max(0,anchor.top-gap-topEdge);
  const side=below<targetHeight&&above>below?"above":"below";
  const maxHeight=Math.floor(Math.min(targetHeight,side==="above"?above:below));
  if(maxHeight<22)return null;
  return {left,width,top:side==="above"?anchor.top-gap:anchor.bottom+gap,maxHeight,side};
}
