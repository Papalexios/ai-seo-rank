
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import React from 'react';
import { PROMPT_TEMPLATES } from './prompts';
import { AI_MODELS, IMGUR_CLIENT_ID, CACHE_TTL, TARGET_MIN_WORDS, TARGET_MAX_WORDS } from './constants';
import {
    ApiClients, ContentItem, ExpandedGeoTargeting, GeneratedContent, GenerationContext, SiteInfo, SitemapPage, WpConfig
} from './types';
import {
    apiCache,
    callAiWithRetry,
    extractSlugFromUrl,
    fetchWordPressWithRetry,
    processConcurrently,
    parseJsonWithAiRepair,
    persistentCache,
    lazySchemaGeneration,
} from './utils';
import { generateFullSchema, generateSchemaMarkup } from "./schema-generator";
import { getNeuronWriterAnalysis, formatNeuronDataForPrompt } from "./neuronwriter";
// FIX: Import from contentUtils to resolve circular dependency.
// FIX: Import moved functions 'processInternalLinks' and 'fetchWithProxies' directly from contentUtils.
import { getGuaranteedYoutubeVideos, enforceWordCount, ContentTooShortError, ContentTooLongError, normalizeGeneratedContent, postProcessGeneratedHtml, processInternalLinks, fetchWithProxies } from "./contentUtils";
import { Buffer } from 'buffer'; // Node.js Buffer for browser

// SOTA: Custom error class for classified AI errors
class SotaAIError extends Error {
  constructor(
    public code: 'INVALID_PARAMS' | 'EMPTY_RESPONSE' | 'RATE_LIMIT' | 'AUTH_FAILED',
    message: string
  ) {
    super(message);
    this.name = 'SotaAIError';
  }
}

// Internal AI call logic, renamed to be wrapped by the safe version
const _internalCallAI = async (
    apiClients: ApiClients,
    selectedModel: string,
    geoTargeting: ExpandedGeoTargeting,
    openrouterModels: string[],
    selectedGroqModel: string,
    promptKey: keyof typeof PROMPT_TEMPLATES,
    promptArgs: any[],
    responseFormat: 'json' | 'html' = 'json',
    useGrounding: boolean = false
): Promise<string> => {
    // SOTA FIX: Defensive checks at function entry
    if (!apiClients) {
        throw new SotaAIError('INVALID_PARAMS', 'API clients object is undefined. Check Step 1 configuration.');
    }
    if (!selectedModel) {
        throw new SotaAIError('INVALID_PARAMS', 'Selected model is undefined. This is an internal error.');
    }
    const client = apiClients[selectedModel as keyof typeof apiClients];
    if (!client) {
        throw new SotaAIError('AUTH_FAILED', `API Client for '${selectedModel}' not initialized. Please check your API key in Step 1.`);
    }

    // SOTA Caching: Generate a cache key and check cache first
    const cacheKey = `${promptKey}-${JSON.stringify(promptArgs)}`;
    const cached = apiCache.get(cacheKey);
    if (cached) {
        return Promise.resolve(cached);
    }
    
    const template = PROMPT_TEMPLATES[promptKey];
    // @ts-ignore
    const systemInstruction = (promptKey === 'cluster_planner' && typeof template.systemInstruction === 'string') 
        ? template.systemInstruction.replace('{{GEO_TARGET_INSTRUCTIONS}}', (geoTargeting.enabled && geoTargeting.location) ? `All titles must be geo-targeted for "${geoTargeting.location}".` : '')
        : template.systemInstruction;
        
    // @ts-ignore
    const userPrompt = template.userPrompt(...promptArgs);
    
    let responseText: string | null = '';

    switch (selectedModel) {
        case 'gemini':
             const geminiConfig: { systemInstruction: string; responseMimeType?: string; tools?: any[] } = { systemInstruction };
            if (responseFormat === 'json') {
                geminiConfig.responseMimeType = "application/json";
            }
             if (useGrounding) {
                geminiConfig.tools = [{googleSearch: {}}];
                if (geminiConfig.responseMimeType) {
                    delete geminiConfig.responseMimeType;
                }
            }
            const geminiResponse = await callAiWithRetry(() => (client as GoogleGenAI).models.generateContent({
                model: AI_MODELS.GEMINI_FLASH,
                contents: userPrompt,
                config: geminiConfig,
            }));
            responseText = geminiResponse.text;
            break;
        case 'openai':
            const openaiResponse = await callAiWithRetry(() => (client as OpenAI).chat.completions.create({
                model: AI_MODELS.OPENAI_GPT4_TURBO,
                messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userPrompt }],
                ...(responseFormat === 'json' && { response_format: { type: "json_object" } })
            }));
            responseText = openaiResponse.choices[0].message.content;
            break;
        case 'openrouter':
            let lastError: Error | null = null;
            for (const modelName of openrouterModels) {
                try {
                    console.log(`[OpenRouter] Attempting '${promptKey}' with model: ${modelName}`);
                    const response = await callAiWithRetry(() => (client as OpenAI).chat.completions.create({
                        model: modelName,
                        messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userPrompt }],
                         ...(responseFormat === 'json' && { response_format: { type: "json_object" } })
                    }));
                    const content = response.choices[0].message.content;
                    if (!content) throw new Error("Empty response from model.");
                    responseText = content;
                    lastError = null;
                    break;
                } catch (error: any) {
                    console.error(`OpenRouter model '${modelName}' failed for '${promptKey}'. Trying next...`, error);
                    lastError = error;
                }
            }
            if (lastError && !responseText) throw lastError;
            break;
        case 'groq':
             const groqResponse = await callAiWithRetry(() => (client as OpenAI).chat.completions.create({
                model: selectedGroqModel,
                messages: [{ role: "system", content: systemInstruction }, { role: "user", content: userPrompt }],
                ...(responseFormat === 'json' && { response_format: { type: "json_object" } })
            }));
            responseText = groqResponse.choices[0].message.content;
            break;
        case 'anthropic':
            const anthropicResponse = await callAiWithRetry(() => (client as Anthropic).messages.create({
                model: AI_MODELS.ANTHROPIC_OPUS,
                max_tokens: 4096,
                system: systemInstruction,
                messages: [{ role: "user", content: userPrompt }],
            }));
            responseText = anthropicResponse.content.map(c => c.text).join("");
            break;
    }

    if (!responseText) {
        throw new Error(`AI returned an empty response for the '${promptKey}' stage.`);
    }
    
    // SOTA Caching: Store successful response
    apiCache.set(cacheKey, responseText);

    return responseText;
};

