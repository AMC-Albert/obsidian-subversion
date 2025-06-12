import { App } from 'obsidian';
import { SVNPathResolver } from './SVNPathResolver';
import { execPromise } from '@/utils/AsyncUtils';
import { join, dirname, basename, extname as nodeExtname } from 'path'; // Renamed extname to avoid conflict
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { loggerDebug, loggerError, loggerInfo, loggerWarn, registerLoggerClass } from '@/utils/obsidian-logger';

const PLUGIN_ID_FOR_PATHS = 'obsidian-subversion'; 
const SIDECARS_PLUGIN_ID = 'sidecars'; 

interface SidecarExtensionEntry {
	extension: string;
	sidecarSuffix: string;
}

export class SVNSidecarManager {
	private app: App;
	private svnPath: string;
	private pathResolver: SVNPathResolver;
	private previewCacheDir: string;

	constructor(app: App, svnPath: string, pathResolver: SVNPathResolver) {
		this.app = app;
		this.svnPath = svnPath;
		this.pathResolver = pathResolver;
		
		this.updatePreviewCacheDir();
		this.ensureCacheDirectoryExists();
		registerLoggerClass(this, 'SVNSidecarManager');
	}

	private updatePreviewCacheDir(): void {
		const vaultPath = this.pathResolver.getVaultPath();
		if (!vaultPath) {
			loggerError(this, 'SVNSidecarManager: Vault path is not available. Preview cache will be relative to plugin config.');
			// Use a common workaround to get the vault's absolute base path
			const basePath = (this.app.vault.adapter as any).basePath;
			if (basePath) {
				this.previewCacheDir = join(basePath, this.app.vault.configDir, 'plugins', PLUGIN_ID_FOR_PATHS, 'preview_cache_fallback');
			} else {
				loggerError(this, 'SVNSidecarManager: Could not determine vault base path for fallback cache directory.');
				// As a last resort, place it directly in the plugin's folder within .obsidian/plugins
				this.previewCacheDir = join(this.app.vault.configDir, 'plugins', PLUGIN_ID_FOR_PATHS, 'preview_cache_absolute_fallback');
			}
		} else {
			this.previewCacheDir = join(vaultPath, this.app.vault.configDir, 'plugins', PLUGIN_ID_FOR_PATHS, 'preview_cache');
		}
		loggerInfo(this, 'SVNSidecarManager: Preview cache directory updated to:', this.previewCacheDir);
	}
	
	public setVaultPath(_newVaultPathNotUsedDirectly: string): void {
		loggerInfo(this, 'SVNSidecarManager: setVaultPath called. Re-evaluating preview cache directory.');
		this.updatePreviewCacheDir();
		this.ensureCacheDirectoryExists();
	}

	private ensureCacheDirectoryExists(): void {
		try {
			if (!existsSync(this.previewCacheDir)) {
				mkdirSync(this.previewCacheDir, { recursive: true });
				loggerInfo(this, `Created preview cache directory: ${this.previewCacheDir}`);
			}
		} catch (error) {
			loggerError(this, `Failed to create preview cache directory ${this.previewCacheDir}:`, error);
		}
	}

	public getSidecarSuffix(filePath: string): string {
		// @ts-ignore - Accessing other plugin's settings
		const sidecarsPlugin = this.app.plugins?.plugins?.[SIDECARS_PLUGIN_ID];

		if (sidecarsPlugin && sidecarsPlugin.settings?.useSidecars) {
			const fileExtension = nodeExtname(filePath); // Use imported extname
			const sidecarExtensions = sidecarsPlugin.settings.sidecarExtensions as SidecarExtensionEntry[];

			if (Array.isArray(sidecarExtensions)) {
				for (const entry of sidecarExtensions) {
					if (entry.extension === fileExtension && typeof entry.sidecarSuffix === 'string') {
						loggerDebug(this, `Found sidecar/preview suffix '${entry.sidecarSuffix}' for ext '${fileExtension}' via ${SIDECARS_PLUGIN_ID}.`);
						return entry.sidecarSuffix;
					}
				}
				loggerDebug(this, `No specific mapping for ext '${fileExtension}' in ${SIDECARS_PLUGIN_ID} sidecarExtensions.`);
			} else {
				loggerWarn(this, `${SIDECARS_PLUGIN_ID} 'sidecarExtensions' setting is not an array or missing.`);
			}
			
			if (sidecarsPlugin.settings.previewFileSuffix && typeof sidecarsPlugin.settings.previewFileSuffix === 'string') {
				const genericPreviewSuffix = sidecarsPlugin.settings.previewFileSuffix;
				loggerDebug(this, `Using generic 'previewFileSuffix' ('${genericPreviewSuffix}') from ${SIDECARS_PLUGIN_ID} for ${filePath}.`);
				return genericPreviewSuffix;
			}

		} else {
			loggerDebug(this, `${SIDECARS_PLUGIN_ID} plugin not active/found, or 'useSidecars' is false, or settings unavailable.`);
		}
		
		loggerWarn(this, `No sidecar/preview suffix found for ${filePath} via ${SIDECARS_PLUGIN_ID}. Returning empty string.`);
		return "";
	}

