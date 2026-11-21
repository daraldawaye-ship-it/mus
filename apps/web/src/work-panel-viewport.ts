type VisualViewportGeometry = Pick<VisualViewport,"height"|"offsetTop"|"scale">;

/** rect.top and VisualViewport.offsetTop are both relative to the layout viewport;
 * don't add document scrollY, or subtract a sticky header a second time. */
export function mobileWorkPanelAvailableHeight(
  shellTop:number, innerHeight:number, visual:VisualViewportGeometry | null | undefined,
):number | null {
  if (visual && Number.isFinite(visual.scale) && Math.abs(visual.scale-1)>0.025) return null;
  const bottom = visual && Number.isFinite(visual.height) && visual.height>0 && Number.isFinite(visual.offsetTop)
    ? visual.height+visual.offsetTop : innerHeight;
  const available = bottom-shellTop;
  return Number.isFinite(available) ? Math.max(0,Math.floor(available)) : null;
}

export function mobileWorkPanelMaxSize(available:number,rail:number):number {
  return Math.max(rail+1,Math.min(Math.round(available*.8),available-130));
}

/** Android Back can hide its IME without blurring the input. Sample only while
 * an editable dock control is focused, as a fallback to viewport notifications. */
export function watchMobileWorkPanelGeometry({
  measure,viewport,win,document,focusWithinDock,
}:{
  measure:()=>void; viewport:EventTarget|null; win:Window; document:Document; focusWithinDock:()=>boolean;
}):()=>void {
  let frame:number|undefined;
  let recovery:number|undefined;
  let sample:number|undefined;
  const schedule = () => {
    if(frame!==undefined)return;
    frame=win.requestAnimationFrame(()=>{frame=undefined;measure();});
  };
  const onFocusChange = () => {
    schedule();
    if(recovery!==undefined)win.clearTimeout(recovery);
    recovery=win.setTimeout(()=>{
      recovery=undefined;
      const active=!document.hidden&&focusWithinDock();
      if(active&&sample===undefined)sample=win.setInterval(schedule,350);
      if(!active&&sample!==undefined){win.clearInterval(sample);sample=undefined;}
      schedule();
    },120);
  };
  viewport?.addEventListener("resize",schedule);
  viewport?.addEventListener("scroll",schedule);
  win.addEventListener("resize",schedule);
  win.addEventListener("scroll",schedule,{passive:true});
  win.addEventListener("pageshow",onFocusChange);
  document.addEventListener("focusin",onFocusChange);
  document.addEventListener("focusout",onFocusChange);
  document.addEventListener("visibilitychange",onFocusChange);
  onFocusChange();
  return ()=>{
    if(frame!==undefined)win.cancelAnimationFrame(frame);
    if(recovery!==undefined)win.clearTimeout(recovery);
    if(sample!==undefined)win.clearInterval(sample);
    viewport?.removeEventListener("resize",schedule);
    viewport?.removeEventListener("scroll",schedule);
    win.removeEventListener("resize",schedule);
    win.removeEventListener("scroll",schedule);
    win.removeEventListener("pageshow",onFocusChange);
    document.removeEventListener("focusin",onFocusChange);
    document.removeEventListener("focusout",onFocusChange);
    document.removeEventListener("visibilitychange",onFocusChange);
  };
}
