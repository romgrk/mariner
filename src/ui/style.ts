import Gtk from 'gi:Gtk-4.0'
import Gdk from 'gi:Gdk-4.0'
import { fileURLToPath } from 'node:url'

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
}
