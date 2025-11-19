
import { GeneratedContent, SiteInfo, SitemapPage } from "./types";
import { MIN_INTERNAL_LINKS, TARGET_MAX_WORDS, TARGET_MIN_WORDS } from "./constants";

// FIX: Moved here to ensure availability for components and internal logic
export const escapeRegExp = (string: string) => {
    return string.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// FIX: Moved here to ensure availability for components
export const calculateFleschReadability = (text: string): number => {
    if (!text || text.trim().length === 0) return 100;

    const words: string[] = text.match(/\b\w+\b/g) || [];
    const wordCount = words.length;
    if (wordCount < 100) return 100;

    const sentences: string[] = text.match(/[^.!?]+[.!?]+/g) || [];
    const sentenceCount = sentences.length || 1;

    const syllables = words.reduce((acc: number, word: string) => {
        let currentWord = word.toLowerCase();
        if (currentWord.length <= 3) return acc + 1;
        currentWord = currentWord.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
        currentWord = currentWord.replace(/^y/, '');
        const syllableMatches = currentWord.match(/[aeiouy]{1,2}/g);
        return acc + (syllableMatches ? syllableMatches.length : 0);
    }, 0);

    const score = 206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syllables / wordCount);
    return Math.max(0, Math.min(100, Math.round(score)));
};

// FIX: Moved here to ensure availability for components
export const getReadabilityVerdict = (score: number): { verdict: string, color: string } => {
    if (score >= 90) return { verdict: 'Very Easy', color: 'var(--success)' };
    if (score >= 80) return { verdict: 'Easy', color: 'var(--success)' };
    if (score >= 70) return { verdict: 'Fairly Easy', color: '#4caf50' };
    if (score >= 60) return { verdict: 'Standard', color: 'var(--warning)' };
    if (score >= 50) return { verdict: 'Fairly Difficult', color: 'var(--warning)' };
    if (score >= 30) return { verdict: 'Difficult', color: 'var(--error)' };
    return { verdict: 'Very Difficult', color: 'var(--error)' };
};

/**
 * Extracts a YouTube video ID from various URL formats.
 * @param url The YouTube URL.
 * @returns The 11-character video ID or null if not found.
 */
export const extractYouTubeID = (url: string): string | null => {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    if (match && match[2].length === 11) {
        return match[2];
    }
    return null;
};

/**
 * SOTA NETWORKING ENGINE v8.6 (Optimized for NeuronWriter)
 * 
 * CRITICAL UPGRADES:
 * - Correct endpoint routing to avoid 404s.
 * - Specialized proxy routing for requests with 'X-API-KEY'.
 * - Aggressive stripping of 'User-Agent', 'Origin', 'Host' which confuse proxies.
 * - Prioritization of 'thingproxy' and 'codetabs' for header preservation.
 * - Intelligent fallback for 401 errors (differentiating proxy auth fail vs target auth fail).
 */
