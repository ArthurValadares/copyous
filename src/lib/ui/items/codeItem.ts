import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import type CopyousExtension from '../../../extension.js';
import { registerClass } from '../../common/gjs.js';
import { Icon } from '../../common/icons.js';
import { CodeItemSettings } from '../../common/settings.js';
import { ClipboardEntry, CodeMetadata } from '../../database/database.js';
import { type IdleHandle, idleQueue } from '../../misc/asyncCache.js';
import { CodeLabel } from '../components/codeLabel.js';
import { CodeInfo } from '../components/contentInfo.js';
import { ClipboardItem } from './clipboardItem.js';

@registerClass()
export class CodeItem extends ClipboardItem {
	private readonly codeItemSettings: CodeItemSettings;

	// The label (text layout, syntax highlighting) is the expensive part of the item. It is built in a deferred
	// idle task, so creating the item itself stays cheap and a batch of items does not block a frame.
	private _code?: CodeLabel;
	private _codeBinding: GObject.Binding | undefined = undefined;
	private _codeInfo?: CodeInfo;
	private _deferred: IdleHandle | undefined = undefined;

	constructor(ext: CopyousExtension, entry: ClipboardEntry) {
		super(ext, entry, Icon.Code, _('Code'));

		this.codeItemSettings = this.ext.settings.get_child('code-item');

		this.add_style_class_name('code-item');

		this.codeItemSettings.connectObject(
			'changed::syntax-highlighting',
			this.updateCode.bind(this),
			'changed::show-line-numbers',
			this.updateCode.bind(this),
			'changed::show-code-info',
			this.updateCodeInfo.bind(this),
			'changed::text-count-mode',
			this.updateCodeInfo.bind(this),
			this,
		);

		this.entry.connectObject(
			'notify::content',
			this.updateCodeInfo.bind(this),
			'notify::metadata',
			() => {
				const m = { language: null, ...this.entry.metadata };
				if (this._code) this._code.language = m.language;
				if (this._codeInfo) this._codeInfo.language = m.language?.name ?? null;
			},
			this,
		);

		this.updateCodeInfo();

		// With a dynamic height the size of the item depends on its content, so the content cannot arrive later
		// without moving the items after it. Otherwise the size is fixed and the content can be filled in later.
		const dynamicHeight = this.ext.settings.get_boolean('dynamic-item-height');
		const orientation: Clutter.Orientation = this.ext.settings.get_enum('clipboard-orientation');
		if (dynamicHeight && orientation === Clutter.Orientation.VERTICAL) {
			this.buildCode();
		} else {
			this._deferred = idleQueue.enqueue(() => {
				this._deferred = undefined;
				this.buildCode();
			});
		}
	}

	private buildCode() {
		if (this._code) return;

		const metadata: CodeMetadata = { language: null, ...this.entry.metadata };

		// Everything is passed to the constructor, so the text is highlighted once and not again for each setting
		const code = new CodeLabel(this.ext, {
			style_class: 'code-item-content',
			code: this.entry.content,
			language: metadata.language,
			syntaxHighlighting: this.codeItemSettings.get_boolean('syntax-highlighting'),
			showLineNumbers: this.codeItemSettings.get_boolean('show-line-numbers'),
			tabWidth: this.ext.settings.get_int('tab-width'),
			y_align: Clutter.ActorAlign.FILL,
			y_expand: true,
		});
		this._code = code;

		// Before the code info, if that exists
		this._content.insert_child_at_index(code, 0);

		this.ext.settings.connectObject('changed::tab-width', this.updateCode.bind(this), code);

		// Update label
		this._codeBinding = this.entry.bind_property('content', code, 'code', GObject.BindingFlags.SYNC_CREATE);

		this.updateCode();

		// Update metadata
		code.connect('notify::language', () => {
			this.entry.metadata = { language: code.language };
		});
	}

	private updateCode() {
		if (!this._code) return;

		this._code.syntaxHighlighting = this.codeItemSettings.get_boolean('syntax-highlighting');
		this._code.showLineNumbers = this.codeItemSettings.get_boolean('show-line-numbers');
		this._code.tabWidth = this.ext.settings.get_int('tab-width');
	}

	private updateCodeInfo() {
		const show = this.codeItemSettings.get_boolean('show-code-info');
		const textCountMode = this.codeItemSettings.get_enum('text-count-mode');

		if (this._codeInfo) {
			this._codeInfo.visible = show;
			this._codeInfo.text = this.entry.content;
			this._codeInfo.textCountMode = textCountMode;
		} else if (show) {
			const m = { language: null, ...this.entry.metadata };
			this._codeInfo = new CodeInfo(this.entry.content, textCountMode, m.language?.name ?? null);
			this._content.add_child(this._codeInfo);
		}
	}

	override destroy() {
		this._deferred?.cancel();
		this._deferred = undefined;

		this._codeBinding?.unbind();
		this._codeBinding = undefined;

		this.codeItemSettings.disconnectObject(this);
		if (this._code) this.ext.settings.disconnectObject(this._code);
		this.entry.disconnectObject(this);

		super.destroy();
	}
}
