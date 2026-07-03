import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import Pango from 'gi:Pango-1.0'

/* A small overlay status pill, mirroring nautilus's NautilusFloatingBar
 * (src/nautilus-floating-bar.c + .floating-bar in style.css): a rounded box
 * pinned to a corner of the view via an Adw/Gtk overlay. Drives the typeahead
 * query indicator and the "Searching…" progress status (spinner + Cancel).
 *
 * Passthrough by default (canTarget false) so it never intercepts clicks on the
 * items beneath it — except while its Cancel button is shown (a running search),
 * where it becomes interactive so the button is clickable, like nautilus. */
export class FloatingBar {
  widget: any
  _label: any
  _spinner: any
  _stop: any
  onStop: () => void = () => {}

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

    /* Cancel button — mirrors nautilus's floating-bar stop button (circular,
     * flat, process-stop icon). Hidden unless a cancellable status is shown. */
    this._stop = new Gtk.Button({
      iconName: 'process-stop-symbolic', valign: Gtk.Align.CENTER,
      tooltipText: 'Cancel', cssClasses: ['circular', 'flat'], visible: false,
    })
    this._stop.on('clicked', () => this.onStop())
    this.widget.append(this._stop)
  }

  show(text: string, { spinner = false, stop = false }: { spinner?: boolean; stop?: boolean } = {}): void {
    this._label.setLabel(text)
    this._spinner.setVisible(spinner)
    this._stop.setVisible(stop)
    /* Only grab pointer events when there's a button to click; otherwise stay
     * passthrough so clicks fall through to the items beneath the pill. */
    this.widget.setCanTarget(stop)
    this.widget.setVisible(true)
  }

  hide(): void { this.widget.setVisible(false); this.widget.setCanTarget(false) }
}
