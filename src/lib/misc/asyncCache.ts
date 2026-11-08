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

/** Releases everything held by the caches. Call this when the extension is disabled. */
export function clearAsyncCaches(): void {
	for (const cache of caches) cache.clear();
}
