import Gtk from 'gi:Gtk-4.0'
import Gdk from 'gi:Gdk-4.0'
import { fileURLToPath } from 'node:url'
import { TAG_COLORS } from '../services/tags-service.ts'

const CSS_PATH = fileURLToPath(new URL('./style.css', import.meta.url))

/* Installs the app stylesheet (src/ui/style.css, adapted from nautilus) on the
 * default display at application priority. Idempotent-safe to call once after
 * the display exists (i.e. inside Application::activate). */
export function loadStyles(): void {
  const display = Gdk.Display.getDefault()
  if (!display) return
  const provider = new Gtk.CssProvider()
  provider.loadFromPath(CSS_PATH)
  Gtk.StyleContext.addProviderForDisplay(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

  /* Per-color tag classes (.tag-color-blue { … }), generated from the palette
   * in tags-service.ts. Colors come from libadwaita's accent CSS variables so
   * they track the light/dark style; the hex is the fallback for older GTK. */
  const tagCss = TAG_COLORS.map(c =>
    `.tag-color-${c.key} { background-color: var(${c.cssVar}, ${c.hex}); }`,
  ).join('\n')
  const tagProvider = new Gtk.CssProvider()
  /* loadFromString is GTK ≥ 4.12; fall back to the older loadFromData. */
  try { tagProvider.loadFromString(tagCss) } catch { tagProvider.loadFromData(tagCss, -1) }
  Gtk.StyleContext.addProviderForDisplay(display, tagProvider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
}
