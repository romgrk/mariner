#!/usr/bin/gjs
/*
 * org.freedesktop.FileManager1 service for Mariner.
 *
 * This is the standard cross-desktop interface a browser's "Show in folder",
 * a download notification, or `gio open` uses to reveal a file in the file
 * manager. Owning its well-known name makes Mariner answer those calls instead
 * of Nautilus.
 *
 * Why a separate gjs process rather than doing this inside Mariner: Mariner
 * runs on node-gtk, whose GObject-introspection bindings cannot host a D-Bus
 * object — g_dbus_connection_register_object[_with_closures] and message
 * filters all rely on closure/vtable marshalling node-gtk does not implement
 * (its GClosure marshaller is hardcoded for signal dispatch, and it punts on
 * callback return-value ownership). gjs has first-class D-Bus export, so this
 * tiny translator owns the name and turns each method into a `mariner`
 * invocation. See docs/default-file-manager.md.
 *
 * The command used to launch Mariner is `mariner` on $PATH, overridable with
 * $MARINER_EXEC (a shell word-split command line — handy in a dev checkout,
 * e.g. MARINER_EXEC="node --import node-gtk/register /path/to/src/main.ts").
 */

const { GLib, Gio } = imports.gi

const BUS_NAME = 'org.freedesktop.FileManager1'
const OBJECT_PATH = '/org/freedesktop/FileManager1'

const INTERFACE = `
<node>
  <interface name="org.freedesktop.FileManager1">
    <method name="ShowFolders">
      <arg type="as" name="URIs" direction="in"/>
      <arg type="s" name="StartupId" direction="in"/>
    </method>
    <method name="ShowItems">
      <arg type="as" name="URIs" direction="in"/>
      <arg type="s" name="StartupId" direction="in"/>
    </method>
    <method name="ShowItemProperties">
      <arg type="as" name="URIs" direction="in"/>
      <arg type="s" name="StartupId" direction="in"/>
    </method>
  </interface>
</node>`

/* Spawn `mariner` with the given arguments. StartupId (if provided) is passed
 * through as DESKTOP_STARTUP_ID so the launched window gets proper focus/
 * activation on the caller's behalf. Fire-and-forget: the reply is sent as soon
 * as the process is spawned. */
function launch(args, startupId) {
  const cmdline = GLib.getenv('MARINER_EXEC') || 'mariner'
  const [parsed, base] = GLib.shell_parse_argv(cmdline)
  if (!parsed) {
    logError(new Error(`invalid MARINER_EXEC: ${cmdline}`))
    return
  }
  const argv = base.concat(args)

  let envp = null
  if (startupId) {
    envp = GLib.environ_setenv(GLib.get_environ(), 'DESKTOP_STARTUP_ID', startupId, true)
  }

  try {
    GLib.spawn_async(null, argv, envp, GLib.SpawnFlags.SEARCH_PATH, null)
  } catch (e) {
    logError(e, `could not launch: ${argv.join(' ')}`)
  }
}

const FileManager1 = {
  /* Open each URI as a folder. */
  ShowFolders(uris, startupId) {
    if (uris.length) launch(uris, startupId)
  },
  /* Open each URI's parent folder and select the item within it. */
  ShowItems(uris, startupId) {
    if (uris.length) launch(['--select', ...uris], startupId)
  },
  /* Reveal the items and open their Properties dialog. */
  ShowItemProperties(uris, startupId) {
    if (uris.length) launch(['--properties', ...uris], startupId)
  },
}

const loop = new GLib.MainLoop(null, false)
let exported = null

Gio.bus_own_name(
  Gio.BusType.SESSION,
  BUS_NAME,
  Gio.BusNameOwnerFlags.NONE,
  (connection) => {
    /* bus acquired — export the object before the name is granted so we can
     * answer the very first activation call. */
    exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE, FileManager1)
    exported.export(connection, OBJECT_PATH)
  },
  null,
  (_connection, name) => {
    /* Name lost — either something replaced us, or the session bus went away.
     * Either way there is nothing left to serve, so exit rather than linger. */
    printerr(`mariner: no longer owning ${name}; exiting`)
    loop.quit()
  },
)

loop.run()
