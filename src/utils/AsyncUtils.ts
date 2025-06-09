import { AsyncResult, CancellationToken, DebouncedFunction } from '@/types';
import { loggerDebug, loggerError } from '@/utils/obsidian-logger';

/**
 * Async utilities for better error handling and performance
 */
export class AsyncUtils {
	/**
	 * Wraps an async operation with proper error handling
	 */
	static async safeAsync<T>(
		operation: () => Promise<T>,
		errorContext?: string
	): Promise<AsyncResult<T>> {
		try {
			const data = await operation();
			return { success: true, data };
		} catch (err: any) {
			const errorMessage = err?.message || 'Unknown error';
			if (errorContext) {
				loggerError(this, `${errorContext}: ${errorMessage}`, err);
			}
			return {
				success: false,
				error: errorMessage,
				details: err
			};
		}
	}

	/**
	 * Creates a debounced function
	 */
	static debounce<T extends (...args: any[]) => any>(
		func: T,
		delay: number
	): DebouncedFunction<T> {
		let timeoutId: NodeJS.Timeout;
		
		return (...args: Parameters<T>) => {
			clearTimeout(timeoutId);
			timeoutId = setTimeout(() => func(...args), delay);
		};
	}

	/**
	 * Creates a throttled function
	 */
	static throttle<T extends (...args: any[]) => any>(
		func: T,
		delay: number
	): DebouncedFunction<T> {
		let lastCall = 0;
		
		return (...args: Parameters<T>) => {
			const now = Date.now();
			if (now - lastCall >= delay) {
				lastCall = now;
				func(...args);
			}
		};
	}

	/**
	 * Retries an async operation with exponential backoff
	 */
	static async retry<T>(
		operation: () => Promise<T>,
		maxRetries: number = 3,
		baseDelay: number = 1000
	): Promise<T> {
		let lastError: any;
		
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await operation();
			} catch (err) {
				lastError = err;
				
				if (attempt === maxRetries) {
					throw lastError;
				}
				
				const delay = baseDelay * Math.pow(2, attempt);
				loggerDebug(this, `Retry attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delay}ms`);
				await this.sleep(delay);
			}
		}
		
		throw lastError;
	}

	/**
	 * Creates a cancellation token
	 */
	static createCancellationToken(): CancellationToken {
		let isCancelled = false;
		const callbacks: (() => void)[] = [];
		
		return {
			get isCancelled() { return isCancelled; },
			cancel() {
				if (!isCancelled) {
					isCancelled = true;
					callbacks.forEach(callback => callback());
				}
			},
			onCancelled(callback: () => void) {
				if (isCancelled) {
					callback();
				} else {
					callbacks.push(callback);
				}
			}
		};
	}

	/**
	 * Promise-based sleep
	 */
	static sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Run operations in parallel with a concurrency limit
	 */
	static async parallelLimit<T, R>(
		items: T[],
		concurrency: number,
		operation: (item: T) => Promise<R>
	): Promise<R[]> {
		const results: R[] = [];
		const executing: Promise<void>[] = [];
		
		for (const [index, item] of items.entries()) {
			const promise = operation(item).then(result => {
				results[index] = result;
			});
			
			executing.push(promise);
			
			if (executing.length >= concurrency) {
				await Promise.race(executing);
				executing.splice(executing.findIndex(p => p === promise), 1);
			}
		}
		
		await Promise.all(executing);
		return results;
	}

	/**
	 * Timeout wrapper for promises
	 */
	static withTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
		timeoutMessage = 'Operation timed out'
	): Promise<T> {
		return Promise.race([
			promise,
			new Promise<T>((_, reject) => 
				setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
			)
		]);
	}
}
