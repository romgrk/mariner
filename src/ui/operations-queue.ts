import Gtk from 'gi:Gtk-4.0'
import GLib from 'gi:GLib-2.0'
import Pango from 'gi:Pango-1.0'
import { ProgressRing } from './progress-ring.ts'
import type { OpBegin, OpProgress, OpDone, OpError } from '../core/types.ts'

interface Row { widget: any; top: any; label: any; bar: any; toggle: any; cancelBtn: any; determinate: boolean; paused: boolean; finished: boolean; done: number; total: number }

/* Optional per-op controls a source can expose (each takes the op's numeric id). */
interface OpActions { cancel?: (id: number) => void; pause?: (id: number) => void; resume?: (id: number) => void }

/* Header button + popover listing the active long file operations, each with a
 * per-op progress bar, an optional pause/resume toggle, and (when cancellable) a ✕.
 * Fed by any emitter that speaks the op event protocol (FileOperations,
 * ArchiveService); `bind` namespaces ids by a prefix so multiple sources never
 * collide. A completed op isn't dropped: its bar fills, its controls become a ✓,
 * the header button flashes for attention (like nautilus), and the row lingers
 * until dismissed via "Clear". The button hides only when no rows remain. */
export class OperationsQueue {
  button: any
  _popover: any
  _list: any
  _clearRow: any
  _rows = new Map<string, Row>()
  _pulseTimer = 0
  _flashTimer = 0
  _ring: ProgressRing

