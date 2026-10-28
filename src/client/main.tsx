import { createRoot, hydrateRoot } from "react-dom/client";
import "../app/globals.css";
import "./fonts.css";
import { AppRoot } from "./AppRoot";

/*
 * The built page carries the prerendered shell inside #root, which React
 * hydrates. The dev server sends no shell, so there the app renders fresh.
 */
const root = document.getElementById("root")!;
if (root.firstElementChild) {
  hydrateRoot(root, <AppRoot />);
} else {
  createRoot(root).render(<AppRoot />);
}