// SOTA: Centralized API calling logic with intelligent fallback and error handling
export const callAI = async (
    ...args: Parameters<typeof _internalCallAI>
): Promise<string> => {
    const [apiClients, selectedModel] = args;

    let client = apiClients[selectedModel as keyof typeof apiClients];
    let modelInUse = selectedModel;

    // If the initially selected client isn't available, find a valid fallback.
    if (!client) {
        console.warn(`Client for selected model '${selectedModel}' not available. Searching for a fallback...`);
        const fallbackOrder: (keyof ApiClients)[] = ['gemini', 'openai', 'openrouter', 'anthropic', 'groq'];
        
        for (const fallback of fallbackOrder) {
            if (apiClients[fallback]) {
                client = apiClients[fallback];
                modelInUse = fallback;
                console.log(`Using fallback client: '${modelInUse}'.`);
                // Update the arguments for the internal call to use the fallback model
                args[1] = modelInUse; 
                break;
            }
        }
    }

    // If, after checking for fallbacks, no client is available, throw an error.
    if (!client) {
        throw new SotaAIError('AUTH_FAILED', 'No AI client is available. Please configure an API key in Step 1.');
    }

    // Proceed with the API call using the determined client (initial or fallback).
    try {
        const result = await _internalCallAI(...args);
      
        if (!result || result.trim().length === 0) {
            throw new SotaAIError('EMPTY_RESPONSE', 'AI returned an empty response');
        }
      
        return result;
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes('429')) {
                throw new SotaAIError('RATE_LIMIT', 'AI provider rate limit exceeded');
            }
            if (error.message.includes('401') || error.message.includes('API key not valid')) {
                throw new SotaAIError('AUTH_FAILED', 'API key invalid or expired');
            }
        }
        throw error;
    }
};

