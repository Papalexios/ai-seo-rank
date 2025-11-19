
import { SitemapPage } from "./types";
import { MIN_INTERNAL_LINKS } from "./constants";
import { GeneratedContent } from './types';
import { WpConfig, SiteInfo, ExpandedGeoTargeting } from './types';
import { generateFullSchema, generateSchemaMarkup } from './schema-generator';

// --- START: Performance & Caching Enhancements ---

/**
 * A sophisticated caching layer for API responses to reduce redundant calls
 * and improve performance within a session.
 */
class ContentCache {
  private cache = new Map<string, {data: any, timestamp: number}>();
  private TTL = 3600000; // 1 hour
  
  set(key: string, data: any) {
    this.cache.set(key, {data, timestamp: Date.now()});
  }
  
  get(key: string): any | null {
    const item = this.cache.get(key);
    if (item && Date.now() - item.timestamp < this.TTL) {
      console.log(`[Cache] HIT for key: ${key.substring(0, 100)}...`);
      return item.data;
    }
    console.log(`[Cache] MISS for key: ${key.substring(0, 100)}...`);
    return null;
  }
}
export const apiCache = new ContentCache();

// SOTA PERFORMANCE ENGINE v5.0
// 1. PERSISTENT CACHE (survives session)
class PersistentCache {
  private storage = localStorage;
  
  set(key: string, data: any, ttl: number = 86400000) { // 24h default
    const item = {
      data,
      expiry: Date.now() + ttl
    };
    try {
        this.storage.setItem(`wcop_${key}`, JSON.stringify(item));
    } catch (e) {
        console.error("Failed to write to persistent cache (localStorage full?):", e);
    }
  }
  
  get(key: string): any | null {
    const item = this.storage.getItem(`wcop_${key}`);
    if (!item) return null;
    
    try {
      const parsed = JSON.parse(item);
      if (Date.now() > parsed.expiry) {
        this.storage.removeItem(`wcop_${key}`);
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }
  
  has(key: string): boolean {
    return this.get(key) !== null;
  }
}

export const persistentCache = new PersistentCache();

// 3. LAZY SCHEMA GENERATION (generate only when needed)
export const lazySchemaGeneration = (content: GeneratedContent, wpConfig: WpConfig, siteInfo: SiteInfo, geoTargeting: ExpandedGeoTargeting) => {
    let schemaCache: string | null = null;
    
    return () => {
        if (!schemaCache) {
            schemaCache = generateSchemaMarkup(
                generateFullSchema(content, wpConfig, siteInfo, content.faqSection, geoTargeting.enabled ? geoTargeting : undefined)
            );
        }
        return schemaCache;
    };
};

// 4. CONNECTION POOLING
class AIClientPool {
    private clients: Map<string, any> = new Map();
    
    get(clientType: string, apiKey: string) {
        const key = `${clientType}_${apiKey.slice(-8)}`;
        return this.clients.get(key);
    }
    
    set(clientType: string, apiKey: string, client: any) {
        const key = `${clientType}_${apiKey.slice(-8)}`;
        this.clients.set(key, client);
    }
}

export const clientPool = new AIClientPool();

// --- START: Core Utility Functions ---

// Debounce function to limit how often a function gets called
export const debounce = (func: (...args: any[]) => void, delay: number) => {
    let timeoutId: ReturnType<typeof setTimeout>;
    return (...args: any[]) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(null, args);
        }, delay);
    };
};


/**
 * A highly resilient function to extract a JSON object from a string.
 * It surgically finds the JSON boundaries by balancing brackets, strips conversational text and markdown,
 * and automatically repairs common syntax errors like trailing commas.
 * @param text The raw string response from the AI, which may contain conversational text.
 * @returns The clean, valid JSON object.
 * @throws {Error} if a valid JSON object cannot be found or parsed.
 */