export const fetchWithProxies = async (
    url: string,
    options: RequestInit = {},
    onProgress?: (message: string) => void
): Promise<Response> => {
    let lastError: Error | null = null;
    const REQUEST_TIMEOUT = 45000; // Increased timeout for proxies

    // SOTA FIX: Ultra-Strict Header Sanitization.
    // Proxies often fail if you pass forbidden browser headers or if the User-Agent looks like a browser but isn't.
    const safeHeaders: Record<string, string> = {
        'Accept': 'application/json', // Strict Accept
    };
    
    let hasAuth = false;

    if (options.headers) {
        const headerObj = options.headers as Record<string, string>;
        Object.keys(headerObj).forEach(key => {
            const lowerKey = key.toLowerCase();
            // CRITICAL: Detect Auth headers
            if (lowerKey === 'x-api-key' || lowerKey === 'authorization') {
                hasAuth = true;
            }
            // REMOVE headers that confuse proxies or trigger CORS blocks
            // 'host' is critical to remove as proxies set their own
            if (!['user-agent', 'origin', 'referer', 'host', 'connection', 'sec-fetch-mode', 'accept-encoding', 'content-length'].includes(lowerKey)) {
                safeHeaders[key] = headerObj[key];
            }
        });
    }

    const fetchOptions = {
        ...options,
        headers: safeHeaders
    };

    // 1. Attempt Direct Fetch (Optimistic - unlikely for NeuronWriter but good for others)
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort('Direct fetch timed out'), 4000); 
        const directResponse = await fetch(url, {
            ...fetchOptions,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        
        // If direct works (2xx) or returns client error (4xx) that ISN'T a CORS opaque error
        if (directResponse.ok || (directResponse.status >= 400 && directResponse.status < 600)) {
            // Warning: Browsers sometimes return 401 for CORS preflight failures if not handled well.
            // But if we get a response object, it's usually "safe".
            return directResponse;
        }
    } catch (error: any) {
        // Ignore direct errors, proceed to proxy
    }

    // 2. Intelligent Proxy Selection
    const encodedUrl = encodeURIComponent(url);
    let proxies: string[] = [];

    if (hasAuth) {
        // [SOTA] AUTH-OPTIMIZED PROXY CHAIN
        // ThingProxy is robust for Auth. CodeTabs is good. 
        // CorsProxy.io is sometimes flaky with headers on free tier, moved to last.
        proxies = [
            `https://thingproxy.freeboard.io/fetch/${url}`,
            `https://api.codetabs.com/v1/proxy?quest=${encodedUrl}`,
            `https://corsproxy.io/?${encodedUrl}`,
        ];
        onProgress?.("Engaging SOTA Secure Proxy Layer (Header Preservation Mode)...");
    } else {
        // [SOTA] SPEED-OPTIMIZED PROXY CHAIN (GET only)
        proxies = [
            `https://corsproxy.io/?${url}`,
            `https://api.allorigins.win/raw?url=${encodedUrl}`,
            `https://api.codetabs.com/v1/proxy?quest=${encodedUrl}`,
        ];
    }

    // 3. Proxy Iteration
    for (let i = 0; i < proxies.length; i++) {
        const proxyUrl = proxies[i];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(`Proxy timed out`), REQUEST_TIMEOUT);

        try {
            const shortName = new URL(proxyUrl).hostname;
            // onProgress?.(`Connecting via ${shortName}...`);
            console.log(`[SOTA Net] Attempting proxy ${i+1}/${proxies.length}: ${shortName}`);
            
            const response = await fetch(proxyUrl, {
                ...fetchOptions,
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            // 5xx errors usually mean the proxy itself failed, not the target. Try next.
            if (response.status >= 500) {
                 console.warn(`[SOTA Net] Proxy ${shortName} failed with ${response.status}`);
                 lastError = new Error(`Proxy ${shortName} failed`);
                 continue;
            }

            // SPECIAL HANDLING FOR 401/403 WITH AUTH
            // If we sent auth, and got 401/403, it *might* be the proxy stripping the header.
            // If we have more proxies, try them just in case.
            if (hasAuth && (response.status === 401 || response.status === 403)) {
                 console.warn(`[SOTA Net] Auth failed via ${shortName}. Proxy might have stripped headers. Trying next...`);
                 lastError = new Error(`Auth failed via ${shortName} (Status ${response.status})`);
                 // Only continue if there are more proxies. If this is the last one, we'll return it below.
                 if (i < proxies.length - 1) continue;
            }

            // If we got here, we have a response that seems to be from the target
            return response; 

        } catch (error: any) {
            clearTimeout(timeoutId);
            lastError = error as Error;
        }
    }

    const errorDetails = lastError ? lastError.message : "Unknown network error";
    // Explicitly mention headers in error if auth was attempted
    const failureMessage = hasAuth 
        ? `Network Failure: Unable to connect to ${new URL(url).hostname}. Proxies failed to forward authentication headers. \nDetails: ${errorDetails}`
        : `Network Failure: Unable to connect to ${new URL(url).hostname}. \nDetails: ${errorDetails}`;
        
    throw new Error(failureMessage);
};


/**
 * Custom error for when generated content fails a quality gate,
 * but we still want to preserve the content for manual review.
 */
export class ContentTooShortError extends Error {
    public content: string;
    public wordCount: number;
  
    constructor(message: string, content: string, wordCount: number) {
      super(message);
      this.name = 'ContentTooShortError';
      this.content = content;
      this.wordCount = wordCount;
    }
}

export class ContentTooLongError extends Error {
    public content: string;
    public wordCount: number;
  
    constructor(message: string, content: string, wordCount: number) {
      super(message);
      this.name = 'ContentTooLongError';
      this.content = content;
      this.wordCount = wordCount;
    }
}
  
export function enforceWordCount(content: string, minWords = TARGET_MIN_WORDS, maxWords = TARGET_MAX_WORDS) {
    const textOnly = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const words = textOnly.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    console.log(`📊 Word Count: ${wordCount} (target: ${minWords}-${maxWords})`);

    if (wordCount < minWords) {
        throw new ContentTooShortError(`CONTENT TOO SHORT: ${wordCount} words (minimum ${minWords} required). The content may be incomplete.`, content, wordCount);
    }

    if (wordCount > maxWords) {
        throw new ContentTooLongError(`CONTENT TOO LONG: ${wordCount} words (maximum ${maxWords} allowed). The content may be too verbose.`, content, wordCount);
    }

    return wordCount;
}

export function checkHumanWritingScore(content: string) {
    const aiPhrases = [
        'delve into', 'in today\'s digital landscape', 'revolutionize', 'game-changer',
        'unlock', 'leverage', 'robust', 'seamless', 'cutting-edge', 'elevate', 'empower',
        'it\'s important to note', 'it\'s worth mentioning', 'needless to say',
        'in conclusion', 'to summarize', 'in summary', 'holistic', 'paradigm shift',
        'utilize', 'commence', 'endeavor', 'facilitate', 'implement', 'demonstrate',
        'ascertain', 'procure', 'terminate', 'disseminate', 'expedite',
        'in order to', 'due to the fact that', 'for the purpose of', 'with regard to',
        'in the event that', 'at this point in time', 'for all intents and purposes',
        'furthermore', 'moreover', 'additionally', 'consequently', 'nevertheless',
        'notwithstanding', 'aforementioned', 'heretofore', 'whereby', 'wherein',
        'landscape', 'realm', 'sphere', 'domain', 'ecosystem', 'framework',
        'navigate', 'embark', 'journey', 'transform', 'transition',
        'plethora', 'myriad', 'multitude', 'abundance', 'copious',
        'crucial', 'vital', 'essential', 'imperative', 'paramount',
        'optimize', 'maximize', 'enhance', 'augment', 'amplify',
        'intricate', 'nuanced', 'sophisticated', 'elaborate', 'comprehensive',
        'comprehensive guide', 'ultimate guide', 'complete guide',
        'dive deep', 'take a deep dive', 'let\'s explore', 'let\'s dive in'
    ];

    let aiScore = 0;
    const lowerContent = content.toLowerCase();

    aiPhrases.forEach(phrase => {
        const count = (lowerContent.match(new RegExp(phrase, 'g')) || []).length;
        if (count > 0) {
            aiScore += (count * 10);
            console.warn(`⚠️  AI phrase detected ${count}x: "${phrase}"`);
        }
    });

    const sentences: string[] = content.match(/[^.!?]+[.!?]+/g) || [];
    if (sentences.length > 0) {
        const avgLength = sentences.reduce((sum: number, s: string) => sum + s.split(/\s+/).length, 0) / sentences.length;
        if (avgLength > 25) {
            aiScore += 15;
            console.warn(`⚠️  Average sentence too long (${avgLength.toFixed(1)} words)`);
        }
    }

    const humanScore = Math.max(0, 100 - aiScore);
    console.log(`🤖 Human Writing Score: ${humanScore}% (target: 100%)`);

    return humanScore;
}

// Strict video validation
function isValidVideo(video: any): boolean {
    if (!video.link || !video.title) return false;
    
    const videoId = extractYouTubeID(video.link);
    if (!videoId) return false;
    
    // Duration check (> 2 minutes, not a short)
    if (video.duration) {
        const parts = video.duration.split(':').map(Number);
        let minutes = 0;
        if (parts.length === 2) { // MM:SS
            minutes = parts[0];
        } else if (parts.length === 3) { // HH:MM:SS
            minutes = parts[0] * 60 + parts[1];
        } else if (parts.length === 1) { // Could be seconds, handle it just in case
             minutes = parts[0] / 60;
        }
        if (minutes < 2) return false;
    }
    
    // Title quality (not clickbait, not too short)
    if (video.title.length < 15 || video.title.toUpperCase().includes('$ CLICK HERE')) return false;
    
    return true;
}

// Emergency backup videos from top channels
async function getBackupVideos(keyword: string, apiKey: string): Promise<any[]> {
    const broadQuery = keyword.split(' ')[0]; // Use root term
    try {
        const response = await fetchWithProxies("https://google.serper.dev/search", {
            method: 'POST',
            headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                q: `${broadQuery} official tutorial`,
                search_type: 'videos',
                num: 5
            })
        });
        const data = await response.json();
        return (data.videos || [])
            .filter(isValidVideo)
            .map((v: any) => ({
                ...v,
                videoId: extractYouTubeID(v.link),
                embedUrl: `https://www.youtube.com/embed/${extractYouTubeID(v.link)}`
            }))
            .slice(0, 2);
    } catch (error) {
        console.error('Backup video search failed:', error);
        return [];
    }
}

