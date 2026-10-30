import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, useRouteError } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./styles.css";
import { prepareInstall } from "./app-install";
prepareInstall();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
function RouteLoadError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "";
  const missingModule = /dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(message);
  return (
    <main dir="rtl" style={{ maxWidth: 640, margin: "4rem auto", padding: 24 }}>
      <h1>تعذر فتح الصفحة</h1>
      <p>{missingModule
        ? "ملف هذه الصفحة غير متاح على الجهاز أثناء انقطاع الإنترنت. افتح التطبيق مرة واحدة بعد عودة الاتصال لتجهيز الملفات."
        : "حدث خطأ أثناء فتح الصفحة. يمكنك إعادة المحاولة دون حذف البيانات المحفوظة على الجهاز."}</p>
      <button type="button" onClick={() => window.location.reload()}>إعادة فتح الصفحة</button>
    </main>
  );
}
const router = createBrowserRouter([{ path: "*", element: <App />, errorElement: <RouteLoadError /> }]);
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
