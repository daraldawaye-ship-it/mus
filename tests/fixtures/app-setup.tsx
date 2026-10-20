import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AppSetup } from "../../apps/web/src/AppSetup";
import { SessionProvider } from "../../apps/web/src/api";
import "../../apps/web/src/styles.css";

const probe = window as Window & { setupProbe?: { earlyPrompt?: boolean } };
if (probe.setupProbe?.earlyPrompt) {
  // AppSetup's static dependency has registered its listener; React has not
  // mounted yet. Verify that such an early browser event is not lost.
  window.dispatchEvent(Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: () => {
      const state = window as Window & { installRequests?: number; installHadGesture?: boolean };
      state.installRequests = (state.installRequests ?? 0) + 1;
      state.installHadGesture = navigator.userActivation.isActive;
      return Promise.resolve();
    },
    userChoice: Promise.resolve({ outcome: "accepted" }),
  }));
}
const userId = new URLSearchParams(location.search).has("signed-in") ? 7 : undefined;
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter><SessionProvider><AppSetup userId={userId} /></SessionProvider></MemoryRouter>
  </QueryClientProvider>,
);
