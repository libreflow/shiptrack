import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Garde-fous statiques (analyse du CSS source, pas de rendu réel) contre la
// classe de bug découverte lors de l'audit UX : le <dialog> natif (édition,
// confirmation, import) retombait sur un fond blanc UA par défaut en mode
// sombre, tandis que ses enfants (input/label) utilisaient var(--text) pensé
// pour un fond sombre — contraste mesuré ~1.2:1 (WCAG AA exige 4.5:1).
// Ces tests ne calculent pas de contraste réel (pas de moteur de rendu ici),
// mais verrouillent que les fixes structurels ne soient jamais retirés par
// inadvertance dans un futur refactor de styles.css.

const CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf-8"
);

describe("styles.css — cohérence du thème sombre sur les éléments natifs", () => {
  it("déclare color-scheme pour le thème clair par défaut", () => {
    expect(CSS).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/s);
  });

  it("déclare color-scheme: dark à la fois pour la préférence système et l'override manuel", () => {
    // Override manuel : :root[data-theme="dark"]
    expect(CSS).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/s);
    // Préférence système (prefers-color-scheme) sans override manuel.
    expect(CSS).toMatch(/prefers-color-scheme:\s*dark[\s\S]*?color-scheme:\s*dark/);
  });

  it("le <dialog> natif déclare explicitement background et color (pas de fond UA blanc)", () => {
    const dialogRuleMatch = CSS.match(/(?<!:{2})dialog\s*\{([^}]*)\}/);
    expect(dialogRuleMatch).toBeTruthy();
    const body = dialogRuleMatch[1];
    expect(body).toMatch(/background:\s*var\(--card\)/);
    expect(body).toMatch(/color:\s*var\(--text\)/);
  });
});
