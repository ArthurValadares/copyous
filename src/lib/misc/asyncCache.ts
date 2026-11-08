import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Every cache, so that they can be released together when the extension is disabled
const caches = new Set<{ clear(): void }>();

/** Small least-recently-used cache. Values may be null, a miss is `undefined`. */
export class LruCache<K, V> {
	private readonly _map = new Map<K, V>();

	constructor(private readonly _max: number) {
		caches.add(this);
	}

	get(key: K): V | undefined {
		if (!this._map.has(key)) return undefined;
		const value = this._map.get(key) as V;
		// Refresh recency
		this._map.delete(key);
		this._map.set(key, value);
		return value;
	}

	has(key: K): boolean {
		return this._map.has(key);
	}

	set(key: K, value: V): void {
		this._map.delete(key);
		this._map.set(key, value);
		if (this._map.size > this._max) {
			const oldest = this._map.keys().next();
			if (!oldest.done) this._map.delete(oldest.value);
		}
	}

	delete(key: K): void {
		this._map.delete(key);
	}

	clear(): void {
		this._map.clear();
	}
}

/**
 * Cache of asynchronous results, shared by every widget.
 *
 * - Concurrent requests for the same key share one load.
 * - Results (also null) are kept in an LRU, so items that are destroyed and created again while scrolling
 *   do not repeat the work.
 * - Failed loads are not cached.
 * - The load runs with a cancellable owned by the cache, not by the widget that asked: destroying a widget must not
 *   cancel a load that other widgets or a later widget will use. Use clear() to cancel everything.
 */
export class AsyncCache<K, V> {
	private readonly _lru: LruCache<K, V>;
	private readonly _inflight = new Map<K, Promise<V>>();
	private _cancellable = new Gio.Cancellable();

	constructor(max: number) {
		this._lru = new LruCache(max);
		caches.add(this);
	}

	/** The cached value, without starting a load. */
	peek(key: K): V | undefined {
		return this._lru.get(key);
	}

	load(key: K, loader: (cancellable: Gio.Cancellable) => Promise<V>): Promise<V> {
		if (this._lru.has(key)) return Promise.resolve(this._lru.get(key) as V);

		const pending = this._inflight.get(key);
		if (pending) return pending;

		const cancellable = this._cancellable;
		const promise = loader(cancellable)
			.then((value) => {
				if (!cancellable.is_cancelled()) this._lru.set(key, value);
				return value;
			})
			.finally(() => {
				if (this._inflight.get(key) === promise) this._inflight.delete(key);
			});

		this._inflight.set(key, promise);
		return promise;
	}

	/** Cancels the loads in progress and forgets every result. */
	clear(): void {
		this._cancellable.cancel();
		this._cancellable = new Gio.Cancellable();
		this._inflight.clear();
		this._lru.clear();
	}
}

export interface IdleHandle {
	cancel(): void;
}

/** Time budget (µs) of one slice of the idle queue. */
const IDLE_BUDGET_US = 4000;

interface IdleTask {
	fn: (() => void) | null;
}

/**
 * Runs deferred work (such as building the heavy content of an item) in slices limited by a time budget, in idle
 * callbacks, oldest task first. This does not add parallelism, the work still runs in the main thread, but it keeps
 * any single frame short. A task that was cancelled never runs.
 */
class IdleQueue {
	private _tasks: IdleTask[] = [];
	private _head: number = 0;
	private _sourceId: number = 0;

	enqueue(fn: () => void): IdleHandle {
		const task: IdleTask = { fn };
		this._tasks.push(task);
		this.schedule();
		return {
			cancel: () => {
				task.fn = null;
			},
		};
	}

	private schedule(): void {
		if (this._sourceId !== 0) return;

		this._sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			this._sourceId = 0;
			this.run();
			return GLib.SOURCE_REMOVE;
		});
	}

	private run(): void {
		const deadline = GLib.get_monotonic_time() + IDLE_BUDGET_US;

		let ran = 0;
		while (this._head < this._tasks.length) {
			// Always run at least one task, so that every slice makes progress
			if (ran > 0 && GLib.get_monotonic_time() >= deadline) break;

			const task = this._tasks[this._head++]!;
			const fn = task.fn;
			task.fn = null;
			if (!fn) continue;

			ran++;
			try {
				fn();
			} catch (e) {
				console.error('Copyous: deferred task failed', e);
			}
		}

		if (this._head >= this._tasks.length) {
			this._tasks = [];
			this._head = 0;
		} else {
			// Drop the tasks that are done
			if (this._head > 64) {
				this._tasks = this._tasks.slice(this._head);
				this._head = 0;
			}
			this.schedule();
		}
	}

	clear(): void {
		if (this._sourceId !== 0) GLib.source_remove(this._sourceId);
		this._sourceId = 0;
		this._tasks = [];
		this._head = 0;
	}
}

export const idleQueue = new IdleQueue();

/** Releases everything held by the caches and the idle queue. Call this when the extension is disabled. */
export function clearAsyncCaches(): void {
	idleQueue.clear();
	for (const cache of caches) cache.clear();
}