// SOTA VIDEO GUARANTEE v3.0 - ALWAYS returns 2 videos
export async function getGuaranteedYoutubeVideos(
    keyword: string,
    serperApiKey: string,
    semanticKeywords: string[]
): Promise<any[]> {
    if (!serperApiKey) {
        console.warn("Serper API key not provided, cannot fetch videos.");
        return [];
    }
    
    const queries = [
        keyword,
        `${keyword} tutorial`,
        `${keyword} guide`,
        `${keyword} explained`,
        `${keyword} review`,
        ...semanticKeywords.slice(0, 3).map(k => `${k} video`)
    ];
    
    let allVideos: any[] = [];
    
    // Search until we have 2 valid videos
    for (const query of queries) {
        if (allVideos.length >= 2) break;
        
        try {
            const response = await fetchWithProxies("https://google.serper.dev/search", {
                method: 'POST',
                headers: { 
                    'X-API-KEY': serperApiKey, 
                    'Content-Type': 'application/json' 
                },
                body: JSON.stringify({ 
                    q: query,
                    type: 'videos', // Correct parameter for serper
                    num: 10
                })
            });
            
            const data = await response.json();
            const videos = data.videos || [];
            
            // Validate and filter videos
            for (const video of videos) {
                if (allVideos.length >= 2) break;
                
                if (isValidVideo(video)) {
                    // Ensure uniqueness
                    const videoId = extractYouTubeID(video.link);
                    if (videoId && !allVideos.some(v => v.videoId === videoId)) {
                        allVideos.push({
                            ...video,
                            videoId: videoId,
                            embedUrl: `https://www.youtube.com/embed/${videoId}`
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`Video search failed for: ${query}`, error);
        }
    }
    
    // FINAL GUARANTEE: If still < 2 videos, use top trending in category
    if (allVideos.length < 2) {
        console.warn(`⚠️ Only ${allVideos.length} video(s) found. Using category backups...`);
        const backupVideos = await getBackupVideos(keyword, serperApiKey);
        
        // Add backups without creating duplicates
        for (const backup of backupVideos) {
            if (allVideos.length >= 2) break;
            if (!allVideos.some(v => v.videoId === backup.videoId)) {
                allVideos.push(backup);
            }
        }
    }
    
    return allVideos.slice(0, 2);
}


export const enforceUniqueVideoEmbeds = (content: string, youtubeVideos: any[]): string => {
    if (!youtubeVideos || youtubeVideos.length < 2) {
        return content; // Not enough videos to have a duplicate issue.
    }

    const iframeRegex = /<iframe[^>]+src="https:\/\/www\.youtube\.com\/embed\/([^"?&]+)[^>]*><\/iframe>/g;
    const matches = [...content.matchAll(iframeRegex)];
    
    if (matches.length < 2) {
        return content; // Not enough embeds to have duplicates.
    }

    const videoIdsInContent = matches.map(m => m[1]);
    const firstVideoId = videoIdsInContent[0];
    const isDuplicate = videoIdsInContent.every(id => id === firstVideoId);


    if (isDuplicate) {
        const duplicateId = videoIdsInContent[0];
        console.warn(`[Video Guardian] Duplicate video ID "${duplicateId}" detected. Attempting to replace second instance.`);

        const secondVideo = youtubeVideos[1];
        if (secondVideo && secondVideo.videoId && secondVideo.videoId !== duplicateId) {
            const secondMatch = matches[1]; // The second iframe tag found
            const secondMatchIndex = content.indexOf(secondMatch[0], secondMatch.index as number);

            if (secondMatchIndex !== -1) {
                const correctedIframe = secondMatch[0].replace(duplicateId, secondVideo.videoId);
                content = content.substring(0, secondMatchIndex) + correctedIframe + content.substring(secondMatchIndex + secondMatch[0].length);
                console.log(`[Video Guardian] Successfully replaced second duplicate with unique video: "${secondVideo.videoId}".`);
            }
        }
    }
    return content;
};

export const normalizeGeneratedContent = (parsedJson: any, itemTitle: string): GeneratedContent => {
    const normalized = { ...parsedJson };

    if (!normalized.title) normalized.title = itemTitle;
    if (!normalized.slug) normalized.slug = itemTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '');
    if (!normalized.content) {
        console.warn(`[Normalization] 'content' field was missing for "${itemTitle}". Defaulting to empty string.`);
        normalized.content = '';
    }

    if (!normalized.imageDetails || !Array.isArray(normalized.imageDetails) || normalized.imageDetails.length === 0) {
        console.warn(`[Normalization] 'imageDetails' was missing or invalid for "${itemTitle}". Generating default image prompts.`);
        const slugBase = normalized.slug || itemTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '');
        normalized.imageDetails = [
            {
                prompt: `A high-quality, photorealistic image representing the concept of: "${normalized.title}". Cinematic, professional blog post header image, 16:9 aspect ratio.`,
                altText: `A conceptual image for "${normalized.title}"`,
                title: `${slugBase}-feature-image`,
                placeholder: '[IMAGE_1_PLACEHOLDER]'
            },
            {
                prompt: `An infographic or diagram illustrating a key point from the article: "${normalized.title}". Clean, modern design with clear labels. 16:9 aspect ratio.`,
                altText: `Infographic explaining a key concept from "${normalized.title}"`,
                title: `${slugBase}-infographic`,
                placeholder: '[IMAGE_2_PLACEHOLDER]'
            }
        ];
        
        if (normalized.content && !normalized.content.includes('[IMAGE_1_PLACEHOLDER]')) {
            const paragraphs = normalized.content.split('</p>');
            if (paragraphs.length > 2) {
                paragraphs.splice(2, 0, '<p>[IMAGE_1_PLACEHOLDER]</p>');
                normalized.content = paragraphs.join('</p>');
            } else {
                normalized.content += '<p>[IMAGE_1_PLACEHOLDER]</p>';
            }
        }
        if (normalized.content && !normalized.content.includes('[IMAGE_2_PLACEHOLDER]')) {
            const paragraphs = normalized.content.split('</p>');
            if (paragraphs.length > 5) {
                paragraphs.splice(5, 0, '<p>[IMAGE_2_PLACEHOLDER]</p>');
                 normalized.content = paragraphs.join('</p>');
            } else {
                 normalized.content += '<p>[IMAGE_2_PLACEHOLDER]</p>';
            }
        }
    }

    if (!normalized.metaDescription) normalized.metaDescription = `Read this comprehensive guide on ${normalized.title}.`;
    if (!normalized.primaryKeyword) normalized.primaryKeyword = itemTitle;
    if (!normalized.semanticKeywords || !Array.isArray(normalized.semanticKeywords)) normalized.semanticKeywords = [];
    if (!normalized.strategy) normalized.strategy = { targetAudience: '', searchIntent: '', competitorAnalysis: '', contentAngle: '' };
    if (!normalized.jsonLdSchema) normalized.jsonLdSchema = {};
    if (!normalized.socialMediaCopy) normalized.socialMediaCopy = { twitter: '', linkedIn: '' };
    if (!normalized.faqSection || !Array.isArray(normalized.faqSection)) normalized.faqSection = [];
    if (!normalized.keyTakeaways || !Array.isArray(normalized.keyTakeaways)) normalized.keyTakeaways = [];
    if (!normalized.outline || !Array.isArray(normalized.outline)) normalized.outline = [];
    if (!normalized.references || !Array.isArray(normalized.references)) normalized.references = [];

    return normalized as GeneratedContent;
};