export const extractJson = (text: string): string => {
    if (!text || typeof text !== 'string') {
        throw new Error("Input text is invalid or empty.");
    }
    
    // First, try a simple parse. If it's valid, we're done.
    try {
        JSON.parse(text);
        return text;
    } catch (e: any) { /* Not valid, proceed with cleaning */ }

    // Aggressively clean up common conversational text and markdown fences.
    let cleanedText = text
        .replace(/^```(?:json)?\s*/, '') // Remove opening ```json or ```
        .replace(/\s*```$/, '')           // Remove closing ```
        .trim();

    // Remove any remaining markdown blocks
    cleanedText = cleanedText.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

    // Remove trailing commas before closing brackets  
    cleanedText = cleanedText.replace(/,(\s*[}\]])/g, '$1');

    // Find the first real start of a JSON object or array.
    const firstBracket = cleanedText.indexOf('{');
    const firstSquare = cleanedText.indexOf('[');
    
    if (firstBracket === -1 && firstSquare === -1) {
        console.error(`[extractJson] No JSON start characters ('{' or '[') found after cleanup.`, { originalText: text });
        throw new Error("No JSON object/array found. Ensure your prompt requests JSON output only without markdown.");
    }

    let startIndex = -1;
    if (firstBracket === -1) startIndex = firstSquare;
    else if (firstSquare === -1) startIndex = firstBracket;
    else startIndex = Math.min(firstBracket, firstSquare);

    let potentialJson = cleanedText.substring(startIndex);
    
    // Find the balanced end bracket for the structure.
    const startChar = potentialJson[0];
    const endChar = startChar === '{' ? '}' : ']';
    
    let balance = 1;
    let inString = false;
    let escapeNext = false;
    let endIndex = -1;

    for (let i = 1; i < potentialJson.length; i++) {
        const char = potentialJson[i];
        
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        
        if (char === '\\') {
            escapeNext = true;
            continue;
        }
        
        if (char === '"' && !escapeNext) {
            inString = !inString;
        }
        
        if (inString) continue;

        if (char === startChar) balance++;
        else if (char === endChar) balance--;

        if (balance === 0) {
            endIndex = i;
            break;
        }
    }

    let jsonCandidate;
    if (endIndex !== -1) {
        jsonCandidate = potentialJson.substring(0, endIndex + 1);
    } else {
        jsonCandidate = potentialJson;
        if (balance > 0) {
            console.warn(`[extractJson] Could not find a balanced closing bracket (unclosed structures: ${balance}). The response may be truncated. Attempting to auto-close.`);
            jsonCandidate += endChar.repeat(balance);
        } else {
             console.warn("[extractJson] Could not find a balanced closing bracket. The AI response may have been truncated.");
        }
    }

    // Attempt to parse the candidate string.
    try {
        JSON.parse(jsonCandidate);
        return jsonCandidate;
    } catch (e) {
        // If parsing fails, try to repair common issues like trailing commas.
        console.warn("[extractJson] Initial parse failed. Attempting to repair trailing commas.");
        try {
            const repaired = jsonCandidate.replace(/,(?=\s*[}\]])/g, '');
            JSON.parse(repaired);
            return repaired;
        } catch (repairError: any) {
            console.error(`[extractJson] CRITICAL FAILURE: Parsing failed even after repair.`, { 
                errorMessage: repairError.message,
                attemptedToParse: jsonCandidate
            });
            throw new Error(`Unable to parse JSON from AI response after multiple repair attempts.`);
        }
    }
};

/**
 * SOTA Self-Healing JSON Parser.
 * Attempts to parse a string as JSON. If it fails, it uses a provided AI function
 * to repair the broken syntax and then attempts to parse the result.
 * @param text The raw string response from an AI.
 * @param aiRepairer An async function that takes the broken text and returns a repaired string.
 * @returns A promise that resolves to the parsed JavaScript object.
 * @throws {Error} if parsing fails even after the AI repair attempt.
 */
export async function parseJsonWithAiRepair(
    text: string, 
    aiRepairer: (brokenText: string) => Promise<string>
): Promise<any> {
    try {
        const jsonString = extractJson(text);
        return JSON.parse(jsonString);
    } catch (initialError: any) {
        console.warn(`[JSON Repair] Initial parsing failed: ${initialError.message}. Attempting AI repair.`);
        try {
            // Call the AI to fix the broken JSON
            const repairedResponseText = await aiRepairer(text);
            
            // Now, try to extract and parse the REPAIRED text
            const repairedJsonString = extractJson(repairedResponseText);
            console.log("[JSON Repair] AI repair successful. Parsing repaired JSON.");
            return JSON.parse(repairedJsonString);
        } catch (repairError: any) {
            console.error("[JSON Repair] CRITICAL: AI repair failed. The response is unrecoverable.", {
                originalError: initialError.message,
                repairError: repairError.message,
                originalText: text
            });
            throw new Error(`Failed to parse JSON even after AI repair: ${repairError.message}`);
        }
    }
}


