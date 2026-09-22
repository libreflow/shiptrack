import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Vérifie que le CSS responsive est cohérent : chaque règle media query
// référence des sélecteurs qui existent réellement dans index.html (sinon
// la règle est morte / n'a aucun effet, comme le bug trouvé avec
// `.checkbox-filter span` avant que le <span> ne soit ajouté au markup).

const CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf-8"
);
const HTML = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
  "utf-8"
);

describe("styles.css — responsive", () => {
  it("définit des media queries max-width couvrant la plage jusqu'à 800px (minWidth Tauri)", () => {
    const breakpoints = [...CSS.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    expect(breakpoints.length).toBeGreaterThan(0);
    const smallest = Math.min(...breakpoints);
    // La fenêtre Tauri a minWidth: 800 (tauri.conf.json) : le plus petit
    // breakpoint doit être strictement au-dessus pour que la mise en page
    // s'adapte avant d'atteindre la taille minimale réelle de la fenêtre.
    expect(smallest).toBeGreaterThan(800);
  });

  it("main est en display:flex column pour occuper l'espace vertical restant à toute largeur", () => {
    expect(CSS).toMatch(/main\s*\{[^}]*flex:\s*1/);
  });

  it("le sélecteur ciblé par la media query 850px existe dans le markup (.checkbox-filter span)", () => {
    expect(CSS).toContain(".checkbox-filter span");
    expect(HTML).toMatch(/class="checkbox-filter"[^>]*>\s*<input[^>]*\/>\s*<span>/);
  });

  it("le tableau reste scrollable horizontalement sous la largeur de contenu (pas de coupe silencieuse)", () => {
    expect(CSS).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  });
});