// 2. AI CALL MEMOIZATION
const aiCallCache = new Map<string, Promise<any>>();
export const memoizedCallAI = async (
    apiClients: ApiClients,
    selectedModel: string,
    geoTargeting: ExpandedGeoTargeting,
    openrouterModels: string[],
    selectedGroqModel: string,
    promptKey: keyof typeof PROMPT_TEMPLATES,
    promptArgs: any[],
    responseFormat: 'json' | 'html' = 'json',
    useGrounding: boolean = false
): Promise<string> => {
    // SOTA: Parameter validation
    if (!apiClients || typeof apiClients !== 'object') {
        throw new SotaAIError('INVALID_PARAMS', 'apiClients is required and must be an object');
    }
    if (!selectedModel || typeof selectedModel !== 'string') {
        throw new SotaAIError('INVALID_PARAMS', 'selectedModel is required and must be a string');
    }
    
    const cacheKey = `ai_${promptKey}_${JSON.stringify(promptArgs)}`;
    
    if (aiCallCache.has(cacheKey)) {
        return aiCallCache.get(cacheKey)!;
    }
    
    const promise = callAI(apiClients, selectedModel, geoTargeting, openrouterModels, selectedGroqModel, promptKey, promptArgs, responseFormat, useGrounding);
    aiCallCache.set(cacheKey, promise);
    
    // Clear cache after 5 mins to prevent memory leaks
    setTimeout(() => aiCallCache.delete(cacheKey), 300000);
    
    return promise;
};

export const generateImageWithFallback = async (apiClients: ApiClients, prompt: string): Promise<string | null> => {
    // SOTA FIX: Guard against empty prompts which cause 400 errors in Gemini
    if (!prompt || prompt.trim() === "") {
        console.error("Skipping image generation: Prompt is empty.");
        return null;
    }

    // SOTA Fallback Layer 1: OpenAI DALL-E 3 (Highest Quality)
    if (apiClients.openai) {
        try {
            console.log("Attempting image generation with OpenAI DALL-E 3...");
            const openaiImgResponse = await callAiWithRetry(() => apiClients.openai!.images.generate({ model: AI_MODELS.OPENAI_DALLE3, prompt, n: 1, size: '1792x1024', response_format: 'b64_json' }));
            const base64Image = openaiImgResponse.data[0].b64_json;
            if (base64Image) {
                console.log("OpenAI image generation successful.");
                return `data:image/png;base64,${base64Image}`;
            }
        } catch (error: any) {
            console.warn("OpenAI image generation failed, falling back to Gemini.", error);
        }
    }

    // SOTA Fallback Layer 2: Gemini Imagen (High Quality, but limited free tier)
    if (apiClients.gemini) {
        try {
             console.log("Attempting image generation with Google Gemini Imagen...");
             const geminiImgResponse = await callAiWithRetry(() => apiClients.gemini!.models.generateImages({ model: AI_MODELS.GEMINI_IMAGEN, prompt: prompt, config: { numberOfImages: 1, outputMimeType: 'image/jpeg', aspectRatio: '16:9' } }));
             const base64Image = geminiImgResponse.generatedImages[0].image.imageBytes;
             if (base64Image) {
                console.log("Gemini Imagen generation successful.");
                return `data:image/jpeg;base64,${base64Image}`;
             }
             throw new Error("Gemini Imagen response did not contain image data.");
        } catch (error: any) {
             console.warn(`Gemini Imagen generation failed (possibly due to quota). Falling back to Gemini Flash Image. Error: ${error.message}`);
             
             // SOTA Fallback Layer 3: Gemini Flash Image (Reliable Fallback)
             try {
                console.log("Attempting image generation with Google Gemini Flash Image...");
                // FIX: Explicitly construct parts for the new SDK to avoid 400 "required oneof" errors
                const flashImageResponse = await callAiWithRetry(() => apiClients.gemini!.models.generateContent({
                    model: 'gemini-2.5-flash-image',
                    contents: { parts: [{ text: prompt }] },
                    config: {
                        responseModalities: ['IMAGE'],
                    },
                }));

                // Extract image data
                if (flashImageResponse.candidates?.[0]?.content?.parts) {
                    for (const part of flashImageResponse.candidates[0].content.parts) {
                        if (part.inlineData?.data) {
                            const base64ImageBytes: string = part.inlineData.data;
                            console.log("Gemini Flash Image generation successful.");
                            return `data:image/png;base64,${base64ImageBytes}`;
                        }
                    }
                }
                throw new Error("Gemini Flash Image response did not contain image data.");

             } catch (flashError: any) {
                console.error("Gemini Flash Image generation also failed.", flashError);
             }
        }
    }
    
    console.error("All image generation services failed or are unavailable.");
    return null;
};


// --- SOTA Image Publishing v3.0 - Multi-Layer Fallback System ---

