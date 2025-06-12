import { App, Modal, ButtonComponent } from "obsidian";

export class ConfirmCheckoutModal extends Modal {
	private fileName: string;
	private revision: string;
	private onConfirm: () => void;
	private onCancel?: () => void;

	constructor(app: App, fileName: string, revision: string, onConfirm: () => void, onCancel?: () => void) {
		super(app);
		this.fileName = fileName;
		this.revision = revision;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		
		this.titleEl.setText('Confirm Checkout');
		
		contentEl.createEl("p", { 
			text: `File "${this.fileName}" has local modifications. Checking out revision ${this.revision} will overwrite your changes.`
		});
		
		const buttonContainer = contentEl.createDiv('modal-button-container');
		
		new ButtonComponent(buttonContainer)
			.setButtonText('Proceed (Lose Changes)')
			.setWarning()
			.onClick(() => {
				this.onConfirm();
				this.close();
			});
			
		new ButtonComponent(buttonContainer)
			.setButtonText('Cancel')
			.onClick(() => {
				this.onCancel?.();
				this.close();
			});
	}
}
