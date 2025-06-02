import { App, Modal, Setting } from "obsidian";

export class ConfirmRevertModal extends Modal {
	private fileName: string;
	private onConfirm: () => void;

	constructor(app: App, fileName: string, onConfirm: () => void) {
		super(app);
		this.fileName = fileName;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass('mod-svn-revert-confirm');
		
		const modalHeader = modalEl.querySelector('.modal-header');
		if (modalHeader) {
			modalHeader.createDiv('modal-title', el => {
				el.textContent = 'Confirm Revert';
			});
		}

		contentEl.createEl("p", { 
			text: `Are you sure you want to revert all changes to "${this.fileName}"? This action cannot be undone.`,
			cls: 'mod-warning'
		});
		
		const buttonRow = contentEl.createDiv('modal-button-container');
		new Setting(buttonRow)
			.addButton(btn => btn
				.setButtonText('Revert')
				.setClass('mod-warning')
				.onClick(() => {
					this.onConfirm();
					this.close();
				})
			)
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close())
			);
	}
}
