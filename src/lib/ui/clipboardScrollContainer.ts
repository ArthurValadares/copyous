import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import type CopyousExtension from '../../extension.js';
import { registerClass } from '../common/gjs.js';
import type { ClipboardEntry } from '../database/database.js';
import { ClipboardItem } from './items/clipboardItem.js';
import { State, StatusItem } from './items/statusItem.js';
import { SearchChange, SearchQuery } from './searchEntry.js';

/** Number of widgets created synchronously whenever the list is rebuilt. */
const INITIAL = 20;

/** Items are realized this many pages before and after the visible area (fixed item size). */
const OVERSCAN_PAGES = 1;

/** Realized items are only released when they are further than this many pages from the visible area. */
const KEEP_PAGES = 2;

/** Widgets are created at least this many pages ahead of the visible area while scrolling (dynamic item size). */
const AHEAD_PAGES = 3;

/** Time budget (µs) of one slice of widget creation when the scroll position is close to what is missing. */
const URGENT_BUDGET_US = 8000;

/** Time budget (µs) of one slice of widget creation when nothing visible is missing. */
const BACKGROUND_BUDGET_US = 3000;

/** Creates the widget for an entry. Returns null if the entry cannot be displayed. */
export type ClipboardItemFactory = (entry: ClipboardEntry) => ClipboardItem | null;

/**
 * A scrollable list of clipboard items with placeholders.
 *
 * All entries (the model) are always kept in memory. The layout is entirely done by the St.BoxLayout, so nothing
 * here depends on the orientation, the text direction, the spacing or the margins defined by the theme:
 *
 * - Fixed item size (the default): every matching entry has a child. Entries near the visible area have a real
 *   ClipboardItem ("realized"), all the others have a cheap placeholder of exactly the same size and style. The
 *   scroll range is correct from the start and there are no spacers to keep in sync. Items far from the visible
 *   area are turned back into placeholders (with hysteresis, so scrolling back and forth does not rebuild them).
 * - Dynamic item height (vertical only): the size of an item depends on its content, so a placeholder cannot
 *   have the right size. The list then creates real items progressively and never releases them.
 *
 * Widgets are created by a single "pump", in slices limited by a time budget so that no frame is blocked for long.
 */
@registerClass()
export class ClipboardScrollContainer extends St.BoxLayout {
	private readonly _statusItem: StatusItem;
	private _itemFactory: ClipboardItemFactory | null = null;

	// Model
	private _entries: ClipboardEntry[] = []; // all entries, newest first
	private readonly _matched = new Map<ClipboardEntry, boolean>(); // search result, also used as membership set
	private _filtered: ClipboardEntry[] = []; // entries matching the search, newest first
	private readonly _indexOf = new Map<ClipboardEntry, number>(); // index in _filtered

	// Widgets. Invariant: the children of this container (apart from the status item) are, in order, the widgets of
	// the first `_count` entries of _filtered. Each one is either in _live (real item) or in _holders (placeholder).
	private readonly _live = new Map<ClipboardEntry, ClipboardItem>();
	private readonly _holders = new Map<ClipboardEntry, St.Widget>();
	private _count: number = 0;
	private _fixed: boolean = true; // whether placeholders are used (fixed item size)
	private _firstWidget: St.Widget | null = null; // the only widget with the first-child pseudo-class
	private _lastWidget: St.Widget | null = null; // the only widget with the last-child pseudo-class

	// Pump
	private _filling: boolean = false; // whether the dialog has been mapped, so that the pump may run
	private _pumpId: number = 0;
	private _pumpUrgent: boolean = false;
	private _settleUpper: number | null = null; // scroll range at the time widgets were created, until it is laid out
	private _scrollId: number = 0;

	private _lastFocus: ClipboardEntry | null = null;
	private _lastQuery: SearchQuery | null = null;

	constructor(private readonly _ext: CopyousExtension) {
		super({
			style_class: 'clipboard-item-list',
			x_align: Clutter.ActorAlign.START,
			x_expand: false,
		});

		this._statusItem = new StatusItem(_ext);
		this._fixed = this.isFixed();
		this.refresh();

		// The scroll direction changes the adjustment that has to be watched
		this.connectObject('notify::orientation', () => this.schedulePump(), this);
	}

