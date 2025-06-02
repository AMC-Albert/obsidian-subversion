import { TFile, Notice, ButtonComponent } from 'obsidian';
import { SVNClient } from '../../../services/SVNClient';
import type ObsidianSvnPlugin from '../../../main';
import { join } from 'path';

export class SVNRepositoryHandler {
    private plugin: ObsidianSvnPlugin;
    private svnClient: SVNClient;
    private onRefresh: () => void;

    constructor(plugin: ObsidianSvnPlugin, svnClient: SVNClient, onRefresh: () => void) {
        this.plugin = plugin;
        this.svnClient = svnClient;
        this.onRefresh = onRefresh;
    }

    async validateRepository(): Promise<{ isValid: boolean; repoPath?: string; error?: string }> {
        try {
            const settings = this.plugin.settings;            if (!settings.repositoryName) {
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
    }    renderRepositorySetup(container: HTMLElement, currentFile: TFile): void {
        container.empty();
        
        this.validateRepository().then(validation => {
            const setupEl = container.createEl('div', { cls: 'workspace-leaf-content' });
            
            if (!validation.isValid) {
                this.renderRepositoryError(setupEl, validation, currentFile);
            } else {
                this.renderCheckoutOptions(setupEl, validation.repoPath!, currentFile);
            }
        });
    }

    private renderRepositoryError(container: HTMLElement, validation: any, currentFile: TFile): void {
        container.createEl('h3', { 
            text: 'SVN Repository Setup Required',
            cls: 'setting-item-name'
        });

        container.createEl('p', { 
            text: validation.error,
            cls: 'setting-item-description mod-warning'
        });        const settings = this.plugin.settings;
        if (!settings.repositoryName) {
            container.createEl('p', { 
                text: 'Please configure a repository name in the plugin settings first.',
                cls: 'setting-item-description'
            });

            new ButtonComponent(container)
                .setButtonText('Open Settings')
                .setClass('mod-cta')
                .onClick(() => {
                    (this.plugin.app as any).setting.open();
                    (this.plugin.app as any).setting.openTabById(this.plugin.manifest.id);
                });
        } else {
            // Repository name is configured but repo doesn't exist
            container.createEl('p', { 
                text: `You can create a new repository '${settings.repositoryName}' or checkout an existing one.`,
                cls: 'setting-item-description'
            });

            const buttonContainer = container.createEl('div', { cls: 'svn-button-container' });

            new ButtonComponent(buttonContainer)
                .setButtonText('Create New Repository')
                .setClass('mod-cta')
                .onClick(() => this.createRepository(currentFile));

            new ButtonComponent(buttonContainer)
                .setButtonText('Checkout Existing Repository')
                .onClick(() => this.showCheckoutModal(currentFile));
        }
    }
    private renderCheckoutOptions(container: HTMLElement, repoPath: string, currentFile: TFile): void {
        container.createEl('div', { 
            text: 'Working copy setup',
            cls: 'setting-item-name'
        });

        container.createEl('div', { 
            text: 'The repository exists but this file is not in a working copy. You need to checkout the repository to start tracking files.',
            cls: 'setting-item-description'
        });

        const buttonContainer = container.createEl('div', { cls: 'svn-button-container' });

        new ButtonComponent(buttonContainer)
            .setButtonText('Checkout repository')
            .setClass('mod-cta')
            .onClick(() => this.checkoutRepository(repoPath, currentFile));

        new ButtonComponent(buttonContainer)
            .setButtonText('Initialize working copy')
            .onClick(() => this.initWorkingCopy(repoPath, currentFile));
    }

    private async createRepository(currentFile: TFile): Promise<void> {
        try {
            const settings = this.plugin.settings;
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

    private async checkoutRepository(repoPath: string, currentFile: TFile): Promise<void> {
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
    }    private async initWorkingCopy(repoPath: string, currentFile: TFile): Promise<void> {
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
    }

    private showCheckoutModal(currentFile: TFile): void {
        // For now, show a simple prompt - could be enhanced with a proper modal
        const repoUrl = prompt('Enter SVN repository URL to checkout:');
        if (repoUrl) {
            this.checkoutExternalRepository(repoUrl, currentFile);
        }
    }    private async checkoutExternalRepository(repoUrl: string, currentFile: TFile): Promise<void> {
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