  constructor() {
    this._list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, marginTop: 10, marginBottom: 10, marginStart: 10, marginEnd: 10 })
    this._list.setSizeRequest(320, -1)
    /* "Clear" for finished rows; shown only while any completed row lingers. */
    const clearBtn = new Gtk.Button({ label: 'Clear', cssClasses: ['flat'], halign: Gtk.Align.END, hexpand: true })
    clearBtn.on('clicked', () => this._clearFinished())
    this._clearRow = new Gtk.Box({ marginBottom: 2, visible: false })
    this._clearRow.append(clearBtn)
    this._list.append(this._clearRow)
    this._popover = new Gtk.Popover({ child: this._list })
    this.button = new Gtk.MenuButton({ popover: this._popover, tooltipText: 'File Operations', visible: false, cssClasses: ['operations-indicator'] })
    this._ring = new ProgressRing(16, 2)
    this.button.setChild(this._ring.widget)
  }

  /* Subscribe to an op emitter. `actions` wire the optional per-op ✕ / pause toggle. */
  bind(emitter: any, prefix: string, actions: OpActions = {}): void {
    emitter.on('begin', (p: OpBegin) => this._add(prefix + p.id, p.title, {
      cancel: actions.cancel ? () => actions.cancel!(p.id) : null,
      pause: actions.pause ? () => actions.pause!(p.id) : null,
      resume: actions.resume ? () => actions.resume!(p.id) : null,
    }))
    emitter.on('progress', (p: OpProgress) => this._progress(prefix + p.id, p.done, p.total, p.paused))
    /* Cancelled ops vanish; successful ones linger as a ✓ until cleared. */
    emitter.on('done', (p: OpDone) => { if (p.cancelled) this._remove(prefix + p.id); else this._finish(prefix + p.id) })
    emitter.on('error', (p: OpError) => { if (p.id != null) this._remove(prefix + p.id) })
  }

  _add(key: string, title: string, cb: { cancel: (() => void) | null; pause: (() => void) | null; resume: (() => void) | null }): void {
    if (this._rows.has(key)) return
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 })
    const top = new Gtk.Box({ spacing: 8 })
    const label = new Gtk.Label({ label: title, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.MIDDLE })
    top.append(label)
    const bar = new Gtk.ProgressBar({ pulseStep: 0.1, fraction: 0 })
    const row: Row = { widget: box, top, label, bar, toggle: null, cancelBtn: null, determinate: false, paused: false, finished: false, done: 0, total: 0 }
    if (cb.pause && cb.resume) {
      const btn = new Gtk.Button({ iconName: 'media-playback-pause-symbolic', tooltipText: 'Pause', cssClasses: ['flat', 'circular'], valign: Gtk.Align.CENTER })
      /* Flip local state on click (a paused archive subprocess emits nothing, so we
       * can't rely on an incoming event to update the icon); events reconcile it. */
      btn.on('clicked', () => {
        const next = !row.paused
        this._setPaused(row, next)
        if (next) cb.pause!(); else cb.resume!()
        this._sync()
      })
      row.toggle = btn
      top.append(btn)
    }
    if (cb.cancel) {
      const btn = new Gtk.Button({ iconName: 'window-close-symbolic', tooltipText: 'Cancel', cssClasses: ['flat', 'circular'], valign: Gtk.Align.CENTER })
      btn.on('clicked', () => cb.cancel!())
      row.cancelBtn = btn
      top.append(btn)
    }
    box.append(top)
    box.append(bar)
    this._list.append(box)
    this._rows.set(key, row)
    this._sync()
  }

  _progress(key: string, done: number, total: number, paused?: boolean): void {
    const row = this._rows.get(key)
    if (!row || row.finished) return
    row.done = done; row.total = total
    if (total > 0) { row.determinate = true; row.bar.setFraction(Math.min(1, done / total)) }
    if (paused !== undefined) this._setPaused(row, paused)
    this._sync()
  }

  /* Reflect paused state on the row's toggle (icon + tooltip). Idempotent. */
  _setPaused(row: Row, paused: boolean): void {
    if (paused === row.paused) return
    row.paused = paused
    if (row.toggle) {
      row.toggle.setIconName(paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic')
      row.toggle.setTooltipText(paused ? 'Resume' : 'Pause')
    }
  }

  /* Mark an op complete: fill its bar, swap the live controls for a ✓, flash the
   * header button, and keep the row until the user clears it. */
  _finish(key: string): void {
    const row = this._rows.get(key)
    if (!row || row.finished) return
    row.finished = true
    row.paused = false
    row.determinate = true
    row.bar.setFraction(1)
    if (row.toggle) { row.top.remove(row.toggle); row.toggle = null }
    if (row.cancelBtn) { row.top.remove(row.cancelBtn); row.cancelBtn = null }
    row.top.append(new Gtk.Image({ iconName: 'object-select-symbolic', tooltipText: 'Completed', valign: Gtk.Align.CENTER }))
    row.label.addCssClass('dim-label')
    this._flash()
    this._sync()
  }

  /* Briefly flash the header button (nautilus' "needs-attention": a short accent
   * pulse). Re-arm on each completion; the class self-clears after the animation. */
  _flash(): void {
    this.button.removeCssClass('op-flash')
    this.button.addCssClass('op-flash')
    if (this._flashTimer) GLib.sourceRemove(this._flashTimer)
    this._flashTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 2000, () => { this.button.removeCssClass('op-flash'); this._flashTimer = 0; return false })
  }

  _clearFinished(): void {
    for (const [key, row] of [...this._rows]) if (row.finished) { this._list.remove(row.widget); this._rows.delete(key) }
    this._sync()
  }

  _remove(key: string): void {
    const row = this._rows.get(key)
    if (!row) return
    this._list.remove(row.widget)
    this._rows.delete(key)
    this._sync()
  }

  _sync(): void {
    const rows = [...this._rows.values()]
    const active = rows.length > 0
    this.button.setVisible(active)
    if (!active) { try { this._popover.popdown() } catch {} }
    this._clearRow.setVisible(rows.some(r => r.finished))
    /* Header ring: aggregate the *active* (unfinished) determinate ops (like
     * nautilus). No active op left → show a full ring (the lingering ✓ state).
     * Pulse/spin only for active ops with no determinate total that aren't paused,
     * so a paused op visibly freezes. */
    let done = 0, total = 0, activeCount = 0
    for (const r of rows) if (!r.finished) { activeCount++; if (r.determinate && r.total > 0) { done += r.done; total += r.total } }
    const needPulse = rows.some(r => !r.finished && !r.determinate && !r.paused)
    if (activeCount === 0) this._ring.setProgress(1)
    else if (total > 0) this._ring.setProgress(done / total)
    else this._ring.setSpinning(needPulse)
    if (needPulse && !this._pulseTimer) {
      this._pulseTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 120, () => {
        for (const r of this._rows.values()) if (!r.finished && !r.determinate && !r.paused) r.bar.pulse()
        this._ring.tick()
        return true
      })
    } else if (!needPulse && this._pulseTimer) {
      GLib.sourceRemove(this._pulseTimer); this._pulseTimer = 0
    }
  }
}