	/**
	 * Must be called after this actor has been set as the child of the St.ScrollView,
	 * since the adjustments are owned by the scroll view.
	 */
	public attachAdjustments(): void {
		for (const adjustment of [this.hadjustment, this.vadjustment]) {
			// prettier-ignore
			adjustment.connectObject(
				'notify::value', () => this.schedulePump(),
				'notify::upper', () => this.schedulePump(),
				'notify::page-size', () => this.schedulePump(),
				this);
		}
	}

	public setItemFactory(factory: ClipboardItemFactory): void {
		this._itemFactory = factory;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Model
	// ---------------------------------------------------------------------------------------------------------------

	public addEntry(entry: ClipboardEntry): void {
		if (this._matched.has(entry)) {
			this.moveEntry(entry);
			return;
		}

		this.registerEntry(entry);
		this._entries.splice(this.insertionIndex(entry), 0, entry);
		if (this._lastQuery) this.applyQuery(entry, this._lastQuery);
		this.refresh();
	}

	/** Adds many entries with a single sort and a single update of the widgets. */
	public addEntries(entries: ClipboardEntry[]): void {
		for (const entry of entries) {
			if (this._matched.has(entry)) continue;

			this.registerEntry(entry);
			this._entries.push(entry);
			if (this._lastQuery) this.applyQuery(entry, this._lastQuery);
		}

		this._entries.sort((a, b) => b.datetime.compare(a.datetime));
		this.refresh();
	}

	public removeEntry(entry: ClipboardEntry): void {
		if (!this._matched.has(entry)) return;

		const index = this._indexOf.get(entry);
		const hadFocus = this.focusedEntry() === entry;

		this.dropEntry(entry);
		this.refresh();

		if (hadFocus) {
			const next = index !== undefined ? this.neighbor(index) : null;
			if (next) {
				this.focusEntry(next);
			} else {
				this._lastFocus = null;

				// Navigate to the search entry
				global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
			}
		}
	}

	public clearItems(): void {
		const hadFocus = this.focusedEntry() !== null;

		for (const entry of this._entries) entry.disconnectObject(this);
		this._entries = [];
		this._matched.clear();
		this._lastFocus = null;
		this.refresh();

		if (hadFocus) {
			// Navigate to the search entry
			global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
		}
	}

	private registerEntry(entry: ClipboardEntry): void {
		this._matched.set(entry, true);

		// The signals are connected to the entry, not the widget, since the widget may not exist
		// prettier-ignore
		entry.connectObject(
			'notify::datetime', () => this.moveEntry(entry), // Move item when datetime changes
			'delete', () => this.removeEntry(entry), // Delete item when deleted
			// Update search only when properties used by search can change.
			'notify::content', () => this.updateSearch(entry),
			'notify::pinned', () => this.updateSearch(entry),
			'notify::tag', () => this.updateSearch(entry),
			'notify::type', () => this.updateSearch(entry),
			'notify::metadata', () => this.updateSearch(entry),
			'notify::title', () => this.updateSearch(entry),
			this);
	}

	private dropEntry(entry: ClipboardEntry): void {
		entry.disconnectObject(this);
		const i = this._entries.indexOf(entry);
		if (i >= 0) this._entries.splice(i, 1);
		this._matched.delete(entry);
	}

	private insertionIndex(entry: ClipboardEntry): number {
		const i = this._entries.findIndex((e) => e.datetime.compare(entry.datetime) <= 0);
		return i === -1 ? this._entries.length : i;
	}

	private moveEntry(entry: ClipboardEntry): void {
		const i = this._entries.indexOf(entry);
		if (i === -1) return;

		this._entries.splice(i, 1);
		this._entries.splice(this.insertionIndex(entry), 0, entry);
		this.refresh();
	}

	private applyQuery(entry: ClipboardEntry, query: SearchQuery): void {
		this._matched.set(entry, query.matchesEntry(this._matched.get(entry) ?? true, entry, entry.content));
	}

	private neighbor(index: number): ClipboardEntry | null {
		// After a removal the next entry has taken the place of the removed one
		return this._filtered[index] ?? this._filtered[index - 1] ?? null;
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Widgets
	// ---------------------------------------------------------------------------------------------------------------

	/** Placeholders are only possible when every item has the same, known size. */
	private isFixed(): boolean {
		const dynamicHeight = this._ext.settings.get_boolean('dynamic-item-height');
		const orientation: Clutter.Orientation = this._ext.settings.get_enum('clipboard-orientation');
		return !(dynamicHeight && orientation === Clutter.Orientation.VERTICAL);
	}

	/**
	 * A placeholder has the style class of an item (so margins, borders and spacing from the theme are identical)
	 * and the size of an item. It paints the same background, which is what shows while scrolling quickly.
	 */
	private createHolder(): St.Widget {
		return new St.Widget({
			style_class: 'clipboard-item clipboard-item-placeholder',
			x_expand: false,
			y_expand: false,
			width: this._ext.settings.get_int('item-width'),
			height: this._ext.settings.get_int('item-height'),
		});
	}

	/**
	 * Recomputes the matching entries from the model and brings the widgets up to date.
	 *
	 * Fixed item size: every matching entry gets a widget. The first INITIAL entries and the focused entry are
	 * real items, the others placeholders, and the pump realizes what is near the visible area.
	 * Dynamic item size: the widgets are the first INITIAL entries, the run of real items that already exist
	 * right after them (so a more specific search or a new entry does not rebuild items that still fit) and the
	 * focused entry.
	 */
	private refresh(): void {
		const focused = this.focusedEntry();

		this._fixed = this.isFixed();
		this._filtered = this._entries.filter((e) => this._matched.get(e) !== false);
		this._indexOf.clear();
		this._filtered.forEach((e, i) => this._indexOf.set(e, i));

		const n = this._filtered.length;
		let limit = n;
		if (!this._fixed) {
			limit = Math.min(INITIAL, n);
			while (limit < n && this._live.has(this._filtered[limit]!)) limit++;

			// The focused item (e.g. while editing its title) must keep existing
			const focusIndex = focused !== null ? this._indexOf.get(focused) : undefined;
			if (focusIndex !== undefined) limit = Math.max(limit, focusIndex + 1);
		}

		const wanted = this._filtered.slice(0, limit);
		const wantedSet = new Set(wanted);

		for (const [entry, item] of [...this._live]) {
			if (!wantedSet.has(entry)) this.destroyWidget(entry, item);
		}
		for (const [entry, holder] of [...this._holders]) {
			if (!wantedSet.has(entry) || (!this._fixed && this._holders.has(entry))) {
				this.destroyWidget(entry, holder);
			}
		}

		if (this._statusItem.get_parent() === this) this.remove_child(this._statusItem);

		const widgets: St.Widget[] = [];
		const failed: ClipboardEntry[] = [];
		let created = false;
		for (const [i, entry] of wanted.entries()) {
			let widget: St.Widget | undefined = this._live.get(entry) ?? this._holders.get(entry);
			if (!widget) {
				if (!this._fixed || i < INITIAL || entry === focused) {
					const item = this.createWidget(entry);
					if (!item) {
						failed.push(entry);
						continue;
					}
					widget = item;
				} else {
					const holder = this.createHolder();
					this._holders.set(entry, holder);
					widget = holder;
				}

				created = true;
				this.add_child(widget);
			}
			widgets.push(widget);
		}

		// Entries that could not be turned into a widget are dropped from the model
		if (failed.length > 0) {
			for (const entry of failed) this.dropEntry(entry);
			this.refresh();
			return;
		}

		// Apply order, only touching children that are not already in place
		widgets.forEach((widget, i) => {
			if (this.get_child_at_index(i) !== widget) this.set_child_at_index(widget, i);
		});

		this._count = widgets.length;
		this.updateEdges();
		this.updateStatus();
		if (created && !this._fixed) this.markPending();
		this.schedulePump();
	}

	/** Dynamic item size: creates the widgets of the next entries, up to `limit` in total, until `deadline`. */
	private extend(limit: number, deadline: number = Infinity): void {
		limit = Math.min(limit, this._filtered.length);

		let created = 0;
		while (this._count < limit) {
			// Always create at least one widget, so that every slice makes progress
			if (created > 0 && GLib.get_monotonic_time() >= deadline) break;

			const entry = this._filtered[this._count]!;
			const item = this.createWidget(entry);
			if (!item) {
				// The entry cannot be displayed. The widgets of the entries before it are not affected.
				this.dropEntry(entry);
				this.refresh();
				return;
			}

			// New widgets always come after the existing ones, which are in order
			this.add_child(item);
			this._count++;
			created++;
		}

		if (created === 0) return;

		this.updateEdges();
		this.markPending();
	}

	private createWidget(entry: ClipboardEntry): ClipboardItem | null {
		const item = this._itemFactory?.(entry) ?? null;
		if (item) this._live.set(entry, item);
		return item;
	}

	private destroyWidget(entry: ClipboardEntry, widget: St.Widget): void {
		this._live.delete(entry);
		this._holders.delete(entry);
		if (widget === this._firstWidget) this._firstWidget = null;
		if (widget === this._lastWidget) this._lastWidget = null;
		widget.destroy();
	}

	/** Fixed item size: makes sure the entry at `index` has a real item, replacing its placeholder. */
	private realizeItem(index: number): ClipboardItem | null {
		const entry = this._filtered[index];
		if (!entry) return null;

		const existing = this._live.get(entry);
		if (existing) return existing;

		const holder = this._holders.get(entry);
		const item = this.createWidget(entry);
		if (!item) {
			this.dropEntry(entry);
			this.refresh();
			return null;
		}

		if (holder) this.swapWidget(holder, item, index);
		else this.add_child(item);
		this._holders.delete(entry);
		return item;
	}

	/** Fixed item size: turns a real item back into a placeholder. */
	private releaseItem(entry: ClipboardEntry, item: ClipboardItem): void {
		const index = this._indexOf.get(entry);
		if (index === undefined) return;

		const holder = this.createHolder();
		this._holders.set(entry, holder);
		this._live.delete(entry);
		this.swapWidget(item, holder, index);
	}

	/** Puts `next` at the position of `old` and destroys `old`. Both have the same size, so nothing moves. */
	private swapWidget(old: St.Widget, next: St.Widget, index: number): void {
		for (const pseudo of ['first-child', 'last-child']) {
			if (old.has_style_pseudo_class(pseudo)) next.add_style_pseudo_class(pseudo);
		}
		if (old === this._firstWidget) this._firstWidget = next;
		if (old === this._lastWidget) this._lastWidget = next;

		this.insert_child_at_index(next, index);
		old.destroy();
	}

	/**
	 * Only the first widget has the first-child pseudo-class. Only the last widget of the *complete* list has the
	 * last-child pseudo-class, otherwise the end margin of the theme would show up in the middle of the list.
	 * Only changes pseudo-classes that differ, since every change restyles and relayouts the widget.
	 */
	private updateEdges(): void {
		const complete = this._count >= this._filtered.length;
		const first = this._count > 0 ? this.widgetAt(0) : null;
		const last = this._count > 0 && complete ? this.widgetAt(this._count - 1) : null;

		if (first !== this._firstWidget) {
			this._firstWidget?.remove_style_pseudo_class('first-child');
			first?.add_style_pseudo_class('first-child');
			this._firstWidget = first;
		}

		if (last !== this._lastWidget) {
			this._lastWidget?.remove_style_pseudo_class('last-child');
			last?.add_style_pseudo_class('last-child');
			this._lastWidget = last;
		}
	}

	private widgetAt(index: number): St.Widget | null {
		const entry = this._filtered[index];
		return entry ? (this._live.get(entry) ?? this._holders.get(entry) ?? null) : null;
	}

	private updateStatus(): void {
		if (this._count === 0) {
			this.add_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.CENTER;
			this.x_expand = true;

			this._statusItem.state = this._entries.length === 0 ? State.Empty : State.NoResults;
		} else {
			this.x_align = Clutter.ActorAlign.START;
			this.x_expand = false;
		}
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Pump
	// ---------------------------------------------------------------------------------------------------------------

	private get adjustment(): St.Adjustment {
		return this.orientation === Clutter.Orientation.HORIZONTAL ? this.hadjustment : this.vadjustment;
	}

	/** Dynamic item size: remembers that widgets were created whose size is not part of the scroll range yet. */
	private markPending(): void {
		this._settleUpper = this.adjustment.upper;
	}

	/**
	 * Dynamic item size: whether the scroll position is within AHEAD_PAGES pages of the last created widget.
	 *
	 * The scroll range only includes new widgets after the next layout. Until then the range is stale and the
	 * position would look closer to the end than it is, so the pump is not considered urgent. This never blocks
	 * the pump, it only keeps it at the background budget until the range is up to date.
	 */
	private isUrgent(): boolean {
		if (this._count >= this._filtered.length) return false;

		const adjustment = this.adjustment;
		if (adjustment.page_size <= 0) return false;

		if (this._settleUpper !== null) {
			if (adjustment.upper === this._settleUpper) return false;
			this._settleUpper = null;
		}

		return adjustment.upper - (adjustment.value + adjustment.page_size) < adjustment.page_size * AHEAD_PAGES;
	}

	/**
	 * Fixed item size: the indices of the first and last entry that are at least partly visible, from the
	 * allocation of the first two widgets (all widgets have the same size, so this gives the stride). In RTL the
	 * horizontal adjustment is mirrored, as in scrollToChild. Null while the layout is not known yet.
	 */
	private visibleRange(): [number, number] | null {
		const adjustment = this.adjustment;
		const c0 = this.get_child_at_index(0);
		if (!c0 || this._filtered.length === 0 || adjustment.page_size <= 0) return null;

		const horizontal = this.orientation === Clutter.Orientation.HORIZONTAL;
		const rtl = horizontal && this.text_direction === Clutter.TextDirection.RTL;

		const startOf = (actor: Clutter.Actor): number => {
			const box = actor.get_allocation_box();
			if (!horizontal) return box.y1;
			return rtl ? adjustment.upper - box.x2 : box.x1;
		};
		const sizeOf = (actor: Clutter.Actor): number => {
			const box = actor.get_allocation_box();
			return horizontal ? box.get_width() : box.get_height();
		};

		const size = sizeOf(c0);
		if (size <= 0) return null;

		const c1 = this._filtered.length > 1 ? this.get_child_at_index(1) : null;
		const origin = startOf(c0);
		const stride = c1 ? startOf(c1) - origin : size;
		if (!(stride > 0)) return null;

		const viewStart = rtl ? adjustment.upper - adjustment.value - adjustment.page_size : adjustment.value;
		const n = this._filtered.length;
		const first = Math.min(Math.max(Math.floor((viewStart - origin) / stride), 0), n - 1);
		const last = Math.min(Math.max(Math.floor((viewStart + adjustment.page_size - origin) / stride), first), n - 1);
		return [first, last];
	}

	/**
	 * Makes sure a slice of widget creation is scheduled, in an idle callback and never inside a scroll or layout
	 * event. At most one is pending.
	 */
	private schedulePump(): void {
		if (!this._filling) return;

		if (this._fixed) {
			if (this._pumpId !== 0 || this._filtered.length === 0) return;

			this._pumpId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
				this._pumpId = 0;
				this.pumpWindow();
				return GLib.SOURCE_REMOVE;
			});
			return;
		}

		// Dynamic item size. A pending background slice is replaced when scrolling makes it urgent.
		if (this._count >= this._filtered.length) return;

		const urgent = this.isUrgent();
		if (this._pumpId !== 0) {
			if (!urgent || this._pumpUrgent) return;
			GLib.source_remove(this._pumpId);
		}

		this._pumpUrgent = urgent;
		this._pumpId = GLib.idle_add(urgent ? GLib.PRIORITY_DEFAULT_IDLE : GLib.PRIORITY_LOW, () => {
			this._pumpId = 0;
			this.pump();
			return GLib.SOURCE_REMOVE;
		});
	}

	/** Dynamic item size: creates the widgets that are missing, in the background. */
	private pump(): void {
		if (this._count >= this._filtered.length) return;

		const budget = this.isUrgent() ? URGENT_BUDGET_US : BACKGROUND_BUDGET_US;
		this.extend(this._filtered.length, GLib.get_monotonic_time() + budget);
		this.schedulePump();
	}

	/**
	 * Fixed item size: realizes the items around the visible area, nearest first, and then releases the items that
	 * are far away. Only a slice runs at a time, if anything is left the pump schedules itself again.
	 */
	private pumpWindow(): void {
		const range = this.visibleRange();
		if (range === null) return;

		const n = this._filtered.length;
		const [first, last] = range;
		const pages = last - first + 1;
		const lo = Math.max(first - pages * OVERSCAN_PAGES, 0);
		const hi = Math.min(last + pages * OVERSCAN_PAGES, n - 1);

		const middle = (first + last) / 2;
		const missing: number[] = [];
		for (let i = lo; i <= hi; i++) {
			if (!this._live.has(this._filtered[i]!)) missing.push(i);
		}
		missing.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));

