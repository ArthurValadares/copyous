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

/** Widgets are created at least this many pages ahead of the visible area while scrolling. */
const AHEAD_PAGES = 3;

/** Time budget (µs) of one slice of widget creation when the scroll position is close to the last created widget. */
const URGENT_BUDGET_US = 8000;

/** Time budget (µs) of one slice of widget creation when filling the list in the background. */
const BACKGROUND_BUDGET_US = 3000;

/** Creates the widget for an entry. Returns null if the entry cannot be displayed. */
export type ClipboardItemFactory = (entry: ClipboardEntry) => ClipboardItem | null;

/**
 * A scrollable list of clipboard items that creates its widgets progressively.
 *
 * All entries (the model) are always kept in memory, but a ClipboardItem is only created for the first `_shown`
 * entries that match the search. Position, spacing and size of the widgets are entirely handled by the
 * St.BoxLayout: nothing here depends on the item size, the orientation, the text direction or the margins defined
 * by the theme.
 *
 * Widgets are created by a single "pump", in slices limited by a time budget so that no frame is blocked for long:
 * - The first INITIAL widgets are created synchronously (when the list changes), so the dialog opens quickly.
 * - After the dialog has been opened once, the rest is created in the background, in small slices at low priority.
 * - When the scroll position gets within AHEAD_PAGES pages of the last created widget, the pump runs at a higher
 *   priority and with a larger budget, so it stays ahead of the scrolling.
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

	// Widgets. Invariant: the children of this container (apart from the status item) are the widgets of the first
	// `_shown` entries of _filtered, in order.
	private readonly _live = new Map<ClipboardEntry, ClipboardItem>();
	private _shown: number = 0;
	private _firstItem: ClipboardItem | null = null; // the only item with the first-child pseudo-class
	private _lastItem: ClipboardItem | null = null; // the only item with the last-child pseudo-class

	// Pump
	private _filling: boolean = false; // whether the list is completed in the background
	private _pumpId: number = 0;
	private _pumpUrgent: boolean = false;
	private _settleUpper: number | null = null; // scroll range at the time widgets were created, until it is laid out
	private _scrollId: number = 0;

	private _lastFocus: ClipboardEntry | null = null;
	private _lastQuery: SearchQuery | null = null;

	constructor(ext: CopyousExtension) {
		super({
			style_class: 'clipboard-item-list',
			x_align: Clutter.ActorAlign.START,
			x_expand: false,
		});

		this._statusItem = new StatusItem(ext);
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

	/**
	 * Recomputes the matching entries from the model and brings the widgets up to date.
	 *
	 * The window of widgets is the first INITIAL entries, the run of widgets that already exist right after them
	 * (so a more specific search or a new entry does not rebuild widgets that still fit) and the focused entry.
	 * Widgets outside of the window are destroyed, missing widgets inside of it are created synchronously.
	 */
	private refresh(): void {
		const focused = this.focusedEntry();

		this._filtered = this._entries.filter((e) => this._matched.get(e) !== false);
		this._indexOf.clear();
		this._filtered.forEach((e, i) => this._indexOf.set(e, i));

		const n = this._filtered.length;
		let limit = Math.min(INITIAL, n);
		while (limit < n && this._live.has(this._filtered[limit]!)) limit++;

		// The focused item (e.g. while editing its title) must keep existing
		const focusIndex = focused !== null ? this._indexOf.get(focused) : undefined;
		if (focusIndex !== undefined) limit = Math.max(limit, focusIndex + 1);

		const wanted = this._filtered.slice(0, limit);
		const wantedSet = new Set(wanted);

		for (const [entry, item] of [...this._live]) {
			if (!wantedSet.has(entry)) this.destroyItem(entry, item);
		}

		if (this._statusItem.get_parent() === this) this.remove_child(this._statusItem);

		const items: ClipboardItem[] = [];
		const failed: ClipboardEntry[] = [];
		let created = false;
		for (const entry of wanted) {
			let item = this._live.get(entry);
			if (!item) {
				const newItem = this.createWidget(entry);
				if (!newItem) {
					failed.push(entry);
					continue;
				}

				item = newItem;
				created = true;
				this.add_child(item);
			}
			items.push(item);
		}

		// Entries that could not be turned into a widget are dropped from the model
		if (failed.length > 0) {
			for (const entry of failed) this.dropEntry(entry);
			this.refresh();
			return;
		}

		// Apply order, only touching children that are not already in place
		items.forEach((item, i) => {
			if (this.get_child_at_index(i) !== item) this.set_child_at_index(item, i);
		});

		this._shown = items.length;
		this.updateEdges();
		this.updateStatus();
		if (created) this.markPending();
		this.schedulePump();
	}

	/** Creates the widgets of the next entries, up to `limit` entries in total, stopping once `deadline` is passed. */
	private extend(limit: number, deadline: number = Infinity): void {
		limit = Math.min(limit, this._filtered.length);

		let created = 0;
		while (this._shown < limit) {
			// Always create at least one widget, so that every slice makes progress
			if (created > 0 && GLib.get_monotonic_time() >= deadline) break;

			const entry = this._filtered[this._shown]!;
			const item = this.createWidget(entry);
			if (!item) {
				// The entry cannot be displayed. The widgets of the entries before it are not affected.
				this.dropEntry(entry);
				this.refresh();
				return;
			}

			// New widgets always come after the existing ones, which are in order
			this.add_child(item);
			this._shown++;
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

	private destroyItem(entry: ClipboardEntry, item: ClipboardItem): void {
		this._live.delete(entry);
		if (item === this._firstItem) this._firstItem = null;
		if (item === this._lastItem) this._lastItem = null;
		item.destroy();
	}

	/**
	 * Only the first widget has the first-child pseudo-class. Only the last widget of the *complete* list has the
	 * last-child pseudo-class, otherwise the end margin of the theme would show up in the middle of the list.
	 * Only changes pseudo-classes that differ, since every change restyles and relayouts the item.
	 */
	private updateEdges(): void {
		const complete = this._shown >= this._filtered.length;
		const first = this._shown > 0 ? (this._live.get(this._filtered[0]!) ?? null) : null;
		const last = this._shown > 0 && complete ? (this._live.get(this._filtered[this._shown - 1]!) ?? null) : null;

		if (first !== this._firstItem) {
			this._firstItem?.remove_style_pseudo_class('first-child');
			first?.add_style_pseudo_class('first-child');
			this._firstItem = first;
		}

		if (last !== this._lastItem) {
			this._lastItem?.remove_style_pseudo_class('last-child');
			last?.add_style_pseudo_class('last-child');
			this._lastItem = last;
		}
	}

	private updateStatus(): void {
		if (this._shown === 0) {
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

	/** Remembers that widgets were created whose size is not part of the scroll range yet. */
	private markPending(): void {
		this._settleUpper = this.adjustment.upper;
	}

	/**
	 * Whether the scroll position is within AHEAD_PAGES pages of the last created widget.
	 *
	 * The scroll range only includes new widgets after the next layout. Until then the range is stale and the
	 * position would look closer to the end than it is, so the pump is not considered urgent. This never blocks
	 * the pump, it only keeps it at the background budget until the range is up to date.
	 */
	private isUrgent(): boolean {
		if (this._shown >= this._filtered.length) return false;

		const adjustment = this.adjustment;
		if (adjustment.page_size <= 0) return false;

		if (this._settleUpper !== null) {
			if (adjustment.upper === this._settleUpper) return false;
			this._settleUpper = null;
		}

		return adjustment.upper - (adjustment.value + adjustment.page_size) < adjustment.page_size * AHEAD_PAGES;
	}

	/**
	 * Makes sure a slice of widget creation is scheduled, in an idle callback and never inside a scroll or layout
	 * event. At most one is pending. A pending background slice is replaced when scrolling makes it urgent.
	 */
	private schedulePump(): void {
		if (!this._filling || this._shown >= this._filtered.length) return;

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

	private pump(): void {
		if (this._shown >= this._filtered.length) return;

		const budget = this.isUrgent() ? URGENT_BUDGET_US : BACKGROUND_BUDGET_US;
		this.extend(this._filtered.length, GLib.get_monotonic_time() + budget);
		this.schedulePump();
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

	/** Focuses the widget of an entry, creating it (and every widget before it) if necessary. */
	public focusEntry(entry: ClipboardEntry, animate: boolean = true): void {
		const index = this._indexOf.get(entry);
		if (index === undefined) return;

		const created = index >= this._shown;
		this.extend(index + 1);
		const item = this._live.get(entry);
		if (!item) return;

		this._lastFocus = entry;
		item.grab_key_focus();
		this.scrollToChild(item, animate && !created);

		// Widgets that were just created may not be reflected in the scroll range yet, which would clamp the
		// scroll position. Scroll again once the layout has settled.
		if (created) this.scrollAfterLayout(entry);
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

	/** Creates a widget for every entry that matches, so this is the one operation that scales with the history. */
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

		this.extend(1);
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

		// The rest of the list is created in the background from the first time the dialog is opened. Until then
		// only the initial widgets exist, which keeps the start of the shell light.
		this._filling = true;
		this.schedulePump();
	}

	override destroy(): void {
		if (this._pumpId !== 0) GLib.source_remove(this._pumpId);
		this._pumpId = 0;
		if (this._scrollId !== 0) GLib.source_remove(this._scrollId);
		this._scrollId = 0;

		super.destroy();
	}
}