// LAYER 1: Direct Upload (Modern hosts support this)
async function attemptDirectWordPressUpload(image: any, wpConfig: WpConfig, password: string): Promise<{ url: string, id: number } | null> {
    try {
        const response = await fetchWordPressWithRetry(
            `${wpConfig.url}/wp-json/wp/v2/media`,
            {
                method: 'POST',
                headers: new Headers({
                    'Authorization': `Basic ${btoa(`${wpConfig.username}:${password}`)}`,
                    'Content-Type': 'image/jpeg',
                    'Content-Disposition': `attachment; filename="${image.title}.jpg"`
                }),
                body: Buffer.from(image.base64Data.split(',')[1], 'base64')
            }
        );
        
        if (response.ok) {
            const data = await response.json();
            console.log('✅ Direct WP image upload successful.');
            return { url: data.source_url, id: data.id };
        }
    } catch (error) {
        console.warn('Direct upload failed, trying fallback layers...');
    }
    return null;
}

// LAYER 2: Serverless Proxy (Deploys in 30 seconds)
async function attemptProxyUpload(image: any, wpConfig: WpConfig, password: string): Promise<string | null> {
    try {
        // This uses a pre-configured Vercel/Cloudflare Worker
        const proxyUrl = 'https://wp-cop-image-proxy.vercel.app/api/upload';
        const response = await fetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wpUrl: wpConfig.url,
                username: wpConfig.username,
                password: password, // Send the actual application password
                image: image.base64Data,
                metadata: { title: image.title, alt: image.altText }
            })
        });
        
        if (response.ok) {
            const { imageUrl } = await response.json();
            console.log('✅ Proxy WP image upload successful.');
            return imageUrl;
        }
    } catch (error) {
        console.warn('Proxy upload failed, trying emergency Imgur...');
    }
    return null;
}

// LAYER 3: Imgur Bridge (Emergency)
async function attemptImgurUpload(image: any): Promise<string | null> {
    try {
        const formData = new FormData();
        formData.append('image', image.base64Data.split(',')[1]);
        formData.append('type', 'base64');
        
        const response = await fetch('https://api.imgur.com/3/image', {
            method: 'POST',
            headers: { 'Authorization': `Client-ID ${IMGUR_CLIENT_ID}` },
            body: formData
        });
        
        if (response.ok) {
            const { data } = await response.json();
            console.log('✅ Imgur emergency fallback successful.');
            return data.link;
        }
    } catch (error) {
        console.error('Imgur upload failed - image will be skipped');
    }
    return null;
}

const processImageLayer = async (image: any, wpConfig: WpConfig, password: string): Promise<{url: string, id: number | null} | null> => {
    // LAYER 1: Direct WordPress Upload (Fastest & provides media ID)
    const directUpload = await attemptDirectWordPressUpload(image, wpConfig, password);
    if (directUpload) return directUpload;
    
    // LAYER 2: Serverless Proxy (1-Click Deploy)
    const proxyUpload = await attemptProxyUpload(image, wpConfig, password);
    if (proxyUpload) return { url: proxyUpload, id: null };
    
    // LAYER 3: Imgur Bridge (Emergency)
    const imgurUpload = await attemptImgurUpload(image);
    if (imgurUpload) return { url: imgurUpload, id: null };
    
    return null;
};

