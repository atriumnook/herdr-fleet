import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// styles.css first: it holds the primitives (.btn, .input, .menu…) that component
// stylesheets override, and Vite emits CSS in import order
import "./styles.css";
import "katex/dist/katex.min.css";
import { Root } from "./ui/Root.tsx";
import "./lib/viewport.ts";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