/**
 * Strips markdown code fences and conversational text from AI-generated HTML snippets.
 * Ensures that only raw, clean HTML is returned, preventing page distortion.
 * @param rawHtml The raw string response from the AI.
 * @returns A string containing only the HTML content.
 */
export const sanitizeHtmlResponse = (rawHtml: string): string => {
    if (!rawHtml || typeof rawHtml !== 'string') {
        return '';
    }
    
    // Remove markdown code fences for html, plain text, etc.
    let cleanedHtml = rawHtml
        .replace(/^```(?:html)?\s*/i, '') // Remove opening ```html or ```
        .replace(/\s*```$/, '')           // Remove closing ```
        .trim();

    // In case the AI adds conversational text like "Here is the HTML for the section:"
    // A simple heuristic is to find the first opening HTML tag and start from there.
    const firstTagIndex = cleanedHtml.indexOf('<');
    if (firstTagIndex > 0) {
        // Check if the text before the tag is just whitespace or contains actual words.
        const pretext = cleanedHtml.substring(0, firstTagIndex).trim();
        if (pretext.length > 0 && pretext.length < 100) { // Avoid stripping large amounts of text by accident
            console.warn(`[Sanitize HTML] Stripping potential boilerplate: "${pretext}"`);
            cleanedHtml = cleanedHtml.substring(firstTagIndex);
        }
    }

    return cleanedHtml;
};


/**
 * Extracts the final, clean slug from a URL, intelligently removing parent paths and file extensions.
 * This ensures a perfect match with the WordPress database slug.
 * @param urlString The full URL to parse.
 * @returns The extracted slug.
 */
