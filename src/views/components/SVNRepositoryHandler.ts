import { TFile, Notice, ButtonComponent } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import type ObsidianSvnPlugin from '../../main';
import { CheckoutModal } from '../../modals/CheckoutModal';
import { join } from 'path';

export class SVNRepositoryHandler {
    private plugin: ObsidianSvnPlugin;
    private svnClient: SVNClient;
    private onRefresh: () => void;
    private onUserInteraction?: () => void;

    constructor(plugin: ObsidianSvnPlugin, svnClient: SVNClient, onRefresh: () => void, onUserInteraction?: () => void) {
        this.plugin = plugin;
        this.svnClient = svnClient;
        this.onRefresh = onRefresh;
        this.onUserInteraction = onUserInteraction;
    }    async validateRepository(): Promise<{ isValid: boolean; repoPath?: string; error?: string }> {
        try {
            const settings = this.plugin.settings;
            console.log('[SVN RepositoryHandler] validateRepository - full settings:', settings);
            console.log('[SVN RepositoryHandler] validateRepository - repositoryName:', settings.repositoryName);
            
            if (!settings.repositoryName) {
                return { 
                    isValid: false, 
                    error: 'No repository name configured in settings' 
                };
            }

            const vaultPath = this.svnClient.getVaultPath();
            if (!vaultPath) {
                return { 
                    isValid: false, 
                    error: 'Vault path not configured in SVN client' 
                };
            }

            const hiddenRepoName = `.${settings.repositoryName}`;
            const repoPath = join(vaultPath, hiddenRepoName);
            
            console.log('[SVN RepositoryHandler] validateRepository - hiddenRepoName:', hiddenRepoName);
            console.log('[SVN RepositoryHandler] validateRepository - repoPath:', repoPath);

            // Check if repository exists
            const fs = require('fs');
            if (!fs.existsSync(repoPath)) {
                return { 
                    isValid: false, 
                    repoPath,
                    error: `Repository '${hiddenRepoName}' not found in vault` 
                };
            }

            // Check if it's a valid SVN repository
            const svnConfigPath = join(repoPath, 'db');
            if (!fs.existsSync(svnConfigPath)) {
                return { 
                    isValid: false, 
                    repoPath,
                    error: `Directory '${hiddenRepoName}' exists but is not a valid SVN repository` 
                };
            }

            return { isValid: true, repoPath };
        } catch (error) {
            return { 
                isValid: false, 
                error: `Error validating repository: ${error.message}` 
            };
        }
    }
    renderRepositorySetup(container: HTMLElement, currentFile: TFile | null): void {
        container.empty();
        
        this.validateRepository().then(validation => {
            const setupEl = container.createEl('div', { cls: 'workspace-leaf-content' });
            
            if (!validation.isValid) {
                this.renderRepositoryError(setupEl, validation, currentFile);
            } else {
                this.renderCheckoutOptions(setupEl, validation.repoPath!, currentFile);
            }
        });
    }    private renderRepositoryError(container: HTMLElement, validation: any, currentFile: TFile | null): void {
        const settings = this.plugin.settings;
        
        if (!settings.repositoryName) {
            // Create settings configuration section
            const settingItem = container.createEl('div', { cls: 'setting-item' });
            const settingInfo = settingItem.createEl('div', { cls: 'setting-item-info' });
            settingInfo.createEl('div', { 
                text: 'Repository Configuration Required',
                cls: 'setting-item-name'
            });
            settingInfo.createEl('div', { 
                text: 'Configure a repository name in the plugin settings to get started with SVN version control.',
                cls: 'setting-item-description'
            });
            
            const settingControl = settingItem.createEl('div', { cls: 'setting-item-control' });
            new ButtonComponent(settingControl)
                .setButtonText('Open Settings')
                .setClass('mod-cta')
                .onClick(async () => {
                    // Wait a bit to let any ongoing refreshes complete
                    await new Promise(resolve => setTimeout(resolve, 20));
                    try {
                        (this.plugin.app as any).setting.open();
                        (this.plugin.app as any).setting.openTabById(this.plugin.manifest.id);
                    } catch (error) {
                        console.error('Failed to open settings:', error);
                    }
                });
        } else {
            // Repository name is configured but repo doesn't exist
            console.log('[SVN RepositoryHandler] Repository name configured:', settings.repositoryName);
            console.log('[SVN RepositoryHandler] Validation error:', validation.error);
            
            // Create new repository section
            const newRepoItem = container.createEl('div', { cls: 'setting-item' });
            const newRepoInfo = newRepoItem.createEl('div', { cls: 'setting-item-info' });
            newRepoInfo.createEl('div', { 
                text: 'Create New Repository',
                cls: 'setting-item-name'
            });
            newRepoInfo.createEl('div', { 
                text: `Create a new SVN repository named '${settings.repositoryName}' in your vault.`,
                cls: 'setting-item-description'
            });
            
            const newRepoControl = newRepoItem.createEl('div', { cls: 'setting-item-control' });
            new ButtonComponent(newRepoControl)
                .setButtonText('Create')
                .setClass('mod-cta')
                .onClick(() => this.createRepository(currentFile));

            // Checkout existing repository section
            const checkoutItem = container.createEl('div', { cls: 'setting-item' });
            const checkoutInfo = checkoutItem.createEl('div', { cls: 'setting-item-info' });
            checkoutInfo.createEl('div', { 
                text: 'Checkout Existing Repository',
                cls: 'setting-item-name'
            });
            checkoutInfo.createEl('div', { 
                text: 'Connect to an existing SVN repository by providing its URL.',
                cls: 'setting-item-description'
            });
            
            const checkoutControl = checkoutItem.createEl('div', { cls: 'setting-item-control' });
            new ButtonComponent(checkoutControl)
                .setButtonText('Checkout')
                .onClick(() => this.showCheckoutModal(currentFile));
        }
    }    private renderCheckoutOptions(container: HTMLElement, repoPath: string, currentFile: TFile | null): void {
        // Checkout repository section
        const checkoutItem = container.createEl('div', { cls: 'setting-item' });
        const checkoutInfo = checkoutItem.createEl('div', { cls: 'setting-item-info' });
        checkoutInfo.createEl('div', { 
            text: 'Checkout Repository',
            cls: 'setting-item-name'
        });
        checkoutInfo.createEl('div', { 
            text: 'The repository exists but needs to be checked out to start tracking files.',
            cls: 'setting-item-description'
        });
        
        const checkoutControl = checkoutItem.createEl('div', { cls: 'setting-item-control' });
        new ButtonComponent(checkoutControl)
            .setButtonText('Checkout')
            .setClass('mod-cta')
            .onClick(() => this.checkoutRepository(repoPath, currentFile));

        // Initialize working copy section
        const initItem = container.createEl('div', { cls: 'setting-item' });
        const initInfo = initItem.createEl('div', { cls: 'setting-item-info' });
        initInfo.createEl('div', { 
            text: 'Initialize Working Copy',
            cls: 'setting-item-name'
        });
        initInfo.createEl('div', { 
            text: 'Create a working copy of the repository in your vault directory.',
            cls: 'setting-item-description'
        });
        
        const initControl = initItem.createEl('div', { cls: 'setting-item-control' });
        new ButtonComponent(initControl)
            .setButtonText('Initialize')
            .onClick(() => this.initWorkingCopy(repoPath, currentFile));
    }private async createRepository(currentFile: TFile | null): Promise<void> {
        try {
            const settings = this.plugin.settings;
            // Use the repository name from settings (which now has a default value)
            await this.svnClient.createRepository(settings.repositoryName);
            new Notice(`Repository '${settings.repositoryName}' created successfully`);
            // After creating, initialize working copy
            const vaultPath = this.svnClient.getVaultPath();
            const hiddenRepoName = `.${settings.repositoryName}`;
            const repoPath = join(vaultPath, hiddenRepoName);
            
            await this.initWorkingCopy(repoPath, currentFile);
        } catch (error) {
            console.error('Failed to create repository:', error);
            new Notice(`Failed to create repository: ${error.message}`);
        }
    }