		// What is visible is urgent and gets a larger budget
		const urgent = missing.some((i) => i >= first && i <= last);
		const deadline = GLib.get_monotonic_time() + (urgent ? URGENT_BUDGET_US : BACKGROUND_BUDGET_US);

		let created = 0;
		for (const i of missing) {
			// Always create at least one item, so that every slice makes progress
			if (created > 0 && GLib.get_monotonic_time() >= deadline) {
				this.schedulePump();
				return;
			}

			// An entry that cannot be displayed is dropped and the list is rebuilt, which schedules the pump
			if (!this.realizeItem(i)) return;
			created++;
		}

		if (created > 0) this.updateEdges();

		// Release the items that are far from the visible area, but never the focused one
		const keepLo = first - pages * KEEP_PAGES;
		const keepHi = last + pages * KEEP_PAGES;
		const focused = this.focusedEntry();
		for (const [entry, item] of [...this._live]) {
			const index = this._indexOf.get(entry);
			if (index === undefined || entry === focused || (index >= keepLo && index <= keepHi)) continue;
			this.releaseItem(entry, item);
		}
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Focus and scrolling
	// ---------------------------------------------------------------------------------------------------------------

	/** The entry whose widget contains the key focus. This includes children such as the title entry. */
	private focusedEntry(): ClipboardEntry | null {
		let actor: Clutter.Actor | null = global.stage.get_key_focus();
		while (actor !== null && actor.get_parent() !== this) actor = actor.get_parent();
		return actor instanceof ClipboardItem ? actor.entry : null;
	}