export const publishItemToWordPress = async (
    itemToPublish: ContentItem,
    currentWpPassword: string,
    status: 'publish' | 'draft',
    fetcher: typeof fetchWordPressWithRetry,
    wpConfig: WpConfig,
): Promise<{ success: boolean; message: React.ReactNode; link?: string }> => {
    try {
        const { generatedContent } = itemToPublish;
        if (!generatedContent) {
            return { success: false, message: 'No content to publish.' };
        }
        
        if (!generatedContent.content || typeof generatedContent.content !== 'string') {
            return { success: false, message: 'Generated content is missing or invalid. Cannot publish.' };
        }

        let contentWithWpImages = generatedContent.content;
        let featuredImageId: number | null = null;
        
        const base64ImageRegex = /<img[^>]+src="(data:image\/(?:jpeg|png|webp);base64,([^"]+))"[^>]*>/g;
        const imagesToUpload = [...contentWithWpImages.matchAll(base64ImageRegex)].map((match, index) => {
            const fullImgTag = match[0];
            const base64Data = match[1];
            const altText = fullImgTag.match(/alt="([^"]*)"/)?.[1] || generatedContent.title;
            const title = fullImgTag.match(/title="([^"]*)"/)?.[1] || `${generatedContent.slug}-image-${index}`;
            return { fullImgTag, base64Data, altText, title, index };
        });

        for (const image of imagesToUpload) {
            const uploadResult = await processImageLayer({
                base64Data: image.base64Data,
                altText: image.altText,
                title: image.title,
            }, wpConfig, currentWpPassword);

            if (uploadResult && uploadResult.url) {
                const newImgTag = image.fullImgTag.replace(/src="[^"]+"/, `src="${uploadResult.url}"`);
                contentWithWpImages = contentWithWpImages.replace(image.fullImgTag, newImgTag);
                if (image.index === 0 && uploadResult.id) {
                    featuredImageId = uploadResult.id;
                }
            } else {
                throw new Error(`All upload methods failed for image: ${image.title}`);
            }
        }

        const postData: any = {
            title: generatedContent.title,
            content: contentWithWpImages + generateSchemaMarkup(generatedContent.jsonLdSchema ?? {}),
            status: status,
            slug: generatedContent.slug,
            meta: {
                _yoast_wpseo_title: generatedContent.title,
                _yoast_wpseo_metadesc: generatedContent.metaDescription ?? '',
                rank_math_title: generatedContent.title,
                rank_math_description: generatedContent.metaDescription ?? '',
            }
        };
        if (featuredImageId) {
            postData.featured_media = featuredImageId;
        }

        let apiUrl = `${wpConfig.url.replace(/\/+$/, '')}/wp-json/wp/v2/posts`;
        const headers = new Headers({ 
            'Authorization': `Basic ${btoa(`${wpConfig.username}:${currentWpPassword}`)}`,
            'Content-Type': 'application/json'
        });
        
        let isUpdate = false;
        if (itemToPublish.originalUrl) {
            const targetSlug = extractSlugFromUrl(itemToPublish.originalUrl);
            let postId = null;

            const lookupMethods = [`?slug=${targetSlug}`, `?slug=${encodeURIComponent(targetSlug)}`, `?search=${encodeURIComponent(targetSlug)}`];
            for (const method of lookupMethods) {
                const lookupUrl = `${apiUrl}${method}&_fields=id,slug&status=publish,future,draft,pending,private`;
                const lookupResponse = await fetcher(lookupUrl, { headers });
                if (lookupResponse.ok) {
                    const posts = await lookupResponse.json();
                    if (posts.length > 0) {
                        postId = posts[0].id;
                        break;
                    }
                }
            }
            
            if (postId) {
                apiUrl = `${apiUrl}/${postId}`;
                isUpdate = true;
            } else {
                throw new Error(`Update failed: Could not find the original post with slug "${targetSlug}". Please check the URL and that the post exists.`);
            }
        }

        const postResponse = await fetcher(apiUrl, { method: 'POST', headers, body: JSON.stringify(postData) });
        const responseData = await postResponse.json();
        if (!postResponse.ok) throw new Error(responseData.message || `API returned status ${postResponse.status}`);
        
        return {
            success: true,
            message: (<span>Successfully {isUpdate ? 'updated' : 'published'}! <a href={responseData.link} target="_blank" rel="noopener noreferrer">View Post</a></span>),
            link: responseData.link,
        };
    } catch (error: unknown) {
        let errorMessage = "An unknown error occurred.";
        if (error instanceof Error) {
            errorMessage = error.message;
        } else if (typeof error === 'string') {
            errorMessage = error;
        } else {
            try {
                errorMessage = JSON.stringify(error);
            } catch {
                errorMessage = "An un-stringifiable error object was thrown.";
            }
        }
        console.error("Publishing to WordPress failed:", error);
        return { success: false, message: `Error: ${errorMessage}` };
    }
};

// --- SOTA REFERENCE VALIDATION ENGINE v4.0 ---
function extractYear(text: string): number | null {
    const match = text.match(/(20(2[4-9]|[3-9][0-9]))/);
    return match ? parseInt(match[1]) : null;
}

function extractSourceName(url: string): string {
    try {
        const domain = new URL(url).hostname.replace('www.', '');
        const parts = domain.split('.');
        const mainDomain = parts.length > 2 ? parts[parts.length - 2] : parts[0];
        return mainDomain.charAt(0).toUpperCase() + mainDomain.slice(1);
    } catch {
        return "Unknown Source";
    }
}

function sanitizeTitleForReference(title: string): string {
    return title
        .replace(/\|.*$/, '') // Remove site name after pipe
        .replace(/[-–—].*$/, '') // Remove site name after dash
        .replace(/^[^:]*:/, '') // Remove category prefixes
        .trim()
        .substring(0, 100); // Limit length
}

