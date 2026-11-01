import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { isDesktop } from "./cloud";
import { Hud } from "./Hud";
import "./styles.css";
import "./pwa";

const hud = isDesktop && getCurrentWindow().label === "hud";
if (hud) document.documentElement.classList.add("hud-root");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {hud ? <Hud /> : <App />}
  </StrictMode>,
);