	private nextFocus(entry: ClipboardEntry, animate: boolean = true): void {
		const index = this._indexOf.get(entry);
		if (index === undefined) return;

		const next = this._filtered[index + 1] ?? this._filtered[index - 1];
		if (next) {
			this.focusEntry(next, animate);
		} else {
			// Navigate to the search entry
			global.focus_manager.get_group(this).grab_key_focus();
		}
	}

	/** Makes sure the entry at `index` has a real item. In the dynamic mode this creates every item before it. */
	private ensureRealized(index: number): void {
		if (this._fixed) this.realizeItem(index);
		else this.extend(index + 1);
	}

	/** Focuses the widget of an entry, creating it (and, with dynamic item size, every widget before it). */
	public focusEntry(entry: ClipboardEntry, animate: boolean = true): void {
		const index = this._indexOf.get(entry);
		if (index === undefined) return;

		// With fixed item size the scroll range is already complete, only the dynamic mode grows it
		const grows = !this._fixed && index >= this._count;
		this.ensureRealized(index);
		const item = this._live.get(entry);
		if (!item) return;

		if (this._fixed) this.updateEdges();

		this._lastFocus = entry;
		item.grab_key_focus();
		this.scrollToChild(item, animate && !grows);

		// Widgets that were just created may not be reflected in the scroll range yet, which would clamp the
		// scroll position. Scroll again once the layout has settled.
		if (grows) this.scrollAfterLayout(entry);
		this.schedulePump();
	}

