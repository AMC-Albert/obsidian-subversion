import { App, Modal, ButtonComponent } from "obsidian";

export class ConfirmRemoveModal extends Modal {
	private fileName: string;
	private onConfirm: () => void;

	constructor(app: App, fileName: string, onConfirm: () => void) {
		super(app);
		this.fileName = fileName;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		this.titleEl.setText('Remove File from Version Control');
		
		contentEl.createEl("p", { 
			text: `Are you sure you want to remove "${this.fileName}" from SVN version control? The file will be untracked by SVN on next commit. The file will remain on disk but will no longer be versioned.`,
			cls: 'mod-warning'
		});
		
		const buttonContainer = contentEl.createDiv('modal-button-container');
		
		new ButtonComponent(buttonContainer)
			.setButtonText('Remove from SVN')
			.setWarning()
			.onClick(() => {
				this.onConfirm();
				this.close();
			});
			
		new ButtonComponent(buttonContainer)
			.setButtonText('Cancel')
			.onClick(() => this.close());
	}
}
