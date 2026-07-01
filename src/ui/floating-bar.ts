import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Pango from 'gi:Pango-1.0'

/* A small overlay status pill, mirroring nautilus's NautilusFloatingBar
 * (src/nautilus-floating-bar.c + .floating-bar in style.css): a rounded box
 * pinned to a corner of the view via an Adw/Gtk overlay. Currently drives the
 * typeahead query indicator; kept general (optional spinner) for future
 * loading/selection status use.
 *
 * Purely informational — canTarget is false so it never intercepts clicks on
 * the items beneath it (nautilus instead hides on hover; we don't need that). */
export class FloatingBar {
  widget: any
  _label: any
  _spinner: any

  constructor(align: { h?: any; v?: any } = {}) {
    this.widget = new Gtk.Box({
      halign: align.h ?? Gtk.Align.END,
      valign: align.v ?? Gtk.Align.END,
      spacing: 8,
      marginTop: 4, marginBottom: 4, marginStart: 4, marginEnd: 4,
      visible: false,
    })
    this.widget.addCssClass('floating-bar')
    this.widget.setCanTarget(false)

    this._spinner = new Adw.Spinner({ widthRequest: 16, heightRequest: 16, marginStart: 8, visible: false })
    this.widget.append(this._spinner)

    this._label = new Gtk.Label({
      singleLineMode: true, ellipsize: Pango.EllipsizeMode.MIDDLE,
      marginTop: 2, marginBottom: 2, marginStart: 8, marginEnd: 8,
    })
    this.widget.append(this._label)
  }

  show(text: string, { spinner = false }: { spinner?: boolean } = {}): void {
    this._label.setLabel(text)
    this._spinner.setVisible(spinner)
    this.widget.setVisible(true)
  }

  hide(): void { this.widget.setVisible(false) }
}