	private scrollAfterLayout(entry: ClipboardEntry): void {
		if (this._scrollId !== 0) GLib.source_remove(this._scrollId);

		this._scrollId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
			this._scrollId = 0;
			const item = this._live.get(entry);
			if (item && this.focusedEntry() === entry) this.scrollToChild(item, false);
			return GLib.SOURCE_REMOVE;
		});
	}

	public focusFirst(): void {
		const entry = this._filtered[0];
		if (entry) this.focusEntry(entry);
	}

	/** With fixed item size only the last item is created, with dynamic item size every item is. */
	public focusLast(): void {
		const entry = this._filtered[this._filtered.length - 1];
		if (entry) this.focusEntry(entry);
	}

	public focusChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child instanceof ClipboardItem) this.focusEntry(child.entry, animate);
	}

	public scrollToFocus(animate: boolean = true): void {
		const entry = this.focusedEntry();
		if (entry === null) return;

		this._lastFocus = entry;
		const item = this._live.get(entry);
		if (item) this.scrollToChild(item, animate);
	}

	public scrollToChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		// Getting the allocation of an actor that needs one makes the stage relayout first, so this is also
		// correct for a widget that has just been created
		const box = child.get_allocation_box();
		if (box.get_width() === 0 && box.get_height() === 0) return;

		let adjustment: St.Adjustment;
		let value: number;
		if (this.orientation === Clutter.Orientation.HORIZONTAL) {
			adjustment = this.hadjustment;
			value = box.x1 + box.get_width() * 0.5 - adjustment.page_size * 0.5;
		} else {
			adjustment = this.vadjustment;
			value = box.y1 + box.get_height() * 0.5 - adjustment.page_size * 0.5;
		}

		if (this.text_direction === Clutter.TextDirection.RTL) {
			value = adjustment.get_upper() - adjustment.page_size - value;
		}

		if (animate) {
			adjustment.ease(value, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
		} else {
			adjustment.value = value;
		}
	}

	public selectItem(index: number): boolean {
		const entry = this._filtered[index];
		if (!entry) return false;

		this.focusEntry(entry);
		return true;
	}

	public selectNextItem() {
		const focused = this.focusedEntry();
		if (focused) {
			this.nextFocus(focused);
			return;
		}

		const first = this._filtered[0];
		if (first) this.focusEntry(first);
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Search
	// ---------------------------------------------------------------------------------------------------------------

	public search(query: SearchQuery): void {
		// Copy search query, but with SearchChange.Different to always force re-search
		this._lastQuery = query.withChange(SearchChange.Different);

		const focused = this.focusedEntry();
		const hadFocus = focused !== null;

		// Only the data is searched, widgets that are still needed are reused
		for (const entry of this._entries) this.applyQuery(entry, query);
		this.refresh();

		if (focused !== null && this._indexOf.has(focused)) {
			this.focusEntry(focused, false);
			return;
		}

		// Only restore the scroll position if that does not require creating more widgets
		const last = this._lastFocus !== null ? this._live.get(this._lastFocus) : undefined;
		if (last) {
			this.scrollToChild(last, false);
		} else if (hadFocus && this._filtered.length > 0) {
			this.focusEntry(this._filtered[0]!, false);
		}
	}

	private updateSearch(entry: ClipboardEntry): void {
		if (!this._lastQuery || !this._matched.has(entry)) return;

		const before = this._matched.get(entry) !== false;
		this.applyQuery(entry, this._lastQuery);
		const after = this._matched.get(entry) !== false;
		if (before === after) return; // The list does not change

		const index = this._indexOf.get(entry);
		const hadFocus = this.focusedEntry() === entry;

		this.refresh();

		if (hadFocus && !after) {
			const next = index !== undefined ? this.neighbor(index) : null;
			if (next) this.focusEntry(next, false);
			else global.focus_manager.get_group(this).grab_key_focus();
		}
	}

	public activateFirst(): void {
		const first = this._filtered[0];
		if (!first) return;

		this.ensureRealized(0);
		const item = this._live.get(first);
		if (item instanceof St.Button) {
			item.vfunc_clicked(1);
		}
	}

	// ---------------------------------------------------------------------------------------------------------------
	// Navigation
	// ---------------------------------------------------------------------------------------------------------------

	override vfunc_navigate_focus(from: Clutter.Actor | null, direction: St.DirectionType): boolean {
		const fromEntry = from instanceof ClipboardItem && from.get_parent() === this ? from.entry : null;
		const n = this._filtered.length;

		// Navigation from the search entry
		if (fromEntry === null) {
			// If tab navigation is used, then focus on first or last child
			if (direction === St.DirectionType.TAB_FORWARD || direction === St.DirectionType.TAB_BACKWARD) {
				const entry = direction === St.DirectionType.TAB_BACKWARD ? this._filtered[n - 1] : this._filtered[0];
				this._lastFocus = entry ?? null;
			}

			// If the last focus is null or does not match anymore, then focus the first child
			if (this._lastFocus === null || !this._indexOf.has(this._lastFocus)) {
				this._lastFocus = this._filtered[0] ?? null;
			}

			if (!this._lastFocus) return Clutter.EVENT_PROPAGATE;

			this.focusEntry(this._lastFocus);
			return Clutter.EVENT_STOP;
		}

		const index = this._indexOf.get(fromEntry);
		if (index === undefined) return Clutter.EVENT_PROPAGATE;
		const isFirst = index === 0;
		const isLast = index === n - 1;

		if (this.orientation === Clutter.Orientation.HORIZONTAL) {
			// If up or shift tab navigation then focus the search entry
			if (direction === St.DirectionType.UP) {
				this._lastFocus = fromEntry;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore down navigation
			if (direction === St.DirectionType.DOWN) {
				return Clutter.EVENT_STOP;
			}
		} else {
			// If on the first child then focus the search entry
			if (isFirst && direction === St.DirectionType.UP) {
				this._lastFocus = fromEntry;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// If on the last child then focus on footer
			if (isLast && direction === St.DirectionType.DOWN) {
				this._lastFocus = fromEntry;
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore left and right navigation
			if (direction === St.DirectionType.LEFT || direction === St.DirectionType.RIGHT) {
				return Clutter.EVENT_STOP;
			}
		}

		// If on first child and shift tab navigation then focus the search entry
		if (isFirst && direction === St.DirectionType.TAB_BACKWARD) {
			this._lastFocus = fromEntry;
			// Navigate to the search entry
			return Clutter.EVENT_PROPAGATE;
		}

		// If on last child and tab navigation then focus the footer
		if (isLast && direction === St.DirectionType.TAB_FORWARD) {
			this._lastFocus = fromEntry;
			// Navigate to footer
			return Clutter.EVENT_PROPAGATE;
		}

		// Otherwise move to the previous or next entry, whose widget may not exist yet
		const forward =
			direction === St.DirectionType.TAB_FORWARD ||
			direction === St.DirectionType.RIGHT ||
			direction === St.DirectionType.DOWN;
		const target = this._filtered[index + (forward ? 1 : -1)];
		if (!target) return Clutter.EVENT_PROPAGATE;

		this.focusEntry(target);
		return Clutter.EVENT_STOP;
	}

	override vfunc_map(): void {
		this._lastFocus = null;
		this.hadjustment.value = 0;
		this.vadjustment.value = 0;

		super.vfunc_map();

		// The pump runs from the first time the dialog is opened. Until then only the initial widgets are real
		// items, which keeps the start of the shell light.
		this._filling = true;
		this.schedulePump();
	}

	override destroy(): void {
		if (this._pumpId !== 0) GLib.source_remove(this._pumpId);
		this._pumpId = 0;
		if (this._scrollId !== 0) GLib.source_remove(this._scrollId);
		this._scrollId = 0;

		for (const entry of this._entries) entry.disconnectObject(this);

		super.destroy();
	}
}