    private async checkoutRepository(repoPath: string, currentFile: TFile | null): Promise<void> {
        try {
            const vaultPath = this.svnClient.getVaultPath();
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execPromise = promisify(exec);

            // Checkout the repository to the vault directory
            const command = `svn checkout "file:///${repoPath.replace(/\\/g, '/')}" "${vaultPath}"`;
            await execPromise(command);
            
            new Notice('Repository checked out successfully');
            this.onRefresh();
        } catch (error) {
            console.error('Failed to checkout repository:', error);
            new Notice(`Failed to checkout repository: ${error.message}`);
        }
    }    private async initWorkingCopy(repoPath: string, currentFile: TFile | null): Promise<void> {
        try {
            const vaultPath = this.svnClient.getVaultPath();
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execPromise = promisify(exec);

            // Initialize the vault as a working copy pointing to the repository
            const repoUrl = `file:///${repoPath.replace(/\\/g, '/')}`;
            const command = `svn checkout "${repoUrl}" "${vaultPath}" --force`;
            await execPromise(command, { cwd: vaultPath });
            
            new Notice('Working copy initialized successfully');
            this.onRefresh();
        } catch (error) {
            console.error('Failed to initialize working copy:', error);
            new Notice(`Failed to initialize working copy: ${error.message}`);
        }
    }    private async showCheckoutModal(currentFile: TFile | null): Promise<void> {
        return new Promise((resolve) => {
            const modal = new CheckoutModal(
                this.plugin.app,
                'Checkout SVN Repository',
                async (url: string) => {
                    try {
                        console.log('[SVN RepositoryHandler] Starting checkout from:', url);
                        await this.checkoutExternalRepository(url, currentFile);
                        resolve();
                    } catch (error: any) {
                        console.error('[SVN RepositoryHandler] Checkout failed:', error);
                        new Notice(`Checkout failed: ${error.message}`);
                        resolve();
                    }
                }
            );
            
            // Handle modal close without checkout
            const originalOnClose = modal.onClose.bind(modal);
            modal.onClose = () => {
                originalOnClose();
                resolve();
            };
            
            modal.open();
        });
    }    private async checkoutExternalRepository(repoUrl: string, currentFile: TFile | null): Promise<void> {
        try {
            const vaultPath = this.svnClient.getVaultPath();
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execPromise = promisify(exec);

            const command = `svn checkout "${repoUrl}" "${vaultPath}" --force`;
            await execPromise(command, { cwd: vaultPath });
            
            new Notice('External repository checked out successfully');
            this.onRefresh();
        } catch (error) {
            console.error('Failed to checkout external repository:', error);
            new Notice(`Failed to checkout repository: ${error.message}`);
        }
    }
}
