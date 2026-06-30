/* Node's EventEmitter is pure JS (no libuv handles), so it works fine under the
 * GLib main loop. Services extend it to expose a decoupled event interface. */
export { EventEmitter } from 'node:events'