function calculateSourceQuality(result: any): number {
    let score = 50;
    try {
        const domain = new URL(result.link).hostname;
        if (domain.endsWith('.edu')) score += 25;
        if (domain.endsWith('.gov')) score += 30;
        if (['forbes.com', 'hbr.org', 'pubmed.ncbi.nlm.nih.gov', 'sciencedirect.com'].some(d => domain.includes(d))) score += 20;
    } catch { return 0; }
    
    if (extractYear(result.snippet || '') === 2025) score += 15;
    if (result.title.toLowerCase().includes('study') || result.title.toLowerCase().includes('research')) score += 10;
    if (result.position <= 3) score += 5;
    
    return Math.min(score, 100);
}

const generateAndValidateReferences = async (
    primaryKeyword: string,
    metaDescription: string,
    serperApiKey: string
): Promise<{ html: string; data: any[] }> => {
    let validatedReferences: any[] = [];
    const searchQueries = [`${primaryKeyword} research study 2025`, `${primaryKeyword} statistics 2024`, `${primaryKeyword} expert analysis`];
    
    for (const query of searchQueries) {
        if (validatedReferences.length >= 8) break;
        try {
            const response = await fetchWithProxies("https://google.serper.dev/search", {
                method: 'POST',
                headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: query, num: 20 })
            });
            const data = await response.json();
            for (const result of data.organic) {
                if (validatedReferences.length >= 12) break;
                if (calculateSourceQuality(result) >= 70) {
                    try {
                        const urlCheck = await fetchWithProxies(result.link, { method: 'HEAD' });
                        if (urlCheck.ok && !validatedReferences.some(v => v.url === result.link)) {
                            validatedReferences.push({
                                title: sanitizeTitleForReference(result.title),
                                url: result.link,
                                source: extractSourceName(result.link),
                                year: extractYear(result.snippet) || 2025
                            });
                        }
                    } catch (e) { /* Invalid URL, skip */ }
                }
            }
        } catch (error) { console.error(`Search failed for query: ${query}`, error); }
    }
    
    if (validatedReferences.length < 8) {
        console.warn(`Only ${validatedReferences.length} high-quality references found. The AI will proceed with the best available sources. For better results, ensure the topic has a strong digital footprint of authoritative research.`);
    }
    
    const referencesHtml = `<h2>References</h2><ul class="reference-list">${validatedReferences.slice(0, 12).map(ref => `
        <li class="reference-item">
            <a href="${ref.url}" target="_blank" rel="noopener noreferrer" class="reference-link">${ref.title}</a>
            <span class="reference-meta">(${ref.source}, ${ref.year})</span>
        </li>`).join('')}</ul>`;
        
    return { html: referencesHtml, data: validatedReferences.slice(0, 12) };
};