export const extractSlugFromUrl = (urlString: string): string => {
    try {
        const url = new URL(urlString);
        let pathname = url.pathname;

        // Remove trailing slash
        if (pathname.endsWith('/') && pathname.length > 1) {
            pathname = pathname.slice(0, -1);
        }

        // Get the last segment
        const lastSegment = pathname.substring(pathname.lastIndexOf('/') + 1);

        // Remove file extensions and query parameters
        const cleanedSlug = lastSegment
            .replace(/\.[a-zA-Z0-9]{2,5}$/, '') // Remove .html, .php, etc.
            .split('?')[0] // Remove query strings
            .split('#')[0]; // Remove anchors

        // SOTA FIX: WordPress slug sanitization (match WP's sanitize_title() function)
        return cleanedSlug
            .toLowerCase()
            .replace(/[^a-z0-9/_\-]/g, '-') // Replace non-alphanumeric with hyphens
            .replace(/-+/g, '-') // Remove duplicate hyphens
            .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

    } catch (error: any) {
        console.error("Could not parse URL to extract slug:", urlString, error);
        // Fallback: manual slug extraction
        const fallback = urlString.split('/').pop() || '';
        return fallback
            .toLowerCase()
            .replace(/[^a-z0-9/_\-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }
};


/**
 * A more professional and resilient fetch function for AI APIs that includes
 * exponential backoff for retries and intelligently fails fast on non-retriable errors.
 * This is crucial for handling rate limits (429) and transient server issues (5xx)
 * while avoiding wasted time on client-side errors (4xx).
 * @param apiCall A function that returns the promise from the AI SDK call.
 * @param maxRetries The maximum number of times to retry the call.
 * @param initialDelay The baseline delay in milliseconds for the first retry.
 * @returns The result of the successful API call.
 * @throws {Error} if the call fails after all retries or on a non-retriable error.
 */
export const callAiWithRetry = async (apiCall: () => Promise<any>, maxRetries = 5, initialDelay = 5000) => {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await apiCall();
        } catch (error: any) {
            console.error(`AI call failed on attempt ${attempt + 1}. Error:`, error);

            const errorMessage = (error?.message || '').toLowerCase();
            // Try to get status from error object, or parse it from the message as a fallback.
            const statusMatch = errorMessage.match(/\[(\d{3})[^\]]*\]/); 
            const statusCode = error?.status || (statusMatch ? parseInt(statusMatch[1], 10) : null);

            const isNonRetriableClientError = statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
            const isContextLengthError = errorMessage.includes('context length') || errorMessage.includes('token limit');
            const isInvalidApiKeyError = errorMessage.includes('api key not valid');

            if (isNonRetriableClientError || isContextLengthError || isInvalidApiKeyError) {
                 console.error(`Encountered a non-retriable error (Status: ${statusCode}, Message: ${error.message}). Failing immediately.`);
                 throw error; // Fail fast.
            }

            // If it's the last attempt for any retriable error, give up.
            if (attempt === maxRetries - 1) {
                console.error(`AI call failed on final attempt (${maxRetries}).`);
                throw error;
            }
            
            let delay: number;
            // --- Intelligent Rate Limit Handling ---
            if (error.status === 429 || statusCode === 429) {
                // Respect the 'Retry-After' header if the provider sends it. This is the gold standard.
                const retryAfterHeader = error.headers?.['retry-after'] || error.response?.headers?.get('retry-after');
                if (retryAfterHeader) {
                    const retryAfterSeconds = parseInt(retryAfterHeader, 10);
                    if (!isNaN(retryAfterSeconds)) {
                        // The value is in seconds.
                        delay = retryAfterSeconds * 1000 + 500; // Add a 500ms buffer.
                        console.log(`Rate limit hit. Provider requested a delay of ${retryAfterSeconds}s. Waiting...`);
                    } else {
                        // The value might be an HTTP-date.
                        const retryDate = new Date(retryAfterHeader);
                        if (!isNaN(retryDate.getTime())) {
                            delay = retryDate.getTime() - new Date().getTime() + 500; // Add buffer.
                             console.log(`Rate limit hit. Provider requested waiting until ${retryDate.toISOString()}. Waiting...`);
                        } else {
                             // Fallback if the date format is unexpected.
                             delay = initialDelay * Math.pow(2, attempt) + (Math.random() * 1000);
                             console.log(`Rate limit hit. Could not parse 'Retry-After' header ('${retryAfterHeader}'). Using exponential backoff.`);
                        }
                    }
                } else {
                    // If no 'Retry-After' header, use our more patient exponential backoff.
                    delay = initialDelay * Math.pow(2, attempt) + (Math.random() * 1000);
                    console.log(`Rate limit hit. No 'Retry-After' header found. Using exponential backoff.`);
                }
            } else {
                 // --- Standard Exponential Backoff for Server-Side Errors (5xx) ---
                 const backoff = Math.pow(2, attempt);
                 const jitter = Math.random() * 1000;
                 delay = initialDelay * backoff + jitter;
            }

            console.log(`Retrying in ${Math.round(delay)}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error("AI call failed after all retries.");
};

/**
 * Smartly fetches a WordPress API endpoint. If the request is authenticated, it forces a direct
 * connection, as proxies will strip authentication headers. Unauthenticated requests will use
 * the original proxy fallback logic.
 * @param targetUrl The full URL to the WordPress API endpoint.
 * @param options The options for the fetch call (method, headers, body).
 * @returns The successful Response object.
 * @throws {Error} if the connection fails.
 */
export const fetchWordPressWithRetry = async (targetUrl: string, options: RequestInit): Promise<Response> => {
    const REQUEST_TIMEOUT = 30000; // 30 seconds for potentially large uploads
    const hasAuthHeader = options.headers && (options.headers as Headers).has('Authorization');

    // If the request has an Authorization header, it MUST be a direct request.
    // Proxies will strip authentication headers and cause a guaranteed failure.
    if (hasAuthHeader) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort("WordPress API request timed out."), REQUEST_TIMEOUT);
            const directResponse = await fetch(targetUrl, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            return directResponse; // Return the response directly, regardless of status, to be handled by the caller.
        } catch (error: any) {
            // A TypeError is the classic sign of a CORS error on a failed fetch.
            // This will be caught and diagnosed by the calling function.
            throw error;
        }
    }

    // --- Fallback to original proxy logic for NON-AUTHENTICATED requests ---
    let lastError: Error | null = null;
    
    // 1. Attempt Direct Connection
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort("WordPress API request timed out."), REQUEST_TIMEOUT);
        const directResponse = await fetch(targetUrl, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        // Return client-side errors (4xx) immediately as they are not transient.
        if (directResponse.ok || (directResponse.status >= 400 && directResponse.status < 500)) {
            return directResponse;
        }
        lastError = new Error(`Direct connection failed with status ${directResponse.status}`);
    } catch (error: any) {
        console.warn("Direct WP API call failed (likely CORS or network issue). Trying proxies.", error.name);
        lastError = error;
    }
    
    // 2. Attempt with Proxies if Direct Fails
    const encodedUrl = encodeURIComponent(targetUrl);
    const proxies = [
        `https://corsproxy.io/?${encodedUrl}`,
        `https://api.allorigins.win/raw?url=${encodedUrl}`,
    ];

    for (const proxyUrl of proxies) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort("Proxy request timed out."), REQUEST_TIMEOUT);
        try {
            const shortProxyUrl = new URL(proxyUrl).hostname;
            console.log(`Attempting WP API call via proxy: ${shortProxyUrl}`);
            const response = await fetch(proxyUrl, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            if (response.ok || (response.status >= 400 && response.status < 500)) {
                console.log(`Successfully fetched via proxy: ${shortProxyUrl}`);
                return response;
            }
            const responseText = await response.text().catch(() => '(could not read response body)');
            lastError = new Error(`Proxy request failed with status ${response.status} for ${shortProxyUrl}. Response: ${responseText.substring(0, 100)}`);
        } catch (error: any) {
             clearTimeout(timeoutId);
             lastError = error;
        }
    }

    throw lastError || new Error("All attempts to connect to the WordPress API failed.");
};


