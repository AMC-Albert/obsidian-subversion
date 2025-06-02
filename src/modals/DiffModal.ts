import { App, Modal } from "obsidian";

export class DiffModal extends Modal {
	private fileName: string;
	private diff: string;
	private title: string;

	constructor(app: App, fileName: string, diff: string, title?: string) {
		super(app);
		this.fileName = fileName;
		this.diff = diff;
		this.title = title || `Current Changes for ${fileName}`;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass('mod-svn-diff');
		
		const modalHeader = modalEl.querySelector('.modal-header');
		if (modalHeader) {
			modalHeader.createDiv('modal-title', el => {
				el.textContent = this.title;
			});
		}

		if (!this.diff || this.diff.trim() === '') {
			contentEl.createEl('p', { 
				text: 'No changes detected',
				cls: 'svn-info-text'
			});
		} else {
			const pre = contentEl.createEl('pre', { cls: 'svn-diff-content' });
			pre.createEl('code', { text: this.diff });
		}
	}
}
