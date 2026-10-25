// Tiny DOM helpers: every element the app touches has an id in index.html.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

/** Shows one full-screen section and hides the rest. */
export function show(id: string): void {
  for (const s of document.querySelectorAll<HTMLElement>("[data-screen]")) {
    s.classList.toggle("on", s.id === id);
  }
}
