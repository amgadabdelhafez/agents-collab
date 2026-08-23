import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import { initializeBrowserAppearance } from "./theme";

initializeBrowserAppearance();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Loop Web UI root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