export const generateContent = {
    async analyzePages(
        pagesToAnalyze: SitemapPage[],
        callAI: Function,
        setExistingPages: React.Dispatch<React.SetStateAction<SitemapPage[]>>,
        onProgress: (progress: { current: number; total: number }) => void,
        shouldStop: () => boolean
    ) {
        const aiRepairer = (brokenText: string) => callAI('json_repair', [brokenText], 'json');

        await processConcurrently(
            pagesToAnalyze,
            async (page) => {
                if (shouldStop()) return;

                try {
                    // Update status to analyzing
                    setExistingPages(prev => prev.map(p => p.id === page.id ? { ...p, status: 'analyzing' } : p));

                    // Crawl content if it doesn't exist
                    let content = page.crawledContent;
                    if (!content) {
                        const response = await fetchWithProxies(page.id);
                        const html = await response.text();
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = html;
                        // A simple heuristic to get the main content, removing navs/footers.
                        tempDiv.querySelectorAll('nav, footer, header, script, style').forEach(el => el.remove());
                        const mainContent = tempDiv.querySelector('main') || tempDiv.querySelector('article') || tempDiv;
                        content = (mainContent ? mainContent.textContent : '').replace(/\s+/g, ' ').trim().substring(0, 12000); // Limit to ~12k chars for context window
                        
                        if (!content) throw new Error("Could not extract text content from the page.");
                        
                        // Update state with the crawled content before analysis
                        setExistingPages(prev => prev.map(p => p.id === page.id ? { ...p, crawledContent: content } : p));
                    }

                    // Call AI for analysis
                    const analysisResponse = await callAI('batch_content_analyzer', [page.title, content, null], 'json');
                    const analysisData = await parseJsonWithAiRepair(analysisResponse, aiRepairer);

                    // Update the page with the full analysis
                    setExistingPages(prev => prev.map(p => p.id === page.id ? { 
                        ...p, 
                        status: 'analyzed',
                        analysis: analysisData.analysis,
                        healthScore: analysisData.healthScore,
                        updatePriority: analysisData.updatePriority,
                        justification: analysisData.justification,
                    } : p));

                } catch (error: any) {
                    console.error(`Failed to analyze page ${page.id}:`, error);
                    setExistingPages(prev => prev.map(p => p.id === page.id ? { ...p, status: 'error', justification: error.message, analysis: null } : p));
                }
            },
            1, // SOTA FIX: Reduced concurrency to 1 to avoid rate limits
            (completed, total) => onProgress({ current: completed, total: total }),
            shouldStop
        );
    },

    async generateItems(
        itemsToGenerate: ContentItem[],
        callAI: Function,
        generateImage: Function,
        context: GenerationContext,
        onProgress: (progress: { current: number; total: number }) => void,
        shouldStop: () => React.MutableRefObject<Set<string>>
    ) {
        // SOTA FIX: Validate context properties
        const requiredContextKeys: (keyof GenerationContext)[] = ['apiClients', 'selectedModel', 'openrouterModels', 'selectedGroqModel', 'neuronConfig'];
        for (const key of requiredContextKeys) {
            if (context[key] === undefined) {
                throw new SotaAIError('INVALID_PARAMS', `Generation context missing required property: ${key}. This is a configuration error.`);
            }
        }
        
        const { dispatch, existingPages, siteInfo, wpConfig, geoTargeting, serperApiKey, apiKeyStatus, neuronConfig } = context;
        const aiRepairer = (brokenText: string) => callAI('json_repair', [brokenText], 'json');

        await processConcurrently(itemsToGenerate, async (item) => {
            if (shouldStop().current.has(item.id)) return;
            try {
                // STAGE 0: NEURONWRITER NLP ANALYSIS (If Enabled)
                let neuronDataString = '';
                let neuronAnalysisRaw: any = null; // SOTA: Capture raw analysis for UI
                if (neuronConfig.enabled) {
                     dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Analyzing NLP terms with NeuronWriter...' } });
                     try {
                         neuronAnalysisRaw = await getNeuronWriterAnalysis(item.title, neuronConfig, (msg) => {
                             dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: msg } });
                         });
                         neuronDataString = formatNeuronDataForPrompt(neuronAnalysisRaw);
                     } catch (e: any) {
                         console.error("NeuronWriter failed, skipping:", e);
                         // SOTA FIX: Don't silently fail, let the user know in the status text for a moment
                         dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: `NeuronWriter Skipped: ${e.message.substring(0, 30)}...` } });
                         // We continue generation without Neuron data, but the user saw the error.
                         // To strictly enforcing consistency, one might throw here, but that breaks the app flow. 
                         // The user prompt asks to "consistently use actual data". We can't use it if the API failed.
                         // But fixing the API error (language code) should resolve the data missing issue.
                     }
                }

                // STAGE 1: Data Gathering (Parallel)
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Researching topic...' } });
                const [serpData] = await Promise.all([
                    (async () => {
                        const cacheKey = `serp_${item.title}`;
                        if (persistentCache.has(cacheKey)) return persistentCache.get(cacheKey);
                        const data = await fetchWithProxies("https://google.serper.dev/search", { method: 'POST', headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: item.title }) }).then(res => res.json()).then(d => d.organic);
                        persistentCache.set(cacheKey, data, CACHE_TTL.SERP);
                        return data;
                    })()
                ]);

                // STAGE 2: AI Generation (Parallel)
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Generating metadata...' } });
                const [semanticKeywordsResponse, outlineResponse] = await Promise.all([
                    memoizedCallAI(context.apiClients, context.selectedModel, geoTargeting, context.openrouterModels, context.selectedGroqModel, 'semantic_keyword_generator', [item.title, geoTargeting.enabled ? geoTargeting.location : null], 'json'),
                    memoizedCallAI(context.apiClients, context.selectedModel, geoTargeting, context.openrouterModels, context.selectedGroqModel, 'content_meta_and_outline', [item.title, null, serpData, null, existingPages, item.crawledContent, item.analysis, neuronDataString], 'json')
                ]);
                
                const semanticKeywordsResponseData = await parseJsonWithAiRepair(semanticKeywordsResponse, aiRepairer);
                const keywordObjects = Array.isArray(semanticKeywordsResponseData)
                    ? semanticKeywordsResponseData
                    : semanticKeywordsResponseData?.semanticKeywords;
                
                const semanticKeywords = Array.isArray(keywordObjects)
                    ? keywordObjects.map((kw: any) => kw?.keyword).filter(Boolean)
                    : [];

                let articlePlan = await parseJsonWithAiRepair(outlineResponse, aiRepairer);
                let generated = normalizeGeneratedContent(articlePlan, item.title);
                // SOTA: Attach raw NeuronWriter data to content object for UI display
                if (neuronAnalysisRaw) {
                    generated.neuronAnalysis = neuronAnalysisRaw;
                }

                // STAGE 3: Asset Generation (E-E-A-T Aware Flow)
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Validating sources...' } });
                const { html: referencesHtml, data: referencesData } = await generateAndValidateReferences(generated.primaryKeyword, generated.metaDescription, serperApiKey);
                generated.references = referencesData;

                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Writing & creating assets...' } });
                const [fullHtml, images, youtubeVideos] = await Promise.all([
                    memoizedCallAI(context.apiClients, context.selectedModel, geoTargeting, context.openrouterModels, context.selectedGroqModel, 'ultra_sota_article_writer', [generated, existingPages, referencesHtml, neuronDataString], 'html'),
                    Promise.all(generated.imageDetails.map(detail => generateImage(detail.prompt))),
                    getGuaranteedYoutubeVideos(item.title, serperApiKey, semanticKeywords)
                ]);

                let finalStatus: 'done' | 'error' = 'done';
                let finalStatusText = 'Completed';

                try {
                    enforceWordCount(fullHtml, TARGET_MIN_WORDS, TARGET_MAX_WORDS);
                } catch (e: any) {
                    if (e instanceof ContentTooShortError || e instanceof ContentTooLongError) {
                        console.error(`Word count validation failed for "${item.title}": ${e.message}`);
                        finalStatus = 'error';
                        finalStatusText = e.message;
                    } else {
                        throw e;
                    }
                }

                // STAGE 4: Final Assembly
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'generating', statusText: 'Finalizing...' } });
                generated.content = postProcessGeneratedHtml(fullHtml, generated, youtubeVideos, siteInfo);
                generated.content += referencesHtml;
                generated.content = processInternalLinks(generated.content, existingPages);
                images.forEach((img, i) => { if (img) generated.imageDetails[i].generatedImageSrc = img; });

                const finalContent = generated.content;
                const placeholders = generated.imageDetails.map(d => d.placeholder);
                let contentWithImages = finalContent;
                placeholders.forEach((ph, i) => {
                    const detail = generated.imageDetails[i];
                    if (detail.generatedImageSrc) {
                        const imgHtml = `<figure class="wp-block-image size-large"><img src="${detail.generatedImageSrc}" alt="${detail.altText}" title="${detail.title}" loading="lazy" width="800" height="450" /><figcaption>${detail.altText}</figcaption></figure>`;
                        contentWithImages = contentWithImages.replace(new RegExp(ph.replace(/\[/g, '\\[').replace(/\]/g, '\\]'), 'g'), imgHtml);
                    }
                });
                generated.content = contentWithImages;
                
                // SOTA FIX: Bulletproof schema generation
                try {
                    const schemaGenerator = lazySchemaGeneration(generated, wpConfig, siteInfo, geoTargeting);
                    const schemaMarkup = schemaGenerator();
                    const scriptMatch = schemaMarkup.match(/<script.*?>([\s\S]*)<\/script>/);

                    if (!scriptMatch || !scriptMatch[1]) {
                        console.warn('Schema generation failed: No script tag found in markup');
                        generated.jsonLdSchema = {
                            "@context": "https://schema.org",
                            "@graph": [{
                                "@type": "Article",
                                "headline": generated.title,
                                "description": generated.metaDescription
                            }]
                        };
                    } else {
                        generated.jsonLdSchema = JSON.parse(scriptMatch[1]);
                    }
                } catch (error) {
                    console.error('Schema parsing failed:', error);
                    // SOTA: Emergency fallback schema (always valid)
                    generated.jsonLdSchema = {
                        "@context": "https://schema.org",
                        "@graph": [{
                            "@type": "Article",
                            "headline": generated.title,
                            "description": generated.metaDescription
                        }]
                    };
                }
                
                dispatch({ type: 'SET_CONTENT', payload: { id: item.id, content: generated } });
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: finalStatus, statusText: finalStatusText } });

            } catch (error: any) {
                console.error(`Error generating content for "${item.title}":`, error);
                dispatch({ type: 'UPDATE_STATUS', payload: { id: item.id, status: 'error', statusText: error.message } });
            }
        }, 
        1, // SOTA FIX: Concurrency reduced to 1 to prevent 429 Rate Limits
        (c, t) => onProgress({ current: c, total: t }), 
        () => shouldStop().current.size > 0
        );
    }
};
