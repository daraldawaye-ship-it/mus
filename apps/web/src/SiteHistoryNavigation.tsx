import {useLayoutEffect, useState} from "react";
import {useLocation, useNavigate, useNavigationType} from "react-router-dom";
import {ChevronLeft, ChevronRight} from "lucide-react";
import {siteHistory} from "./site-history-state";

export function SiteHistoryNavigation() {
  const navigate = useNavigate();
  const {key} = useLocation();
  const navigation = useNavigationType();
  const received = typeof window !== "undefined" ? window.history.state?.idx : null;
  const index = typeof received === "number" && Number.isSafeInteger(received) && received >= 0 ? received : 0;
  const [tracked, setTracked] = useState(() => siteHistory(null,{index,key},navigation));
  const current = siteHistory(tracked,{index,key},navigation);
  useLayoutEffect(() => setTracked(value => siteHistory(value,{index,key},navigation)), [index,key,navigation]);
  return <div className="site-history-navigation" role="group" aria-label="التنقل بين الصفحات">
    <button type="button" className="button button-ghost" title="الصفحة السابقة" aria-label="الصفحة السابقة"
      disabled={index === 0} onClick={() => navigate(-1)}><ChevronRight size={15} aria-hidden="true"/></button>
    <button type="button" className="button button-ghost" title="الصفحة التالية" aria-label="الصفحة التالية"
      disabled={index >= current.furthest} onClick={() => navigate(1)}><ChevronLeft size={15} aria-hidden="true"/></button>
  </div>;
}