	public generatePreviewCacheFileName(filePath: string, revision?: number): string | null {
		const previewSuffix = this.getSidecarSuffix(filePath);
		if (!previewSuffix) {
			loggerInfo(this, `Cannot generate preview cache name for ${filePath}: no preview suffix configured/found.`);
			return null;
		}

		const mainFileBaseName = basename(filePath, nodeExtname(filePath)); // Use imported extname
		const revisionString = revision ? `_r${revision}` : '';
		
		let normalizedSuffix = previewSuffix;
		if (!normalizedSuffix.startsWith('.') && !normalizedSuffix.startsWith('_')) {
			normalizedSuffix = `.${normalizedSuffix}`; 
		}
		
		return `${mainFileBaseName}${revisionString}${normalizedSuffix}`;
	}

	public async getLocalPreviewImage(filePath: string, revision?: number): Promise<string | null> {
		loggerDebug(this, 'getLocalPreviewImage checking cache for:', { filePath, revision });
		const localFileName = this.generatePreviewCacheFileName(filePath, revision);
		
		if (!localFileName) {
			loggerInfo(this, `Could not get local preview for ${filePath} (rev ${revision}): cache file name generation failed.`);
			return null;
		}

		const cachedPath = join(this.previewCacheDir, localFileName);

		if (existsSync(cachedPath)) {
			loggerInfo(this, `Local preview image found in cache: ${cachedPath}`);
			return cachedPath;
		} else {
			loggerInfo(this, `Local preview image NOT in cache for ${filePath} (rev ${revision}). Expected: ${cachedPath}`);
			return null;
		}
	}
	
	async exportAndCachePreviewImage(
		previewFileSvnUrlAtRevision: string,
		localFileNameForCache: string 
	): Promise<string | null> {
		loggerDebug(this, 'exportAndCachePreviewImage attempting export:', { previewFileSvnUrlAtRevision, localFileNameForCache });
		this.ensureCacheDirectoryExists();

		const localCachedFilePath = join(this.previewCacheDir, localFileNameForCache);

		if (existsSync(localCachedFilePath)) {
			loggerInfo(this, `Preview image already cached at ${localCachedFilePath}. Overwriting.`);
			try {
				unlinkSync(localCachedFilePath);
			} catch (e) {
				loggerWarn(this, `Could not delete existing cached file ${localCachedFilePath} before export: ${(e as Error).message}`);
			}
		}

		const command = `${this.svnPath} export --force "${previewFileSvnUrlAtRevision}" "${localCachedFilePath}"`;
		const cwd = this.pathResolver.getVaultPath() || dirname(this.previewCacheDir);

		loggerInfo(this, 'Executing SVN export for preview:', { command, cwd });
		try {
			await execPromise(command, { cwd });
			if (existsSync(localCachedFilePath)) {
				loggerInfo(this, `Successfully exported preview to: ${localCachedFilePath}`);
				return localCachedFilePath;
			} else {
				loggerError(this, `SVN export command ran, but cached file not found: ${localCachedFilePath}`);
				return null;
			}
		} catch (error) {
			loggerError(this, `Failed to export preview from ${previewFileSvnUrlAtRevision} to ${localCachedFilePath}:`, error);
			if (existsSync(localCachedFilePath)) {
				try {
					unlinkSync(localCachedFilePath);
				} catch (cleanupError) {
					loggerWarn(this, `Failed to clean up partial file ${localCachedFilePath} after export error:`, cleanupError);
				}
			}
			return null;
		}
	}
}
