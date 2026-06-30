import { DirModel } from './model.mjs'
import { FileView } from './ui/view.mjs'
import { F, locationName } from './util.mjs'

/* One tab = one location with its own history + model + view. */
export class Tab {
  constructor(win, file) {
    this.win = win
    this.model = new DirModel()
    this.view = new FileView(this.model)
    this.view.onActivate = (info, f) => win.onItemActivated(this, info, f)
    this.view.onContextMenu = (w, x, y, target) => win.showContextMenu(this, w, x, y, target)

    this.location = null
    this.history = { back: [], forward: [] }
    this.searchText = ''

    this.page = win.tabView.append(this.view.widget)
    this.navigate(file, false)
  }

  get canGoBack() { return this.history.back.length > 0 }
  get canGoForward() { return this.history.forward.length > 0 }
  get parent() { return F.getParent(this.location) }

  navigate(file, push = true) {
    if (push && this.location) {
      this.history.back.push(this.location)
      this.history.forward = []
    }
    this.location = file
    this.searchText = ''
    this._reload()
    this.win.onTabChanged(this)
  }

  back() {
    if (!this.canGoBack) return
    this.history.forward.push(this.location)
    this.location = this.history.back.pop()
    this._reload(); this.win.onTabChanged(this)
  }

  forward() {
    if (!this.canGoForward) return
    this.history.back.push(this.location)
    this.location = this.history.forward.pop()
    this._reload(); this.win.onTabChanged(this)
  }

  up() {
    const parent = this.parent
    if (parent) this.navigate(parent)
  }

  reload() { this._reload() }

  setSearch(text) {
    this.searchText = text
    this.applyPrefs()
  }

  applyPrefs() {
    const p = this.win.prefs
    this.model.apply({
      showHidden: p.showHidden, sortKey: p.sortKey, sortDesc: p.sortDesc,
      search: this.searchText,
    })
    this.view.setMode(p.viewMode)
    this.view.setZoom(p.iconSize)
  }

  _reload() {
    this.model.unwatch()
    try {
      this.model.load(this.location)
    } catch (e) {
      this.win.toast(`Could not open “${locationName(this.location)}”`)
      this.model.store.removeAll()
    }
    this.applyPrefs()
    this.model.watch(() => this.applyPrefs())
    this.page.setTitle(locationName(this.location))
  }

  destroy() { this.model.unwatch() }
}