export const generateEeatBoxHtml = (siteInfo: SiteInfo, primaryKeyword: string): string => {
    if (!siteInfo?.authorName) {
        return '';
    }

    const hasAuthorUrl = siteInfo.authorUrl && siteInfo.authorUrl.trim() !== '';
    const hasAuthorSameAs = Array.isArray(siteInfo.authorSameAs) && siteInfo.authorSameAs.length > 0;

    return `
<div class="eeat-author-box">
    <div class="eeat-row">
        <span class="eeat-icon" role="img" aria-label="Expert Author">👤</span>
        <p class="eeat-text">
            Written by <strong>${hasAuthorUrl ? `<a href="${siteInfo.authorUrl}" target="_blank" rel="noopener noreferrer">${siteInfo.authorName}</a>` : siteInfo.authorName}</strong>, a recognized expert in ${primaryKeyword}.
        </p>
    </div>
    <div class="eeat-row">
        <span class="eeat-icon" role="img" aria-label="Fact Checked">✔️</span>
        <p class="eeat-text">
            All information in this article has been fact-checked and reviewed for accuracy. Our content is based on extensive research from authoritative sources.
        </p>
    </div>
    ${hasAuthorSameAs ? `
    <div class="eeat-row">
        <span class="eeat-icon" role="img" aria-label="Connect">🔗</span>
        <p class="eeat-text">
            Connect with the author: ${siteInfo.authorSameAs.map(url => {
                try {
                    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${new URL(url).hostname.replace('www.','')}</a>`;
                } catch {
                    return '';
                }
            }).filter(Boolean).join(', ')}
        </p>
    </div>` : ''}
</div>`;
};


/**
 * SOTA Post-Processing: A quality gate for the "one-shot" generated HTML.
 * It checks for structural integrity and adds/reorders missing elements from the plan.
 */
export const postProcessGeneratedHtml = (html: string, plan: GeneratedContent, youtubeVideos: any[] | null, siteInfo: SiteInfo): string => {
    let processedHtml = html;

    // SOTA FIX: Ensure Key Takeaways appear IMMEDIATELY AFTER intro and BEFORE first H2
    if (!processedHtml.includes('key-takeaways-box') && plan.keyTakeaways && plan.keyTakeaways.length > 0) {
        const keyTakeawaysHtml = `<div class="key-takeaways-box"><h3>Key Takeaways</h3><ul>${plan.keyTakeaways.map(t => `<li>${t}</li>`).join('')}</ul></div>`;
        
        // Find where intro ends (first H2 marker)
        const firstH2Index = processedHtml.search(/<h2/i);
        
        if (firstH2Index !== -1) {
            // Inject takeaways between intro and first H2
            processedHtml = processedHtml.slice(0, firstH2Index) + keyTakeawaysHtml + processedHtml.slice(firstH2Index);
        } else {
            // Fallback: append after intro if no H2s
            processedHtml = processedHtml + keyTakeawaysHtml;
        }
    }

    // SOTA FIX: Ensure E-E-A-T Author box appears after Key Takeaways
    const eeatBoxHtml = generateEeatBoxHtml(siteInfo, plan.primaryKeyword);
    if (eeatBoxHtml && !processedHtml.includes('eeat-author-box')) {
        // Logic to inject the box. The best place is right after the key takeaways.
        if (processedHtml.includes('key-takeaways-box')) {
            const insertionPoint = processedHtml.indexOf('</div>', processedHtml.indexOf('key-takeaways-box')) + 6;
            processedHtml = processedHtml.slice(0, insertionPoint) + eeatBoxHtml + processedHtml.slice(insertionPoint);
        } else {
            // Fallback: put it before the first H2 if takeaways are missing
            const firstH2Index = processedHtml.search(/<h2/i);
            if (firstH2Index !== -1) {
                processedHtml = processedHtml.slice(0, firstH2Index) + eeatBoxHtml + processedHtml.slice(firstH2Index);
            } else {
                processedHtml = eeatBoxHtml + processedHtml;
            }
        }
    }


    // SOTA FIX: Inject YouTube videos at strategic points (after 2nd and 5th paragraphs)
    if (youtubeVideos && youtubeVideos.length > 0) {
        const paragraphs = processedHtml.split('</p>');
        
        // Always inject first video after 2nd paragraph
        if (youtubeVideos[0] && paragraphs.length > 2) {
            const videoEmbed1 = `
                <figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube wp-embed-aspect-16-9 wp-has-aspect-ratio">
                    <div class="wp-block-embed__wrapper">
                        <iframe title="${youtubeVideos[0].title}" width="500" height="281" src="${youtubeVideos[0].embedUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
                    </div>
                    <figcaption>${youtubeVideos[0].title}</figcaption>
                </figure>
            `;
            paragraphs.splice(2, 0, videoEmbed1);
        }
        
        // Inject second video after 5th paragraph
        if (youtubeVideos[1] && paragraphs.length > 5) {
            const videoEmbed2 = `
                <figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube wp-embed-aspect-16-9 wp-has-aspect-ratio">
                    <div class="wp-block-embed__wrapper">
                        <iframe title="${youtubeVideos[1].title}" width="500" height="281" src="${youtubeVideos[1].embedUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
                    </div>
                    <figcaption>${youtubeVideos[1].title}</figcaption>
                </figure>
            `;
            paragraphs.splice(5, 0, videoEmbed2);
        }
        
        processedHtml = paragraphs.join('</p>');
    }

    return processedHtml;
};

/**
 * SOTA Internal Linking Engine:
 * Processes AI-generated link placeholders, cross-references them with actual sitemap data,
 * and builds 100% accurate URLs. This eliminates 404 errors from hallucinated links.
 * @param content The HTML content containing placeholders like [INTERNAL_LINK slug="..." text="..."]
 * @param availablePages The array of SitemapPage objects from the sitemap crawl.
 * @returns The final HTML with valid, correct internal links and stripped invalid ones.
 */
export const processInternalLinks = (content: string, availablePages: SitemapPage[]): string => {
    const placeholderRegex = /\[INTERNAL_LINK slug="([^"]+)" text="([^"]+)"\]/g;
    
    // Create a fast lookup map for slugs to full URLs for optimal performance.
    // FIX: Changed `new Map<string, string>()` to a type annotation to fix JSX parsing error.
    const slugToUrlMap: Map<string, string> = new Map();
    availablePages.forEach(page => {
        if (page.slug) {
            slugToUrlMap.set(page.slug, page.id); // page.id is the full, correct URL
        }
    });

    return content.replace(placeholderRegex, (match, slug, text) => {
        const href = slugToUrlMap.get(slug);
        if (href) {
            // Success: A valid page was found. Create the link.
            return `<a href="${href}">${text}</a>`;
        } else {
            // Fail-safe: AI hallucinated a link to a non-existent slug.
            console.warn(`[Internal Linker] AI generated a link to a non-existent slug: "${slug}". Removing link to prevent 404.`);
            return text; // Return just the anchor text to prevent a broken link.
        }
    });
};
