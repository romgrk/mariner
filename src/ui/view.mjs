import Gtk from 'gi:Gtk-4.0'
import Pango from 'gi:Pango-1.0'
import {
  displayName, formatSize, formatType, formatModified,
} from '../util.mjs'

/* Grid + list views over a shared selection model, swapped in a Gtk.Stack.
 * Window sets onActivate(info, file) and onContextMenu(widget, x, y, target). */
export class FileView {
  constructor(model) {
    this.model = model
    this.selection = Gtk.MultiSelection.new(model.store)
    this.iconSize = 64
    this.onActivate = () => {}
    this.onContextMenu = () => {}

    this.gridView = new Gtk.GridView({
      model: this.selection,
      factory: this._gridFactory(),
      maxColumns: 20,
      minColumns: 1,
      vexpand: true,
    })
    this.gridView.on('activate', (...a) => this._activate(a[a.length - 1]))

    this.columnView = new Gtk.ColumnView({ model: this.selection, vexpand: true })
    this.columnView.addCssClass('rich-list')
    this._addColumn('Name', i => displayName(i), true, true)
    this._addColumn('Size', formatSize, false, false, Gtk.Justification.RIGHT)
    this._addColumn('Type', formatType, false, false)
    this._addColumn('Modified', formatModified, false, false)
    this.columnView.on('activate', (...a) => this._activate(a[a.length - 1]))

    this.stack = new Gtk.Stack()
    this.stack.addNamed(scrolled(this.gridView), 'grid')
    this.stack.addNamed(scrolled(this.columnView), 'list')

    this._addBackgroundMenu(this.gridView)
    this._addBackgroundMenu(this.columnView)
  }

  get widget() { return this.stack }

  setMode(mode) { this.stack.setVisibleChildName(mode === 'list' ? 'list' : 'grid') }

  setZoom(px) {
    this.iconSize = px
    this.gridView.setFactory(this._gridFactory())
  }

  /* [{info, file}] for current selection. */
  getSelected() {
    const out = []
    const sel = this.selection
    const n = sel.getNItems()
    for (let i = 0; i < n; i++) {
      if (sel.isSelected(i)) {
        const info = this.model.store.getItem(i)
        out.push({ info, file: this.model.childFor(info) })
      }
    }
    return out
  }

  selectAll() { this.selection.selectAll() }

  _activate(pos) {
    const info = this.model.store.getItem(pos)
    if (!info) return
    this.onActivate(info, this.model.childFor(info))
  }

  _gridFactory() {
    const factory = new Gtk.SignalListItemFactory()
    factory.on('setup', item => {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 6,
        halign: Gtk.Align.CENTER, valign: Gtk.Align.START,
        marginTop: 6, marginBottom: 6, marginStart: 4, marginEnd: 4,
        widthRequest: 100,
      })
      const image = new Gtk.Image({ pixelSize: this.iconSize })
      const label = new Gtk.Label({
        ellipsize: Pango.EllipsizeMode.END, wrap: true,
        wrapMode: Pango.WrapMode.WORD_CHAR, lines: 2,
        justify: Gtk.Justification.CENTER, maxWidthChars: 14, widthChars: 0,
      })
      box.append(image); box.append(label)
      item.setChild(box)
      this._attachCellMenu(box, item)
    })
    factory.on('bind', item => {
      const info = item.getItem()
      const box = item.getChild()
      box._item = item
      const image = box.getFirstChild()
      const label = box.getLastChild()
      const icon = info.getIcon()
      if (icon) image.setFromGicon(icon)
      else image.setFromIconName('text-x-generic')
      label.setLabel(displayName(info))
    })
    return factory
  }

  _addColumn(title, fmt, expand, isName, justify = Gtk.Justification.LEFT) {
    const factory = new Gtk.SignalListItemFactory()
    factory.on('setup', item => {
      if (isName) {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 })
        const image = new Gtk.Image({ pixelSize: 16 })
        const label = new Gtk.Label({ ellipsize: Pango.EllipsizeMode.END, xalign: 0 })
        box.append(image); box.append(label)
        item.setChild(box)
        this._attachCellMenu(box, item)
      } else {
        const label = new Gtk.Label({
          xalign: justify === Gtk.Justification.RIGHT ? 1 : 0,
          ellipsize: Pango.EllipsizeMode.END,
        })
        label.addCssClass('dim-label')
        item.setChild(label)
      }
    })
    factory.on('bind', item => {
      const info = item.getItem()
      const child = item.getChild()
      if (isName) {
        child._item = item
        const icon = info.getIcon()
        if (icon) child.getFirstChild().setFromGicon(icon)
        child.getLastChild().setLabel(fmt(info))
      } else {
        child.setLabel(fmt(info))
      }
    })
    const col = new Gtk.ColumnViewColumn({ title, factory })
    col.setExpand(!!expand)
    if (!isName) col.setResizable(true)
    this.columnView.appendColumn(col)
  }

  _attachCellMenu(widget, item) {
    const gesture = new Gtk.GestureClick({ button: 3 })
    gesture.on('pressed', (...a) => {
      const [x, y] = a.slice(-2)
      const pos = item.getPosition()
      if (!this.selection.isSelected(pos)) this.selection.selectItem(pos, true)
      const info = this.model.store.getItem(pos)
      gesture.setState(Gtk.EventSequenceState.CLAIMED)
      this.onContextMenu(widget, x, y, { info, file: this.model.childFor(info) })
    })
    widget.addController(gesture)
  }

  _addBackgroundMenu(view) {
    const gesture = new Gtk.GestureClick({ button: 3 })
    gesture.on('pressed', (...a) => {
      const [x, y] = a.slice(-2)
      this.onContextMenu(view, x, y, null)
    })
    view.addController(gesture)
  }
}

function scrolled(child) {
  return new Gtk.ScrolledWindow({
    child, hexpand: true, vexpand: true,
    hscrollbarPolicy: Gtk.PolicyType.NEVER,
  })
}
