/* node-gtk exposes GObject-Introspection namespaces under `gi:` specifiers.
 * They have no generated types here, so they are declared `any`. Our own domain
 * is typed in core/types.ts. (A future option: node-gtk's `gen-types`.) */
declare module 'gi:Gtk-4.0' { const Gtk: any; export default Gtk }
declare module 'gi:Adw-1' { const Adw: any; export default Adw }
declare module 'gi:Gio-2.0' { const Gio: any; export default Gio }
declare module 'gi:GLib-2.0' { const GLib: any; export default GLib }
declare module 'gi:GObject-2.0' { const GObject: any; export default GObject }
declare module 'gi:Gdk-4.0' { const Gdk: any; export default Gdk }
declare module 'gi:GdkPixbuf-2.0' { const GdkPixbuf: any; export default GdkPixbuf }
declare module 'gi:Pango-1.0' { const Pango: any; export default Pango }