/**
 * Processes an array of items concurrently using async workers, with a cancellable mechanism.
 * @param items The array of items to process.
 * @param processor An async function that processes a single item.
 * @param concurrency The number of parallel workers.
 * @param onProgress An optional callback to track progress.
 * @param shouldStop An optional function that returns true to stop processing.
 */
export async function processConcurrently<T>(
    items: T[],
    processor: (item: T) => Promise<void>,
    concurrency = 5,
    onProgress?: (completed: number, total: number) => void,
    shouldStop?: () => boolean
): Promise<void> {
    const queue = [...items];
    let completed = 0;
    const total = items.length;

    const run = async () => {
        while (queue.length > 0) {
            if (shouldStop?.()) {
                // Emptying the queue is a robust way to signal all workers to stop
                // after they finish their current task.
                queue.length = 0;
                break;
            }
            const item = queue.shift();
            if (item) {
                await processor(item);
                completed++;
                onProgress?.(completed, total);
            }
        }
    };

    const workers = Array(concurrency).fill(null).map(run);
    await Promise.all(workers);
};

export const sanitizeTitle = (title: string, slug: string): string => {
    try {
        new URL(title);
        const decodedSlug = decodeURIComponent(slug);
        return decodedSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    } catch (e) {
        return title;
    }
};

/**
 * Enterprise-grade nullish check
 */
export const isNullish = (value: any): value is null | undefined => {
    return value === null || value === undefined;
};

/**
 * Validates sort key exists on object prototype
 */
export const isValidSortKey = (key: string, obj: any): boolean => {
    if (!key || !obj || typeof obj !== 'object') return false;
    return key in obj;
};

/**
 * SOTA: Immutable property accessor with fallback
 */
export const safeAccess = <T, K extends keyof T>(
    obj: T,
    key: K,
    fallback: T[K]
): T[K] => {
    return obj?.[key] ?? fallback;
};

/**
 * SOTA: Parse with Zod-like runtime validation
 */
// FIX: Changed to a standard function declaration to avoid TSX parsing ambiguity with generics.
export function parseValidatedJson<T>(text: string, schema: (data: any) => data is T): T {
    try {
        const parsed = JSON.parse(text);
        if (!schema(parsed)) {
            throw new Error('Schema validation failed');
        }
        return parsed;
    } catch (error: any) {
        console.error('JSON parse+validation failed:', error);
        throw error;
    }
};
